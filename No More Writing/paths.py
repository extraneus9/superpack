"""Where No More Writing keeps its files.

Running from source (the author's own copy): everything stays next to the code, exactly as before.
Installed (frozen .exe, e.g. from superpack): the install folder is read-only Program Files, so the user's
settings and dictation history live in %APPDATA%\\NoMoreWriting. A first run starts CLEAN from the bundled
config.default.json — nobody else's settings, vocabulary, microphone or history ever ship.
"""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

FROZEN = bool(getattr(sys, "frozen", False))
# bundled, read-only files (assets, config.default.json): _internal\ when frozen, the source folder otherwise
ROOT = Path(__file__).parent
# the folder the .exe sits in (superpack drops a superpack.json here)
APP_DIR = Path(sys.executable).parent if FROZEN else ROOT
USER_DIR = (Path(os.environ.get("APPDATA") or Path.home()) / "NoMoreWriting") if FROZEN else ROOT
PACKED = (APP_DIR / "superpack.json").exists()


def ensure_user_config() -> Path:
    """Return the config path; on an installed copy's first run, seed it from the clean default."""
    cfg = USER_DIR / "config.json"
    if FROZEN and not cfg.exists():
        USER_DIR.mkdir(parents=True, exist_ok=True)
        default = ROOT / "config.default.json"
        if default.exists():
            shutil.copyfile(default, cfg)
    return cfg
