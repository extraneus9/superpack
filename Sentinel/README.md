# Sentinel

A free antivirus that catches and quarantines real malware. Sentinel scans files and folders, watches for threats as
they land, and moves anything dangerous out of reach — no account, no telemetry, nothing uploaded unless you ask.
Windows. Made by the author.

A plain Python engine does the work: content signatures, a set of built-in rules, and (optionally) a large community
threat-rule pack it fetches on demand. It never replaces Windows Security — run it alongside.

## Build it

    powershell -ExecutionPolicy Bypass -File tools/build_exe.ps1   # → dist/Sentinel.exe (PyInstaller, one file)

Needs Python 3.10+ and the packages in `requirements.txt`. On a Mac, `tools/build_mac.sh` builds the same app.

## Use it without the app

    python run_sentinel.py --scan "C:\path\to\folder"     # scan a file or folder
    python run_sentinel.py --guard "C:\path\to\Downloads" # watch a folder in real time

## The online check (optional)

The online check compares a file's fingerprint against 70+ engines through VirusTotal. It's off until you paste your
own free key into `VT_API_KEY.default` (rename it, or set the `VT_API_KEY` environment variable). No key is ever
shipped, and nothing is sent anywhere until you add one.

## Where things are
- `sentinel/scanner.py` — the engine: hashes, content rules, archive handling, verdicts
- `sentinel/realtime.py` — the real-time guard: watches a folder, scans on write, acts on a burst
- `sentinel/respond.py` — active response: finds the process behind a threat, stops it and quarantines it
- `sentinel/intel.py` — the optional VirusTotal check (your own key)
- `sentinel/yara_engine.py` — the optional community rule pack
- `sentinel/webapp.py`, `webui/` — the dashboard window
- `sentinel/paths.py` — where data and quarantine live (per user, writable)
- `run_sentinel.py` — the command line, the launcher and the headless scan/guard/safe-run modes

Change anything you like — that's the point.
