# The Prompterinator

A teleprompter that follows your voice. The voice part runs on your own PC (faster-whisper); nothing goes online.
Made by alva.

## Run it from source
You need [Python](https://python.org) 3.10+ and Chrome or Edge.

    pip install -r server/requirements.txt
    python server/voice_server.py      # serves the app on http://127.0.0.1:8787 and opens the voice engine

Then open http://127.0.0.1:8787 in Chrome or Edge.

## Build your own .exe
    pip install pyinstaller
    pyinstaller --noconfirm packaging/Prompterinator.spec

## Where things are
- `server/app/index.html` — the whole teleprompter (interface, settings, file import) in one readable file
- `server/voice_server.py` — the local voice engine (speech → where you are in the script)
- `packaging/` — the entry point and PyInstaller recipe for the .exe

Change anything you like — that's the point.
