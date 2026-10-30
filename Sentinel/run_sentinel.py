"""Entry point for the packaged Sentinel app (what PyInstaller builds into Sentinel.exe).

Normally launches the tray + real-time protection + dashboard. Also supports headless modes
that work in a bare environment (no window, no console) — each writes a report file and opens
it, so they run inside a Windows Sandbox where the WebView2 dashboard won't render:

    Sentinel.exe --scan C:\\samples
    Sentinel.exe --guard C:\\watchme --duration 30
    Sentinel.exe --safe-run C:\\downloads\\installer.exe
    Sentinel.exe --safe-run C:\\samples\\thing.exe --detonate --duration 45   (SANDBOX ONLY: runs it)
"""
import sys


def _arg(name, default=None):
    if name in sys.argv:
        i = sys.argv.index(name)
        return sys.argv[i + 1] if len(sys.argv) > i + 1 else default
    return default


def _full_scanner():
    """A scanner wired to the full stack: VirusTotal (if a key is set) + whatever YARA is present."""
    from sentinel.scanner import Scanner
    from sentinel.intel import VirusTotalIntel
    intel = VirusTotalIntel(allow_network=True)
    return Scanner(intel=intel if intel.enabled else None)


def _engine_line(scanner) -> str:
    yc = len(scanner.yara.rule_names) if (scanner.yara and scanner.yara.active) else 0
    vt = "on" if (scanner.intel and scanner.intel.online) else "off"
    return f"yara_rules: {yc}    virustotal: {vt}"


def _write_open(out, report: str) -> None:
    import os
    try:
        out.write_text(report, encoding="utf-8")
        if os.name == "nt":
            os.startfile(str(out))
    except OSError:
        print(report)


def _headless_scan(target: str) -> int:
    import time
    from pathlib import Path
    root = Path(target)
    scanner = _full_scanner()
    files = [root] if root.is_file() else [p for p in root.rglob("*") if p.is_file()]

    counts = {"MALICIOUS": 0, "SUSPICIOUS": 0, "CLEAN": 0}
    lines, t0 = [], time.time()
    for p in files:
        r = scanner.scan_file(p)
        counts[r.verdict] = counts.get(r.verdict, 0) + 1
        if r.verdict != "CLEAN":
            rules = ", ".join(f.rule for f in r.findings[:5])
            lines.append(f"[{r.verdict}] {r.malware_class} - {r.category}  ::  {p.name}\n      {rules}")

    n = len(files)
    flagged = counts["MALICIOUS"] + counts["SUSPICIOUS"]
    header = [
        "SENTINEL scan report",
        f"Folder:    {root}",
        f"Scanned:   {n}   in {time.time()-t0:.1f}s",
        f"Malicious: {counts['MALICIOUS']}    Suspicious: {counts['SUSPICIOUS']}    Clean: {counts['CLEAN']}",
        f"Detection: {(flagged/n*100 if n else 0):.1f}%  ({flagged} of {n} flagged)",
        _engine_line(scanner),
        "-" * 60,
    ]
    report = "\n".join(header + (lines or ["Nothing flagged."]))
    out = (root.parent if root.is_file() else root) / "sentinel_report.txt"
    _write_open(out, report)
    return 0


def _seed_bait(folder, n: int = 24) -> None:
    """Fill a folder with decoy documents + canary tripwires so a running sample has bait."""
    folder.mkdir(parents=True, exist_ok=True)
    body = b"Quarterly report and personal records. " * 300
    for i in range(n):
        try:
            (folder / f"document_{i:02d}.docx").write_bytes(body)
            (folder / f"photo_{i:02d}.jpg").write_bytes(body)
        except OSError:
            pass
    for i in range(4):
        try:
            (folder / f"__sentinel_canary_{i}.txt").write_text("do not touch", encoding="utf-8")
        except OSError:
            pass


def _headless_guard(folder: str, seconds: int) -> int:
    """Real-time watch for a fixed window: scan-on-write + ransomware/behavior alerts -> report."""
    import time
    from pathlib import Path
    from sentinel.monitor import Monitor
    root = Path(folder)
    root.mkdir(parents=True, exist_ok=True)
    scanner = _full_scanner()
    mon = Monitor(root, scanner=scanner).start()
    t0 = time.time()
    try:
        while time.time() - t0 < (seconds or 30):
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    mon.stop()
    header = [
        "SENTINEL real-time guard report",
        f"Watched:   {root}   for {int(time.time()-t0)}s",
        _engine_line(scanner),
        f"Alerts:    {len(mon.alerts)}",
        "-" * 60,
    ]
    lines = [f"[{a.kind}] {a.detail}" for a in mon.alerts] or \
            ["No real-time alerts (nothing written/changed in the window, or nothing flagged)."]
    _write_open(root / "sentinel_guard_report.txt", "\n".join(header + lines))
    return 0


def _extract_from_zip(zip_path):
    """Unpack an archive (incl. WinZip-AES 'infected' sample zips) and return the main payload
    file on disk, so Safe Install can scan AND run what's really inside. Returns None on failure."""
    from pathlib import Path
    try:
        import pyzipper as zmod
        Reader = zmod.AESZipFile
    except Exception:
        import zipfile as zmod
        Reader = zmod.ZipFile
    out = Path(zip_path).parent / (Path(zip_path).stem + "_unpacked")
    out.mkdir(parents=True, exist_ok=True)
    try:
        zf = Reader(str(zip_path))
    except Exception:
        return None
    extracted = []
    for m in zf.infolist():
        if m.is_dir():
            continue
        data = None
        for pwd in (None, b"infected", b"malware", b"virus"):
            try:
                if pwd is not None:
                    zf.setpassword(pwd)
                data = zf.read(m.filename)
                break
            except Exception:
                continue
        if data is None:
            continue
        safe = "".join(c for c in Path(m.filename).name if c not in '<>:"/\\|?*') or "payload.bin"
        # MalwareBazaar names the payload by its hash with no extension — give a PE one so it runs.
        if data[:2] == b"MZ" and Path(safe).suffix.lower() not in (".exe", ".dll", ".scr", ".com", ".msi"):
            safe += ".exe"
        p = out / safe
        try:
            p.write_bytes(data)
            extracted.append(p)
        except OSError:
            pass
    if not extracted:
        return None
    EXE = {".exe", ".dll", ".scr", ".com", ".msi", ".bat", ".cmd", ".ps1", ".vbs", ".js", ".hta"}
    exes = [p for p in extracted if p.suffix.lower() in EXE]
    return max(exes or extracted, key=lambda p: p.stat().st_size)


def _launch(path):
    """Run the sample and return a Popen handle, so the guard can kill it on detection."""
    import os
    import subprocess
    ext = path.suffix.lower()
    try:
        if ext in (".js", ".jse", ".wsf", ".vbs"):
            return subprocess.Popen(["wscript.exe", str(path)])
        if ext == ".ps1":
            return subprocess.Popen(["powershell.exe", "-ExecutionPolicy", "Bypass", "-File", str(path)])
        return subprocess.Popen([str(path)])            # exe/com/scr/bat/msi
    except Exception:
        try:
            os.startfile(str(path))                     # fallback: launched, but no handle to kill
        except Exception:
            pass
        return None


def _kill_tree(proc, also_names=()) -> list:
    """Terminate the launched process tree (+ known ransomware self-copy image names). SANDBOX ONLY."""
    import subprocess
    killed = []
    if proc is not None and proc.poll() is None:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        killed.append(f"pid {proc.pid}")
    for nm in also_names:
        if subprocess.run(["taskkill", "/IM", nm, "/T", "/F"], capture_output=True).returncode == 0:
            killed.append(nm)
    return killed


def _headless_safe_run(target: str, detonate: bool, watch, seconds: int) -> int:
    """Safe Install, headless: scan a file before it runs; with --detonate, also run it under the
    behavior monitor and report what it did at runtime (SANDBOX ONLY)."""
    import os
    import time
    from pathlib import Path
    from sentinel.monitor import Monitor
    tgt = orig = Path(target)
    unpacked_note = None
    if tgt.suffix.lower() in (".zip",):
        payload = _extract_from_zip(tgt)
        if payload is not None:
            unpacked_note = f"Unpacked {tgt.name}  ->  {payload.name}"
            tgt = payload
    scanner = _full_scanner()
    r = scanner.scan_file(tgt)
    block = r.verdict in ("MALICIOUS", "SUSPICIOUS")
    report = [
        "SENTINEL Safe Install report",
        f"File:      {tgt.name}",
        *([f"Source:    {unpacked_note}"] if unpacked_note else []),
        _engine_line(scanner),
        "-" * 60,
        "[1] Pre-install scan (what Safe Install does before letting anything run)",
        f"    Verdict:  {r.verdict}   ({r.malware_class} / {r.category}, confidence {r.confidence})",
        f"    Reasons:  " + (", ".join(f.rule for f in r.findings[:8]) or "none"),
        f"    Decision: " + ("BLOCK — Safe Install would refuse to install this file."
                             if block else "ALLOW — scan is clean, safe to install."),
    ]
    if detonate:
        bait = Path(watch) if watch else (Path.home() / "Documents" / "SentinelBait")
        _seed_bait(bait)
        report += ["", f"[2] Real-time detonation ({seconds}s cap) — SANDBOX ONLY: run it, watch, respond",
                   f"    Watching: {bait}  ({sum(1 for _ in bait.iterdir())} decoy/canary files as bait)"]
        from sentinel.scanner import Scanner as _Sc
        from sentinel.respond import neutralize, HAVE_PSUTIL
        guard_scanner = _Sc()   # local engine only (sigs + heuristics + YARA); VT's rate-limit
                                # must NEVER block the live guard, so no intel in the real-time path
        mon = Monitor(bait, scanner=guard_scanner).start()
        proc = _launch(tgt)   # deliberately run the sample so the guard can watch AND stop it
        t0 = time.time()
        responded_at = None
        neutral = {"killed": [], "quarantined": []}
        # RESPOND the instant ransomware behavior shows: find the process doing it (on our own,
        # NOT from the pid we launched), kill it, quarantine it. Retry until something is caught.
        while time.time() - t0 < (seconds or 60):
            time.sleep(0.25)
            if mon.alerts:
                if responded_at is None:
                    responded_at = time.time() - t0
                s = neutralize(bait, scanner=guard_scanner, since=t0 - 3, exclude_pids={os.getpid()})
                _kill_tree(proc, also_names=("drpbx.exe", "firefox.exe"))   # fallback for the launched tree
                for k in s["killed"]:
                    if k not in neutral["killed"]:
                        neutral["killed"].append(k)
                for q in s["quarantined"]:
                    if q not in neutral["quarantined"]:
                        neutral["quarantined"].append(q)
                if neutral["killed"]:
                    break
        mon.stop()
        _kill_tree(proc, also_names=("drpbx.exe", "firefox.exe"))   # ensure the launched tree is dead
        report.append(f"    Behavioral alerts: {len(mon.alerts)}")
        for a in mon.alerts:
            report.append(f"      [{a.kind}] {a.detail}")
        if not mon.alerts:
            report.append("      (none — sample stayed idle, needs network/C2, or never touched the bait)")
        if responded_at is not None:
            report.append(f"    DETECTED ransomware behavior {responded_at:.1f}s after launch.")
            report.append("    KILLED:      " + ("; ".join(neutral["killed"]) or "(process already exited)"))
            report.append("    QUARANTINED: " + ("; ".join(neutral["quarantined"]) or "(none)"))
            if not HAVE_PSUTIL:
                report.append("    (psutil not available — killed only the launched process tree)")
        else:
            report.append("    RESPONSE: nothing to stop (no behavior detected).")
    else:
        report += ["", "[2] Runtime watch skipped. Add --detonate to run it under the monitor (sandbox only)."]
    out = (orig.parent if orig.parent.exists() else Path.cwd()) / "safeinstall_report.txt"
    _write_open(out, "\n".join(report))
    return 0


def main():
    if "--scan" in sys.argv:
        return _headless_scan(_arg("--scan", "."))
    if "--guard" in sys.argv:
        return _headless_guard(_arg("--guard", "."), int(_arg("--duration", "30") or 30))
    if "--safe-run" in sys.argv:
        return _headless_safe_run(_arg("--safe-run", "."), "--detonate" in sys.argv,
                                  _arg("--watch"), int(_arg("--duration", "45") or 45))
    from sentinel.tray import main as tray_main
    return tray_main()


if __name__ == "__main__":
    raise SystemExit(main())
