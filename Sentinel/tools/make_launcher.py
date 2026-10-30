"""Build Sentinel's desktop-app launcher pieces:

  * assets/sentinel.ico  — the eye icon (multi-size)
  * Sentinel.vbs         — a silent launcher (starts the tray with no console window)

Run:  python tools/make_launcher.py
Then create a shortcut to Sentinel.vbs (the make_shortcut PowerShell step does this).
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from sentinel.tray import make_icon

ASSETS = ROOT / "assets"
ASSETS.mkdir(exist_ok=True)


def build_ico() -> Path:
    base = make_icon(256)
    out = ASSETS / "sentinel.ico"
    base.save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    return out


def build_vbs() -> Path:
    pythonw = sys.executable.replace("python.exe", "pythonw.exe")
    projdir = str(ROOT)
    vbs = (
        'Set sh = CreateObject("WScript.Shell")\r\n'
        f'sh.CurrentDirectory = "{projdir}"\r\n'
        f'sh.Run """{pythonw}"" -m sentinel.tray", 0, False\r\n'
    )
    out = ROOT / "Sentinel.vbs"
    out.write_text(vbs, encoding="utf-8")
    return out


def main():
    ico = build_ico()
    vbs = build_vbs()
    print("icon:   ", ico)
    print("launcher:", vbs)


if __name__ == "__main__":
    main()
