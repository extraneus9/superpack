"""Sentinel — local dashboard server (standard library only).

Serves the branded dashboard on 127.0.0.1 and exposes a JSON API over the same Scanner the
CLI and self-test use. Bound to localhost; it never listens on the network.

    python -m sentinel.webapp                 # opens the dashboard
    python -m sentinel.webapp --port 8787 --no-browser

API:
  GET  /api/catalog                 engine catalog + status + schedule
  POST /api/scan     {mode,path,quarantine}   -> {job_id}   (runs in background)
  GET  /api/progress?job=ID         live progress / final results
  POST /api/scan_bytes  (raw body, X-Filename header)        -> single result (drag-drop)
  GET  /api/schedule                schedule config/status
  POST /api/schedule {enabled,interval_hours,mode}
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import threading
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from .scanner import Scanner, detection_catalog
from .intel import VirusTotalIntel
from .report import build_csv, build_pdf

from .paths import BUNDLE, DATA

HERE = Path(__file__).resolve().parent
WEBUI = BUNDLE / "webui"
SCHEDULE_FILE = DATA / "schedule.json"
SETTINGS_FILE = DATA / "settings.json"
HISTORY_FILE = DATA / "history.json"
HISTORY_MAX = 50
_DEFAULT_SETTINGS = {"sensitivity": "balanced", "exclusions": []}


def load_history() -> list:
    try:
        return json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def add_history(entry: dict) -> None:
    try:
        h = load_history()
        h.insert(0, entry)
        HISTORY_FILE.write_text(json.dumps(h[:HISTORY_MAX]), encoding="utf-8")
    except OSError:
        pass


def load_settings() -> dict:
    try:
        return {**_DEFAULT_SETTINGS, **json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))}
    except (OSError, ValueError):
        return dict(_DEFAULT_SETTINGS)


def save_settings(s: dict) -> None:
    try:
        SETTINGS_FILE.write_text(json.dumps(s, indent=2), encoding="utf-8")
    except OSError:
        pass


def _excluded(path_str: str, exclusions) -> bool:
    low = path_str.replace("\\", "/").lower()
    return any(ex and ex.replace("\\", "/").lower() in low for ex in exclusions)


def _keep_result(r, sens: str) -> bool:
    """Whether a flagged result is surfaced at the chosen sensitivity."""
    if sens == "high":
        return True
    if sens == "low":
        return r.malware_class in ("MALWARE", "POLICY")
    return not (r.malware_class == "SUSPECT" and r.confidence == "LOW")  # balanced
MAX_RESULTS = 1000
LIMITS = {"quick": 4000, "full": 20000, "custom": 20000}
# Scan speed tiers (faster = fewer/smaller files read less deeply, so a more surface-level pass).
# read_bytes = how much of each file to read; max_file_mb = skip files larger than this; archives
# = look inside zips/apks; quick_limit = file cap for a Quick scan at this tier.
DEPTH = {
    "fast":     {"read_bytes":  8_000_000, "max_file_mb": 25,   "archives": False, "quick_limit":  2500},
    "balanced": {"read_bytes": 64_000_000, "max_file_mb": None, "archives": True,  "quick_limit":  4000},
    "thorough": {"read_bytes": 64_000_000, "max_file_mb": None, "archives": True,  "quick_limit": 20000},
}
NOISE_DIRS = {"node_modules", ".git", ".venv", "venv", "__pycache__", "$recycle.bin",
              ".cache", ".gradle", ".nuget", ".cargo", "site-packages"}

_scanner: Scanner | None = None
_guard = None  # set by the tray app so the dashboard can show real-time status
_lock = threading.Lock()
JOBS: dict[str, dict] = {}
_last_scan: dict | None = None
_sys_cache = {"when": 0.0, "data": {"defender": None, "firewall": None}}


def system_status() -> dict:
    """Windows Defender real-time + firewall state (cached 60s). None if unknown/non-Windows."""
    now = time.time()
    if now - _sys_cache["when"] < 60 and _sys_cache["data"].get("defender") is not None:
        return _sys_cache["data"]
    data = {"defender": None, "firewall": None}
    if os.name != "nt":   # Windows Defender / Windows Firewall only exist on Windows
        _sys_cache.update(when=now, data=data)
        return data
    try:
        ps = ("$d=(Get-MpComputerStatus).RealTimeProtectionEnabled;"
              "$f=[bool](Get-NetFirewallProfile | Where-Object {$_.Enabled -eq 'True'});"
              "@{d=$d;f=$f} | ConvertTo-Json -Compress")
        flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
        out = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                             capture_output=True, text=True, timeout=9, creationflags=flags)
        j = json.loads(out.stdout.strip())
        data = {"defender": bool(j.get("d")), "firewall": bool(j.get("f"))}
    except Exception:
        pass
    _sys_cache.update(when=now, data=data)
    return data


# ---------------------------------------------------------------- scanner / targets
def get_scanner() -> Scanner:
    global _scanner
    if _scanner is None:
        intel = VirusTotalIntel(allow_network=True)
        _scanner = Scanner(intel=intel if intel.enabled else None)
    return _scanner


def _profile() -> Path:
    return Path(os.environ.get("USERPROFILE") or os.path.expanduser("~"))


def quick_targets() -> list[Path]:
    p = _profile()
    cands = [p / "Downloads", p / "Desktop", p / "Documents",
             Path(os.environ.get("TEMP") or p / "AppData/Local/Temp"),
             p / "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup"]
    seen, out = set(), []
    for c in cands:
        try:
            rc = c.resolve()
        except OSError:
            continue
        if c.exists() and rc not in seen:
            seen.add(rc)
            out.append(c)
    return out


def _targets(mode: str, target: str):
    if mode == "quick":
        return quick_targets(), "Quick scan · high-risk locations", True
    if mode == "full":
        return [_profile()], f"Full scan · {_profile()}", True
    root = Path(target).expanduser()
    if not target.strip() or not root.exists():
        return None, f"Path not found: {target}", False
    return [root], str(root), False


def _walk(root: Path, qdir: Path, skip_noise: bool, exclusions=()):
    for dp, dns, fns in os.walk(root):
        try:
            dpr = Path(dp).resolve()
        except OSError:
            continue
        if dpr == qdir or qdir in dpr.parents or _excluded(dp, exclusions):
            dns[:] = []
            continue
        if skip_noise:
            dns[:] = [d for d in dns if d.lower() not in NOISE_DIRS and not d.startswith(".")]
        for fn in fns:
            p = Path(dp) / fn
            if not _excluded(str(p), exclusions):
                yield p


def _result_dict(r) -> dict:
    return {"path": r.path, "verdict": r.verdict, "malware_class": r.malware_class,
            "category": r.category, "confidence": r.confidence, "rationale": r.rationale,
            "quarantined_to": r.quarantined_to,
            "findings": [{"rule": f.rule, "severity": f.severity, "detail": f.detail} for f in r.findings]}


# ---------------------------------------------------------------- background scan jobs
def start_job(mode: str, target: str, quarantine: bool, depth: str = "balanced") -> str:
    if depth not in DEPTH:
        depth = "balanced"
    jid = uuid.uuid4().hex[:12]
    JOBS[jid] = {"state": "running", "mode": mode, "depth": depth, "scanned": 0, "flagged": 0,
                 "skipped": 0, "counts": {"MALICIOUS": 0, "SUSPICIOUS": 0, "CLEAN": 0},
                 "root": "", "started": time.time(), "elapsed": 0.0,
                 "results": [], "truncated": False, "error": None}
    threading.Thread(target=_run_job, args=(jid, mode, target, quarantine, depth), daemon=True).start()
    # keep only the most recent few jobs
    for old in list(JOBS)[:-6]:
        if JOBS[old]["state"] != "running":
            JOBS.pop(old, None)
    return jid


def _run_job(jid: str, mode: str, target: str, quarantine: bool, depth: str = "balanced") -> None:
    global _last_scan
    job = JOBS[jid]
    s = get_scanner()
    roots, label, skip_noise = _targets(mode, target)
    job["root"] = label
    if roots is None:
        job["state"] = "error"
        job["error"] = label
        return
    prof = DEPTH.get(depth, DEPTH["balanced"])
    limit = prof["quick_limit"] if mode == "quick" else LIMITS.get(mode, LIMITS["custom"])
    max_file = (prof["max_file_mb"] or 0) * 1_000_000   # 0 = no size skip
    settings = load_settings()
    sens = settings.get("sensitivity", "balanced")
    excl = settings.get("exclusions", [])
    qdir = s.quarantine_dir.resolve()
    # Bulk disk scan: fast, deterministic LOCAL engine only (signatures, heuristics, archives,
    # YARA when present). VirusTotal's free tier is one lookup per ~15 s, so a per-file online
    # check would turn a scan of thousands of files into hours. The online check stays on the
    # interactive paths — a dropped file, a single-file scan, Safe Install — where one file is
    # worth the wait. (A paid key with VT_MIN_INTERVAL=0 could re-enable it here later.)
    # The chosen speed tier sets how much of each file we read and whether we open archives.
    knobs_prev = (s.vt_policy, s.max_scan_bytes, s.scan_archives)
    s.vt_policy = "off"
    s.max_scan_bytes = prof["read_bytes"]
    s.scan_archives = prof["archives"]
    t0 = time.time()
    results = []
    try:
        for root in roots:
            files = iter([root]) if root.is_file() else _walk(root, qdir, skip_noise, excl)
            for p in files:
                if job["scanned"] >= limit:
                    job["truncated"] = True
                    break
                if max_file:   # Fast tier: skip big files (large media isn't the quick-scan threat)
                    try:
                        if p.stat().st_size > max_file:
                            job["skipped"] += 1
                            continue
                    except OSError:
                        pass
                r = s.scan_file(p)
                job["scanned"] += 1
                job["counts"][r.verdict] = job["counts"].get(r.verdict, 0) + 1
                if r.verdict != "CLEAN" and _keep_result(r, sens):
                    job["flagged"] += 1
                    if quarantine and r.verdict == "MALICIOUS":
                        s.quarantine(r)
                    if len(results) < MAX_RESULTS:
                        results.append(_result_dict(r))
            if job["truncated"]:
                break
        order = {"MALICIOUS": 0, "SUSPICIOUS": 1}
        results.sort(key=lambda x: order.get(x["verdict"], 2))
        job["results"] = results
        job["elapsed"] = round(time.time() - t0, 2)
        job["state"] = "done"
        when = time.strftime("%Y-%m-%d %H:%M")
        _last_scan = {"mode": mode, "root": label, "scanned": job["scanned"],
                      "flagged": job["flagged"], "counts": dict(job["counts"]), "when": when}
        add_history({"id": jid, "when": when, "mode": mode, "root": label,
                     "scanned": job["scanned"], "flagged": job["flagged"],
                     "counts": dict(job["counts"]), "elapsed": job["elapsed"], "results": results})
    except Exception as e:  # pragma: no cover
        job["state"] = "error"
        job["error"] = str(e)
    finally:
        s.vt_policy, s.max_scan_bytes, s.scan_archives = knobs_prev


def scan_one_bytes(data: bytes, name: str) -> dict:
    s = get_scanner()
    s.vt_policy = "all"  # a single dropped file: the full online check is worth the wait
    r = s.scan_bytes(data, name or "dropped.bin")
    return _result_dict(r)


# ---------------------------------------------------------------- schedule
_DEFAULT_SCHED = {"enabled": False, "interval_hours": 24, "mode": "quick",
                  "last_run": None, "next_run": None, "history": []}


def load_schedule() -> dict:
    try:
        d = json.loads(SCHEDULE_FILE.read_text(encoding="utf-8"))
        return {**_DEFAULT_SCHED, **d}
    except (OSError, ValueError):
        return dict(_DEFAULT_SCHED)


def save_schedule(sched: dict) -> None:
    try:
        SCHEDULE_FILE.write_text(json.dumps(sched, indent=2), encoding="utf-8")
    except OSError:
        pass


def _scheduler_loop() -> None:
    while True:
        time.sleep(30)
        sched = load_schedule()
        if not sched.get("enabled"):
            continue
        now = time.time()
        nxt = sched.get("next_run") or 0
        if now >= nxt:
            jid = start_job(sched.get("mode", "quick"), "", False)
            job = JOBS[jid]
            while job["state"] == "running":
                time.sleep(1)
            sched = load_schedule()
            sched["last_run"] = time.strftime("%Y-%m-%d %H:%M")
            sched["next_run"] = now + sched.get("interval_hours", 24) * 3600
            entry = {"when": sched["last_run"], "mode": sched.get("mode"),
                     "scanned": job["scanned"], "flagged": job["flagged"]}
            sched["history"] = ([entry] + sched.get("history", []))[:12]
            save_schedule(sched)


# ---------------------------------------------------------------- catalog
# ---------------------------------------------------------------- start with Windows
_RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
_APP_NAME = "Sentinel"


def _startup_target() -> str:
    import sys
    from .paths import FROZEN, BUNDLE
    if FROZEN:
        return f'"{sys.executable}"'
    pyw = sys.executable.replace("python.exe", "pythonw.exe")
    return f'"{pyw}" "{BUNDLE / "run_sentinel.py"}"'


def startup_enabled() -> bool:
    if os.name != "nt":
        return False
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _RUN_KEY) as k:
            v, _ = winreg.QueryValueEx(k, _APP_NAME)
            return bool(v)
    except OSError:
        return False


def set_startup(enable: bool) -> bool:
    if os.name != "nt":
        return False
    import winreg
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
        if enable:
            winreg.SetValueEx(k, _APP_NAME, 0, winreg.REG_SZ, _startup_target())
        else:
            try:
                winreg.DeleteValue(k, _APP_NAME)
            except FileNotFoundError:
                pass
    return startup_enabled()


# ---------------------------------------------------------------- safe install
SAFE_DL_MAX = 800_000_000  # 800 MB cap


def _safe_in_staging(path: str) -> Path | None:
    p = Path(path).resolve()
    staging = (DATA / "staging").resolve()
    return p if (staging in p.parents and p.exists()) else None


def safe_install_scan(data: bytes, name: str) -> dict:
    """Stage a dropped file and scan it before the user installs it."""
    if len(data) > SAFE_DL_MAX:
        return {"error": "file is larger than the 800 MB limit"}
    staging = DATA / "staging"
    staging.mkdir(parents=True, exist_ok=True)
    name = "".join(c for c in (name or "file.bin") if c not in '<>:"/\\|?*').strip() or "file.bin"
    dst = staging / f"{uuid.uuid4().hex[:8]}_{name}"
    dst.write_bytes(data)
    res = get_scanner().scan_file(dst)
    return {"ok": True, "name": name, "size": len(data), "staged": str(dst),
            "verdict": res.verdict, "malware_class": res.malware_class, "category": res.category,
            "confidence": res.confidence, "rationale": res.rationale,
            "findings": [{"rule": f.rule, "severity": f.severity, "detail": f.detail} for f in res.findings]}


def safe_install_run(path: str) -> dict:
    """Launch a staged file the user chose to install (only called after a CLEAN scan)."""
    p = _safe_in_staging(path)
    if not p:
        return {"error": "file not found in staging"}
    try:
        from .paths import open_path
        open_path(p)   # user-initiated install of a scanned file (cross-platform)
    except Exception as e:
        return {"error": str(e)}
    return {"ok": True}


def staged_delete(path: str) -> dict:
    p = _safe_in_staging(path)
    if p:
        p.unlink(missing_ok=True)
    return {"ok": True}


def build_catalog() -> dict:
    s = get_scanner()
    cat = detection_catalog(s.rules)
    return {
        "layers": cat,
        "core_total": sum(len(v) for v in cat.values()),
        "yara_rules_count": len(s.yara.rule_names) if (s.yara and s.yara.active) else 0,
        "yara_active": bool(s.yara and s.yara.active),
        "intel": {"enabled": bool(s.intel and s.intel.enabled),
                  "online": bool(s.intel and s.intel.online)},
        "last_scan": _last_scan,
    }


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj).encode("utf-8"), "application/json")

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(n) if n else b""

    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ("/", "/index.html"):
            self._send(200, (WEBUI / "index.html").read_bytes(), "text/html; charset=utf-8")
        elif u.path == "/api/catalog":
            self._json(build_catalog())
        elif u.path == "/api/progress":
            jid = (parse_qs(u.query).get("job") or [""])[0]
            job = JOBS.get(jid)
            if not job:
                self._json({"error": "unknown job"}, 404)
                return
            snap = {k: job[k] for k in ("state", "mode", "depth", "scanned", "flagged", "skipped",
                                        "counts", "root", "elapsed", "truncated", "error")}
            if job["state"] == "running":   # live elapsed so the UI can show a running timer
                snap["elapsed"] = round(time.time() - job.get("started", time.time()), 1)
            elif job["state"] == "done":
                snap["results"] = job["results"]
            self._json(snap)
        elif u.path == "/api/schedule":
            self._json(load_schedule())
        elif u.path == "/api/status":
            s = get_scanner()
            g = _guard
            self._json({
                "protection": {"running": g is not None, "active": bool(g and not g.paused)},
                "caught": (g.caught[:12] if g else []),
                "caught_count": (len(g.caught) if g else 0),
                "scanned_rt": (g.scanned if g else 0),
                "quarantine_count": len(s.list_quarantine()),
                "last_scan": _last_scan,
                "intel": {"enabled": bool(s.intel and s.intel.enabled),
                          "online": bool(s.intel and s.intel.online)},
                "system": system_status(),
            })
        elif u.path == "/api/history":
            light = [{k: e.get(k) for k in ("id", "when", "mode", "root", "scanned",
                                            "flagged", "counts", "elapsed")}
                     for e in load_history()]
            self._json({"items": light})
        elif u.path == "/api/report":
            q = parse_qs(u.query)
            eid = (q.get("id") or [""])[0]
            fmt = (q.get("fmt") or ["csv"])[0]
            entry = next((e for e in load_history() if e.get("id") == eid), None)
            if not entry:
                self._send(404, b"no such report", "text/plain")
                return
            if fmt == "pdf":
                body, ct, ext = build_pdf(entry), "application/pdf", "pdf"
            else:
                body, ct, ext = build_csv(entry), "text/csv", "csv"
            self.send_response(200)
            self.send_header("Content-Type", ct)
            self.send_header("Content-Disposition", f'attachment; filename="sentinel-report-{eid}.{ext}"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif u.path == "/api/quarantine":
            self._json({"items": get_scanner().list_quarantine()})
        elif u.path == "/api/settings":
            s = get_scanner()
            self._json({**load_settings(),
                        "intel": {"enabled": bool(s.intel and s.intel.enabled),
                                  "online": bool(s.intel and s.intel.online)},
                        "startup": startup_enabled(), "startup_supported": os.name == "nt"})
        else:
            self._send(404, b"not found", "text/plain")

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/api/scan":
            try:
                req = json.loads(self._body() or b"{}")
            except ValueError:
                self._json({"error": "bad request"}, 400); return
            jid = start_job((req.get("mode") or "custom").lower(),
                            (req.get("path") or "").strip(), bool(req.get("quarantine")),
                            (req.get("depth") or "balanced").lower())
            self._json({"job_id": jid})
        elif u.path == "/api/scan_bytes":
            data = self._body()
            name = self.headers.get("X-Filename", "dropped.bin")
            self._json(scan_one_bytes(data, name))
        elif u.path == "/api/schedule":
            try:
                req = json.loads(self._body() or b"{}")
            except ValueError:
                self._json({"error": "bad request"}, 400); return
            sched = load_schedule()
            if "enabled" in req:
                sched["enabled"] = bool(req["enabled"])
            if "interval_hours" in req:
                sched["interval_hours"] = max(1, int(req["interval_hours"]))
            if "mode" in req and req["mode"] in ("quick", "full"):
                sched["mode"] = req["mode"]
            if sched["enabled"] and not sched.get("next_run"):
                sched["next_run"] = time.time() + sched["interval_hours"] * 3600
            if not sched["enabled"]:
                sched["next_run"] = None
            save_schedule(sched)
            self._json(sched)
        elif u.path == "/api/quarantine":
            try:
                req = json.loads(self._body() or b"{}")
            except ValueError:
                self._json({"error": "bad request"}, 400); return
            s = get_scanner()
            f, action = req.get("file", ""), req.get("action")
            try:
                if action == "restore":
                    s.restore(f)
                elif action == "delete":
                    s.delete_quarantine(f)
                else:
                    self._json({"error": "unknown action"}, 400); return
            except Exception as e:
                self._json({"error": str(e)}, 400); return
            self._json({"ok": True, "items": s.list_quarantine()})
        elif u.path == "/api/settings":
            try:
                req = json.loads(self._body() or b"{}")
            except ValueError:
                self._json({"error": "bad request"}, 400); return
            st = load_settings()
            if req.get("sensitivity") in ("low", "balanced", "high"):
                st["sensitivity"] = req["sensitivity"]
            if isinstance(req.get("exclusions"), list):
                st["exclusions"] = [str(x).strip() for x in req["exclusions"] if str(x).strip()][:100]
            save_settings(st)
            if "startup" in req:
                try:
                    set_startup(bool(req["startup"]))
                except Exception:
                    pass
            self._json({**st, "startup": startup_enabled()})
        elif u.path == "/api/safeinstall":
            data = self._body()
            name = self.headers.get("X-Filename", "file.bin")
            self._json(safe_install_scan(data, name))
        elif u.path == "/api/safeinstall/run":
            try:
                req = json.loads(self._body() or b"{}")
            except ValueError:
                self._json({"error": "bad request"}, 400); return
            self._json(safe_install_run(req.get("path", "")))
        elif u.path == "/api/safeinstall/delete":
            try:
                req = json.loads(self._body() or b"{}")
            except ValueError:
                self._json({"error": "bad request"}, 400); return
            self._json(staged_delete(req.get("path", "")))
        else:
            self._send(404, b"not found", "text/plain")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="sentinel.webapp")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args(argv)
    get_scanner()
    threading.Thread(target=_scheduler_loop, daemon=True).start()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    url = f"http://{a.host}:{a.port}/"
    print(f"Sentinel dashboard -> {url}  (Ctrl+C to stop)")
    if not a.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
