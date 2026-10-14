"""
Cross-platform shims for tiny OS-bound operations.

Windows uses winsound.PlaySound (pre-rendered tones) + the `keyboard` lib for paste; macOS has neither.
This module isolates the platform branching so engine.py stays clean.
"""

from __future__ import annotations

import os
import sys
import threading
from typing import Callable

IS_WIN = sys.platform == "win32"
IS_MAC = sys.platform == "darwin"
IS_LINUX = sys.platform.startswith("linux")


# ---------- Beeps ----------

if IS_WIN:
    import winsound  # type: ignore[import-not-found]

    import math
    import struct
    import wave
    from pathlib import Path

    # winsound.Beep() goes through Windows' emulated beep path, which degrades
    # (crackle, clipped attack, wrong pitch) after long uptime / audio-device sleep.
    # Instead render each tone once to a small WAV with a soft envelope and play it
    # through the normal audio stack with PlaySound — same pitch/length, clean every time.
    _TONE_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "NoMoreWriting" / "tones"
    _TONE_RATE = 44100
    _TONE_LEAD_MS = 12      # silence so a waking output device doesn't swallow the attack
    _tone_cache: dict[tuple[int, int], str] = {}
    _tone_lock = threading.Lock()

    def _render_tone(freq: int, dur_ms: int) -> str:
        key = (freq, dur_ms)
        with _tone_lock:
            path = _tone_cache.get(key)
            if path:
                return path
            _TONE_DIR.mkdir(parents=True, exist_ok=True)
            out = _TONE_DIR / f"tone_{freq}_{dur_ms}_v1.wav"
            if not out.exists():
                n = int(_TONE_RATE * dur_ms / 1000)
                lead = int(_TONE_RATE * _TONE_LEAD_MS / 1000)
                attack = max(1, int(_TONE_RATE * 0.004))
                release = max(1, min(n // 2, int(_TONE_RATE * 0.025)))
                frames = bytearray(struct.pack("<h", 0) * lead)
                for i in range(n):
                    env = min(1.0, i / attack, (n - i) / release)
                    v = 0.32 * env * math.sin(2 * math.pi * freq * i / _TONE_RATE)
                    frames += struct.pack("<h", int(v * 32767))
                tmp = out.with_suffix(".tmp")
                with wave.open(str(tmp), "wb") as w:
                    w.setnchannels(1)
                    w.setsampwidth(2)
                    w.setframerate(_TONE_RATE)
                    w.writeframes(bytes(frames))
                os.replace(tmp, out)
            _tone_cache[key] = str(out)
            return str(out)

    def _beep_native(freq: int, dur_ms: int):
        try:
            winsound.PlaySound(
                _render_tone(freq, dur_ms),
                winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT,
            )
        except Exception:
            try:
                winsound.Beep(freq, dur_ms)
            except RuntimeError:
                pass

    def prerender_beeps(tones=((880, 80), (660, 80), (330, 60), (220, 220), (220, 200))):
        """Write the tone WAVs at startup so the first beep has no render delay."""
        for f, d in tones:
            try:
                _render_tone(f, d)
            except Exception:
                pass

elif IS_MAC:
    # macOS has no frequency-controllable beep without going through AVFoundation.
    # The system sound is good enough; map our 3 distinct beeps to 3 distinct system aiffs
    # so the user still gets aural feedback for start/stop/error.
    _MAC_SOUND_FOR_FREQ = {
        880: "/System/Library/Sounds/Tink.aiff",      # start recording (bright)
        660: "/System/Library/Sounds/Pop.aiff",       # stop recording (mid)
        330: "/System/Library/Sounds/Bottle.aiff",    # cancel (low)
        220: "/System/Library/Sounds/Funk.aiff",      # error (low)
    }

    def _beep_native(freq: int, dur_ms: int):
        sound = _MAC_SOUND_FOR_FREQ.get(freq, "/System/Library/Sounds/Tink.aiff")
        # afplay returns immediately on stdin/stdout, plays in background.
        os.system(f"afplay '{sound}' >/dev/null 2>&1 &")

else:
    def _beep_native(freq: int, dur_ms: int):
        # Linux / fallback: print bell char. Better than silently doing nothing.
        sys.stdout.write("\a")
        sys.stdout.flush()


if not IS_WIN:
    def prerender_beeps(*_a, **_k):
        pass


def beep(freq: int, dur_ms: int, enabled: bool = True):
    """Non-blocking beep — runs on a daemon thread so the audio call never adds latency to the flow."""
    if not enabled:
        return
    threading.Thread(target=_beep_native, args=(freq, dur_ms), daemon=True).start()


# ---------- Synthetic paste ----------
#
# Both backends rely on the clipboard already containing the text. They issue the
# OS-native paste shortcut to the focused app.

def _paste_win(delay_ms: int = 50):
    import keyboard  # type: ignore[import-not-found]
    import time as _time
    if delay_ms:
        _time.sleep(delay_ms / 1000.0)
    keyboard.send("ctrl+v")


def _paste_mac(delay_ms: int = 50):
    # pynput is the cross-platform paste backend on macOS. It needs Accessibility
    # permission — the first time the user hits the hotkey, macOS prompts them.
    from pynput.keyboard import Key, Controller  # type: ignore[import-not-found]
    import time as _time
    if delay_ms:
        _time.sleep(delay_ms / 1000.0)
    kbd = Controller()
    with kbd.pressed(Key.cmd):
        kbd.press("v")
        kbd.release("v")


def _paste_linux(delay_ms: int = 50):
    # Same pynput path but with ctrl instead of cmd.
    from pynput.keyboard import Key, Controller  # type: ignore[import-not-found]
    import time as _time
    if delay_ms:
        _time.sleep(delay_ms / 1000.0)
    kbd = Controller()
    with kbd.pressed(Key.ctrl):
        kbd.press("v")
        kbd.release("v")


def send_paste_shortcut(delay_ms: int = 50):
    """Send Ctrl+V (Win/Linux) or Cmd+V (Mac) to the focused app."""
    if IS_WIN:
        _paste_win(delay_ms)
    elif IS_MAC:
        _paste_mac(delay_ms)
    else:
        _paste_linux(delay_ms)


# ---------- Per-process app identifier (Windows taskbar grouping) ----------

def set_app_user_model_id(app_id: str):
    """Windows-only — tells the OS this process belongs to our taskbar group so the
    pinned-icon and jump-list logic find us. Silent no-op on Mac/Linux."""
    if not IS_WIN:
        return
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(app_id)
    except Exception as e:
        print(f"[platform] AppUserModelID failed: {e}")


# ---------- Subprocess flags (hide consoles on Windows) ----------

def subprocess_creationflags() -> int:
    """Return CREATE_NO_WINDOW on Windows, 0 elsewhere — pass to subprocess.Popen(creationflags=...)."""
    if IS_WIN:
        import subprocess
        return subprocess.CREATE_NO_WINDOW
    return 0
