"""Sentinel self-test — runs every harmless fixture against the scanner + monitor
and prints a scorecard. Exit code 0 only if every fixture matches its expectation.

Usage:  python run_tests.py
Writes all test files into a throwaway temp lab that is deleted afterwards.
"""
from __future__ import annotations

import hashlib
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sentinel import Scanner, Monitor
from sentinel.scanner import detection_catalog, SEV
import sim


def run_signature_pack(scanner: Scanner) -> list[tuple[str, bool, str]]:
    """Every rule in rules.json that ships a `sample` is scanned in memory and must fire at
    (or above) its declared severity. Proves each signature actually detects its own vector."""
    rules = [r for r in scanner.rules.get("patterns", [])
             if r.get("sample") is not None or r.get("sample_b64") is not None]
    passed, missed = 0, []
    import base64
    for r in rules:
        sample = (base64.b64decode(r["sample_b64"]).decode("latin-1")
                  if r.get("sample_b64") is not None else r["sample"])  # b64 keeps secret-shaped test
        data = sample.encode("latin-1", "ignore") if isinstance(sample, str) else sample  # vectors out of source
        got = scanner.scan_bytes(data, r.get("sample_name", "vector.bin")).verdict
        if SEV[got] >= SEV[r["severity"]]:
            passed += 1
        else:
            missed.append(f"{r['name']}={got}")
    detail = f"{passed}/{len(rules)} rules fired" + (f" | missed: {', '.join(missed)}" if missed else "")
    return [("signature_pack", passed == len(rules), detail)]


def run_static(scanner: Scanner, lab: Path) -> list[tuple[str, bool, str]]:
    rows = []
    for make in sim.STATIC_FIXTURES:
        fx = make(lab)
        if fx.get("allow_sha256"):
            scanner.rules.setdefault("_allow", set()).add(fx["allow_sha256"])
        want = fx["expect_static"]
        if fx.get("mem") is not None:
            got = scanner.scan_bytes(fx["mem"], fx["mem_name"]).verdict
            rows.append((fx["name"], got == want, f"mem -> {got} (want {want})"))
        else:
            verdicts = [scanner.scan_file(f).verdict for f in fx["files"]]
            if want == "CLEAN":
                ok = all(v == "CLEAN" for v in verdicts)
            else:
                ok = any(v == want for v in verdicts)
            rows.append((fx["name"], ok, f"{verdicts} (want {want})"))
    return rows


def run_yara(scanner: Scanner) -> list[tuple[str, bool, str]]:
    if not (scanner.yara and scanner.yara.active):
        return [("yara_match", True, "SKIPPED — yara not installed")]
    r = scanner.scan_bytes(b"ref: YARA-LAB-SENTINEL-MATCH end", "y.txt")
    hits = [f.rule for f in r.findings if f.rule.startswith("yara.")]
    return [("yara_match", r.verdict == "MALICIOUS" and bool(hits), f"{r.verdict} {hits}")]


def run_intel(lab: Path) -> list[tuple[str, bool, str]]:
    from sentinel import VirusTotalIntel
    intel = VirusTotalIntel(cache_path=lab / "_vtcache.json", allow_network=False)
    blob = b"a-benign-blob-standing-in-for-an-unknown-file"
    intel.seed(hashlib.sha256(blob).hexdigest(), malicious=58, total=72)
    s = Scanner(quarantine_dir=lab / "_q2", intel=intel)
    r = s.scan_bytes(blob, "unknown.bin")
    ok = r.verdict == "MALICIOUS" and any(f.rule == "intel.virustotal" for f in r.findings)
    return [("vt_reputation", ok, f"{r.verdict} ({[f.rule for f in r.findings]})")]


def run_classify(lab: Path) -> list[tuple[str, bool, str]]:
    """Classification is tested with YARA disabled so results are deterministic (community
    rules aren't in CI). Proves category + MALWARE/PUA/TEST/POLICY/SUSPECT calls."""
    from sentinel import YaraEngine
    empty = lab / "_noyara"; empty.mkdir(exist_ok=True)
    s = Scanner(quarantine_dir=lab / "_q3", yara_engine=YaraEngine(rules_dir=empty))
    upx = b"MZ" + b"\x00" * 200 + b"UPX0" + b"\x00" * 8 + b"UPX1"
    eicar = b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
    cases = [
        ("ransomware", b"your files are encrypted. vssadmin delete shadows /all", "readme.ps1", "MALWARE", "Ransom"),
        ("cred_theft", b"sekurlsa::logonpasswords", "dump.txt", "MALWARE", "Credential"),
        ("pua_crack", upx, "fifa23-crack.exe", "PUA", "Cracked"),
        ("test_file", eicar, "probe.txt", "TEST", "Test"),
        ("dlp_secret", b"AWS_ACCESS_KEY_ID=AKIA" b"IOSFODNN7EXAMPLE", "cfg.txt", "POLICY", "Secret"),
        ("packed_suspect", upx, "tool.exe", "SUSPECT", "Packed"),
    ]
    rows = []
    for cname, data, nm, want_class, want_cat in cases:
        r = s.scan_bytes(data, nm)
        ok = r.malware_class == want_class and want_cat.lower() in r.category.lower()
        rows.append((f"class:{cname}", ok, f"{r.malware_class}/{r.category} (want {want_class}/{want_cat})"))
    return rows


def run_realtime(lab: Path) -> list[tuple[str, bool, str]]:
    """Real-time guard must catch harmless threats dropped into a watched folder live.
    YARA disabled for determinism; expects the 4 non-YARA fixtures to be caught."""
    import time, threading
    from sentinel import YaraEngine
    from sentinel.realtime import RealtimeGuard
    from sentinel.livetest import drop_threats
    watch = lab / "_watch"; watch.mkdir(exist_ok=True)
    s = Scanner(quarantine_dir=lab / "_rtq", yara_engine=YaraEngine(rules_dir=lab / "_noyara2"))
    caught = []
    g = RealtimeGuard(s, [watch], on_detect=lambda d: caught.append(d), interval=0.3).start()
    time.sleep(0.5)
    threading.Thread(target=lambda: drop_threats(watch, delay=0.4)).start()
    time.sleep(3.0)
    g.stop()
    cats = {d["category"] for d in caught}
    ok = len(caught) >= 4 and "Worm / spreader" in cats and "Secret exposure (DLP)" in cats
    return [("realtime_guard", ok, f"{len(caught)} caught live: {sorted(cats)}")]


def run_monitor(scanner: Scanner, lab: Path) -> list[tuple[str, bool, str]]:
    rows = []
    for make in sim.MONITOR_FIXTURES:
        sub = lab / make.__name__
        sub.mkdir(parents=True, exist_ok=True)
        fx = make(sub)
        mon = Monitor(sub, scanner=scanner, burst_threshold=12, window_s=3.0, interval_s=0.2).start()
        t = threading.Thread(target=fx["run"])
        t.start()
        t.join()
        time.sleep(1.0)  # let the monitor catch the tail of the burst
        mon.stop()
        want = fx["expect_monitor"]
        got = mon.has(want)
        kinds = sorted({a.kind for a in mon.alerts})
        rows.append((fx["name"], got, f"alerts={kinds} (want {want})"))
    return rows


def main() -> int:
    lab = Path(tempfile.mkdtemp(prefix="sentinel_lab_"))
    try:
        scanner = Scanner(quarantine_dir=lab / "_quarantine")
        print(f"Sentinel self-test — lab: {lab}\n")
        cat = detection_catalog(scanner.rules)
        total = sum(len(v) for v in cat.values())
        print("Detection catalog:")
        for k, v in cat.items():
            print(f"  {k:<18} {len(v):>3}")
        print(f"  {'TOTAL':<18} {total:>3}   (target 90)")
        yn = len(scanner.yara.rule_names) if scanner.yara and scanner.yara.active else 0
        print(f"  + yara_rules       {yn:>3}   (community rules loaded; drop in thousands)")
        print(f"  + cloud_intel        1   (VirusTotal: ~70 engines by hash)\n")
        rows = (run_signature_pack(scanner) + run_yara(scanner) + run_static(scanner, lab)
                + run_intel(lab) + run_classify(lab) + run_realtime(lab) + run_monitor(scanner, lab))
        print(f"\n{'FIXTURE':<22} {'RESULT':<8} DETAIL")
        print("-" * 72)
        passed = 0
        for name, ok, detail in rows:
            mark = "PASS" if ok else "FAIL"
            passed += ok
            print(f"{name:<22} {mark:<8} {detail}")
        print("-" * 72)
        print(f"{passed}/{len(rows)} fixtures passed")
        return 0 if passed == len(rows) else 1
    finally:
        shutil.rmtree(lab, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
