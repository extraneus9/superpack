# -*- coding: utf-8 -*-
"""The Prompterinator — frozen entry point. Starts the local engine and opens the app window."""
import os, sys, subprocess, threading, time, webbrowser, io

if getattr(sys, "frozen", False):
    BASE = sys._MEIPASS
    HOME = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "The Prompterinator")
    os.makedirs(HOME, exist_ok=True)
    sys.path.insert(0, BASE)
else:
    BASE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server")
    HOME = BASE
    sys.path.insert(0, BASE)

import voice_server as VS
VS.APP_DIR = os.path.join(BASE, "app")
VS.CONFIG_PATH = os.path.join(HOME, "config.json")

def open_app_window(url):
    for p in (os.environ.get("ProgramFiles", ""), os.environ.get("ProgramFiles(x86)", ""), os.environ.get("LOCALAPPDATA", "")):
        for exe in (r"Google\Chrome\Application\chrome.exe", r"Microsoft\Edge\Application\msedge.exe"):
            full = os.path.join(p, exe)
            if p and os.path.exists(full):
                try:
                    subprocess.Popen([full, f"--app={url}", "--new-window", "--window-size=1440,900"])
                    return True
                except Exception:
                    pass
    try:
        webbrowser.open(url); return True
    except Exception:
        return False

def msgbox(title, text):
    try:
        import ctypes; ctypes.windll.user32.MessageBoxW(0, text, title, 0x10)
    except Exception:
        print(title, text)

def main():
    cfg = VS.load_config()
    # already running? just bring that one up instead of failing on a busy port
    existing = VS.already_running(cfg["http_port"])
    if existing:
        open_app_window(existing)
        print("The Prompterinator is already running — opened its window."); time.sleep(2); return
    cfg["open_browser"] = False
    try:
        os.system("title The Prompterinator - engine")
    except Exception:
        pass
    VS.serve_app(cfg)
    url = f'http://127.0.0.1:{cfg["http_port"]}/index.html'
    threading.Thread(target=lambda: (time.sleep(1.2), open_app_window(url)), daemon=True).start()
    print("=" * 58)
    print("  THE PROMPTERINATOR — local engine")
    print(f"  App:   {url}")
    print(f"  Voice: ws://127.0.0.1:{cfg['ws_port']}  (offline speech)")
    print("  Keep this window open while you use the prompter.")
    print("=" * 58)
    import asyncio, traceback
    try:
        asyncio.run(VS.main_async(cfg, False))
    except KeyboardInterrupt:
        pass
    except Exception:
        err = traceback.format_exc()
        try:
            log = os.path.join(HOME, "error.log")
            with open(log, "w", encoding="utf-8") as f: f.write(err)
        except Exception:
            log = "(could not write a log)"
        print(err)
        msgbox("The Prompterinator — problem starting",
               "The prompter could not start.\n\n" + err.strip().splitlines()[-1] +
               f"\n\nDetails: {log}\n\nTip: close any other copy of The Prompterinator and try again.")

if __name__ == "__main__":
    main()
