"""
PySide6 overlay — runs as subprocess of app.py.

Native antialiased painting + true per-pixel alpha (no halo, no pixelation).
Always-on-top with periodic Win32 reassert. 60fps.

Look (theme / accent / glow / waveform / shape), size and placement all come from
overlay_config settings pushed by the parent, so Settings → Overlay previews live.

IPC (one JSON per line):
  parent -> stdin:
    {"type":"state","value":"idle"|"recording"|"processing"}
    {"type":"levels","values":[float,...]}
    {"type":"config","settings":{...overlay_config keys...}}
    {"type":"preview","value":null|"recording"|"processing"}
    {"type":"quit"}
  overlay -> stdout:
    {"type":"toggle"}
    {"type":"cancel"}
    {"type":"show_window"}
    {"type":"show_settings"}
    {"type":"hide"}
    {"type":"quit"}
    {"type":"moved","px":float,"py":float,"ax":float,"ay":float}
    {"type":"screens","list":[{"index","name","x","y","w","h","pw","ph","primary"},...]}
"""

from __future__ import annotations

import ctypes  # ctypes itself exists everywhere; ctypes.wintypes is Win-only and imported lazily
import json
import math
import sys
import threading
import time

from PySide6.QtCore import Qt, QTimer, QPointF, QPoint, QRectF, QObject, Signal
from PySide6.QtGui import (
    QPainter, QPainterPath, QColor, QBrush, QPen, QFont, QPaintEvent,
    QMouseEvent, QCursor, QLinearGradient, QGuiApplication,
)
from PySide6.QtWidgets import QApplication, QWidget, QMenu

import overlay_config as oc


# ---------- Layout ----------
# Base units — the whole overlay is scaled by the `overlay_scale` setting at paint time.
# The window includes generous margin around the pill so the multi-layer glow fades
# to full transparency before reaching the window edge (no hard rectangular cut).
PILL_W_IDLE, PILL_H_IDLE = 144, 34
PILL_W_ACTIVE, PILL_H_ACTIVE = 580, 62
NUM_BARS = 34          # bars / wave points at width 100%
FINE_BARS = 54         # thin bars covering the same span
BAR_W = 2.4
BAR_GAP = 2.4
FINE_BAR_W = 1.4
FINE_BAR_GAP = 1.6
BTN_PAD = 26
OVERSHOOT = 1.06       # ease_out_back peaks a hair above 1.0 — the window leaves room for it

# Glow tuning — number of concentric rounded-rect layers used to fake a gaussian blur.
# More layers = smoother falloff. Each layer is ~88% alpha of the previous.
GLOW_LAYERS = 18
GLOW_EXPAND_X = 80   # max horizontal spread of the outermost layer (px from pill edge)
GLOW_EXPAND_Y = 64   # max vertical spread (taller looks better against thin pill)


# ---------- Easing ----------

def ease_out_cubic(t: float) -> float:
    return 1.0 - (1.0 - t) ** 3


def ease_out_back(t: float, overshoot: float = 1.5) -> float:
    """Cubic with slight overshoot — gives a spring-y settle."""
    c1 = overshoot
    c3 = c1 + 1
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def lerp_color(a: QColor, b: QColor, t: float) -> QColor:
    return QColor(
        int(lerp(a.red(), b.red(), t)),
        int(lerp(a.green(), b.green(), t)),
        int(lerp(a.blue(), b.blue(), t)),
        int(lerp(a.alpha(), b.alpha(), t)),
    )


def resample(values: list[float], n: int) -> list[float]:
    """Stretch/shrink a level list to exactly n points (linear interpolation)."""
    m = len(values)
    if m == 0:
        return [0.0] * n
    if m == 1:
        return [values[0]] * n
    out = []
    for i in range(n):
        u = i * (m - 1) / max(1, n - 1)
        k = int(u)
        f = u - k
        a = values[k]
        b = values[min(k + 1, m - 1)]
        out.append(a + (b - a) * f)
    return out


# ---------- Colors ----------

def _near(a: QColor, b: QColor, dist: int = 100) -> bool:
    return abs(a.red() - b.red()) + abs(a.green() - b.green()) + abs(a.blue() - b.blue()) < dist


class Palette:
    """Every colour the overlay paints with, for one (theme, accent) pair."""

    def __init__(self, theme: str, accent_hex: str):
        dark = theme == "dark"
        acc = QColor(accent_hex)
        # Processing colour is amber unless the accent is itself amber-ish — then the two
        # states would look identical, so switch processing to a cool blue.
        amber = QColor(244, 162, 97) if dark else QColor(226, 124, 40)
        if _near(acc, amber):
            amber = QColor(125, 211, 252) if dark else QColor(14, 116, 190)

        self.bg_idle = QColor(12, 12, 14, 235) if dark else QColor(250, 250, 252, 238)
        self.bg_active = QColor(14, 14, 16, 248) if dark else QColor(250, 250, 252, 250)
        self.border_idle = QColor(255, 255, 255, 22) if dark else QColor(0, 0, 0, 40)
        self.border_hover = QColor(255, 255, 255, 40) if dark else QColor(0, 0, 0, 72)
        self.mic = QColor(232, 232, 232, 235) if dark else QColor(38, 38, 44, 235)
        self.bars = QColor(232, 232, 232, 255) if dark else QColor(30, 30, 36, 255)
        self.dim = QColor(110, 110, 110, 255) if dark else QColor(150, 150, 156, 255)
        self.ok = QColor(127, 224, 122, 255) if dark else QColor(34, 160, 72, 255)

        self.rec = QColor(acc.red(), acc.green(), acc.blue(), 255)
        self.rec_hot = lerp_color(self.rec, QColor(255, 255, 255) if dark else QColor(0, 0, 0), 0.22)
        self.proc = QColor(amber.red(), amber.green(), amber.blue(), 255)

        self.border_rec = QColor(self.rec)
        self.border_rec.setAlpha(235)
        self.border_proc = QColor(self.proc)
        self.border_proc.setAlpha(235)
        self.glow_rec = QColor(self.rec)
        self.glow_rec.setAlpha(90)
        self.glow_proc = QColor(self.proc)
        self.glow_proc.setAlpha(75)


class StdinBridge(QObject):
    """Reads JSON lines from stdin in a worker thread, emits to GUI thread.

    Call start() only AFTER connecting `message` — the parent's first line (the config)
    is often already waiting in the pipe, and a signal emitted with no receiver is lost."""
    message = Signal(dict)

    def __init__(self):
        super().__init__()
        self._thread = threading.Thread(target=self._read, daemon=True)

    def start(self):
        self._thread.start()

    def _read(self):
        try:
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                try:
                    self.message.emit(json.loads(line))
                except json.JSONDecodeError:
                    pass
        except Exception:
            pass


def emit_event(d: dict):
    """Send event to parent over stdout."""
    print(json.dumps(d), flush=True)


# ---------- Win32 z-order plumbing ----------
SWP_NOSIZE, SWP_NOMOVE, SWP_NOACTIVATE, SWP_SHOWWINDOW = 0x0001, 0x0002, 0x0010, 0x0040
_user32_cache = None


def _user32():
    """user32 with REAL function signatures (Windows only).

    Without argtypes, ctypes passes Python ints as 32-bit C ints. On 64-bit Python that turns
    HWND_TOPMOST (-1) into 0x00000000FFFFFFFF instead of a pointer-sized -1, so SetWindowPos
    fails with ERROR_INVALID_WINDOW_HANDLE and does nothing. That silently disabled the whole
    always-on-top safety net (the 200 ms timer AND the focus hook): the overlay stayed above
    other windows only until something buried it (DaVinci Resolve, any normal window), and then
    never recovered. A private WinDLL keeps the signatures from depending on whoever else
    touches ctypes.windll.user32."""
    global _user32_cache
    if _user32_cache is None:
        from ctypes import wintypes
        u = ctypes.WinDLL("user32", use_last_error=True)
        u.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
                                   ctypes.c_int, ctypes.c_int, wintypes.UINT]
        u.SetWindowPos.restype = wintypes.BOOL
        u.IsWindowVisible.argtypes = [wintypes.HWND]
        u.IsWindowVisible.restype = wintypes.BOOL
        _user32_cache = u
    return _user32_cache


class Overlay(QWidget):
    def __init__(self, initial_x: int | None = None, initial_y: int | None = None):
        super().__init__()
        self.setWindowFlags(
            Qt.FramelessWindowHint
            | Qt.WindowStaysOnTopHint
            | Qt.Tool
            | Qt.WindowDoesNotAcceptFocus
            | Qt.NoDropShadowWindowHint
        )
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WA_ShowWithoutActivating, True)

        # Settings — defaults (or a v1–v8 position from the command line) until the parent's
        # first `config` message lands; we stay hidden until then so nothing flashes in the
        # wrong place.
        legacy = {}
        if initial_x is not None and initial_y is not None:
            legacy = {"overlay_x": initial_x, "overlay_y": initial_y}
        self._cfg = oc.resolve(legacy)
        self._pal = Palette(self._cfg["overlay_theme"], self._cfg["overlay_accent"])
        self._configured = False

        # Font
        self._font = QFont("Segoe UI", 9, QFont.DemiBold)

        # State
        self._real_state = "idle"          # what the app says
        self._preview: str | None = None   # Settings → Overlay preview ("recording"/"processing")
        self._state = "idle"               # what we paint (preview wins while the app is idle)
        self._hover = False
        self._hover_zone: str | None = None
        self._press_zone: str | None = None
        self._target_t = 0.0   # 0=idle, 1=active
        self._expand_t = 0.0   # animated value (raw, before easing)
        self._target_opacity = 0.40
        self._opacity = 0.40
        self.setWindowOpacity(self._opacity)
        self._spin_phase = 0.0
        self._bars: list[float] = [0.0] * self._bar_count()
        self._raw_levels: list[float] = []
        # Idle "breathing" pulse — subtle alpha modulation so the bar feels alive
        self._breath_phase = 0.0
        # Glow intensity animated separately for fade-in/out
        self._glow_target = 0.0
        self._glow = 0.0

        # Geometry — filled by _relayout()
        self._sc = 1.0
        self._ax = self._ay = 0.5
        self._ref = QPointF(0, 0)
        self._relayout()

        # Drag
        self._drag_origin: tuple[int, int] | None = None
        self._drag_started = False

        # Mouse tracking for hover
        self.setMouseTracking(True)

        # Animation timer 60 fps
        self._anim = QTimer(self)
        self._anim.timeout.connect(self._tick)
        self._anim.start(16)

        # --- Always-on-top reinforcement ---
        # Three independent mechanisms run together on Windows so the Beam can
        # NEVER fall behind any newly-opened window:
        #
        # 1) Fast tick: reassert HWND_TOPMOST every 200ms (was 1500ms — too slow,
        #    a new window opening could obscure us for over a second).
        # 2) OS hook: subscribe to EVENT_SYSTEM_FOREGROUND so we reassert the
        #    INSTANT another window claims the foreground. Sub-frame response.
        # 3) (Existing) Qt flag WindowStaysOnTopHint set above.
        #
        # On macOS we use a different mechanism — NSWindow.level is bumped to
        # NSStatusWindowLevel via PyObjC, which already survives Mission Control
        # transitions and Spaces switches, so we don't need the timer or hook.
        self._topmost_warned = False
        self._topmost = QTimer(self)
        self._topmost.timeout.connect(self._force_topmost)
        self._topmost.start(200)
        self._install_foreground_hook()

        # Stdin — started last, once every attribute the handlers touch exists.
        self._bridge = StdinBridge()
        self._bridge.message.connect(self._handle_msg)
        self._bridge.start()

        # If the parent never sends a config (older parent, or a bare `python overlay_qt.py`),
        # show up with the defaults after a beat rather than staying invisible forever.
        QTimer.singleShot(600, self._first_show)

    # ---------- settings / layout ----------

    def _bar_count(self) -> int:
        base = FINE_BARS if self._cfg["overlay_wave"] == "fine" else NUM_BARS
        return max(12, round(base * self._cfg["overlay_width"]))

    def apply_settings(self, raw: dict):
        old = self._cfg
        self._cfg = c = oc.resolve(raw)
        if (c["overlay_theme"], c["overlay_accent"]) != (old["overlay_theme"], old["overlay_accent"]):
            self._pal = Palette(c["overlay_theme"], c["overlay_accent"])
        n = self._bar_count()
        if n != len(self._bars):
            self._bars = [0.0] * n
        self._configured = True
        self._relayout()
        self._update_state()

    def _first_show(self):
        if not self._configured:
            self._configured = True
            self._update_state()

    def _screens(self):
        return QGuiApplication.screens()

    def _monitor_screen(self):
        screens = self._screens()
        i = self._cfg["overlay_monitor"]
        if 0 <= i < len(screens):
            return screens[i]
        return QGuiApplication.primaryScreen()

    def _nearest_screen(self, x: float, y: float):
        scr = QGuiApplication.screenAt(QPoint(int(x), int(y)))
        if scr is not None:
            return scr
        best, best_d = None, None
        for s in self._screens():
            g = s.geometry()
            dx = max(g.x() - x, 0, x - (g.x() + g.width()))
            dy = max(g.y() - y, 0, y - (g.y() + g.height()))
            d = dx * dx + dy * dy
            if best_d is None or d < best_d:
                best, best_d = s, d
        return best or QGuiApplication.primaryScreen()

    def _placement(self):
        """(ax, ay, P): which point of the pill is pinned, and where on screen it goes.

        Clamped so the fully expanded pill always fits on its screen — the pill grows in the
        direction of its alignment, so an edge/corner anchor never opens off-screen."""
        c = self._cfg
        wa, ha = self._aw * self._sc, self._ah * self._sc     # expanded pill, screen px
        if c["overlay_anchor"] == "custom":
            ax, ay = c["overlay_ax"], c["overlay_ay"]
            px, py = c["overlay_px"], c["overlay_py"]
            av = self._nearest_screen(px + (0.5 - ax) * wa, py + (0.5 - ay) * ha).availableGeometry()
        else:
            ax, ay = oc.ANCHORS[c["overlay_anchor"]]
            av = self._monitor_screen().availableGeometry()
            m = c["overlay_margin"]
            px = av.x() + m if ax == 0 else (av.x() + av.width() - m if ax == 1 else av.x() + av.width() / 2)
            py = av.y() + m if ay == 0 else (av.y() + av.height() - m if ay == 1 else av.y() + av.height() / 2)
        lo_x = av.x() + ax * wa
        hi_x = max(lo_x, av.x() + av.width() - (1 - ax) * wa)
        lo_y = av.y() + ay * ha
        hi_y = max(lo_y, av.y() + av.height() - (1 - ay) * ha)
        return ax, ay, QPointF(min(max(px, lo_x), hi_x), min(max(py, lo_y), hi_y))

    def _relayout(self):
        """Recompute sizes + window position from the current settings."""
        c = self._cfg
        sc = self._sc = c["overlay_scale"]
        self._aw = PILL_W_ACTIVE * c["overlay_width"]
        self._ah = PILL_H_ACTIVE
        wm = PILL_W_IDLE + (self._aw - PILL_W_IDLE) * OVERSHOOT   # widest the pill ever paints
        hm = PILL_H_IDLE + (self._ah - PILL_H_IDLE) * OVERSHOOT
        self._Wb = math.ceil(wm + 2 * GLOW_EXPAND_X)              # window, base units
        self._Hb = math.ceil(hm + 2 * GLOW_EXPAND_Y)
        self._ax, self._ay, self._ref = self._placement()
        # Where the pinned point sits inside the window (base units).
        self._Lx = GLOW_EXPAND_X + self._ax * wm
        self._Ly = GLOW_EXPAND_Y + self._ay * hm
        w, h = math.ceil(self._Wb * sc), math.ceil(self._Hb * sc)
        if (w, h) != (self.width(), self.height()):
            self.setFixedSize(w, h)
        self.move(round(self._ref.x() - self._Lx * sc), round(self._ref.y() - self._Ly * sc))
        self.update()

    def _pill_rect(self, ex: float) -> QRectF:
        """The pill in window base units at expand amount `ex`, honouring its alignment."""
        w = lerp(PILL_W_IDLE, self._aw, ex)
        h = lerp(PILL_H_IDLE, self._ah, ex)
        return QRectF(self._Lx - self._ax * w, self._Ly - self._ay * h, w, h)

    def _radius(self, h: float) -> float:
        shape = self._cfg["overlay_shape"]
        if shape == "rounded":
            return h * 0.26
        if shape == "sharp":
            return min(h / 2, 5.0)
        return h / 2

    # ---------- screens ----------

    def report_screens(self):
        prim = QGuiApplication.primaryScreen()
        out = []
        for i, s in enumerate(self._screens()):
            g = s.geometry()
            dpr = s.devicePixelRatio()
            out.append({
                "index": i, "name": s.name(),
                "x": g.x(), "y": g.y(), "w": g.width(), "h": g.height(),
                "pw": round(g.width() * dpr), "ph": round(g.height() * dpr),
                "primary": s == prim,
            })
        emit_event({"type": "screens", "list": out})

    def on_screens_changed(self):
        self.report_screens()
        self._relayout()

    # ---------- IPC ----------

    def _handle_msg(self, msg: dict):
        t = msg.get("type")
        if t == "state":
            self._set_state(msg.get("value", "idle"))
        elif t == "levels":
            self._raw_levels = msg.get("values", [])
        elif t == "config":
            self.apply_settings(msg.get("settings") or {})
        elif t == "preview":
            self._set_preview(msg.get("value"))
        elif t == "quit":
            QApplication.instance().quit()

    def _set_state(self, s: str):
        self._real_state = s
        if s != "idle":
            self._preview = None   # a real dictation always wins over a Settings preview
        self._update_state()

    def _set_preview(self, v):
        self._preview = v if v in ("recording", "processing") and self._real_state == "idle" else None
        self._update_state()

    def _update_state(self):
        s = self._preview or self._real_state
        self._state = s
        if s in ("recording", "processing"):
            self._target_t = 1.0
            self._target_opacity = 0.98
            self._glow_target = 1.0
        else:
            self._target_t = 0.0
            if self._cfg["overlay_idle"] == "hidden":
                self._target_opacity = 0.0
            else:
                self._target_opacity = 0.72 if self._hover else 0.40
            self._glow_target = 0.0
        self._apply_visibility()

    def _apply_visibility(self):
        if not self._configured:
            return
        c = self._cfg
        if not c["show_overlay"]:
            self.hide()
            return
        if self._state != "idle" or c["overlay_idle"] == "pill":
            if not self.isVisible():
                self.show()
                self._force_topmost()
                # NSWindow only exists once Qt has created the platform window (on show).
                self._install_mac_topmost()
        # idle + "hidden": _tick fades the window out, then hides it.

    # ---------- topmost ----------

    def _force_topmost(self):
        """Put the overlay back on top of every other window. Runs on a 200 ms timer and the
        instant any other window takes the foreground — see _user32() for why it must use
        real signatures."""
        if sys.platform != "win32":
            return
        try:
            from ctypes import wintypes
            u = _user32()
            hwnd = wintypes.HWND(int(self.winId()))
            flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE
            if self.isVisible() and not u.IsWindowVisible(hwnd):
                flags |= SWP_SHOWWINDOW   # Qt thinks we're shown but Windows hid us — bring us back
            if not u.SetWindowPos(hwnd, wintypes.HWND(-1), 0, 0, 0, 0, flags):   # HWND_TOPMOST
                if not self._topmost_warned:   # say so once — this used to fail silently
                    self._topmost_warned = True
                    print(f"[topmost] SetWindowPos failed (Win32 error {ctypes.get_last_error()}); "
                          "the overlay may sit behind other windows")
        except Exception:
            pass

    # --- Foreground event hook via SetWinEventHook (Windows only) ---
    # Fires the instant another window becomes the foreground. We then defer the
    # SetWindowPos call to the next Qt event loop tick (the OS may not honor the
    # call while it's still in the middle of foreground transition).
    def _install_foreground_hook(self):
        if sys.platform != "win32":
            return
        try:
            from ctypes import wintypes  # Win-only — local import
            EVENT_SYSTEM_FOREGROUND = 0x0003
            WINEVENT_OUTOFCONTEXT = 0x0000

            WinEventProcType = ctypes.WINFUNCTYPE(
                None,
                ctypes.c_void_p,    # hWinEventHook
                wintypes.DWORD,     # event
                wintypes.HWND,      # hwnd
                wintypes.LONG,      # idObject
                wintypes.LONG,      # idChild
                wintypes.DWORD,     # idEventThread
                wintypes.DWORD,     # dwmsEventTime
            )

            def _proc(hWinEventHook, event, hwnd, idObject, idChild, idEventThread, dwmsEventTime):
                # Defer to next Qt tick — calling SetWindowPos mid-transition is unreliable
                try:
                    QTimer.singleShot(0, self._force_topmost)
                except Exception:
                    pass

            # Keep refs alive — these would be GC'd otherwise and the hook would silently break
            self._we_proc = WinEventProcType(_proc)
            self._we_hook = ctypes.windll.user32.SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                None,
                self._we_proc,
                0, 0,
                WINEVENT_OUTOFCONTEXT,
            )
            if not self._we_hook:
                print("[topmost] SetWinEventHook returned 0 — relying on the 200 ms timer only")
        except Exception as e:
            print(f"[topmost] SetWinEventHook failed: {e}")

    # --- macOS NSWindow level bump ---
    # On macOS, Qt's WindowStaysOnTopHint translates to NSFloatingWindowLevel,
    # which sits below status/menu items and gets covered by some fullscreen apps.
    # We bump to NSStatusWindowLevel (== 25) which floats over almost everything
    # including most fullscreen UIs, then add NSWindowCollectionBehavior flags
    # so the window follows the user across Spaces (Mission Control desktops).
    def _install_mac_topmost(self):
        if sys.platform != "darwin":
            return
        try:
            # AppKit constants — see Apple docs for the canonical values.
            NSStatusWindowLevel = 25
            NSWindowCollectionBehaviorCanJoinAllSpaces = 1 << 0
            NSWindowCollectionBehaviorStationary = 1 << 4
            NSWindowCollectionBehaviorFullScreenAuxiliary = 1 << 8

            # PyObjC bindings — let us call Cocoa methods directly on the NSWindow
            # that backs this Qt widget. Failure to import is non-fatal: we fall
            # back to plain Qt-level topmost (works most of the time).
            try:
                from AppKit import NSApp  # type: ignore[import-not-found]
            except ImportError:
                print("[topmost] PyObjC not available — using Qt-only topmost (may hide behind fullscreen apps)")
                return

            # Walk every NSWindow this process owns and bump its level. We can't
            # rely on `self.winId()` returning the right NSWindow handle on every
            # PySide6 version; iterating is safer and cheap.
            for w in (NSApp.windows() or []):
                try:
                    w.setLevel_(NSStatusWindowLevel)
                    w.setCollectionBehavior_(
                        NSWindowCollectionBehaviorCanJoinAllSpaces
                        | NSWindowCollectionBehaviorStationary
                        | NSWindowCollectionBehaviorFullScreenAuxiliary
                    )
                except Exception:
                    pass
        except Exception as e:
            print(f"[topmost] mac topmost failed: {e}")

    # ---------- math ----------

    def _expand(self) -> float:
        # When expanding to active, use spring-y ease_out_back for a satisfying settle.
        # When collapsing back to idle, use the gentler cubic.
        if self._target_t > 0.5:
            return ease_out_back(self._expand_t, overshoot=1.2)
        return ease_out_cubic(self._expand_t)

    def _hit_zone(self, x: float, y: float) -> str:
        """x/y in window base units (mouse px ÷ scale)."""
        ex = self._expand()
        if ex < 0.5:
            return "body"
        r = self._pill_rect(max(0.0, min(ex, 1.05)))
        if r.left() <= x <= r.left() + 38:
            return "cancel"
        if r.right() - 38 <= x <= r.right():
            return "finish"
        return "body"

    def _zone_at(self, e: QMouseEvent) -> str:
        return self._hit_zone(e.position().x() / self._sc, e.position().y() / self._sc)

    # ---------- input ----------

    def mousePressEvent(self, e: QMouseEvent):
        if e.button() == Qt.LeftButton:
            self._drag_origin = (e.globalPos().x(), e.globalPos().y())
            self._drag_started = False
            self._press_zone = self._zone_at(e)
        elif e.button() == Qt.RightButton:
            self._show_menu(e.globalPos())

    def mouseMoveEvent(self, e: QMouseEvent):
        # Hover zone tracking
        zone = self._zone_at(e)
        self._hover_zone = zone
        self._hover = True
        if not self._target_t and zone == "body" and self._cfg["overlay_idle"] == "pill":
            self._target_opacity = 0.72
        if zone in ("cancel", "finish"):
            self.setCursor(QCursor(Qt.PointingHandCursor))
        else:
            self.setCursor(QCursor(Qt.SizeAllCursor if self._state == "idle" else Qt.ArrowCursor))

        if self._drag_origin is None or not (e.buttons() & Qt.LeftButton):
            return
        dx = e.globalPos().x() - self._drag_origin[0]
        dy = e.globalPos().y() - self._drag_origin[1]
        if not self._drag_started and (abs(dx) > 4 or abs(dy) > 4):
            self._drag_started = True
        if self._drag_started:
            self.move(self.x() + dx, self.y() + dy)
            self._drag_origin = (e.globalPos().x(), e.globalPos().y())

    def mouseReleaseEvent(self, e: QMouseEvent):
        if e.button() != Qt.LeftButton:
            return
        if self._drag_started:
            self._finish_drag()
        else:
            zone = self._press_zone or "body"
            if self._state == "recording" and zone == "cancel":
                emit_event({"type": "cancel"})
            else:
                emit_event({"type": "toggle"})
        self._drag_origin = None
        self._drag_started = False
        self._press_zone = None

    def _finish_drag(self):
        """Pin the pill where it was dropped.

        The screen third the pill landed in decides its alignment, so dropping it near an
        edge or corner makes it grow inward from there instead of opening off-screen."""
        sc = self._sc
        r = self._pill_rect(max(0.0, min(self._expand(), 1.05)))
        ox, oy = self.x(), self.y()
        cx, cy = ox + r.center().x() * sc, oy + r.center().y() * sc
        av = self._nearest_screen(cx, cy).availableGeometry()
        fx = (cx - av.x()) / max(1, av.width())
        fy = (cy - av.y()) / max(1, av.height())
        ax = 0.0 if fx < 1 / 3 else (1.0 if fx > 2 / 3 else 0.5)
        ay = 0.0 if fy < 1 / 3 else (1.0 if fy > 2 / 3 else 0.5)
        # The pinned point is the pill's (ax, ay) point as it sits right now, so re-aligning
        # changes how it grows next time, not where it is.
        self._cfg.update(
            overlay_anchor="custom",
            overlay_px=ox + (r.left() + ax * r.width()) * sc,
            overlay_py=oy + (r.top() + ay * r.height()) * sc,
            overlay_ax=ax, overlay_ay=ay,
        )
        self._relayout()   # clamps into the screen and re-seats the window
        emit_event({
            "type": "moved",
            "px": round(self._ref.x(), 1), "py": round(self._ref.y(), 1),
            "ax": self._ax, "ay": self._ay,
        })

    def enterEvent(self, e):
        self._hover = True
        if self._state == "idle" and self._cfg["overlay_idle"] == "pill":
            self._target_opacity = 0.72

    def leaveEvent(self, e):
        self._hover = False
        self._hover_zone = None
        if self._state == "idle" and self._cfg["overlay_idle"] == "pill":
            self._target_opacity = 0.40
        self.unsetCursor()

    def _show_menu(self, global_pos):
        menu = QMenu()
        menu.setStyleSheet("""
            QMenu { background-color: #0d0d0d; color: #e8e8e8; border: 1px solid #2a2a2a; padding: 4px; }
            QMenu::item { padding: 6px 16px; background: transparent; }
            QMenu::item:selected { background-color: #262626; }
            QMenu::separator { height: 1px; background: #2a2a2a; margin: 4px 0; }
        """)
        menu.addAction("Open window", lambda: emit_event({"type": "show_window"}))
        menu.addAction("Customize overlay…", lambda: emit_event({"type": "show_settings"}))
        menu.addSeparator()
        # The parent turns this into `show_overlay = false`; bring it back in Settings → Overlay.
        menu.addAction("Hide overlay", lambda: emit_event({"type": "hide"}))
        menu.addSeparator()
        menu.addAction("Quit", lambda: emit_event({"type": "quit"}))
        menu.exec(global_pos)

    # ---------- paint ----------

    def paintEvent(self, evt: QPaintEvent):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)
        p.setRenderHint(QPainter.SmoothPixmapTransform, True)
        p.setRenderHint(QPainter.TextAntialiasing, True)
        p.scale(self._sc, self._sc)   # everything below is drawn in base units

        pal = self._pal
        strength = self._cfg["overlay_glow"]

        # Clamp expand value (ease_out_back can briefly exceed 1.0 — that's the spring)
        ex = max(0.0, min(self._expand(), 1.05))
        rect = self._pill_rect(ex)
        pill_w, pill_h = rect.width(), rect.height()
        cx, cy = rect.center().x(), rect.center().y()
        radius = self._radius(pill_h)

        # ---- GLOW: many concentric rounded-rect layers w/ exponentially decaying
        # alpha = smooth gaussian-like falloff to fully transparent. No hard edge,
        # no rectangular cut — the outermost layer fades to ~zero before the
        # window border, so the glow appears to dissolve into the desktop.
        if self._glow > 0.01 and strength > 0.01:
            glow_color = pal.glow_rec if self._state == "recording" else pal.glow_proc
            base_alpha = glow_color.alpha()
            p.setPen(Qt.NoPen)
            for i in range(GLOW_LAYERS):
                t = (i + 1) / GLOW_LAYERS               # 1/N .. 1.0
                # Size grows with eased curve so inner layers bunch up near the pill
                # and outer layers spread out — feels like a soft halo.
                size_curve = t ** 0.85
                ex_x = size_curve * GLOW_EXPAND_X
                ex_y = size_curve * GLOW_EXPAND_Y
                w = pill_w + ex_x * 2
                h = pill_h + ex_y * 2
                r = min(h / 2, radius + ex_y)
                # Alpha falls off as (1-t)^p — higher p = tighter glow near pill
                alpha_falloff = (1.0 - t) ** 2.2
                # Per-layer alpha is intentionally low so the buildup is gradual;
                # multiplied by the animated _glow intensity for fade in/out and by
                # the user's glow strength (1.0 = the classic look).
                a = int(base_alpha * self._glow * strength * alpha_falloff * 0.55)
                if a <= 0:
                    continue
                gc = QColor(glow_color)
                gc.setAlpha(min(255, a))
                p.setBrush(QBrush(gc))
                p.drawRoundedRect(QRectF(cx - w / 2, cy - h / 2, w, h), r, r)

        # Border color per state
        if self._state == "recording":
            border = pal.border_rec
        elif self._state == "processing":
            border = pal.border_proc
        else:
            # subtle hover brightening
            border = pal.border_hover if self._hover else pal.border_idle

        # Pill fill + outline
        bg = pal.bg_active if self._state != "idle" else pal.bg_idle
        p.setBrush(QBrush(bg))
        p.setPen(QPen(border, 1.2))
        p.drawRoundedRect(rect, radius, radius)

        # IDLE: subtle mic centered with cleaner proportions
        if ex < 0.35:
            self._draw_mic(p, cx, cy, scale=1.05)
        else:
            pad = BTN_PAD
            # Cancel (X) on left
            if self._state == "recording":
                cancel_col = pal.rec_hot if self._hover_zone == "cancel" else pal.rec
                self._draw_x(p, rect.left() + pad, cy, color=cancel_col, size=8.5)
            elif self._state == "processing":
                self._draw_x(p, rect.left() + pad, cy, color=pal.dim, size=8.5)

            # Finish (check) or spinner on right
            if self._state == "recording":
                self._draw_check(p, rect.right() - pad, cy, color=pal.ok, size=9.5)
            elif self._state == "processing":
                self._draw_spinner(p, rect.right() - pad, cy, size=10.5, color=pal.proc, phase=self._spin_phase)

            # Center content — waveform has more vertical room now
            if self._state == "recording":
                self._draw_waveform(p, cx, cy, max_h=pill_h - 18)
            elif self._state == "processing":
                p.setPen(QPen(pal.proc))
                p.setFont(self._font)
                p.drawText(rect, Qt.AlignCenter, "processing")

    def _draw_mic(self, p: QPainter, cx: float, cy: float, scale: float = 1.0):
        """Clean Material-style mic: narrow capsule body + U-stand + stem + base.
        Proportions tuned for tall idle pill (no clipping, no compression)."""
        col = self._pal.mic
        # Capsule body — narrow (40% w/h ratio is the readable industry standard)
        body_w = 5.0 * scale
        body_h = 9.0 * scale
        body_top = cy - body_h * 0.65
        body_bottom = cy + body_h * 0.35

        p.setPen(Qt.NoPen)
        p.setBrush(QBrush(col))
        body_rect = QRectF(cx - body_w / 2, body_top, body_w, body_bottom - body_top)
        p.drawRoundedRect(body_rect, body_w / 2, body_w / 2)

        # U-shaped stand below body — drawn as a stroked arc
        pen = QPen(col, 1.4 * scale)
        pen.setCapStyle(Qt.RoundCap)
        p.setPen(pen)
        p.setBrush(Qt.NoBrush)
        stand_w = body_w * 2.4
        stand_h = body_h * 0.9
        stand_top = body_top + body_h * 0.45
        arc_rect = QRectF(cx - stand_w / 2, stand_top, stand_w, stand_h)
        # Bottom half-arc (180° starting at 180° = left side going clockwise to right)
        p.drawArc(arc_rect, 180 * 16, 180 * 16)

        # Vertical stem from arc bottom to base
        arc_bottom = stand_top + stand_h / 2
        stem_top = arc_bottom
        stem_bottom = arc_bottom + body_h * 0.30
        p.drawLine(QPointF(cx, stem_top), QPointF(cx, stem_bottom))

        # Horizontal base
        base_w = body_w * 1.2
        p.drawLine(QPointF(cx - base_w / 2, stem_bottom), QPointF(cx + base_w / 2, stem_bottom))

    def _draw_x(self, p: QPainter, cx: float, cy: float, color: QColor, size: float):
        pen = QPen(color, 1.6)
        pen.setCapStyle(Qt.RoundCap)
        p.setPen(pen)
        p.drawLine(QPointF(cx - size, cy - size), QPointF(cx + size, cy + size))
        p.drawLine(QPointF(cx - size, cy + size), QPointF(cx + size, cy - size))

    def _draw_check(self, p: QPainter, cx: float, cy: float, color: QColor, size: float):
        pen = QPen(color, 1.8)
        pen.setCapStyle(Qt.RoundCap)
        pen.setJoinStyle(Qt.RoundJoin)
        p.setPen(pen)
        path = QPainterPath()
        path.moveTo(cx - size, cy + size * 0.15)
        path.lineTo(cx - size * 0.2, cy + size * 0.85)
        path.lineTo(cx + size, cy - size * 0.85)
        p.drawPath(path)

    def _draw_spinner(self, p: QPainter, cx: float, cy: float, size: float, color: QColor, phase: float):
        pen = QPen(color, 1.8)
        pen.setCapStyle(Qt.RoundCap)
        p.setPen(pen)
        p.setBrush(Qt.NoBrush)
        rect = QRectF(cx - size, cy - size, size * 2, size * 2)
        deg = math.degrees(phase) % 360
        p.drawArc(rect, int(-deg * 16), int(120 * 16))

    def _draw_waveform(self, p: QPainter, cx: float, cy: float, max_h: float):
        """Render the live waveform with edge-dim, energy-brightness, and gentle baseline
        minimum so the shape reads even during silence. Three looks: bars / fine / wave."""
        style = self._cfg["overlay_wave"]
        base = self._pal.rec if self._cfg["overlay_wave_tint"] else self._pal.bars
        bars = self._bars
        n = len(bars)
        if style == "fine":
            bw, gap = FINE_BAR_W, FINE_BAR_GAP
        else:
            bw, gap = BAR_W, BAR_GAP
        total_w = n * bw + (n - 1) * gap
        start_x = cx - total_w / 2
        p.setPen(Qt.NoPen)

        baseline = max(1.8 if style == "fine" else 2.4, max_h * 0.06)   # silence still shows a line
        if style == "wave":
            self._draw_wave_shape(p, cy, start_x, total_w, max_h, base, baseline)
            return

        cap_r = bw / 2
        for i, lv in enumerate(bars):
            # Smooth nonlinear curve — emphasizes loud peaks, dampens jitter floor
            shaped = lv ** 0.85
            h = max(baseline, shaped * max_h)
            x = start_x + i * (bw + gap)
            # Edge fade — bars near the buttons are dimmer
            dist_from_center = abs(i - (n - 1) / 2) / ((n - 1) / 2)
            edge_dim = 1.0 - dist_from_center * 0.30
            brightness = 0.62 + 0.38 * shaped
            color = QColor(base)
            color.setAlpha(int(min(255, 255 * brightness * edge_dim)))
            p.setBrush(QBrush(color))
            p.drawRoundedRect(QRectF(x, cy - h / 2, bw, h), cap_r, cap_r)

    def _draw_wave_shape(self, p: QPainter, cy: float, start_x: float, total_w: float,
                         max_h: float, base: QColor, baseline: float):
        """One smooth mirrored silhouette instead of separate bars, faded out at both ends."""
        bars = self._bars
        n = len(bars)
        step = total_w / n
        top, bot = [], []
        for i, lv in enumerate(bars):
            # Ease both ends down to the baseline so the silhouette closes to a point instead of
            # ending in a vertical cut (the newest sample, on the right, is often the loudest).
            edge = min(i + 0.5, n - i - 0.5) / (n * 0.22)
            edge = 1.0 if edge >= 1.0 else edge * edge * (3 - 2 * edge)
            h = baseline + (max(baseline, (lv ** 0.85) * max_h) - baseline) * edge
            x = start_x + (i + 0.5) * step
            top.append(QPointF(x, cy - h / 2))
            bot.append(QPointF(x, cy + h / 2))

        def smooth(path: QPainterPath, pts: list[QPointF]):
            # Quadratic curve through the midpoints — rounds the corners between samples.
            for i in range(1, len(pts) - 1):
                mid = QPointF((pts[i].x() + pts[i + 1].x()) / 2, (pts[i].y() + pts[i + 1].y()) / 2)
                path.quadTo(pts[i], mid)
            path.lineTo(pts[-1])

        path = QPainterPath()
        path.moveTo(top[0])
        smooth(path, top)
        path.lineTo(bot[-1])
        smooth(path, bot[::-1])
        path.closeSubpath()

        grad = QLinearGradient(start_x, 0, start_x + total_w, 0)
        edge = QColor(base)
        edge.setAlpha(30)
        core = QColor(base)
        core.setAlpha(255)
        grad.setColorAt(0.0, edge)
        grad.setColorAt(0.28, core)
        grad.setColorAt(0.72, core)
        grad.setColorAt(1.0, edge)
        p.setBrush(QBrush(grad))
        p.drawPath(path)

    # ---------- tick ----------

    def _synth_levels(self) -> list[float]:
        """Speech-like rolling levels for the Settings preview (same 32-slot shape the recorder sends)."""
        t = time.monotonic()
        out = []
        for k in range(32):
            tt = t - (31 - k) * 0.05          # oldest on the left, like the real scope
            env = max(0.0, math.sin(tt * 1.7)) ** 1.4 * (0.55 + 0.45 * math.sin(tt * 9.3 + 1.7))
            out.append(min(1.0, 0.05 + 0.95 * env))
        return out

    def _tick(self):
        # expand ease — overshoot allowed for spring feel
        diff = self._target_t - self._expand_t
        if abs(diff) > 0.001:
            self._expand_t += diff * 0.20
            # Spring overshoot: allow up to 1.08 briefly when expanding to active
            self._expand_t = max(0.0, min(1.08, self._expand_t))
            if abs(self._expand_t - self._target_t) < 0.003:
                self._expand_t = self._target_t

        # Glow intensity ease
        gdiff = self._glow_target - self._glow
        if abs(gdiff) > 0.005:
            self._glow += gdiff * 0.18

        # Idle breathing: subtle alpha modulation when state is idle
        self._breath_phase += 0.022
        if self._state == "idle":
            if self._cfg["overlay_idle"] == "hidden":
                self._target_opacity = 0.0
            else:
                breath = 0.5 + 0.5 * math.sin(self._breath_phase)
                base = 0.72 if self._hover else 0.40
                # Modulate by ±0.06 around base for a slow heartbeat
                self._target_opacity = base + 0.06 * (breath - 0.5)

        # opacity ease
        odiff = self._target_opacity - self._opacity
        if abs(odiff) > 0.003:
            self._opacity += odiff * 0.18
            self.setWindowOpacity(self._opacity)

        # "Hidden when idle": once the fade-out finishes, take the window off screen.
        if (self._state == "idle" and self._cfg["overlay_idle"] == "hidden"
                and self._opacity < 0.03 and self.isVisible()):
            self.hide()

        # spinner
        if self._state == "processing":
            self._spin_phase += 0.30

        # Settings preview has no microphone behind it — fake a voice.
        if self._preview == "recording":
            self._raw_levels = self._synth_levels()

        # waveform — resample raw levels to the bar count with smooth lerp
        if self._state == "recording" and self._raw_levels:
            targets = resample(self._raw_levels, len(self._bars))
            for i, target in enumerate(targets):
                cur = self._bars[i]
                # Asymmetric easing: rise fast, fall slower → more energetic feel
                rate = 0.55 if target > cur else 0.18
                self._bars[i] = cur + (target - cur) * rate
        else:
            for i in range(len(self._bars)):
                self._bars[i] *= 0.86

        if self.isVisible():
            self.update()


def main():
    # CLI args (optional, v1–v8 parents): initial_x initial_y — only used until the first config arrives.
    try:
        x = int(sys.argv[1]) if len(sys.argv) > 2 else None
        y = int(sys.argv[2]) if len(sys.argv) > 2 else None
    except ValueError:
        x = y = None
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    overlay = Overlay(x, y)
    overlay.report_screens()
    app.screenAdded.connect(lambda *_: overlay.on_screens_changed())
    app.screenRemoved.connect(lambda *_: overlay.on_screens_changed())
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
