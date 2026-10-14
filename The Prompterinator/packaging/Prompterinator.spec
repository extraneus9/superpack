# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec — The Prompterinator (app + local voice engine).
Build:  pyinstaller --noconfirm packaging/Prompterinator.spec
Out:    dist/Prompterinator/Prompterinator.exe   (one-folder = fast start)
"""
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_submodules, collect_dynamic_libs
import os

ROOT = Path(SPECPATH).parent
GPU = os.environ.get("PROMPTER_GPU", "0") == "1"          # PROMPTER_GPU=1 bundles the CUDA runtime (~2 GB)

hiddenimports = []
hiddenimports += collect_submodules("faster_whisper")
hiddenimports += collect_submodules("ctranslate2")
hiddenimports += collect_submodules("sounddevice")
hiddenimports += collect_submodules("websockets")
hiddenimports += ["onnxruntime", "numpy"]

datas = []
datas += [(str(ROOT / "server" / "app" / "index.html"), "app")]
datas += [(str(ROOT / "server" / "README.md"), ".")]
datas += collect_data_files("faster_whisper", includes=["**/*.onnx", "**/*.json"])

binaries = []
binaries += collect_dynamic_libs("ctranslate2")
binaries += collect_dynamic_libs("onnxruntime")
if GPU:
    try:
        import nvidia
        nv = Path(nvidia.__path__[0])
        for sub in ("cublas", "cudnn", "cuda_runtime", "cuda_nvrtc"):
            d = nv / sub / "bin"
            if d.is_dir():
                binaries += [(str(x), ".") for x in d.glob("*.dll")]
    except ImportError:
        pass

a = Analysis([str(ROOT / "packaging" / "app_main.py")],
             pathex=[str(ROOT / "server")], binaries=binaries, datas=datas,
             hiddenimports=hiddenimports, hookspath=[], runtime_hooks=[],
             excludes=["tkinter", "matplotlib", "PySide6", "PyQt5", "scipy", "pandas", "IPython"],
             noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="Prompterinator",
          debug=False, strip=False, upx=False, console=True,
          icon=str(ROOT / "packaging" / "icon.ico"))
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="Prompterinator")
