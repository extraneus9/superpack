"""
Cross-platform global hotkey registration.

Strategy per OS:
- Windows: prefer the Win32 RegisterHotKey path (hotkey_win32.py) — most robust
  against focus changes, fullscreen apps, sleep/wake. Falls back to pynput.
- macOS: pynput.keyboard.GlobalHotKeys — needs Accessibility permission. We
  intentionally do NOT use the `keyboard` lib here because it requires root on
  macOS (kernel-level event tap), which our unsigned app can't get.
- Linux: pynput — needs X11 (Wayland is hit-or-miss; that's a known pynput limit).

The callback runs on a worker thread. If you touch UI from it, marshal back to
the UI thread yourself.
"""

from __future__ import annotations

import sys
from typing import Callable

IS_WIN = sys.platform == "win32"
IS_MAC = sys.platform == "darwin"


def _parse_for_pynput(hotkey: str) -> str:
    """Translate our 'ctrl+alt+w' syntax to pynput's '<ctrl>+<alt>+w' format."""
    parts = [p.strip().lower() for p in hotkey.split("+")]
    out: list[str] = []
    mod_aliases = {"ctrl": "ctrl", "control": "ctrl", "alt": "alt", "shift": "shift",
                   "win": "cmd", "super": "cmd", "meta": "cmd", "cmd": "cmd"}
    for p in parts:
        if p in mod_aliases:
            # On macOS, "ctrl" usually means the real control key; cmd is its own thing.
            # We keep the literal mapping so users who configure "ctrl+alt+w" get ctrl,
            # not the macOS user-experience-expected cmd.
            out.append(f"<{mod_aliases[p]}>")
        else:
            out.append(p)
    return "+".join(out)


def _register_pynput(hotkey: str, callback: Callable[[], None]) -> bool:
    try:
        from pynput.keyboard import GlobalHotKeys  # type: ignore[import-not-found]
    except ImportError:
        print("[hotkey] pynput not installed; cannot register on this platform")
        return False

    combo = _parse_for_pynput(hotkey)
    try:
        listener = GlobalHotKeys({combo: callback})
        listener.daemon = True
        listener.start()
        print(f"[hotkey] registered '{hotkey}' via pynput as '{combo}'")
        return True
    except Exception as e:
        print(f"[hotkey] pynput registration failed for '{hotkey}': {e}")
        return False


def register_hotkey(hotkey: str, callback: Callable[[], None]) -> bool:
    """Register a system-wide hotkey. Returns True on success.

    On macOS, the first invocation will trigger an Accessibility-permission
    prompt — the user must approve it in System Settings → Privacy & Security
    → Accessibility for the hotkey to work.
    """
    if IS_WIN:
        try:
            from hotkey_win32 import register_hotkey_win32
            if register_hotkey_win32(hotkey, callback):
                print(f"[hotkey] registered '{hotkey}' via Win32")
                return True
        except Exception as e:
            print(f"[hotkey] Win32 path errored: {e}")
        # Fall through to pynput as last resort on Windows
        return _register_pynput(hotkey, callback)

    # Mac + Linux + any other Unix
    return _register_pynput(hotkey, callback)
