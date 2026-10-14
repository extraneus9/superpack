"""
No More Writing GUI — dark window with status pill, record button, scrollable history.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import traceback
from datetime import datetime
from pathlib import Path

import customtkinter as ctk
import numpy as np
import pyperclip

from engine import (
    CFG, DEFAULT_EXPRESSIONS, Flow, State, TranscriptEntry, register_hotkey, save_config,
    list_input_devices, resolve_input_device, measure_input_clip, condition_audio, input_boost, BOOST_RANGE,
    SPEED_PRESETS, SPEED_PRESET_DESCRIPTIONS, apply_speed_preset, current_speed_level,
)
from version import VERSION, VERSION_NAME
from updater import UpdateInfo, check_async as check_updates_async
from platform_hooks import IS_MAC
import overlay_config as oc
import queue
import webbrowser

from paths import ROOT, USER_DIR, PACKED
# dictation history is private: next to the code from source, in %APPDATA%\NoMoreWriting when installed
HISTORY_PATH = USER_DIR / "history.jsonl"
ICON_PATH = ROOT / "assets" / "icon.ico"
OVERLAY_SCRIPT = ROOT / "overlay_qt.py"

# Palette — dark cinematic
BG = "#0a0a0a"
PANEL = "#141414"
PANEL_HI = "#1c1c1c"
BORDER = "#262626"
BORDER_HI = "#3a3a3a"
TEXT = "#e8e8e8"
TEXT_DIM = "#8a8a8a"
TEXT_FAINT = "#555"
ACCENT_REC = "#e63946"  # red, recording
ACCENT_PROC = "#f4a261"  # amber, processing
ACCENT_IDLE = "#444"
ACCENT_OK = "#7FE07A"  # green, finished


# --- Color animation helpers ---

def _hex_to_rgb(c: str) -> tuple[int, int, int]:
    c = c.lstrip("#")
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)


def _rgb_to_hex(r: int, g: int, b: int) -> str:
    return f"#{max(0,min(255,r)):02x}{max(0,min(255,g)):02x}{max(0,min(255,b)):02x}"


def lerp_hex(a: str, b: str, t: float) -> str:
    ar, ag, ab = _hex_to_rgb(a)
    br, bg, bb = _hex_to_rgb(b)
    return _rgb_to_hex(
        int(ar + (br - ar) * t),
        int(ag + (bg - ag) * t),
        int(ab + (bb - ab) * t),
    )


# ---------- History persistence ----------

# Rows rendered in the main window. Each row is ~4 CustomTkinter canvases, and
# restore-from-minimize repaints all of them: 30 rows ~0.2 s, 200 ~1.2 s, 350 ~4.7 s
# (measured). The full history stays on disk; only the UI list is capped.
MAX_UI_ROWS = 25


def load_history(limit: int = 200) -> list[dict]:
    if not HISTORY_PATH.exists():
        return []
    rows: list[dict] = []
    with open(HISTORY_PATH, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                continue
    return rows[-limit:]


def append_history(entry: TranscriptEntry):
    row = {
        "timestamp": entry.timestamp,
        "raw": entry.raw,
        "cleaned": entry.cleaned,
        "whisper_ms": entry.whisper_ms,
        "ollama_ms": entry.ollama_ms,
        "total_ms": entry.total_ms,
        "pasted": entry.pasted,
        "peak_db": entry.peak_db,   # loudest moment of the raw recording, dBFS (0 = full scale)
        "gain_db": entry.gain_db,   # what input boost / auto level added before transcribing
    }
    with open(HISTORY_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def prune_history(retention_days: int | None = None, max_entries: int | None = None) -> tuple[int, int]:
    """Drop entries older than retention_days AND/OR keep only the most-recent max_entries.
    Returns (kept_count, dropped_count). Atomic rewrite — never corrupts on crash."""
    if not HISTORY_PATH.exists():
        return 0, 0
    # Read everything
    all_rows: list[dict] = []
    with open(HISTORY_PATH, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                all_rows.append(json.loads(line))
            except Exception:
                continue
    before = len(all_rows)

    # Time-based filter
    if retention_days and retention_days > 0:
        cutoff = time.time() - retention_days * 86400
        all_rows = [r for r in all_rows if r.get("timestamp", 0) >= cutoff]

    # Count cap — keep the most recent max_entries
    if max_entries and max_entries > 0 and len(all_rows) > max_entries:
        all_rows = all_rows[-max_entries:]

    after = len(all_rows)
    dropped = before - after
    if dropped <= 0:
        return after, 0

    # Atomic rewrite via temp file
    tmp = HISTORY_PATH.with_suffix(".jsonl.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        for r in all_rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    tmp.replace(HISTORY_PATH)
    return after, dropped


def get_history_stats() -> dict:
    """Return file size, entry count, oldest/newest timestamps."""
    if not HISTORY_PATH.exists():
        return {"size_bytes": 0, "entries": 0, "oldest": None, "newest": None}
    size = HISTORY_PATH.stat().st_size
    rows = load_history(limit=10**9)
    if not rows:
        return {"size_bytes": size, "entries": 0, "oldest": None, "newest": None}
    return {
        "size_bytes": size,
        "entries": len(rows),
        "oldest": rows[0].get("timestamp"),
        "newest": rows[-1].get("timestamp"),
    }


# ---------- Main window ----------

class App(ctk.CTk):
    def __init__(self):
        super().__init__()
        ctk.set_appearance_mode("dark")
        ctk.set_default_color_theme("dark-blue")

        self.title("No More Writing")
        self.geometry("520x800")
        self.minsize(420, 640)
        self.configure(fg_color=BG)
        if ICON_PATH.exists():
            try:
                self.iconbitmap(default=str(ICON_PATH))
            except Exception:
                pass

        # Set Windows AppUserModelID so the taskbar groups properly with the .lnk shortcut.
        # No-op on macOS / Linux (handled inside the helper).
        from platform_hooks import set_app_user_model_id
        set_app_user_model_id("alva.nomorewriting.1")

        # Auto-prune on launch — drops entries older than retention or beyond max count.
        try:
            kept, dropped = prune_history(
                retention_days=CFG.get("history_retention_days", 90),
                max_entries=CFG.get("history_max_entries", 5000),
            )
            if dropped:
                print(f"[history] auto-prune: kept {kept}, dropped {dropped} old entries")
        except Exception as e:
            print(f"[history] prune failed: {e}")

        self._build_ui()
        self._load_history_to_ui()

        # First-launch bootstrap on macOS: install Ollama + pull the cleanup
        # model if missing, so the user gets the same one-click experience as
        # the Windows Inno Setup installer. Blocks UI until the dialog closes;
        # the user can hit Skip to defer setup. No-op on Windows / Linux.
        if IS_MAC:
            self._run_mac_bootstrap_if_needed()

        # Engine in a worker thread — heavy loads block the UI otherwise.
        # Started via after() so the thread only runs once mainloop() is live:
        # an after() call from the worker before mainloop starts raises
        # "RuntimeError: main thread is not in main loop" and kills engine init.
        self.flow: Flow | None = None
        self.engine_ready = False
        self.after(0, lambda: threading.Thread(target=self._init_engine, daemon=True).start())

        # Spawn PySide6 overlay subprocess
        self.overlay_proc: subprocess.Popen | None = None
        self.overlay_screens: list[dict] = []   # monitors, as reported by the overlay process
        self._overlay_state = "idle"            # last state sent, replayed if the overlay is respawned
        self._settings_win: "SettingsWindow | None" = None
        self._level_pump_running = False
        if CFG.get("show_overlay", True):
            self._spawn_overlay()

        # Update banner widget (hidden until an update is detected)
        self._update_banner: ctk.CTkFrame | None = None
        # Schedule update check shortly after launch so it doesn't slow boot
        if not PACKED:  # a superpack install is updated by the pack, never by the author's own release feed
            self.after(2500, lambda: check_updates_async(self._on_update_found))

        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # ---------- UI build ----------

    def _build_ui(self):
        # Header
        header = ctk.CTkFrame(self, fg_color="transparent", height=64)
        header.pack(fill="x", padx=24, pady=(20, 0))
        header.pack_propagate(False)

        title_wrap = ctk.CTkFrame(header, fg_color="transparent")
        title_wrap.pack(side="left")

        title = ctk.CTkLabel(
            title_wrap,
            text="No More Writing",
            font=ctk.CTkFont(family="Inter", size=20, weight="bold"),
            text_color=TEXT,
        )
        title.pack(side="left")

        version_badge = ctk.CTkLabel(
            title_wrap,
            text=f"  {VERSION}",
            font=ctk.CTkFont(family="Inter", size=10, weight="bold"),
            text_color=TEXT_FAINT,
        )
        version_badge.pack(side="left", pady=(6, 0))

        self.engine_label = ctk.CTkLabel(
            header,
            text="loading models…",
            font=ctk.CTkFont(family="Inter", size=11),
            text_color=TEXT_FAINT,
        )
        self.engine_label.pack(side="right", pady=(6, 0))

        settings_btn = ctk.CTkButton(
            header,
            text="settings",
            width=70, height=24,
            fg_color="transparent",
            hover_color=PANEL,
            text_color=TEXT_DIM,
            font=ctk.CTkFont(family="Inter", size=11),
            command=self._open_settings,
        )
        settings_btn.pack(side="right", padx=(0, 10), pady=(6, 0))

        # Status pill
        status_frame = ctk.CTkFrame(self, fg_color="transparent")
        status_frame.pack(fill="x", padx=24, pady=(28, 0))

        self.status_dot = ctk.CTkLabel(
            status_frame,
            text="●",
            font=ctk.CTkFont(size=22),
            text_color=ACCENT_IDLE,
        )
        self.status_dot.pack(side="left", padx=(0, 10))

        self.status_text = ctk.CTkLabel(
            status_frame,
            text="IDLE",
            font=ctk.CTkFont(family="Inter", size=14, weight="bold"),
            text_color=TEXT,
        )
        self.status_text.pack(side="left")

        # Big record button
        button_frame = ctk.CTkFrame(self, fg_color="transparent", height=180)
        button_frame.pack(fill="x", pady=(32, 0))
        button_frame.pack_propagate(False)

        self.record_btn = ctk.CTkButton(
            button_frame,
            text="●",
            font=ctk.CTkFont(size=48),
            width=140,
            height=140,
            corner_radius=70,
            fg_color=PANEL_HI,
            hover_color=BORDER,
            text_color=ACCENT_IDLE,
            border_width=2,
            border_color=BORDER,
            command=self._on_record_click,
        )
        self.record_btn.pack(anchor="center")

        # Hotkey hint
        hint = ctk.CTkLabel(
            self,
            text=f"or press   {CFG['hotkey'].upper().replace('+', '  +  ')}",
            font=ctk.CTkFont(family="Inter", size=11),
            text_color=TEXT_DIM,
        )
        hint.pack(pady=(12, 0))

        # Speed / accuracy selector — lives on the main window so it's one click
        # away. Each level maps to a preset in engine.SPEED_PRESETS.
        speed_wrap = ctk.CTkFrame(self, fg_color="transparent")
        speed_wrap.pack(fill="x", padx=24, pady=(16, 0))
        speed_head = ctk.CTkFrame(speed_wrap, fg_color="transparent")
        speed_head.pack(fill="x")
        ctk.CTkLabel(
            speed_head, text="SPEED",
            font=ctk.CTkFont(family="Inter", size=10, weight="bold"),
            text_color=TEXT_FAINT,
        ).pack(side="left")
        self.speed_status = ctk.CTkLabel(
            speed_head, text="",
            font=ctk.CTkFont(family="Inter", size=10), text_color=TEXT_FAINT,
        )
        self.speed_status.pack(side="right")
        self._speed_labels = {lvl: f"{lvl}  {SPEED_PRESETS[lvl]['label']}" for lvl in sorted(SPEED_PRESETS)}
        self.speed_seg = ctk.CTkSegmentedButton(
            speed_wrap,
            values=list(self._speed_labels.values()),
            font=ctk.CTkFont(family="Inter", size=11),
            fg_color=PANEL, selected_color=BORDER_HI, selected_hover_color=TEXT_FAINT,
            unselected_color=PANEL, unselected_hover_color=PANEL_HI,
            text_color=TEXT, text_color_disabled=TEXT_FAINT,
            corner_radius=8, border_width=2,
            command=self._on_speed_pick,
        )
        self.speed_seg.pack(fill="x", pady=(6, 0))
        self.speed_desc = ctk.CTkLabel(
            speed_wrap, text="",
            font=ctk.CTkFont(family="Inter", size=10), text_color=TEXT_DIM,
            wraplength=470, justify="center",
        )
        self.speed_desc.pack(fill="x", pady=(6, 0))
        self._sync_speed_ui()

        # Latency line (updates after each transcript)
        self.latency_label = ctk.CTkLabel(
            self,
            text="",
            font=ctk.CTkFont(family="Inter", size=10),
            text_color=TEXT_FAINT,
        )
        self.latency_label.pack(pady=(4, 0))

        # History header
        history_header = ctk.CTkFrame(self, fg_color="transparent")
        history_header.pack(fill="x", padx=24, pady=(28, 6))

        ctk.CTkLabel(
            history_header,
            text="HISTORY",
            font=ctk.CTkFont(family="Inter", size=10, weight="bold"),
            text_color=TEXT_DIM,
        ).pack(side="left")

        clear_btn = ctk.CTkButton(
            history_header,
            text="clear",
            width=44,
            height=22,
            fg_color="transparent",
            hover_color=PANEL,
            text_color=TEXT_FAINT,
            font=ctk.CTkFont(family="Inter", size=10),
            command=self._clear_history,
        )
        clear_btn.pack(side="right")

        # History list (scrollable)
        self.history_list = ctk.CTkScrollableFrame(
            self,
            fg_color=PANEL,
            corner_radius=10,
            scrollbar_button_color=BORDER,
            scrollbar_button_hover_color=TEXT_FAINT,
        )
        self.history_list.pack(fill="both", expand=True, padx=24, pady=(0, 20))

        self.history_rows: list[ctk.CTkFrame] = []

    def _add_history_row(self, row: dict, prepend: bool = True):
        ts = datetime.fromtimestamp(row["timestamp"]).strftime("%H:%M")
        cleaned = row["cleaned"] or row["raw"]
        total_ms = row.get("total_ms", 0)

        # Start at background color (invisible), fade-in to PANEL_HI
        item = ctk.CTkFrame(self.history_list, fg_color=BG, corner_radius=8)
        if prepend and self.history_rows:
            # Pack straight into the top slot — re-packing every row per dictation
            # cost ~1.4 s at 200 rows.
            item.pack(fill="x", padx=4, pady=4, before=self.history_rows[0])
        else:
            item.pack(fill="x", padx=4, pady=4)
        if prepend:
            # animate fade-in from BG → PANEL_HI
            self.after(20, lambda: self._tween_color(item, "fg_color", PANEL_HI, 280, steps=14))

        top = ctk.CTkFrame(item, fg_color="transparent")
        top.pack(fill="x", padx=10, pady=(8, 2))

        ctk.CTkLabel(
            top,
            text=ts,
            font=ctk.CTkFont(family="Inter", size=10, weight="bold"),
            text_color=TEXT_DIM,
        ).pack(side="left")

        ctk.CTkLabel(
            top,
            text=f"{total_ms}ms",
            font=ctk.CTkFont(family="Inter", size=10),
            text_color=TEXT_FAINT,
        ).pack(side="right")

        text_label = ctk.CTkLabel(
            item,
            text=cleaned,
            font=ctk.CTkFont(family="Inter", size=12),
            text_color=TEXT,
            wraplength=420,
            justify="left",
            anchor="w",
        )
        text_label.pack(fill="x", padx=10, pady=(0, 8))

        # Click any part = copy
        def copy_handler(_evt=None, t=cleaned):
            pyperclip.copy(t)
            self._flash(item)

        # Subtle hover state
        def on_enter(_evt=None):
            try:
                if item.winfo_exists():
                    item.configure(fg_color=BORDER)
            except Exception:
                pass

        def on_leave(_evt=None):
            try:
                if item.winfo_exists():
                    item.configure(fg_color=PANEL_HI)
            except Exception:
                pass

        for widget in (item, top, text_label):
            widget.bind("<Button-1>", copy_handler)
            widget.bind("<Enter>", on_enter)
            widget.bind("<Leave>", on_leave)
            widget.configure(cursor="hand2") if hasattr(widget, "configure") else None

        if prepend:
            self.history_rows.insert(0, item)
            while len(self.history_rows) > MAX_UI_ROWS:
                self.history_rows.pop().destroy()
        else:
            self.history_rows.append(item)

    def _flash(self, item: ctk.CTkFrame):
        item.configure(fg_color=ACCENT_OK)
        self.after(180, lambda: item.configure(fg_color=PANEL_HI))

    def _load_history_to_ui(self):
        # newest first — append in reverse-chronological order, one pack per row
        for row in reversed(load_history(limit=MAX_UI_ROWS)):
            self._add_history_row(row, prepend=False)

    def _clear_history(self):
        for w in self.history_rows:
            w.destroy()
        self.history_rows = []
        if HISTORY_PATH.exists():
            HISTORY_PATH.unlink()

    # ---------- macOS first-launch bootstrap ----------

    def _run_mac_bootstrap_if_needed(self):
        """Show the MacBootstrapDialog if Ollama / the cleanup model is missing.

        Blocks on the dialog's grab_set() until the user finishes setup or hits
        Skip. Engine init waits for this to return before instantiating Flow,
        so the Cleaner inside Flow finds a working Ollama by the time it tries
        to connect."""
        try:
            from bootstrap_mac import setup_needed
            needs, reason = setup_needed()
        except Exception as e:
            print(f"[bootstrap] check failed, skipping setup: {e}")
            return

        if not needs:
            return

        dlg = MacBootstrapDialog(self, reason)
        # wait_window blocks until the dialog is destroyed. Both Skip and Done
        # call self.destroy() so this returns cleanly in either path.
        self.wait_window(dlg)

    # ---------- Engine init (runs in worker thread) ----------

    def _init_engine(self):
        def log(msg: str):
            print(msg)
            try:
                self.after(0, lambda m=msg: self.engine_label.configure(text=m.split("] ")[-1][:48]))
            except RuntimeError:
                pass  # mainloop not running (startup race or window closing)

        try:
            self.flow = Flow(
                on_state=self._on_state_change,
                on_transcript=self._on_transcript,
                on_log=log,
            )
            register_hotkey(CFG["hotkey"], self.flow.toggle)
            self.engine_ready = True
            self.after(0, lambda: self.engine_label.configure(text="ready", text_color=ACCENT_OK))
        except Exception as e:
            # Bind the message now — `e` is cleared when the except block exits,
            # so a bare closure raises NameError inside the Tk callback and the
            # label silently stays on "loading models…".
            tb = traceback.format_exc()
            print(tb, file=sys.stderr, flush=True)
            try:
                (USER_DIR / "engine-error.log").write_text(tb, encoding="utf-8")
            except OSError:
                pass
            msg = f"error: {e}"
            try:
                self.after(0, lambda m=msg: self.engine_label.configure(text=m[:120], text_color=ACCENT_REC))
            except RuntimeError:
                pass  # mainloop not running (startup race or window closing)

    # ---------- Callbacks from engine (worker threads → marshal to UI) ----------

    def _on_state_change(self, state: str):
        self.after(0, lambda: self._render_state(state))

    def _render_state(self, state: str):
        # Pick the target colors per state and tween (no more hard snap).
        if state == State.RECORDING:
            target_dot = ACCENT_REC
            target_label = "RECORDING"
            target_border = ACCENT_REC
        elif state == State.PROCESSING:
            target_dot = ACCENT_PROC
            target_label = "PROCESSING"
            target_border = ACCENT_PROC
        else:
            target_dot = ACCENT_IDLE
            target_label = "IDLE"
            target_border = BORDER

        self.status_text.configure(text=target_label)
        self._tween_color(self.status_dot, "text_color", target_dot, 220)
        self._tween_color(self.record_btn, "text_color", target_dot, 220)
        self._tween_color(self.record_btn, "border_color", target_border, 220)

        self._overlay_state = state
        self._send_overlay({"type": "state", "value": state})
        if state == State.RECORDING:
            self._level_pump_running = True
            self.after(40, self._pump_levels)
        else:
            self._level_pump_running = False

    def _tween_color(self, widget, option: str, target_hex: str, duration_ms: int = 200, steps: int = 12):
        """Animate a CTk widget's color option (text_color, border_color, fg_color) to target.
        Falls back to direct set if the current value isn't a parseable hex."""
        def _is_hex6(s):
            if not isinstance(s, str) or not s.startswith("#"):
                return False
            body = s.lstrip("#")
            if len(body) != 6:
                return False
            try:
                int(body, 16)
                return True
            except ValueError:
                return False

        try:
            current = widget.cget(option)
            # CTk sometimes returns ("dark", "light") tuples for themed colors
            if isinstance(current, (tuple, list)):
                current = current[0] if current else target_hex
        except Exception:
            current = None

        if not _is_hex6(current) or not _is_hex6(target_hex):
            try:
                widget.configure(**{option: target_hex})
            except Exception:
                pass
            return

        step_ms = max(8, duration_ms // steps)

        def _step(i):
            try:
                if not widget.winfo_exists():
                    return
            except Exception:
                return
            t = (i + 1) / steps
            t = 1 - (1 - t) ** 3  # ease-out cubic
            try:
                color = lerp_hex(current, target_hex, t)
                widget.configure(**{option: color})
            except Exception:
                return
            if i + 1 < steps:
                self.after(step_ms, lambda: _step(i + 1))

        _step(0)

    def _on_transcript(self, entry: TranscriptEntry):
        append_history(entry)
        row = {
            "timestamp": entry.timestamp,
            "raw": entry.raw,
            "cleaned": entry.cleaned,
            "total_ms": entry.total_ms,
        }
        self.after(0, lambda: self._add_history_row(row, prepend=True))
        self.after(0, lambda: self.latency_label.configure(
            text=f"whisper {entry.whisper_ms}ms  ·  ollama {entry.ollama_ms}ms  ·  total {entry.total_ms}ms"
        ))

    # ---------- User actions ----------

    def _on_record_click(self):
        if not self.engine_ready or self.flow is None:
            return
        threading.Thread(target=self.flow.toggle, daemon=True).start()

    def _on_cancel_click(self):
        if not self.engine_ready or self.flow is None:
            return
        threading.Thread(target=self.flow.cancel, daemon=True).start()

    # ---------- Overlay subprocess ----------

    def _spawn_overlay(self):
        from platform_hooks import subprocess_creationflags
        creationflags = subprocess_creationflags()

        # Build subprocess command. When frozen (PyInstaller .exe), re-launch self with --overlay flag.
        # When running from source, re-launch python on this same script with the flag.
        # Look, size and position are NOT passed here — they travel as a `config` message
        # (below), so the overlay can be restyled live without a restart.
        if getattr(sys, "frozen", False):
            cmd = [sys.executable, "--overlay"]
        else:
            cmd = [sys.executable, str(Path(__file__).resolve()), "--overlay"]

        try:
            self.overlay_proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=1,
                text=True,
                encoding="utf-8",
                creationflags=creationflags,
            )
            threading.Thread(target=self._read_overlay_stdout, daemon=True).start()
        except Exception as e:
            print(f"[overlay] spawn failed: {e}")
            self.overlay_proc = None
            return
        # The overlay waits for this before it shows itself, so it never flashes in the wrong place.
        # A process we just started is meant to be seen, whatever CFG says right now (Settings
        # may be previewing "Show" before it is saved).
        self.push_overlay_config({**oc.resolve(CFG), "show_overlay": True})
        if self._overlay_state != "idle":
            self._send_overlay({"type": "state", "value": self._overlay_state})

    def push_overlay_config(self, settings: dict | None = None):
        """Send the overlay its look/size/position. `settings` defaults to what's saved."""
        self._send_overlay({"type": "config", "settings": settings if settings is not None else oc.resolve(CFG)})

    def set_overlay_enabled(self, enabled: bool):
        """Start or stop the overlay process to match `enabled` — no app restart needed."""
        alive = self.overlay_proc is not None and self.overlay_proc.poll() is None
        if enabled and not alive:
            self._spawn_overlay()
        elif not enabled and alive:
            proc = self.overlay_proc
            self._send_overlay({"type": "quit"})
            self.overlay_proc = None

            def _reap():
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()

            threading.Thread(target=_reap, daemon=True).start()

    def _send_overlay(self, msg: dict):
        if self.overlay_proc is None or self.overlay_proc.poll() is not None:
            return
        try:
            self.overlay_proc.stdin.write(json.dumps(msg) + "\n")
            self.overlay_proc.stdin.flush()
        except Exception:
            pass

    def _read_overlay_stdout(self):
        proc = self.overlay_proc
        if proc is None:
            return
        try:
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                self.after(0, lambda m=msg: self._handle_overlay_msg(m))
        except Exception:
            pass

    def _handle_overlay_msg(self, msg: dict):
        t = msg.get("type")
        if t == "toggle":
            self._on_record_click()
        elif t == "cancel":
            self._on_cancel_click()
        elif t == "show_window":
            self._show_window()
        elif t == "quit":
            self._on_close()
        elif t == "moved":
            # Dragged: remember the pin + which way the pill grows from it (see overlay_config).
            CFG["overlay_anchor"] = "custom"
            CFG["overlay_px"] = msg.get("px")
            CFG["overlay_py"] = msg.get("py")
            CFG["overlay_ax"] = msg.get("ax", 0.5)
            CFG["overlay_ay"] = msg.get("ay", 0.5)
            CFG.pop("overlay_x", None)   # v1–v8 window position, superseded
            CFG.pop("overlay_y", None)
            save_config()
            win = self._settings_win_alive()
            if win is not None:
                win.on_overlay_moved()
        elif t == "screens":
            self.overlay_screens = msg.get("list") or []
            win = self._settings_win_alive()
            if win is not None:
                win.refresh_monitors()
        elif t == "show_settings":
            self._show_window()
            self._open_settings("Overlay")
        elif t == "hide":
            # Right-click → Hide overlay. Same as unticking "Show the floating overlay".
            CFG["show_overlay"] = False
            save_config()
            self.set_overlay_enabled(False)
            win = self._settings_win_alive()
            if win is not None:
                win.on_overlay_hidden()

    # ---------- Update banner ----------

    def _on_update_found(self, info: UpdateInfo):
        # Marshal to the Tk thread
        self.after(0, lambda i=info: self._show_update_banner(i))

    def _show_update_banner(self, info: UpdateInfo):
        if self._update_banner is not None:
            return
        banner = ctk.CTkFrame(self, fg_color="#1f2d1c", corner_radius=10, border_color=ACCENT_OK, border_width=1)
        banner.pack(fill="x", padx=24, pady=(0, 12))

        left = ctk.CTkFrame(banner, fg_color="transparent")
        left.pack(side="left", padx=14, pady=10, fill="x", expand=True)

        ctk.CTkLabel(
            left, text=f"Update available — {info.latest}",
            font=ctk.CTkFont(family="Inter", size=12, weight="bold"),
            text_color=ACCENT_OK,
        ).pack(anchor="w")
        ctk.CTkLabel(
            left, text=f"You are on {info.current}. Click 'Download' to grab the new installer.",
            font=ctk.CTkFont(family="Inter", size=10),
            text_color=TEXT_DIM,
        ).pack(anchor="w", pady=(2, 0))

        right = ctk.CTkFrame(banner, fg_color="transparent")
        right.pack(side="right", padx=10, pady=8)

        def _dismiss():
            banner.destroy()
            self._update_banner = None

        def _download():
            target = info.download_url or info.html_url
            if target:
                webbrowser.open(target)
            _dismiss()

        ctk.CTkButton(
            right, text="Download", width=92, height=30,
            fg_color=ACCENT_OK, hover_color="#6bcc6b",
            text_color="#0a0a0a",
            font=ctk.CTkFont(family="Inter", size=11, weight="bold"),
            command=_download,
        ).pack(side="right", padx=(6, 0))

        ctk.CTkButton(
            right, text="Later", width=60, height=30,
            fg_color="transparent", hover_color="#0e1d0c",
            text_color=TEXT_DIM,
            command=_dismiss,
        ).pack(side="right")

        self._update_banner = banner

    def _pump_levels(self):
        if not self._level_pump_running:
            return
        if self.flow is not None:
            self._send_overlay({"type": "levels", "values": list(self.flow.recorder.levels)})
        self.after(40, self._pump_levels)

    def _settings_win_alive(self) -> "SettingsWindow | None":
        w = self._settings_win
        try:
            return w if (w is not None and w.winfo_exists()) else None
        except Exception:
            return None

    def _open_settings(self, tab: str | None = None):
        existing = self._settings_win_alive()
        if existing is not None:   # already open (e.g. via the overlay's right-click menu) — just surface it
            existing.lift()
            existing.focus_force()
            if tab:
                existing.tabs.set(tab)
            return
        win = SettingsWindow(self, start_tab=tab or "Audio")
        self._settings_win = win
        # Settings can change cleanup keys underneath the preset; re-sync on close.
        win.bind("<Destroy>", lambda e: self.after(50, self._sync_speed_ui) if e.widget is win else None)

    # ---------- Speed selector ----------

    def _sync_speed_ui(self):
        lvl = current_speed_level()
        if lvl is None:
            self.speed_seg.set("")
            self.speed_desc.configure(text="custom (hand-edited config) — pick a level to apply a preset")
            return
        self.speed_seg.set(self._speed_labels[lvl])
        self.speed_desc.configure(text=SPEED_PRESET_DESCRIPTIONS[lvl])

    def _on_speed_pick(self, value: str):
        lvl = next((l for l, s in self._speed_labels.items() if s == value), None)
        if lvl is None:
            return
        model_before = CFG.get("whisper_model")
        apply_speed_preset(lvl)
        save_config()
        self.speed_desc.configure(text=SPEED_PRESET_DESCRIPTIONS[lvl])
        if self.flow is None:
            self.speed_status.configure(text="applies when engine is ready", text_color=TEXT_FAINT)
            return
        if CFG.get("whisper_model") != model_before:
            self.speed_status.configure(text="switching model…", text_color=ACCENT_PROC)
            self.speed_seg.configure(state="disabled")
            def _done():
                self.speed_seg.configure(state="normal")
                self.speed_status.configure(text="ready", text_color=ACCENT_OK)
                self.after(2500, lambda: self.speed_status.configure(text=""))
            self.flow.reload_models(on_done=lambda: self.after(0, _done))
        else:
            self.flow.reload_models()
            self.speed_status.configure(text="applied", text_color=ACCENT_OK)
            self.after(2000, lambda: self.speed_status.configure(text=""))

    def _show_window(self):
        self.deiconify()
        self.lift()
        self.focus_force()

    def _on_close(self):
        try:
            if self.overlay_proc is not None and self.overlay_proc.poll() is None:
                self._send_overlay({"type": "quit"})
                try:
                    self.overlay_proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.overlay_proc.kill()
        except Exception:
            pass
        self.destroy()


LANGUAGE_OPTIONS = [
    ("Auto-detect (any)",                  []),
    ("Spanish only",                       ["es"]),
    ("English only",                       ["en"]),
    ("Spanish + English (auto)",           ["es", "en"]),
    ("Spanish + English + Portuguese",     ["es", "en", "pt"]),
    ("French + English",                   ["fr", "en"]),
]


# ---------- macOS first-launch setup dialog ----------

class MacBootstrapDialog(ctk.CTkToplevel):
    """Mac equivalent of the Windows Inno Setup bootstrap.

    Shows up only when ``bootstrap_mac.setup_needed()`` says we're missing
    Ollama or the cleanup model. Walks the user through the install via the
    native admin-password sheet (no Terminal). Blocks the main window via
    ``grab_set`` so App.__init__ resumes only once the user closes it (either
    by completing setup or hitting Skip)."""

    WIDTH, HEIGHT = 520, 320

    def __init__(self, master, reason: str):
        super().__init__(master)
        self.title("Set up cleanup engine")
        self.geometry(f"{self.WIDTH}x{self.HEIGHT}")
        self.resizable(False, False)
        self.configure(fg_color=BG)
        # Stay on top of the main window, take focus, block until closed.
        self.transient(master)
        self.grab_set()

        # State.
        self._status_q: "queue.Queue[tuple[str, str, str]]" = queue.Queue()
        self._worker: threading.Thread | None = None
        self._done = False

        self._build_ui(reason)
        self.protocol("WM_DELETE_WINDOW", self._on_skip)

    def _build_ui(self, reason: str):
        # Title
        ctk.CTkLabel(
            self,
            text="First-time setup",
            font=ctk.CTkFont(family="Inter", size=18, weight="bold"),
            text_color=TEXT,
        ).pack(anchor="w", padx=24, pady=(22, 4))

        # Body — explain WHY we're asking, in plain language.
        ctk.CTkLabel(
            self,
            text=(
                "No More Writing cleans up your transcripts (fillers, punctuation, "
                "capitalization) using a small AI model that runs locally on your Mac.\n\n"
                f"{reason}\n\n"
                "Click Set up to install it — macOS will ask for your password once. "
                "Total time ~2–3 minutes on a normal connection."
            ),
            font=ctk.CTkFont(family="Inter", size=12),
            text_color=TEXT_DIM,
            wraplength=self.WIDTH - 48,
            justify="left",
        ).pack(anchor="w", padx=24, pady=(0, 12))

        # Status label — hidden until install starts. Reserved height so the
        # window doesn't jump when we swap content.
        self._status = ctk.CTkLabel(
            self,
            text="",
            font=ctk.CTkFont(family="Inter", size=11),
            text_color=TEXT,
            wraplength=self.WIDTH - 48,
            justify="left",
        )
        self._status.pack(anchor="w", padx=24, pady=(0, 4))

        # Indeterminate progress bar — only visible during install.
        self._progress = ctk.CTkProgressBar(self, mode="indeterminate", width=self.WIDTH - 48, height=4)
        # Don't pack yet; will be packed when worker starts.

        # Buttons row.
        self._btns = ctk.CTkFrame(self, fg_color="transparent")
        self._btns.pack(side="bottom", fill="x", padx=24, pady=20)

        self._skip_btn = ctk.CTkButton(
            self._btns,
            text="Skip for now",
            command=self._on_skip,
            width=120, height=36,
            fg_color=PANEL, hover_color=PANEL_HI, text_color=TEXT,
            font=ctk.CTkFont(family="Inter", size=12),
        )
        self._skip_btn.pack(side="left")

        self._action_btn = ctk.CTkButton(
            self._btns,
            text="Set up",
            command=self._on_setup,
            width=160, height=36,
            fg_color=ACCENT_OK, hover_color="#6fcf67", text_color="#0a0a0a",
            font=ctk.CTkFont(family="Inter", size=12, weight="bold"),
        )
        self._action_btn.pack(side="right")

    # ---- callbacks ----

    def _on_skip(self):
        if self._worker is not None and self._worker.is_alive():
            # In-flight install — let the user confirm they really want out
            # so we don't leave Ollama half-installed.
            self._set_status("Setup is still running; closing now will leave it partially installed.")
            return
        self.destroy()

    def _on_setup(self):
        # Lock UI to installing state.
        self._action_btn.configure(state="disabled", text="Installing…")
        self._skip_btn.configure(state="disabled")
        self._progress.pack(anchor="w", padx=24, pady=(0, 8))
        self._progress.start()

        # Spawn worker. It pushes status updates into a queue; we poll from UI.
        self._worker = threading.Thread(target=self._do_install, daemon=True)
        self._worker.start()
        self.after(100, self._drain_status_queue)

    def _do_install(self):
        try:
            from bootstrap_mac import run_full_setup
            run_full_setup(on_status=lambda phase, detail="": self._status_q.put(("status", phase, detail)))
            self._status_q.put(("done", "", ""))
        except Exception as e:
            self._status_q.put(("error", type(e).__name__, str(e)))

    def _drain_status_queue(self):
        try:
            while True:
                kind, phase, detail = self._status_q.get_nowait()
                if kind == "status":
                    self._set_status(f"{phase} — {detail}" if detail else phase)
                elif kind == "done":
                    self._on_install_done()
                    return
                elif kind == "error":
                    self._on_install_error(phase, detail)
                    return
        except queue.Empty:
            pass
        # Keep polling — worker may still be producing updates.
        if not self._done:
            self.after(120, self._drain_status_queue)

    def _on_install_done(self):
        self._done = True
        self._progress.stop()
        self._progress.set(1.0)
        self._progress.configure(mode="determinate")
        self._set_status("Setup complete. You're ready to dictate.", color=ACCENT_OK)
        self._action_btn.configure(state="normal", text="Done", command=self.destroy, fg_color=ACCENT_OK)
        self._skip_btn.configure(state="normal", text="Close", command=self.destroy)
        # Auto-close after a short pause so the user can read the success line.
        self.after(1500, self.destroy)

    def _on_install_error(self, err_type: str, msg: str):
        self._done = True
        self._progress.stop()
        self._progress.pack_forget()
        self._set_status(f"{err_type}: {msg}", color=ACCENT_REC)
        # Let the user retry (re-runs bootstrap) or skip.
        self._action_btn.configure(state="normal", text="Retry", command=self._on_retry, fg_color=ACCENT_PROC)
        self._skip_btn.configure(state="normal", text="Skip", command=self.destroy)

    def _on_retry(self):
        # Reset UI back to "installing" state and re-spawn the worker.
        self._done = False
        self._action_btn.configure(state="disabled", text="Installing…", fg_color=ACCENT_OK)
        self._skip_btn.configure(state="disabled")
        self._set_status("", color=TEXT)
        self._progress.pack(anchor="w", padx=24, pady=(0, 8))
        self._progress.configure(mode="indeterminate")
        self._progress.start()
        self._worker = threading.Thread(target=self._do_install, daemon=True)
        self._worker.start()
        self.after(100, self._drain_status_queue)

    def _set_status(self, text: str, color: str | None = None):
        self._status.configure(text=text)
        if color is not None:
            self._status.configure(text_color=color)


class SettingsWindow(ctk.CTkToplevel):
    # Shared kwargs so every dropdown / textbox looks identical across tabs.
    def _menu_kw(self, **extra):
        kw = dict(
            fg_color=PANEL_HI, button_color=BORDER, button_hover_color=TEXT_FAINT,
            text_color=TEXT, dropdown_fg_color=PANEL, dropdown_hover_color=BORDER,
            dropdown_text_color=TEXT,
        )
        kw.update(extra)
        return kw

    def __init__(self, master, start_tab: str = "Audio"):
        super().__init__(master)
        self.title("No More Writing — settings")
        self.geometry("580x700")
        self.minsize(520, 560)
        self.configure(fg_color=BG)
        self.transient(master)
        self.grab_set()

        self._retention_map = {
            "7 days": 7, "30 days": 30, "90 days": 90,
            "180 days": 180, "1 year": 365, "Forever": 0,
        }
        self._devices: list[dict] = []          # enumerated mics, index-aligned to the picker
        self._testing = False                   # guard against overlapping mic tests
        self._saved = False                     # False on close → the overlay reverts to what was saved
        # The window's X and Esc go through destroy() so an unsaved overlay preview is undone.
        self.protocol("WM_DELETE_WINDOW", self.destroy)
        self.bind("<Escape>", lambda e: self.destroy())

        # Sticky footer FIRST so it always reserves space at the bottom and can
        # never be overlapped by tab content (the old flat layout's bug).
        self._build_footer()

        # Tabbed body fills the rest.
        self.tabs = ctk.CTkTabview(
            self,
            fg_color=PANEL,
            segmented_button_fg_color=PANEL,
            segmented_button_selected_color=BORDER_HI,
            segmented_button_selected_hover_color=TEXT_FAINT,
            segmented_button_unselected_color=PANEL,
            segmented_button_unselected_hover_color=PANEL_HI,
            text_color=TEXT,
            border_width=0,
            command=self._on_tab_change,
        )
        self.tabs.pack(fill="both", expand=True, padx=16, pady=(16, 0))

        self._build_audio_tab(self._scroll(self.tabs.add("Audio")))
        self._build_overlay_tab(self._scroll(self.tabs.add("Overlay")))
        self._build_language_tab(self._scroll(self.tabs.add("Language")))
        self._build_cleanup_tab(self._scroll(self.tabs.add("Cleanup")))
        self._build_storage_tab(self._scroll(self.tabs.add("Storage")))
        self._build_about_tab(self._scroll(self.tabs.add("About")))
        self.tabs.set(start_tab)
        self._on_tab_change()

    # ---- small builders ----

    def _scroll(self, tab) -> ctk.CTkScrollableFrame:
        """Wrap a tab in a scrollable frame so no section is ever clipped."""
        s = ctk.CTkScrollableFrame(
            tab, fg_color="transparent",
            scrollbar_button_color=BORDER, scrollbar_button_hover_color=TEXT_FAINT,
        )
        s.pack(fill="both", expand=True)
        return s

    def _section(self, parent, title: str, desc: str = "", top: int = 16):
        ctk.CTkLabel(
            parent, text=title,
            font=ctk.CTkFont(family="Inter", size=13, weight="bold"),
            text_color=TEXT,
        ).pack(anchor="w", pady=(top, 2))
        if desc:
            ctk.CTkLabel(
                parent, text=desc,
                font=ctk.CTkFont(family="Inter", size=11),
                text_color=TEXT_DIM, wraplength=460, justify="left",
            ).pack(anchor="w", pady=(0, 8))

    def _toggle(self, parent, text: str, key: str, default: bool, command=None) -> ctk.BooleanVar:
        var = ctk.BooleanVar(value=CFG.get(key, default))
        ctk.CTkCheckBox(
            parent, text=text, variable=var, command=command,
            font=ctk.CTkFont(family="Inter", size=12),
            text_color=TEXT, fg_color=ACCENT_OK, hover_color=ACCENT_OK,
        ).pack(anchor="w", pady=5)
        return var

    def _build_footer(self):
        footer = ctk.CTkFrame(self, fg_color=PANEL, corner_radius=0, height=60)
        footer.pack(fill="x", side="bottom")
        footer.pack_propagate(False)

        ctk.CTkButton(
            footer, text="Save", width=100, height=34,
            fg_color=ACCENT_OK, hover_color="#6bcc6b", text_color="#0a0a0a",
            font=ctk.CTkFont(family="Inter", size=12, weight="bold"),
            command=self._save,
        ).pack(side="right", padx=(8, 24), pady=12)

        ctk.CTkButton(
            footer, text="Cancel", width=90, height=34,
            fg_color="transparent", hover_color=PANEL_HI, text_color=TEXT_DIM,
            command=self.destroy,
        ).pack(side="right", pady=12)

        self._footer_note = ctk.CTkLabel(
            footer, text=self._NOTE_DEFAULT,
            font=ctk.CTkFont(family="Inter", size=10), text_color=TEXT_FAINT,
        )
        self._footer_note.pack(side="left", padx=24)

    _NOTE_DEFAULT = "changes apply to next dictation"
    _NOTE_OVERLAY = "overlay previews live — Save keeps it"

    def _on_tab_change(self):
        # Overlay edits are already visible on the real overlay; everything else waits for Save.
        self._footer_note.configure(text=self._NOTE_OVERLAY if self.tabs.get() == "Overlay" else self._NOTE_DEFAULT)

    # ---- Audio tab ----

    def _build_audio_tab(self, p):
        self._section(
            p, "Microphone",
            "Pick which input device records your dictation. 'System default' follows "
            "whatever Windows is set to; choose a device here to lock it.",
            top=6,
        )

        mic_row = ctk.CTkFrame(p, fg_color="transparent")
        mic_row.pack(fill="x", pady=(0, 6))

        self.mic_var = ctk.StringVar(value="System default")
        self.mic_menu = ctk.CTkOptionMenu(
            mic_row, variable=self.mic_var, values=["System default"],
            width=360, command=lambda _v: self._sync_mic_warning(), **self._menu_kw(),
        )
        self.mic_menu.pack(side="left")

        ctk.CTkButton(
            mic_row, text="↻", width=34, height=28,
            fg_color=PANEL_HI, hover_color=BORDER, text_color=TEXT,
            font=ctk.CTkFont(size=14),
            command=self._refresh_devices,
        ).pack(side="left", padx=(8, 0))

        # Test row — capture a short clip and show the peak level.
        test_row = ctk.CTkFrame(p, fg_color="transparent")
        test_row.pack(fill="x", pady=(4, 2))

        self.test_btn = ctk.CTkButton(
            test_row, text="Test mic", width=90, height=28,
            fg_color=PANEL_HI, hover_color=BORDER, text_color=TEXT,
            border_color=BORDER, border_width=1,
            font=ctk.CTkFont(family="Inter", size=11),
            command=self._test_mic,
        )
        self.test_btn.pack(side="left")

        self.level_bar = ctk.CTkProgressBar(
            test_row, width=220, height=10,
            fg_color=PANEL_HI, progress_color=ACCENT_OK,
        )
        self.level_bar.set(0)
        self.level_bar.pack(side="left", padx=(10, 0))

        self.mic_status = ctk.CTkLabel(
            p, text="",
            font=ctk.CTkFont(family="Inter", size=11), text_color=TEXT_DIM,
        )
        self.mic_status.pack(anchor="w", pady=(4, 0))

        # Shown only when the picked mic is a phone-quality Bluetooth "Hands-Free" endpoint.
        self.mic_warn = ctk.CTkLabel(
            p, text="", font=ctk.CTkFont(family="Inter", size=11), text_color=ACCENT_PROC,
            wraplength=470, justify="left",
        )
        self.mic_warn.pack(anchor="w", pady=(6, 0))

        self._refresh_devices()  # populate the picker + select the saved device

        # -- Input level: the answer to "I have to shout for it to hear me"
        self._section(
            p, "Input level",
            "Quiet mic? Auto level raises each recording to a healthy volume before it is "
            "transcribed, so soft speech stops losing words. Input boost adds a fixed extra gain "
            "on top and makes the overlay waveform react more.",
            top=22,
        )
        self.auto_level_var = self._toggle(p, "Auto level  (recommended)", "auto_level", True)
        boost_row = ctk.CTkFrame(p, fg_color="transparent")
        boost_row.pack(fill="x", pady=(6, 0))
        ctk.CTkLabel(
            boost_row, text="Input boost", width=84, anchor="w",
            font=ctk.CTkFont(family="Inter", size=11), text_color=TEXT_DIM,
        ).pack(side="left")
        self.boost_label = ctk.CTkLabel(
            boost_row, text="", width=104, anchor="e",
            font=ctk.CTkFont(family="Inter", size=11), text_color=TEXT,
        )
        self.boost_label.pack(side="right")
        lo, hi = BOOST_RANGE
        self.boost_slider = ctk.CTkSlider(
            boost_row, from_=lo, to=hi, number_of_steps=int((hi - lo) / 0.5), command=self._on_boost,
            fg_color=BORDER, progress_color=TEXT_FAINT, button_color=TEXT, button_hover_color="#ffffff",
        )
        self.boost_slider.set(input_boost())
        self.boost_slider.pack(side="left", fill="x", expand=True, padx=(0, 10))
        self._on_boost(input_boost())
        self.level_hint = ctk.CTkLabel(
            p, text=self._recent_level_text(), font=ctk.CTkFont(family="Inter", size=11),
            text_color=TEXT_DIM, wraplength=470, justify="left",
        )
        self.level_hint.pack(anchor="w", pady=(8, 0))

        self._section(p, "Output", top=22)
        self.auto_paste_var = self._toggle(p, "Auto-paste after dictation", "auto_paste", True)
        self.beep_var = self._toggle(p, "Play start/stop beeps", "beep", True)

    def _device_label(self, d: dict) -> str:
        # Some Windows Bluetooth devices embed newlines/junk in their name —
        # flatten to a single clean line for the dropdown.
        name = " ".join((d.get("name") or "").split())
        tag = "  · default" if d.get("is_default") else ""
        if d.get("narrowband"):
            tag += "  · phone quality"
        return f"{name} — {d['hostapi']}{tag}"

    def _sync_mic_warning(self):
        d = next((x for x in self._devices if x["index"] == self._selected_device_index()), None)
        if d is not None and d.get("narrowband"):
            # Plain ASCII on purpose: glyphs like the warning sign or curly quotes fall back to
            # another font and make the wrapped label render at mixed sizes.
            self.mic_warn.configure(text=(
                'Heads up: a Bluetooth "Hands-Free" mic is phone quality (8 kHz) - quiet and muffled '
                "whatever the volume. If this is a wireless mic, pick its USB receiver instead."))
        else:
            self.mic_warn.configure(text="")

    def _on_boost(self, v):
        v = max(BOOST_RANGE[0], min(BOOST_RANGE[1], round(float(v) * 2) / 2))
        self._boost_value = v
        self.boost_label.configure(text=f"×{v:.1f}  (+{20 * np.log10(v):.0f} dB)" if v > 1 else "off")

    def _recent_level_text(self) -> str:
        """One line about how loud recent dictations really were (needs history rows written by v10+)."""
        try:
            rows = load_history(limit=80)
        except Exception:
            return ""
        peaks = [r["peak_db"] for r in rows if isinstance(r.get("peak_db"), (int, float))][-20:]
        if len(peaks) < 3:
            return ""
        med = float(np.median(peaks))
        state = "healthy" if med >= -12 else ("quiet" if med >= -30 else "very quiet")
        return (f"Your last {len(peaks)} dictations peaked around {med:.0f} dBFS - {state} "
                f"(healthy is roughly -12 to -3).")

    def _refresh_devices(self):
        self._devices = list_input_devices()
        labels = ["System default"] + [self._device_label(d) for d in self._devices]
        self.mic_menu.configure(values=labels)

        # Reselect whatever is stored in config.
        saved_idx = CFG.get("input_device")
        saved_name = (CFG.get("input_device_name") or "").strip()
        chosen = "System default"
        if saved_idx is not None or saved_name:
            for d in self._devices:
                if (saved_idx is not None and d["index"] == saved_idx) or (saved_name and d["name"] == saved_name):
                    chosen = self._device_label(d)
                    break
        self.mic_var.set(chosen)
        self._sync_mic_warning()

    def _selected_device_index(self) -> int | None:
        """The sounddevice index for the currently-picked menu item, or None."""
        label = self.mic_var.get()
        if label == "System default":
            return None
        for d in self._devices:
            if self._device_label(d) == label:
                return d["index"]
        return None

    def _test_mic(self):
        if self._testing:
            return
        self._testing = True
        self.test_btn.configure(state="disabled", text="Listening…")
        self.mic_status.configure(text="Say a sentence at your normal speaking volume…", text_color=TEXT_DIM)
        self.level_bar.set(0)
        device = self._selected_device_index()

        def _worker():
            try:
                clip = measure_input_clip(device, seconds=3.0)
                err = None
            except Exception as e:
                clip, err = None, e
            self.after(0, lambda: self._render_test(clip, err))

        threading.Thread(target=_worker, daemon=True).start()

    def _render_test(self, clip, err):
        self._testing = False
        self.test_btn.configure(state="normal", text="Test mic")
        if err is not None:
            self.level_bar.set(0)
            self.mic_status.configure(text=f"Couldn't open this mic: {err}", text_color=ACCENT_REC)
            return
        peak = float(np.max(np.abs(clip))) if clip is not None and clip.size else 0.0
        db = 20 * float(np.log10(max(peak, 1e-6)))
        boost = self._boost_value
        auto = bool(self.auto_level_var.get())
        # What Whisper would actually receive with the settings as they are on screen right now.
        _, gain = condition_audio(clip, boost=boost, auto_level=auto)
        # Same scale as the overlay waveform (×6, plus the boost) — the bar is what you'll see while dictating.
        self.level_bar.set(max(0.0, min(1.0, peak * 6.0 * boost)))
        head = f"peak {db:.0f} dBFS"
        if peak < 0.003:
            self.level_bar.configure(progress_color=ACCENT_PROC)
            self.mic_status.configure(text="Silent — is this the right device, or is it muted?", text_color=ACCENT_PROC)
        elif peak < 0.25:   # loud passages under ~ -12 dBFS: quiet
            self.level_bar.configure(progress_color=ACCENT_PROC)
            if gain > 1.0:
                tip = f"Whisper will get it ×{gain:.0f} louder."
            elif auto:
                tip = "Say a sentence while it listens."
            else:
                tip = "Turn on Auto level, or raise Input boost."
            self.mic_status.configure(text=f"Quiet mic ({head}). {tip}", text_color=ACCENT_PROC)
        else:
            self.level_bar.configure(progress_color=ACCENT_OK)
            self.mic_status.configure(text=f"Good level ({head}). ✓", text_color=ACCENT_OK)

    # ---- Overlay tab ----
    # Every control edits the draft `self._ov` and pushes it to the running overlay, so changes
    # show up live on the real thing. Save writes the draft to config; closing without saving
    # (see destroy) sends the saved config back.

    _IDLE_LABELS = {"Mic pill": "pill", "Hidden": "hidden"}
    _THEME_LABELS = {"Dark": "dark", "Light": "light"}
    _WAVE_LABELS = {"Bars": "bars", "Fine": "fine", "Wave": "wave"}
    _SHAPE_LABELS = {"Pill": "pill", "Rounded": "rounded", "Sharp": "sharp"}
    _PREVIEW_LABELS = {"Off": None, "Recording": "recording", "Processing": "processing"}

    def _seg_kw(self):
        return dict(
            font=ctk.CTkFont(family="Inter", size=11),
            fg_color=PANEL_HI, selected_color=BORDER_HI, selected_hover_color=TEXT_FAINT,
            unselected_color=PANEL_HI, unselected_hover_color=BORDER,
            text_color=TEXT, corner_radius=8, border_width=2,
        )

    def _ov_row(self, p, label: str, top: int = 5) -> ctk.CTkFrame:
        row = ctk.CTkFrame(p, fg_color="transparent")
        row.pack(fill="x", pady=(top, 0))
        ctk.CTkLabel(
            row, text=label, width=78, anchor="w",
            font=ctk.CTkFont(family="Inter", size=11), text_color=TEXT_DIM,
        ).pack(side="left")
        return row

    def _ov_seg(self, p, label: str, labels: dict, key: str):
        row = self._ov_row(p, label)
        seg = ctk.CTkSegmentedButton(
            row, values=list(labels),
            command=lambda v, k=key, m=labels: self._on_ov_seg(k, m[v]), **self._seg_kw(),
        )
        seg.pack(side="left")
        self._segs[key] = (seg, labels)

    def _ov_slider(self, p, label: str, key: str, lo: int, hi: int, step: int, mult: float, unit: str):
        """Slider whose on-screen number is draft[key] × mult (1.0 → 100 %)."""
        row = self._ov_row(p, label)
        val = ctk.CTkLabel(
            row, text="", width=56, anchor="e",
            font=ctk.CTkFont(family="Inter", size=11), text_color=TEXT,
        )
        val.pack(side="right")

        def _cb(v, k=key, lab=val):
            v = round(v / step) * step
            self._ov[k] = v / mult
            lab.configure(text=f"{int(v)}{unit}")
            self._ov_edited()

        s = ctk.CTkSlider(
            row, from_=lo, to=hi, number_of_steps=int((hi - lo) / step), command=_cb,
            fg_color=BORDER, progress_color=TEXT_FAINT, button_color=TEXT, button_hover_color="#ffffff",
        )
        s.pack(side="left", fill="x", expand=True, padx=(0, 10))
        self._sliders[key] = (s, val, mult, unit)

    def _build_overlay_tab(self, p):
        self._ov = oc.resolve(CFG)        # the draft — resolved, so every key is present and valid
        self._ov_ready = False            # no live pushes while the controls are still being built
        self._segs: dict = {}
        self._sliders: dict = {}
        self._monitor_labels = ["Primary display"]

        self._section(
            p, "Floating overlay",
            "The pill that shows while you dictate. Everything on this tab previews live on the "
            "real overlay — Save keeps it, Cancel puts it back.",
            top=6,
        )
        self.overlay_var = self._toggle(
            p, "Show the floating overlay", "show_overlay", True, command=self._on_ov_show)
        self._ov_seg(p, "When idle", self._IDLE_LABELS, "overlay_idle")

        # -- Style
        self._section(p, "Style", top=18)
        self.preset_seg = ctk.CTkSegmentedButton(
            p, values=list(oc.STYLE_PRESETS), command=self._on_ov_preset, **self._seg_kw())
        self.preset_seg.pack(fill="x", pady=(0, 4))
        self._ov_seg(p, "Theme", self._THEME_LABELS, "overlay_theme")
        self._build_swatches(self._ov_row(p, "Accent"))
        self._ov_seg(p, "Waveform", self._WAVE_LABELS, "overlay_wave")
        self.tint_var = ctk.BooleanVar(value=self._ov["overlay_wave_tint"])
        ctk.CTkCheckBox(
            p, text="Tint the waveform with the accent color", variable=self.tint_var,
            command=self._on_ov_tint, font=ctk.CTkFont(family="Inter", size=11),
            text_color=TEXT, fg_color=ACCENT_OK, hover_color=ACCENT_OK, checkbox_width=18, checkbox_height=18,
        ).pack(anchor="w", padx=(78, 0), pady=(6, 0))
        self._ov_seg(p, "Shape", self._SHAPE_LABELS, "overlay_shape")
        self._ov_slider(p, "Glow", "overlay_glow", 0, 200, 5, 100, "%")

        # -- Size
        self._section(p, "Size", top=18)
        self._ov_slider(p, "Size", "overlay_scale", 60, 160, 5, 100, "%")
        self._ov_slider(p, "Width", "overlay_width", 50, 140, 5, 100, "%")

        # -- Position
        self._section(
            p, "Position",
            "Pick a spot, or just drag the overlay anywhere. Near an edge or corner it opens "
            "inward from there, so it never spills off the screen.",
            top=18,
        )
        prow = ctk.CTkFrame(p, fg_color="transparent")
        prow.pack(fill="x", pady=(2, 0))
        grid = ctk.CTkFrame(prow, fg_color=PANEL_HI, corner_radius=8)
        grid.pack(side="left")
        self._anchor_btns: dict = {}
        for i, name in enumerate(oc.ANCHORS):
            r, c = divmod(i, 3)
            b = ctk.CTkButton(
                grid, text="", width=36, height=22, corner_radius=5,
                fg_color=BORDER, hover_color=TEXT_FAINT,
                command=lambda n=name: self._on_ov_anchor(n),
            )
            b.grid(row=r, column=c, padx=3, pady=3)
            self._anchor_btns[name] = b
        side = ctk.CTkFrame(prow, fg_color="transparent")
        side.pack(side="left", padx=(16, 0), fill="x", expand=True)
        self.pos_caption = ctk.CTkLabel(
            side, text="", anchor="w",
            font=ctk.CTkFont(family="Inter", size=12, weight="bold"), text_color=TEXT,
        )
        self.pos_caption.pack(anchor="w")
        self.monitor_var = ctk.StringVar(value="Primary display")
        self.monitor_menu = ctk.CTkOptionMenu(
            side, variable=self.monitor_var, values=["Primary display"],
            width=250, command=self._on_ov_monitor, **self._menu_kw(),
        )
        self.monitor_menu.pack(anchor="w", pady=(6, 0))
        self._ov_slider(p, "Edge gap", "overlay_margin", 0, 200, 5, 1, " px")
        ctk.CTkButton(
            p, text="Reset position", width=120, height=28,
            fg_color=PANEL_HI, hover_color=BORDER, text_color=TEXT, border_color=BORDER, border_width=1,
            font=ctk.CTkFont(family="Inter", size=11), command=self._ov_reset_position,
        ).pack(anchor="w", padx=(78, 0), pady=(8, 0))

        # -- Preview / reset
        self._section(
            p, "Preview",
            "Force the real overlay into a state so you can judge the look without dictating.",
            top=20,
        )
        self.preview_seg = ctk.CTkSegmentedButton(
            p, values=list(self._PREVIEW_LABELS), command=self._on_ov_preview, **self._seg_kw())
        self.preview_seg.set("Off")
        self.preview_seg.pack(anchor="w")
        ctk.CTkButton(
            p, text="Reset overlay to defaults", width=180, height=30,
            fg_color=PANEL_HI, hover_color=BORDER, text_color=TEXT, border_color=BORDER, border_width=1,
            font=ctk.CTkFont(family="Inter", size=11), command=self._ov_reset_all,
        ).pack(anchor="w", pady=(18, 6))

        self._ov_ready = True
        self._sync_ov_controls()
        self.refresh_monitors()

    def _build_swatches(self, row):
        self._swatches: list = []
        for _name, hexv in oc.ACCENT_SWATCHES:
            b = ctk.CTkButton(
                row, text="", width=22, height=22, corner_radius=11,
                fg_color=hexv, hover_color=hexv, border_width=2, border_color=PANEL,
                command=lambda h=hexv: self._on_ov_accent(h),
            )
            b.pack(side="left", padx=2)
            self._swatches.append((hexv, b))
        # Any other colour: opens the system picker; shows the chosen colour once one is set.
        self._custom_swatch = ctk.CTkButton(
            row, text="+", width=22, height=22, corner_radius=11,
            fg_color=PANEL_HI, hover_color=BORDER, text_color=TEXT, border_width=2, border_color=PANEL,
            font=ctk.CTkFont(size=13), command=self._pick_custom_accent,
        )
        self._custom_swatch.pack(side="left", padx=(6, 2))

    def _sync_swatches(self):
        cur = self._ov["overlay_accent"].upper()
        preset_hexes = {h.upper() for _n, h in oc.ACCENT_SWATCHES}
        for hexv, b in self._swatches:
            b.configure(border_color=TEXT if hexv.upper() == cur else PANEL)
        if cur in preset_hexes:
            self._custom_swatch.configure(fg_color=PANEL_HI, hover_color=BORDER, text="+", border_color=PANEL)
        else:
            self._custom_swatch.configure(fg_color=cur, hover_color=cur, text="", border_color=TEXT)

    def _pick_custom_accent(self):
        from tkinter import colorchooser
        _rgb, hexv = colorchooser.askcolor(
            color=self._ov["overlay_accent"], parent=self, title="Overlay accent color")
        if hexv:   # None on cancel
            self._on_ov_accent(hexv.upper())

    # -- draft plumbing

    def _push_overlay(self):
        if self._ov_ready:
            self.master.push_overlay_config(oc.resolve(self._ov))

    def _ov_edited(self):
        """A control changed the draft: refresh the derived UI and preview it live."""
        self.preset_seg.set(oc.current_style_preset(oc.resolve(self._ov)) or "")
        self._sync_position_ui()
        self._push_overlay()

    def _sync_ov_controls(self):
        """Draft → every control (after a preset, a reset, or a drag). Never pushes."""
        ov = self._ov
        self.overlay_var.set(ov["show_overlay"])
        self.tint_var.set(ov["overlay_wave_tint"])
        for key, (seg, labels) in self._segs.items():
            seg.set(next((lab for lab, v in labels.items() if v == ov[key]), ""))
        for key, (s, val, mult, unit) in self._sliders.items():
            v = ov[key] * mult
            s.set(v)
            val.configure(text=f"{int(round(v))}{unit}")
        self.preset_seg.set(oc.current_style_preset(oc.resolve(ov)) or "")
        self._sync_swatches()
        self._sync_position_ui()

    def _sync_position_ui(self):
        anchor = self._ov["overlay_anchor"]
        for name, b in self._anchor_btns.items():
            on = name == anchor
            b.configure(fg_color=TEXT if on else BORDER, hover_color=TEXT if on else TEXT_FAINT)
        custom = anchor == "custom"
        self.pos_caption.configure(text="Custom — where you dragged it" if custom else oc.ANCHOR_LABELS[anchor])
        # Monitor + edge gap only apply to the presets; a dragged pin is absolute.
        state = "disabled" if custom else "normal"
        self.monitor_menu.configure(state=state)
        self._sliders["overlay_margin"][0].configure(state=state)

    def refresh_monitors(self):
        """Rebuild the monitor picker from the screens the overlay process reported."""
        screens = getattr(self.master, "overlay_screens", None) or []
        labels = ["Primary display"]
        for i, s in enumerate(screens):
            tag = "  · primary" if s.get("primary") else ""
            labels.append(f"Display {i + 1} — {s.get('pw', s.get('w'))}×{s.get('ph', s.get('h'))}{tag}")
        self._monitor_labels = labels
        self.monitor_menu.configure(values=labels)
        idx = self._ov["overlay_monitor"]
        self.monitor_var.set(labels[idx + 1] if -1 <= idx < len(labels) - 1 else labels[0])

    # -- control callbacks

    def _on_ov_show(self):
        self._ov["show_overlay"] = bool(self.overlay_var.get())
        self.master.set_overlay_enabled(self._ov["show_overlay"])   # starts/stops the process live
        self._push_overlay()

    def _on_ov_seg(self, key: str, value):
        self._ov[key] = value
        self._ov_edited()

    def _on_ov_tint(self):
        self._ov["overlay_wave_tint"] = bool(self.tint_var.get())
        self._ov_edited()

    def _on_ov_preset(self, name: str):
        self._ov.update(oc.STYLE_PRESETS[name])
        self._sync_ov_controls()
        self._push_overlay()

    def _on_ov_accent(self, hexv: str):
        self._ov["overlay_accent"] = hexv
        self._sync_swatches()
        self._ov_edited()

    def _on_ov_anchor(self, name: str):
        self._ov["overlay_anchor"] = name
        self._ov_edited()

    def _on_ov_monitor(self, label: str):
        try:
            self._ov["overlay_monitor"] = self._monitor_labels.index(label) - 1
        except ValueError:
            return
        self._ov_edited()

    def _on_ov_preview(self, label: str):
        self.master._send_overlay({"type": "preview", "value": self._PREVIEW_LABELS[label]})

    def _ov_reset_position(self):
        d = oc.DEFAULTS
        self._ov.update({k: d[k] for k in (
            "overlay_anchor", "overlay_margin", "overlay_monitor",
            "overlay_px", "overlay_py", "overlay_ax", "overlay_ay")})
        self._sync_ov_controls()
        self.refresh_monitors()
        self._push_overlay()

    def _ov_reset_all(self):
        self._ov = oc.resolve({})
        self._sync_ov_controls()
        self.refresh_monitors()
        self.master.set_overlay_enabled(True)
        self._push_overlay()

    # -- called by App when the overlay process reports something

    def on_overlay_moved(self):
        """The overlay was dragged. App already saved the new pin to CFG — adopt it into the
        draft so Save doesn't undo the drag."""
        for k in ("overlay_anchor", "overlay_px", "overlay_py", "overlay_ax", "overlay_ay"):
            self._ov[k] = CFG.get(k)
        self._sync_position_ui()

    def on_overlay_hidden(self):
        """Right-click → Hide overlay while this window is open."""
        self._ov["show_overlay"] = False
        self.overlay_var.set(False)

    def destroy(self):
        # Reached by Cancel, the window's X, Esc — and by _save() after it set _saved. An
        # unsaved session must not leave a half-previewed overlay behind.
        try:
            self.master._send_overlay({"type": "preview", "value": None})
            if not self._saved:
                self.master.set_overlay_enabled(oc.resolve(CFG)["show_overlay"])
                self.master.push_overlay_config()
            self.master._settings_win = None
        except Exception:
            pass
        super().destroy()

    # ---- Language tab ----

    def _build_language_tab(self, p):
        self._section(
            p, "Languages you speak",
            "Forces Whisper to bias toward these languages. Auto-detect works but is slower.",
            top=6,
        )
        current_langs = CFG.get("languages") or []
        current_label = next(
            (label for label, val in LANGUAGE_OPTIONS if val == current_langs),
            "Auto-detect (any)",
        )
        self.lang_var = ctk.StringVar(value=current_label)
        ctk.CTkOptionMenu(
            p, variable=self.lang_var,
            values=[label for label, _ in LANGUAGE_OPTIONS],
            width=320, **self._menu_kw(),
        ).pack(anchor="w")

        self._section(
            p, "Personal vocabulary / slang",
            "One term per line. Brand names, slang, jargon, people's names. Whisper biases "
            "toward these AND the cleanup LLM preserves them verbatim.",
            top=20,
        )
        self.vocab_textbox = ctk.CTkTextbox(
            p, width=460, height=150,
            fg_color=PANEL_HI, border_color=BORDER, border_width=1,
            text_color=TEXT, font=ctk.CTkFont(family="Consolas", size=12),
        )
        self.vocab_textbox.pack(fill="x", pady=(0, 6))
        for term in CFG.get("vocabulary") or []:
            self.vocab_textbox.insert("end", term + "\n")

        self._section(
            p, "Your expressions",
            "One per line. The words you say out of habit — the cleanup LLM keeps them "
            "instead of treating them as filler. Leave empty for the defaults.",
            top=20,
        )
        self.expr_textbox = ctk.CTkTextbox(
            p, width=460, height=120,
            fg_color=PANEL_HI, border_color=BORDER, border_width=1,
            text_color=TEXT, font=ctk.CTkFont(family="Consolas", size=12),
        )
        self.expr_textbox.pack(fill="x", pady=(0, 6))
        for term in CFG.get("expressions") or DEFAULT_EXPRESSIONS:
            self.expr_textbox.insert("end", term + "\n")

    # ---- Cleanup tab ----

    def _build_cleanup_tab(self, p):
        self._section(
            p, "Cleanup engine",
            "How raw transcripts get punctuated and structured before pasting.",
            top=6,
        )
        self.cleanup_var = self._toggle(
            p, "Enable AI cleanup (punctuation, capitalization, hesitation removal)",
            "cleanup_enabled", True)
        self.fast_path_var = self._toggle(
            p, "Fast-path (skip the LLM when text is already clean)",
            "fast_path_enabled", True)
        self.structure_var = self._toggle(
            p, "Smart structure  (“parte 1 … parte 2” → sections, “paso 1” → numbered list)",
            "structure_enabled", True)
        self.voice_cmd_var = self._toggle(
            p, "Voice commands  (“nueva línea” / “nuevo párrafo” → line breaks)",
            "voice_commands_enabled", True)
        self.marker_var = self._toggle(
            p, "Marker punctuation  (comma-wrap “o sea”, “¿me entiendes?”)",
            "marker_punctuation_enabled", True)

        self._section(
            p, "Run-on threshold",
            "Send a dictation to the LLM once its longest unpunctuated stretch passes this "
            "many words. Lower = better punctuation, more LLM calls. Default 12.",
            top=20,
        )
        row = ctk.CTkFrame(p, fg_color="transparent")
        row.pack(fill="x")
        cur = int(CFG.get("runon_word_threshold", 12))
        self.runon_var = ctk.StringVar(value=str(cur))
        ctk.CTkOptionMenu(
            row, variable=self.runon_var,
            values=["8", "10", "12", "14", "16", "20"],
            width=90, **self._menu_kw(),
        ).pack(side="left")
        ctk.CTkLabel(
            row, text="words",
            font=ctk.CTkFont(family="Inter", size=11), text_color=TEXT_DIM,
        ).pack(side="left", padx=(8, 0))

    # ---- Storage tab ----

    def _build_storage_tab(self, p):
        self._section(p, "History storage", top=6)

        stats = get_history_stats()
        size_kb = stats["size_bytes"] / 1024
        size_str = f"{size_kb:.1f} KB" if size_kb < 1024 else f"{size_kb/1024:.1f} MB"
        if stats["oldest"] and stats["newest"]:
            oldest = datetime.fromtimestamp(stats["oldest"]).strftime("%Y-%m-%d")
            newest = datetime.fromtimestamp(stats["newest"]).strftime("%Y-%m-%d")
            range_str = f"{oldest} → {newest}"
        else:
            range_str = "(empty)"

        ctk.CTkLabel(
            p, text=f"{size_str}  ·  {stats['entries']} entries  ·  {range_str}",
            font=ctk.CTkFont(family="Inter", size=11), text_color=TEXT_DIM,
        ).pack(anchor="w", pady=(0, 2))
        ctk.CTkLabel(
            p, text="(Whisper + Llama models ~6.9 GB total, fixed — not counted here)",
            font=ctk.CTkFont(family="Inter", size=10), text_color=TEXT_FAINT,
        ).pack(anchor="w", pady=(0, 10))

        ctk.CTkLabel(
            p, text="Auto-delete entries older than:",
            font=ctk.CTkFont(family="Inter", size=11), text_color=TEXT,
        ).pack(anchor="w", pady=(4, 4))

        cur_days = CFG.get("history_retention_days", 90)
        cur_label = next((k for k, v in self._retention_map.items() if v == cur_days), "90 days")
        self.retention_var = ctk.StringVar(value=cur_label)
        ctk.CTkOptionMenu(
            p, variable=self.retention_var,
            values=list(self._retention_map.keys()),
            width=140, **self._menu_kw(),
        ).pack(anchor="w")

    # ---- About tab ----

    def _build_about_tab(self, p):
        self._section(p, "About", top=6)
        ctk.CTkLabel(
            p, text=f"No More Writing  {VERSION}",
            font=ctk.CTkFont(family="Inter", size=13, weight="bold"), text_color=TEXT,
        ).pack(anchor="w", pady=(0, 2))
        ctk.CTkLabel(
            p, text=f"“{VERSION_NAME}”",
            font=ctk.CTkFont(family="Inter", size=11), text_color=TEXT_DIM,
        ).pack(anchor="w", pady=(0, 12))

        self.update_status_label = ctk.CTkLabel(
            p, text="",
            font=ctk.CTkFont(family="Inter", size=11), text_color=TEXT_FAINT,
        )
        self.update_status_label.pack(anchor="w", pady=(0, 6))

        ctk.CTkButton(
            p, text="Check for updates", width=150, height=30,
            fg_color=PANEL_HI, hover_color=BORDER, text_color=TEXT,
            border_color=BORDER, border_width=1,
            font=ctk.CTkFont(family="Inter", size=11),
            command=self._check_updates_now,
        ).pack(anchor="w")

    def _check_updates_now(self):
        from updater import fetch_latest, is_newer
        self.update_status_label.configure(text="checking…", text_color=TEXT_FAINT)

        def _worker():
            info = fetch_latest()
            self.after(0, lambda i=info: self._render_check_result(i))

        threading.Thread(target=_worker, daemon=True).start()

    def _render_check_result(self, info):
        from updater import is_newer
        if info is None:
            self.update_status_label.configure(text="couldn't reach GitHub", text_color="#c25450")
            return
        if is_newer(info.latest, info.current):
            self.update_status_label.configure(text=f"new: {info.latest} available", text_color=ACCENT_OK)
            self.master._on_update_found(info)
        else:
            self.update_status_label.configure(text="you're on the latest", text_color=TEXT_FAINT)

    def _save(self):
        # Language
        selected = self.lang_var.get()
        for label, val in LANGUAGE_OPTIONS:
            if label == selected:
                CFG["languages"] = val
                break

        # Vocabulary
        raw = self.vocab_textbox.get("1.0", "end")
        terms = [t.strip() for t in raw.splitlines() if t.strip()]
        CFG["vocabulary"] = terms

        # Expressions — empty box means "use the built-in defaults"
        raw_expr = self.expr_textbox.get("1.0", "end")
        exprs = [t.strip() for t in raw_expr.splitlines() if t.strip()]
        CFG["expressions"] = exprs or list(DEFAULT_EXPRESSIONS)

        # Microphone — store both the index (fast path) and the name (recovery
        # if the device list re-indexes). "System default" clears the pin.
        dev_idx = self._selected_device_index()
        if dev_idx is None:
            CFG["input_device"] = None
            CFG["input_device_name"] = ""
        else:
            CFG["input_device"] = dev_idx
            match = next((d["name"] for d in self._devices if d["index"] == dev_idx), "")
            CFG["input_device_name"] = match

        # Audio toggles
        CFG["auto_paste"] = bool(self.auto_paste_var.get())
        CFG["beep"] = bool(self.beep_var.get())
        CFG["auto_level"] = bool(self.auto_level_var.get())
        CFG["input_boost"] = float(self._boost_value)

        # Overlay — commit the draft (look, size, position, visibility). All keys are written
        # so config.json documents every option; the v1–v8 window position is superseded.
        ov = oc.resolve(self._ov)
        for k in oc.KEYS:
            CFG[k] = ov[k]
        CFG.pop("overlay_x", None)
        CFG.pop("overlay_y", None)

        # Cleanup toggles
        CFG["cleanup_enabled"] = bool(self.cleanup_var.get())
        CFG["fast_path_enabled"] = bool(self.fast_path_var.get())
        CFG["structure_enabled"] = bool(self.structure_var.get())
        CFG["voice_commands_enabled"] = bool(self.voice_cmd_var.get())
        CFG["marker_punctuation_enabled"] = bool(self.marker_var.get())
        try:
            CFG["runon_word_threshold"] = int(self.runon_var.get())
        except (TypeError, ValueError):
            pass

        # History retention — apply immediately if changed
        new_days = self._retention_map.get(self.retention_var.get(), 90)
        old_days = CFG.get("history_retention_days", 90)
        CFG["history_retention_days"] = new_days
        if new_days != old_days and new_days > 0:
            try:
                kept, dropped = prune_history(
                    retention_days=new_days,
                    max_entries=CFG.get("history_max_entries", 5000),
                )
                if dropped:
                    print(f"[history] retention changed: kept {kept}, dropped {dropped}")
            except Exception as e:
                print(f"[history] prune-on-save failed: {e}")

        save_config()
        self._saved = True
        self.master.set_overlay_enabled(ov["show_overlay"])
        self.master.push_overlay_config()
        flow = getattr(self.master, "flow", None)
        if flow is not None:
            # No-op when the model is unchanged; swaps Whisper in a worker thread otherwise.
            flow.reload_models()
        self.destroy()


def main():
    # Dual-mode entry: --overlay flag routes to the Qt overlay process.
    # Lets a single PyInstaller bundle act as both the main app and the overlay subprocess.
    if len(sys.argv) > 1 and sys.argv[1] == "--overlay":
        sys.argv.pop(1)
        from overlay_qt import main as overlay_main
        overlay_main()
        return
    # --prefetch: the installer downloads the speech model now (with the PC's real device choice), so the first
    # dictation never stalls on a 1.6 GB download. Prints what it loaded and exits; no window, no hotkey.
    if len(sys.argv) > 1 and sys.argv[1] == "--prefetch":
        log = USER_DIR / "prefetch.log"  # a windowed .exe has no console: the installer (and QA) read this
        try:
            from engine import _detect_device_and_model
            device, model_name, compute = _detect_device_and_model()
            from faster_whisper import WhisperModel
            m = WhisperModel(model_name, device=device, compute_type=compute)
            import numpy as _np
            m.transcribe(_np.zeros(16000, dtype=_np.float32), beam_size=1)  # proves the GPU libraries really load
            log.write_text(f"ok {model_name} {device}\n", encoding="utf-8")
        except Exception as e:
            log.write_text(f"error {e}\n", encoding="utf-8")
            sys.exit(1)
        return

    app = App()
    app.mainloop()


if __name__ == "__main__":
    main()
