# No More Writing

Press a key, talk, and your words are typed into any app. Local and private: Whisper for speech, Ollama for tidying.
Made by alva.

## Run it from source
You need [Python](https://python.org) 3.10+ (Windows; an NVIDIA card makes it much faster) and
[Ollama](https://ollama.com) for text tidying (optional):

    pip install -r requirements.txt
    ollama pull gemma3:4b
    python app.py

Your settings are created from `config.default.json` the first time it runs.

## Build your own .exe
    pip install pyinstaller
    pyinstaller --noconfirm NoMoreWriting.spec

## Where things are
- `app.py` — the window, settings and the dictation flow
- `engine.py` — recording, Whisper, the cleanup pass
- `structure.py` — lists, paragraphs and line breaks from what you say
- `overlay_qt.py`, `overlay_config.py` — the floating recording overlay

Change anything you like — that's the point.
