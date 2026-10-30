"""Sentinel — real-time protection guard.

Watches one or more folders and scans every new or modified file the instant it appears
(scan-on-write), plus a burst detector for ransomware-style mass changes. When something is
flagged it calls on_detect(result) — the tray app turns that into a Windows notification.

Pure polling (no third-party deps): a background thread snapshots the watched folders and
diffs them each tick, so it runs anywhere.
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

NOISE_DIRS = {"node_modules", ".git", ".venv", "venv", "__pycache__", "$recycle.bin",
              ".cache", ".gradle", ".nuget", "site-packages"}
MAX_FILE_BYTES = 30_000_000


def _keep(r, sens: str) -> bool:
    if sens == "high":
        return True
    if sens == "low":
        return r.malware_class in ("MALWARE", "POLICY")
    return not (r.malware_class == "SUSPECT" and r.confidence == "LOW")


class RealtimeGuard:
    def __init__(self, scanner, watch_dirs, on_detect=None, settings_file=None,
                 interval=1.0, auto_quarantine=False, burst_threshold=14, burst_window=3.0,
                 auto_respond=False):   # safe default: detect+alert+quarantine, no process-kill
        self.scanner = scanner
        self.watch_dirs = [Path(d) for d in watch_dirs]
        self.on_detect = on_detect or (lambda r: None)
        self.settings_file = Path(settings_file) if settings_file else None
        self.interval = interval
        self.auto_quarantine = auto_quarantine
        self.auto_respond = auto_respond   # on a ransomware burst, kill the process doing it
        self.burst_threshold = burst_threshold
        self.burst_window = burst_window
        self._started = time.time()
        self.paused = False
        self.caught: list[dict] = []
        self.scanned = 0
        self._snap: dict[str, float] = {}
        self._events: list[float] = []
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # ---------- settings ----------
    def _settings(self) -> tuple[str, list]:
        if self.settings_file:
            try:
                d = json.loads(self.settings_file.read_text(encoding="utf-8"))
                return d.get("sensitivity", "balanced"), d.get("exclusions", []) or []
            except (OSError, ValueError):
                pass
        return "balanced", []

    def _excluded(self, p: str, exclusions) -> bool:
        low = p.replace("\\", "/").lower()
        return any(ex and ex.replace("\\", "/").lower() in low for ex in exclusions)

    # ---------- lifecycle ----------
    def start(self):
        self._snap = self._snapshot()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=4)

    def pause(self):
        self.paused = True

    def resume(self):
        self._snap = self._snapshot()
        self.paused = False

    # ---------- internals ----------
    def _snapshot(self) -> dict[str, float]:
        snap = {}
        qdir = self.scanner.quarantine_dir.resolve()
        for root in self.watch_dirs:
            for dp, dns, fns in os.walk(root):
                try:
                    dpr = Path(dp).resolve()
                except OSError:
                    continue
                if dpr == qdir or qdir in dpr.parents:
                    dns[:] = []
                    continue
                dns[:] = [d for d in dns if d.lower() not in NOISE_DIRS]
                for fn in fns:
                    p = Path(dp) / fn
                    try:
                        snap[str(p)] = p.stat().st_mtime
                    except OSError:
                        pass
        return snap

    def _loop(self):
        while not self._stop.is_set():
            time.sleep(self.interval)
            if self.paused:
                continue
            try:
                self._tick()
            except Exception:  # never let the guard die
                pass

    def _tick(self):
        now = time.time()
        new = self._snapshot()
        changed = [p for p, m in new.items() if self._snap.get(p) != m]
        self._snap = new
        sens, excl = self._settings()
        # burst detection
        self._events = [t for t in self._events if t >= now - self.burst_window] + [now] * len(changed)
        if len(self._events) >= self.burst_threshold:
            det = {"path": "(multiple files)", "verdict": "SUSPICIOUS",
                   "malware_class": "SUSPECT", "category": "Mass file changes (ransomware-like)",
                   "confidence": "MEDIUM", "rationale": f"{len(self._events)} file changes in {self.burst_window}s",
                   "findings": [{"rule": "behavior.mass_change", "severity": "SUSPICIOUS", "detail": ""}]}
            if self.auto_respond:   # find + kill the process doing it, quarantine it, stop the damage
                try:
                    import os
                    from .respond import neutralize
                    killed, quar = [], []
                    for d in self.watch_dirs:
                        s = neutralize(d, scanner=self.scanner,
                                       since=now - self.burst_window - 2, exclude_pids={os.getpid()})
                        killed += s["killed"]; quar += s["quarantined"]
                    if killed:
                        det.update(verdict="MALICIOUS", malware_class="MALWARE", confidence="HIGH")
                        det["category"] = "Ransomware behavior — process stopped"
                        det["rationale"] += "  -> killed: " + ", ".join(killed) + \
                            ("; quarantined: " + ", ".join(quar) if quar else "")
                        det["response"] = {"killed": killed, "quarantined": quar}
                except Exception:
                    pass
            self._emit(det)
            self._events.clear()
        # scan-on-write
        for p in changed:
            path = Path(p)
            if self._excluded(p, excl):
                continue
            try:
                if path.stat().st_size > MAX_FILE_BYTES:
                    continue
            except OSError:
                continue
            r = self.scanner.scan_file(path)
            self.scanned += 1
            if r.verdict != "CLEAN" and _keep(r, sens):
                if self.auto_quarantine and r.verdict == "MALICIOUS":
                    self.scanner.quarantine(r)
                self._emit({"path": r.path, "verdict": r.verdict, "malware_class": r.malware_class,
                            "category": r.category, "confidence": r.confidence, "rationale": r.rationale,
                            "quarantined_to": r.quarantined_to,
                            "findings": [{"rule": f.rule, "severity": f.severity, "detail": f.detail} for f in r.findings]})

    def _emit(self, det: dict):
        det["when"] = time.strftime("%H:%M:%S")
        self.caught.insert(0, det)
        del self.caught[200:]
        try:
            self.on_detect(det)
        except Exception:
            pass
