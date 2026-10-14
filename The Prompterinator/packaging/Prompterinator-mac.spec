# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec — The Prompterinator for macOS (Apple Silicon), built on a Mac (GitHub Actions in superpack).
Build:  pyinstaller --noconfirm packaging/Prompterinator-mac.spec
Out:    dist/The Prompterinator.app   (unsigned on purpose; ad-hoc signed by the build so Apple Silicon runs it)
"""
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_submodules, collect_dynamic_libs

ROOT = Path(SPECPATH).parent

hiddenimports = []
hiddenimports += collect_submodules("faster_whisper")
hiddenimports += collect_submodules("ctranslate2")
hiddenimports += collect_submodules("sounddevice")
hiddenimports += collect_submodules("websockets")
hiddenimports += ["onnxruntime", "numpy"]

datas = []
datas += [(str(ROOT / "server" / "app" / "index.html"), "app")]
datas += collect_data_files("faster_whisper", includes=["**/*.onnx", "**/*.json"])

binaries = []
binaries += collect_dynamic_libs("ctranslate2")
binaries += collect_dynamic_libs("onnxruntime")
binaries += collect_dynamic_libs("sounddevice")  # _sounddevice_data/portaudio-binaries/libportaudio.dylib

a = Analysis([str(ROOT / "packaging" / "app_main.py")],
             pathex=[str(ROOT / "server")], binaries=binaries, datas=datas,
             hiddenimports=hiddenimports, hookspath=[], runtime_hooks=[],
             excludes=["tkinter", "matplotlib", "PySide6", "PyQt5", "scipy", "pandas", "IPython"],
             noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="Prompterinator",
          debug=False, strip=False, upx=False, console=False, argv_emulation=False,
          icon=str(ROOT / "packaging" / "icon.icns"))
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="Prompterinator")
app = BUNDLE(
    coll,
    name="The Prompterinator.app",
    icon=str(ROOT / "packaging" / "icon.icns"),
    bundle_identifier="app.alva.prompterinator",
    info_plist={
        "CFBundleName": "The Prompterinator",
        "CFBundleDisplayName": "The Prompterinator",
        "CFBundleShortVersionString": "1.0.0",
        "NSHighResolutionCapable": True,
        # without this line macOS refuses the microphone (voice follow)
        "NSMicrophoneUsageDescription": "The Prompterinator listens on your Mac to follow your place in the script. Nothing leaves your computer.",
    },
)
