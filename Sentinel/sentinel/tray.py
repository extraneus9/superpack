"""Sentinel — desktop app: native window + tray + real-time protection.

A real native window (WebView2 via pywebview) with an enforced MINIMUM size — resizable
above it, never smaller, so the layout can't break. Closing the window hides it to the tray;
the Sentinel eye stays in the tray running real-time protection, and "Open Dashboard" brings
the window back.

    python -m sentinel.tray      (or run the packaged Sentinel.exe)
"""
from __future__ import annotations

import os
import socket
import threading
import time
from pathlib import Path

import pystray
import webview
from PIL import Image, ImageDraw

from . import webapp
from .scanner import Scanner
from .intel import VirusTotalIntel
from .realtime import RealtimeGuard
from .livetest import drop_threats
from .paths import open_path

PORT = 8799
URL = f"http://127.0.0.1:{PORT}/"
WIN_W, WIN_H = 1060, 760
MIN_W, MIN_H = 900, 640
SETTINGS_FILE = Path(__file__).resolve().parent.parent / "settings.json"


def watch_dir() -> Path:
    d = Path(os.environ.get("USERPROFILE", Path.home())) / "Documents" / "Sentinel Watch"
    d.mkdir(parents=True, exist_ok=True)
    readme = d / "README.txt"
    if not readme.exists():
        readme.write_text("Sentinel watches this folder in real time. Drop a file here to have "
                          "it scanned the moment it lands.\n", encoding="utf-8")
    return d


def make_icon(size: int = 64, alert: bool = False) -> Image.Image:
    """Draw the Sentinel eye: almond outline, fiery iris, vertical slit pupil (any size)."""
    k = size / 64.0
    def box(a, b, c, d_):
        return [a * k, b * k, c * k, d_ * k]
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    w = max(1, round(3 * k))
    d.ellipse(box(2, 18, 62, 46), fill=(9, 9, 9, 255), outline=(255, 59, 69, 255), width=w)
    iris = (255, 90, 31, 255) if not alert else (255, 40, 40, 255)
    d.ellipse(box(20, 18, 44, 46), fill=iris)
    d.ellipse(box(20, 18, 44, 46), outline=(229, 9, 20, 255), width=max(1, round(k)))
    d.ellipse(box(29, 20, 35, 44), fill=(7, 7, 7, 255))
    d.ellipse(box(25, 23, 29, 27), fill=(255, 255, 255, 230))
    return img


def _wait_for_server(timeout: float = 15.0) -> None:
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", PORT), timeout=1):
                return
        except OSError:
            time.sleep(0.3)


class App:
    def __init__(self):
        intel = VirusTotalIntel(allow_network=True)
        self.scanner = Scanner(intel=intel if intel.enabled else None)
        webapp._scanner = self.scanner
        # safe default: quarantine malicious files on write, alert on ransomware behavior,
        # but do NOT auto-kill processes (auto_respond stays off) — set in Settings to enable.
        self.guard = RealtimeGuard(self.scanner, [watch_dir()], on_detect=self._on_detect,
                                   settings_file=SETTINGS_FILE, auto_quarantine=True)
        webapp._guard = self.guard
        self.window = None
        self._quitting = False
        self.icon = pystray.Icon("sentinel", make_icon(), "Sentinel — protected", self._menu())

    # ---------- callbacks ----------
    def _on_detect(self, det: dict):
        title = f"{det.get('malware_class','Threat')} · {det.get('category','')}"
        name = Path(det.get("path", "")).name or det.get("path", "")
        try:
            self.icon.notify(f"{name}\n{det.get('rationale','')}", title)
        except Exception:
            pass

    def _show(self):
        if self.window:
            try:
                self.window.show()
                self.window.restore()
            except Exception:
                pass

    def _on_closing(self):
        if self._quitting:
            return True
        try:
            self.window.hide()
        except Exception:
            pass
        return False  # keep running in the tray

    # ---------- menu ----------
    def _menu(self):
        return pystray.Menu(
            pystray.MenuItem("Open Dashboard", lambda: self._show(), default=True),
            pystray.MenuItem("Protection on",
                             lambda i, m: self._toggle(), checked=lambda m: not self.guard.paused),
            pystray.MenuItem("Run live test", lambda: threading.Thread(
                target=lambda: drop_threats(watch_dir()), daemon=True).start()),
            pystray.MenuItem("Open watch folder", lambda: open_path(watch_dir())),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit", self._quit),
        )

    def _toggle(self):
        if self.guard.paused:
            self.guard.resume()
            self.icon.title = "Sentinel — protected"
        else:
            self.guard.pause()
            self.icon.title = "Sentinel — paused"

    def _quit(self, icon=None, item=None):
        self._quitting = True
        self.guard.stop()
        try:
            self.icon.stop()
        except Exception:
            pass
        try:
            self.window.destroy()
        except Exception:
            pass

    # ---------- run ----------
    def run(self):
        threading.Thread(target=lambda: webapp.main(["--port", str(PORT), "--no-browser"]),
                         daemon=True).start()
        _wait_for_server()
        self.guard.start()
        self.icon.run_detached()
        self.window = webview.create_window("Sentinel", URL, width=WIN_W, height=WIN_H,
                                            min_size=(MIN_W, MIN_H))
        self.window.events.closing += self._on_closing
        webview.start()


def main():
    App().run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
