"""Sentinel path resolution — works both in development and as a frozen .exe.

  BUNDLE : read-only resources shipped with the app (rules.json, webui, builtin YARA).
           = the PyInstaller temp dir when frozen, the repo root in development.
  DATA   : writable per-user state (quarantine, settings, history, cache, fetched YARA).
           = %LOCALAPPDATA%\\Sentinel when frozen, the repo root in development.

Keeping these separate is what lets the shared .exe run from anywhere (even read-only
Program Files) while still saving quarantine/settings to a writable place.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

FROZEN = getattr(sys, "frozen", False)


def _user_data_dir() -> Path:
    """Per-user writable app dir, per OS: %LOCALAPPDATA% (Windows),
    ~/Library/Application Support (macOS), $XDG_DATA_HOME or ~/.local/share (Linux)."""
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home())
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share"))
    return base / "Sentinel"


if FROZEN:
    BUNDLE = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    DATA = _user_data_dir()
    try:
        DATA.mkdir(parents=True, exist_ok=True)
    except OSError:
        DATA = Path.home() / ".sentinel"
        DATA.mkdir(parents=True, exist_ok=True)
else:
    BUNDLE = Path(__file__).resolve().parent.parent  # repo root
    DATA = BUNDLE


def open_path(p) -> None:
    """Open a file or folder in the OS default handler (Explorer/Finder/xdg), cross-platform."""
    import subprocess
    p = str(p)
    try:
        if sys.platform == "win32":
            os.startfile(p)  # type: ignore[attr-defined]  # noqa: S606
        elif sys.platform == "darwin":
            subprocess.run(["open", p], check=False)
        else:
            subprocess.run(["xdg-open", p], check=False)
    except Exception:
        pass
