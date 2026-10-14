"""Add CUDA DLLs from pip-installed nvidia packages to the DLL search path.

Must run BEFORE `from faster_whisper import WhisperModel`.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def bootstrap() -> bool:
    """Add nvidia/*/bin folders to PATH and os.add_dll_directory. Return True if CUDA libs found."""
    try:
        import nvidia  # noqa: F401
    except ImportError:
        return False

    site = Path(nvidia.__path__[0])
    needed = ["cublas", "cudnn", "cuda_runtime", "cuda_nvrtc"]
    added = 0
    for sub in needed:
        bin_dir = site / sub / "bin"
        if bin_dir.is_dir():
            os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")
            try:
                os.add_dll_directory(str(bin_dir))
                added += 1
            except (AttributeError, OSError):
                pass
    return added > 0


if __name__ == "__main__":
    ok = bootstrap()
    print(f"cuda bootstrap: {'ok' if ok else 'no nvidia libs found'}")
    # Smoke test
    try:
        import ctranslate2
        print(f"  ctranslate2: {ctranslate2.__version__}  cuda devices: {ctranslate2.get_cuda_device_count()}")
    except Exception as e:
        print(f"  ctranslate2 failed: {e}")
