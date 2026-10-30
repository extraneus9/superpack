"""Sentinel — YARA layer.

Loads every *.yar / *.yara file from a rules directory and scans bytes against them.
This is the plug-in point for the whole YARA community ecosystem: drop thousands of rules
into `yara_rules/` and they all take effect. Degrades gracefully — if the `yara` package
is not installed, or no rules are present, the engine is simply inactive and the rest of
Sentinel runs unchanged.

A rule's severity comes from its `meta: severity = "MALICIOUS" | "SUSPICIOUS"` (default
SUSPICIOUS). Matches surface as findings named `yara.<rulename>`.
"""
from __future__ import annotations

import os
from pathlib import Path

try:
    import yara  # type: ignore
    HAVE_YARA = True
except Exception:  # pragma: no cover - import guard
    yara = None
    HAVE_YARA = False

HERE = Path(__file__).resolve().parent
DEFAULT_RULES_DIR = HERE.parent / "yara_rules"


class YaraEngine:
    # externals real-world packs commonly reference; providing defaults lets them compile
    EXTERNALS = {"filename": "", "filepath": "", "extension": "", "filetype": "",
                 "owner": "", "md5": "", "new_file": False, "positives": 0}

    def __init__(self, rules_dir: str | os.PathLike | None = None):
        self._extra_dir = None
        if rules_dir:
            self.rules_dir = Path(rules_dir)
        else:
            self.rules_dir = DEFAULT_RULES_DIR
            from .paths import DATA  # frozen builds fetch community rules to a writable dir
            extra = DATA / "yara_rules"
            if extra != self.rules_dir and extra.is_dir():
                self._extra_dir = extra
        self.rules = None                 # single combined yara.Rules (fast path)
        self.perfile: list = []           # [(yara.Rules, category)] fallback if combine fails
        self.rule_names: list[str] = []
        self.files_ok = 0
        self.files_skipped = 0
        self.errors: list[str] = []
        if HAVE_YARA:
            self._compile()

    def _category(self, p: Path) -> str:
        parent = p.parent.name
        return "builtin" if parent == self.rules_dir.name else parent

    @property
    def active(self) -> bool:
        return self.rules is not None or bool(self.perfile)

    def _compile(self) -> None:
        dirs = [d for d in (self.rules_dir, self._extra_dir) if d and d.is_dir()]
        if not dirs:
            return
        paths = []
        for d in dirs:
            paths += sorted(d.rglob("*.yar")) + sorted(d.rglob("*.yara"))
        good: dict[str, str] = {}   # namespace -> filepath (namespace carries the pack category)
        for i, p in enumerate(paths):
            try:
                yara.compile(filepath=str(p), externals=dict(self.EXTERNALS))  # validate alone
            except (yara.Error, Exception) as e:  # skip files needing missing modules / bad syntax
                self.files_skipped += 1
                self.errors.append(f"{p.name}: {e}")
                continue
            ns = f"{self._category(p)}::{p.stem}::{i}"
            good[ns] = str(p)
            self.files_ok += 1
            self.rule_names.extend(self._rule_names({p.stem: str(p)}))
        if not good:
            return
        # fast path: compile everything into ONE ruleset (one match() call per file at scan time)
        try:
            self.rules = yara.compile(filepaths=good, externals=dict(self.EXTERNALS))
        except (yara.Error, Exception) as e:
            self.errors.append(f"combined compile failed, using per-file: {e}")
            self.rules = None
            for ns, path in good.items():
                try:
                    self.perfile.append((yara.compile(filepath=path, externals=dict(self.EXTERNALS)),
                                         ns.split("::")[0]))
                except (yara.Error, Exception):
                    pass

    @staticmethod
    def _rule_names(files: dict[str, str]) -> list[str]:
        names: list[str] = []
        for path in files.values():
            try:
                text = Path(path).read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            for line in text.splitlines():
                s = line.strip()
                if s.startswith("rule ") or s.startswith("private rule "):
                    ident = s.split("rule ", 1)[1].split("{")[0].split(":")[0].strip()
                    if ident and all(c.isalnum() or c == "_" for c in ident):
                        names.append(ident)
        return names

    def scan(self, data: bytes) -> list[tuple[str, str, str]]:
        """Return [(rule_name, severity, pack_category), ...] for every matching rule."""
        def sev_of(m):
            s = (m.meta.get("severity") or "SUSPICIOUS").upper()
            return s if s in ("MALICIOUS", "SUSPICIOUS") else "SUSPICIOUS"
        out = []
        if self.rules is not None:
            try:
                for m in self.rules.match(data=data, externals=dict(self.EXTERNALS)):
                    cat = (m.namespace or "").split("::")[0] or "builtin"
                    out.append((m.rule, sev_of(m), cat))
            except yara.Error:  # pragma: no cover
                return []
            return out
        for rules, category in self.perfile:
            try:
                for m in rules.match(data=data, externals=dict(self.EXTERNALS)):
                    out.append((m.rule, sev_of(m), category))
            except yara.Error:  # pragma: no cover
                continue
        return out
