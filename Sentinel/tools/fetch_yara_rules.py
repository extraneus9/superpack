"""Fetch a community YARA rule pack into yara_rules/community/.

Clones a public YARA repo, compiles each rule file against Sentinel's engine, and keeps only
the files that compile cleanly (real-world packs include files needing modules we don't have).
The pack is NOT committed — it lands in a git-ignored folder, so we never vendor third-party
(often GPL) rules into this repo. Run it whenever you want the big coverage locally:

    python tools/fetch_yara_rules.py
    python tools/fetch_yara_rules.py --repo https://github.com/Yara-Rules/rules.git

LICENSING NOTE: community rule packs carry their own licenses (Yara-Rules is GPL v2). GPL rules
cannot be bundled into a closed-source product you sell. For a commercial Sentinel, use
permissively-licensed rules or write our own; this fetcher is for the lab / self-hosted use.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DST = ROOT / "yara_rules" / "community"
SKIP_DIRS = {"deprecated", "utils", ".git"}
EXTERNALS = {"filename": "", "filepath": "", "extension": "", "filetype": "",
             "owner": "", "md5": "", "new_file": False, "positives": 0}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="https://github.com/Yara-Rules/rules.git")
    a = ap.parse_args(argv)
    try:
        import yara
    except ImportError:
        print("yara-python not installed:  pip install yara-python")
        return 1

    tmp = Path(tempfile.mkdtemp(prefix="yara_src_"))
    try:
        print(f"Cloning {a.repo} ...")
        subprocess.run(["git", "clone", "--depth", "1", a.repo, str(tmp)],
                       check=True, capture_output=True)
        if DST.exists():
            shutil.rmtree(DST)
        DST.mkdir(parents=True)
        for up in ("LICENSE", "LICENSE.txt"):
            if (tmp / up).exists():
                shutil.copy2(tmp / up, DST / "UPSTREAM_LICENSE")
                break
        ok = skipped = rules = 0
        for root, dns, fns in os.walk(tmp):
            dns[:] = [d for d in dns if d not in SKIP_DIRS]
            for fn in fns:
                if not fn.endswith((".yar", ".yara")) or fn.endswith("_index.yar") or fn.startswith("index"):
                    continue
                src = Path(root) / fn
                try:
                    yara.compile(filepath=str(src), externals=dict(EXTERNALS))
                except Exception:
                    skipped += 1
                    continue
                topcat = src.relative_to(tmp).parts[0]   # malware / packers / webshells / ...
                catdir = DST / topcat
                catdir.mkdir(parents=True, exist_ok=True)
                out = catdir / fn
                i = 1
                while out.exists():
                    out = catdir / f"{src.stem}_{i}{src.suffix}"
                    i += 1
                shutil.copy2(src, out)
                ok += 1
                try:
                    rules += sum(1 for ln in src.read_text(encoding="utf-8", errors="ignore").splitlines()
                                 if ln.strip().startswith("rule "))
                except OSError:
                    pass
        print(f"Kept {ok} files (~{rules} rules); skipped {skipped} incompatible files.")
        print(f"-> {DST}")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
