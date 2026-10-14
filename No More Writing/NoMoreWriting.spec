# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for No More Writing.

Build:
    pyinstaller --noconfirm NoMoreWriting.spec

Output: dist/NoMoreWriting/NoMoreWriting.exe (one-folder mode, faster startup).
"""

from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_submodules, collect_dynamic_libs

ROOT = Path(SPECPATH)

# --- Hidden imports ---------------------------------------------------------

hiddenimports = []
# faster-whisper pulls in ctranslate2 + tokenizers + onnxruntime (silero VAD)
hiddenimports += collect_submodules("faster_whisper")
hiddenimports += collect_submodules("ctranslate2")
hiddenimports += ["onnxruntime"]
hiddenimports += collect_submodules("sounddevice")
hiddenimports += ["keyboard", "pyperclip", "ollama"]
hiddenimports += collect_submodules("PIL")
hiddenimports += ["customtkinter"]
# PySide6 essentials for the overlay
hiddenimports += [
    "PySide6.QtCore", "PySide6.QtGui", "PySide6.QtWidgets",
]

# --- Data files -------------------------------------------------------------

datas = []
datas += [("assets/icon.ico", "assets")]
for s in (16, 24, 32, 48, 64, 128, 256):
    datas += [(f"assets/icon_{s}.png", "assets")]
datas += [("config.default.json", ".")]  # clean defaults; the user's own config.json is created in %APPDATA% on first run

# faster-whisper bundles a silero VAD ONNX model; collect it
datas += collect_data_files("faster_whisper", includes=["**/*.onnx", "**/*.json"])

# ctranslate2 ships compiled DLLs that PyInstaller's binary collection should grab.
binaries = []
binaries += collect_dynamic_libs("ctranslate2")
binaries += collect_dynamic_libs("onnxruntime")

# Pull in CUDA DLLs from the pip-installed nvidia/* packages (Windows only).
try:
    import nvidia
    nvidia_root = Path(nvidia.__path__[0])
    for sub in ("cublas", "cudnn", "cuda_runtime", "cuda_nvrtc"):
        bin_dir = nvidia_root / sub / "bin"
        if bin_dir.is_dir():
            for dll in bin_dir.glob("*.dll"):
                # Place at root of dist so DLL search finds them
                binaries.append((str(dll), "."))
except ImportError:
    pass


# --- Analysis ---------------------------------------------------------------

a = Analysis(
    ["app.py"],
    pathex=[str(ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Drop unused heavy packages that get pulled in transitively
        "matplotlib", "scipy", "pandas", "notebook", "jupyter",
        "torch", "tensorflow", "transformers",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="NoMoreWriting",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,                 # UPX would compress but UPX-packed binaries are heavily AV-flagged
    console=False,             # GUI app - no console window
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon="assets/icon.ico",
    version="version_info.txt",  # Windows VERSIONINFO resource - identifies publisher
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="NoMoreWriting",
)
