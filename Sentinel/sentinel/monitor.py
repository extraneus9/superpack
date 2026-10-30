"""Sentinel — behavior monitor (user-mode, no driver).

Watches a folder tree and raises alerts on ransomware-like behavior:
  * burst of file modifications/renames in a short window
  * many files gaining a new, unknown extension
  * a ransom-note-looking text file appearing
Also scans every newly written file with the static scanner.

Pure polling (no third-party deps) so it runs anywhere, including CI.
"""
from __future__ import annotations

import os
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from .scanner import Scanner

RANSOM_NOTE_RX = re.compile(rb"(your files|all your (data|documents)).{0,120}encrypt|decrypt(ion)? key|bitcoin|readme.{0,10}(decrypt|restore)", re.I | re.S)

CANARY_PREFIX = "__sentinel_canary"
DROP_EXT = {".exe", ".dll", ".scr", ".com", ".bat", ".cmd", ".ps1", ".vbs", ".js", ".jse", ".wsf", ".hta", ".msi"}

# Behavior techniques this monitor can alert on (for the detection catalog count).
MONITOR_TECHNIQUES = (
    "mass_rename_encrypt", "file_burst", "mass_delete", "static_on_write", "ransom_note",
    "honeypot_tripwire", "new_executable_dropped", "startup_persistence",
)


@dataclass
class Alert:
    kind: str
    detail: str
    when: float = field(default_factory=time.time)


class Monitor:
    def __init__(self, root: str | os.PathLike, scanner: Scanner | None = None,
                 burst_threshold: int = 12, window_s: float = 3.0, interval_s: float = 0.25):
        self.root = Path(root)
        self.scanner = scanner or Scanner()
        self.burst_threshold = burst_threshold
        self.window_s = window_s
        self.interval_s = interval_s
        self.alerts: list[Alert] = []
        self._snap: dict[str, tuple[int, int]] = {}  # path -> (mtime_ns, size)
        self._events: list[tuple[float, str, str]] = []  # (t, kind, path)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # ---------- lifecycle ----------
    def start(self) -> "Monitor":
        self._snap = self._snapshot()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    # ---------- internals ----------
    def _snapshot(self) -> dict[str, tuple[int, int]]:
        snap = {}
        for dp, _, fns in os.walk(self.root):
            for fn in fns:
                p = Path(dp) / fn
                try:
                    st = p.stat()
                    snap[str(p)] = (st.st_mtime_ns, st.st_size)
                except OSError:
                    pass
        return snap

    def _loop(self) -> None:
        while not self._stop.is_set():
            time.sleep(self.interval_s)
            self._tick()

    def _tick(self) -> None:
        now = time.time()
        new = self._snapshot()
        old = self._snap
        created = [p for p in new if p not in old]
        deleted = [p for p in old if p not in new]
        modified = [p for p in new if p in old and new[p] != old[p]]
        for p in created:
            self._events.append((now, "create", p))
            self._on_new_file(p)
            self._on_path(p)
        for p in deleted:
            self._events.append((now, "delete", p))
        for p in modified:
            self._events.append((now, "modify", p))
            self._on_canary(p)
        for p in created:
            self._on_canary(p)
        self._snap = new
        self._evaluate(now, created, deleted)

    def _on_path(self, p: str) -> None:
        name = Path(p).name.lower()
        parts = [s.lower() for s in Path(p).parts]
        if Path(p).suffix.lower() in DROP_EXT:
            self._alert("new_executable_dropped", p)
        if "startup" in parts:
            self._alert("startup_persistence", p)

    def _on_canary(self, p: str) -> None:
        if Path(p).name.startswith(CANARY_PREFIX):
            self._alert("honeypot_tripwire", f"canary touched: {p}")

    def _on_new_file(self, p: str) -> None:
        try:
            data = Path(p).read_bytes()
        except OSError:
            return
        res = self.scanner.scan_bytes(data, name=Path(p).name)
        if res.verdict != "CLEAN":
            self._alert("static_on_write", f"{res.verdict} {p}: " + ", ".join(f.rule for f in res.findings))
        if len(data) < 20_000 and RANSOM_NOTE_RX.search(data):
            self._alert("ransom_note", p)

    def _evaluate(self, now: float, created: list[str], deleted: list[str]) -> None:
        cutoff = now - self.window_s
        self._events = [e for e in self._events if e[0] >= cutoff]
        deletes = sum(1 for e in self._events if e[1] == "delete")
        if deletes >= self.burst_threshold:
            self._alert("mass_delete", f"{deletes} deletions in {self.window_s}s")
        churn = sum(1 for e in self._events if e[1] in ("modify", "delete", "create"))
        if churn >= self.burst_threshold:
            # rename-to-new-extension pattern: same stem deleted and created with extra suffix
            del_stems = {Path(p).stem for _, k, p in self._events if k == "delete"}
            new_ext = [Path(p).suffix for _, k, p in self._events if k == "create" and Path(Path(p).stem).stem in del_stems]
            if len(new_ext) >= self.burst_threshold // 2:
                self._alert("mass_rename_encrypt", f"{len(new_ext)} files renamed to {set(new_ext)} in {self.window_s}s")
            else:
                self._alert("file_burst", f"{churn} file events in {self.window_s}s")
            self._events.clear()

    def _alert(self, kind: str, detail: str) -> None:
        # de-dupe identical alerts
        if any(a.kind == kind and a.detail == detail for a in self.alerts):
            return
        self.alerts.append(Alert(kind, detail))
        print(f"  [MONITOR] {kind}: {detail}")

    def has(self, kind: str) -> bool:
        return any(a.kind == kind for a in self.alerts)
