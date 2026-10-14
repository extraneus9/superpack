"""
Global hotkey via the Win32 RegisterHotKey API.

More robust than the third-party `keyboard` library for Windows: registers
directly with the OS, survives focus changes, sleep/wake, and per-app focus
hijacks. The `keyboard` lib was occasionally losing its low-level hook silently
after certain apps stole input (browsers, games, full-screen apps).

Usage:
    register_hotkey_win32("ctrl+alt+w", callback)

The callback is invoked on the worker thread that owns the message pump —
marshal back to the main thread if needed.
"""

from __future__ import annotations

import ctypes
import threading
from ctypes import wintypes
from typing import Callable

user32 = ctypes.windll.user32

# Modifier flags
_MOD = {
    "ctrl": 0x0002, "control": 0x0002,
    "alt": 0x0001,
    "shift": 0x0004,
    "win": 0x0008, "super": 0x0008, "meta": 0x0008,
}
MOD_NOREPEAT = 0x4000

WM_HOTKEY = 0x0312

# Virtual-Key codes for special keys
_VK = {
    "space": 0x20, "enter": 0x0D, "return": 0x0D, "tab": 0x09, "esc": 0x1B, "escape": 0x1B,
    "backspace": 0x08, "insert": 0x2D, "delete": 0x2E, "home": 0x24, "end": 0x23,
    "pageup": 0x21, "pagedown": 0x22, "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
    "capslock": 0x14, "numlock": 0x90, "scrolllock": 0x91,
    "printscreen": 0x2C, "pause": 0x13,
}


def parse_hotkey(s: str) -> tuple[int, int]:
    """Parse 'ctrl+alt+w' → (modifiers, virtual_key)."""
    parts = [p.strip().lower() for p in s.split("+")]
    mods = 0
    key = None
    for p in parts:
        if p in _MOD:
            mods |= _MOD[p]
        else:
            if key is not None:
                raise ValueError(f"multiple non-modifier keys in '{s}': {key} and {p}")
            key = p
    if not key:
        raise ValueError(f"no key in hotkey: '{s}'")

    if len(key) == 1:
        # Letters and digits use their ASCII uppercase value as VK code
        vk = ord(key.upper())
    elif key.startswith("f") and key[1:].isdigit():
        n = int(key[1:])
        if not 1 <= n <= 24:
            raise ValueError(f"function key out of range: {key}")
        vk = 0x70 + (n - 1)
    elif key in _VK:
        vk = _VK[key]
    else:
        raise ValueError(f"unknown key in hotkey: '{key}'")

    return mods | MOD_NOREPEAT, vk


def register_hotkey_win32(hotkey: str, callback: Callable[[], None]) -> bool:
    """Register a system-wide hotkey. Returns True on success.
    Spawns a daemon worker that pumps WM_HOTKEY messages and calls `callback`.
    """
    try:
        mods, vk = parse_hotkey(hotkey)
    except ValueError as e:
        print(f"[hotkey] parse error: {e}")
        return False

    ready = threading.Event()
    result = {"ok": False}

    def _pump():
        # Each thread needs its own hotkey registration (Win32 ties them to the
        # registering thread's message queue).
        hotkey_id = 1
        if not user32.RegisterHotKey(None, hotkey_id, mods, vk):
            err = ctypes.get_last_error()
            print(f"[hotkey] RegisterHotKey failed for '{hotkey}' (err={err})")
            ready.set()
            return
        result["ok"] = True
        ready.set()

        msg = wintypes.MSG()
        try:
            while True:
                ret = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
                if ret in (0, -1):
                    break
                if msg.message == WM_HOTKEY and msg.wParam == hotkey_id:
                    try:
                        callback()
                    except Exception as e:
                        print(f"[hotkey] callback raised: {e}")
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))
        finally:
            user32.UnregisterHotKey(None, hotkey_id)

    threading.Thread(target=_pump, daemon=True, name="hotkey-pump").start()
    ready.wait(timeout=2.0)
    return result["ok"]
