SENTINEL — free antivirus by ALVA
==================================

Real-time protection for your Windows PC. Free. No subscription, ever.

WHAT IT DOES
- Real-time protection: scans files the moment they're written and quarantines malware.
- Safe Install: drop an installer in, and Sentinel scans it before you ever run it.
- On-demand scans: Quick, Full, or scan a single file or folder.
- 90 built-in detections (signatures + heuristics + a ransomware-behavior monitor).
- Optional VirusTotal cloud reputation (~70 engines) — add your own free key (see below).

HOW TO INSTALL / RUN
1. Right-click "Install Sentinel.ps1" -> "Run with PowerShell"   (or just double-click Sentinel.exe).
2. Windows may warn it's from an unknown publisher — this is a small free app, not code-signed.
   Click "More info" -> "Run anyway". (Your own antivirus may also ask you to allow it once.)
3. Sentinel opens its dashboard and adds a red eye icon to your system tray (bottom-right).
4. It watches the folder  Documents\Sentinel Watch  — drop a file there to see it scanned instantly.

TURN ON VIRUSTOTAL  (optional, free, big detection boost)
1. Get a free API key:  https://www.virustotal.com/gui/join-us
2. Make a plain text file containing ONLY your key, saved as:
       %LOCALAPPDATA%\Sentinel\vt_key.txt
   (paste that path into the File Explorer address bar; the Sentinel folder appears after first run)
3. Restart Sentinel. The dashboard will show "VirusTotal on".
   Your key never leaves your PC. Sentinel only sends a file's HASH to VirusTotal — never your files.

FULL YARA COVERAGE  (optional, advanced)
Sentinel ships with a starter rule set. To add the large community rule pack (~12,000 rules),
drop .yar / .yara files into:
       %LOCALAPPDATA%\Sentinel\yara_rules\
and restart. (Community rules are third-party, so they're not bundled here.)

PRIVACY
Sentinel runs entirely on your PC. It never uploads your files. The only network call is an
optional file-hash lookup to VirusTotal, and only if you add your own key.

Free forever. Share it.
