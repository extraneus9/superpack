"""Sentinel — static file scanner.

Layers (like a commercial engine, simplified):
  1. Signatures   — known-bad SHA-256 hashes + byte/regex patterns (rules.json = our "DAT file")
  2. Heuristics   — double extensions, disguised executables, packed/high-entropy binaries,
                    suspicious script content, macro-like office content
  3. Verdict      — CLEAN / SUSPICIOUS / MALICIOUS with the reasons that fired
  4. Quarantine   — move the file into a vault, renamed, with a JSON record for restore
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import os
import re
import shutil
import time
import zipfile
from dataclasses import dataclass, field, asdict
from pathlib import Path

# Archive reader. pyzipper opens WinZip-AES archives (what malware feeds like MalwareBazaar now
# ship) as well as legacy ZipCrypto and plain zips; the stdlib falls back to ZipCrypto + plain.
try:
    import pyzipper
    _ZipReader = pyzipper.AESZipFile
    _HAS_AES = True
except Exception:  # pragma: no cover - optional dependency
    _ZipReader = zipfile.ZipFile
    _HAS_AES = False

HERE = Path(__file__).resolve().parent
RULES_PATH = HERE / "rules.json"

EXEC_EXT = {".exe", ".dll", ".scr", ".com", ".pif", ".bat", ".cmd", ".ps1", ".vbs", ".js", ".jse", ".wsf", ".hta", ".msi"}
DECOY_EXT = {".pdf", ".jpg", ".jpeg", ".png", ".docx", ".doc", ".xlsx", ".txt", ".mp4", ".mp3", ".zip"}
SCRIPT_EXT = {".ps1", ".bat", ".cmd", ".vbs", ".js", ".jse", ".wsf", ".hta", ".py"}
OFFICE_EXT = {".doc", ".docm", ".xls", ".xlsm", ".ppt", ".pptm", ".docx", ".xlsx"}
TEXTISH_EXT = {".txt", ".csv", ".log", ".md", ".ini", ".cfg", ".json"}
RLO = "‮"  # right-to-left override — flips how a filename's extension displays
IMAGE_MAGIC = (b"\x89PNG\r\n", b"\xff\xd8\xff", b"GIF87a", b"GIF89a", b"BM")
DOS_STUB = b"This program cannot be run in DOS mode"

ARCHIVE_MAX_BYTES = 50_000_000
ARCHIVE_MAX_MEMBERS = 200
ARCHIVE_MEMBER_MAX = 10_000_000
ARCHIVE_MAX_DEPTH = 3
# Known research/distribution passwords. Malware-sharing feeds (MalwareBazaar, VX-Underground,
# theZoo) ship samples ZipCrypto-encrypted with one of these so scanners don't eat them in
# transit. A real scanner opens known-password archives and inspects what's inside.
ARCHIVE_PASSWORDS = (b"infected", b"malware", b"virus")

SEV = {"CLEAN": 0, "SUSPICIOUS": 1, "MALICIOUS": 2}

# Script content signals — name -> (regex, weight). Score >=3 => MALICIOUS, >=1 => SUSPICIOUS.
SCRIPT_CHECKS = {
    "b64_exec": (rb"frombase64string|-enc(odedcommand)?\s+[a-z0-9+/=]{40,}", 2),
    "download_exec": (rb"(downloadstring|downloadfile|invoke-webrequest|curl\s|wget\s|bitsadmin).{0,200}(iex|invoke-expression|start-process|\.exe)", 3),
    "hidden_window": (rb"-w(indowstyle)?\s+hidden|-nop\b|-noprofile", 1),
    "bypass_policy": (rb"-ep\s+bypass|executionpolicy\s+bypass|set-mppreference.*disable|amsiutils|amsiinitfailed", 3),
    "persistence": (rb"currentversion\\run|schtasks\s+/create|startup\\|new-scheduledtask|wmic.*startup", 2),
    "shadow_delete": (rb"vssadmin.*delete\s+shadows|wbadmin\s+delete|bcdedit.*recoveryenabled\s+no", 3),
    "ransom_note": (rb"your files (have been|are) encrypted|decrypt(ion)? key|pay.{0,40}bitcoin", 3),
    "mass_crypto": (rb"(aes|rc4|xor).{0,400}(os\.walk|get-childitem\s+-recurse|for\s+/r)", 2),
    "obfuscation": (rb"(\^.){6,}|(\[char\]\d+\+?){4,}|replace\(['\"].{1,3}['\"],['\"]['\"]\)", 1),
    "raw_ip_url": (rb"https?://\d{1,3}(\.\d{1,3}){3}", 1),
    "keylogger_api": (rb"getasynckeystate|setwindowshookex|keybd_event", 2),
    "clipboard_hijack": (rb"get-clipboard|set-clipboard|system\.windows\.forms\.clipboard", 1),
    "screen_capture": (rb"copyfromscreen|bitblt|screencapture\b", 1),
    "av_discovery": (rb"get-mpcomputerstatus|select.*antivirusproduct|win32_product.*defender", 1),
}

# Static structural heuristics this engine can raise (for the detection catalog count).
HEURISTIC_TECHNIQUES = (
    "heur.rlo_filename", "heur.disguised_exe", "heur.double_extension", "heur.packed_pe",
    "heur.upx_packed", "heur.polyglot_image_pe", "heur.polyglot_image_zip", "heur.lnk_launcher",
    "heur.reg_persistence", "heur.punycode_domain", "heur.entropy_masquerade",
    "heur.base64_embedded_pe", "heur.base64_embedded_zip", "heur.office_macro_dropper",
    "heur.office_macro", "heur.office_vba_project", "heur.zip_bomb", "heur.script_in_archive",
    "heur.deeply_nested_archive", "heur.corrupt_archive", "heur.encrypted_archive_member",
    "heur.pdf_active_content", "heur.rtf_ole_object", "heur.zip_path_traversal",
    "heur.reserved_device_name", "heur.trailing_space_ext",
)


def detection_catalog(rules: dict) -> dict:
    """Every distinct detection technique the engine knows, grouped by layer — the number
    we drive toward 90. Signatures count each pattern; the rest count techniques."""
    from .monitor import MONITOR_TECHNIQUES
    return {
        "signatures": [p["name"] for p in rules.get("patterns", [])],
        "static_heuristics": list(HEURISTIC_TECHNIQUES),
        "script_signals": list(SCRIPT_CHECKS.keys()),
        "behavior_monitor": list(MONITOR_TECHNIQUES),
    }


@dataclass
class Finding:
    rule: str
    severity: str  # SUSPICIOUS | MALICIOUS
    detail: str = ""


@dataclass
class ScanResult:
    path: str
    sha256: str
    size: int
    verdict: str = "CLEAN"
    findings: list[Finding] = field(default_factory=list)
    quarantined_to: str | None = None
    malware_class: str = "CLEAN"   # MALWARE | PUA | TEST | POLICY | SUSPECT | CLEAN
    category: str = ""
    confidence: str = ""
    rationale: str = ""

    def add(self, rule: str, severity: str, detail: str = "") -> None:
        self.findings.append(Finding(rule, severity, detail))
        if SEV[severity] > SEV[self.verdict]:
            self.verdict = severity

    def to_dict(self) -> dict:
        d = asdict(self)
        return d


def load_rules(path: Path = RULES_PATH) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        rules = json.load(f)
    for r in rules.get("patterns", []):
        flags = re.IGNORECASE if r.get("ignore_case", True) else 0
        r["_re"] = re.compile(r["regex"].encode("latin-1"), flags)
    rules["_hashes"] = {h.lower() for h in rules.get("hashes", [])}
    rules["_allow"] = {h.lower() for h in rules.get("allow_hashes", [])}
    return rules


def entropy(data: bytes) -> float:
    if not data:
        return 0.0
    counts = [0] * 256
    for b in data:
        counts[b] += 1
    n = len(data)
    return -sum((c / n) * math.log2(c / n) for c in counts if c)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class Scanner:
    def __init__(self, rules: dict | None = None, quarantine_dir: Path | None = None,
                 yara_engine=None, intel=None):
        self.rules = rules or load_rules()
        if quarantine_dir:
            self.quarantine_dir = Path(quarantine_dir)
        else:
            from .paths import DATA
            self.quarantine_dir = DATA / "quarantine"
        if yara_engine is None:
            from .yara_engine import YaraEngine
            yara_engine = YaraEngine()
        self.yara = yara_engine          # YARA layer (inactive if yara/rules absent)
        self.intel = intel               # VirusTotal layer (opt-in; None = off)

    # ---------- core ----------
    def scan_bytes(self, data: bytes, name: str = "<memory>", _depth: int = 0) -> ScanResult:
        res = ScanResult(path=name, sha256=sha256_bytes(data), size=len(data))
        ext = Path(name).suffix.lower()
        stem_exts = [s.lower() for s in Path(name).suffixes]

        # 0. allowlist (known-good) — suppress false positives before any rule fires
        if res.sha256 in self.rules.get("_allow", set()):
            return res

        # filename tricks
        if RLO in name:
            res.add("heur.rlo_filename", "MALICIOUS", "right-to-left override hides real extension")

        # 1. signatures
        if res.sha256 in self.rules["_hashes"]:
            res.add("sig.hash", "MALICIOUS", "known-bad SHA-256")
        head = data[:2_000_000]  # pattern-scan first 2 MB
        for r in self.rules.get("patterns", []):
            if r["_re"].search(head):
                res.add(f"sig.{r['name']}", r.get("severity", "MALICIOUS"), r.get("desc", ""))

        # 2. heuristics
        is_pe = data[:2] == b"MZ"
        if is_pe and ext in DECOY_EXT:
            res.add("heur.disguised_exe", "MALICIOUS", f"PE executable with {ext} extension")
        if len(stem_exts) >= 2 and stem_exts[-1] in EXEC_EXT and stem_exts[-2] in DECOY_EXT:
            res.add("heur.double_extension", "MALICIOUS", f"{stem_exts[-2]}{stem_exts[-1]}")
        if is_pe:
            e = entropy(data[1024:]) if len(data) > 4096 else 0
            if e > 7.4:
                res.add("heur.packed_pe", "SUSPICIOUS", f"entropy {e:.2f} — likely packed/encrypted")
            if b"UPX0" in head or b"UPX1" in head or b"UPX!" in head:
                res.add("heur.upx_packed", "SUSPICIOUS", "UPX packer sections present")
        # executable or archive smuggled inside an image file (polyglot)
        if any(data.startswith(sig) for sig in IMAGE_MAGIC):
            if DOS_STUB in data:
                res.add("heur.polyglot_image_pe", "MALICIOUS", "Windows executable appended to an image")
            elif b"PK\x03\x04" in data[16:]:
                res.add("heur.polyglot_image_zip", "SUSPICIOUS", "archive appended to an image")
        # shortcut (.lnk) that launches a shell/script host or a URL
        if ext == ".lnk":
            low = head.lower()
            for kw in (b"powershell", b"cmd.exe", b"wscript", b"cscript", b"mshta",
                       b"rundll32", b"regsvr32", b"-enc", b"bypass", b"http://", b"https://"):
                if kw in low:
                    res.add("heur.lnk_launcher", "SUSPICIOUS", f"shortcut references {kw.decode()}")
                    break
        # registry file writing an autostart / persistence key
        if ext == ".reg" and re.search(rb"currentversion\\run|\\services\\|userinit|winlogon\\shell", head, re.I):
            res.add("heur.reg_persistence", "SUSPICIOUS", "registry autostart/persistence key")
        # internationalized (punycode) domain — homoglyph phishing
        if not is_pe and data[:4] != b"PK\x03\x04" and re.search(rb"\bxn--[a-z0-9-]{2,}", head, re.I):
            res.add("heur.punycode_domain", "SUSPICIOUS", "punycode/internationalized domain")
        # PDF with active content (JavaScript / auto-launch)
        if data[:5] == b"%PDF-":
            if re.search(rb"/Launch\b|/JavaScript\b|/JS\b|/OpenAction\b|/AA\b|/EmbeddedFile\b", head):
                res.add("heur.pdf_active_content", "SUSPICIOUS", "PDF auto-action / JavaScript / embedded file")
        # RTF carrying an embedded OLE object (classic exploit carrier)
        if data[:5] == b"{\\rtf" and re.search(rb"\\objdata|\\objupdate|\\objembed|objclass", head, re.I):
            res.add("heur.rtf_ole_object", "SUSPICIOUS", "RTF embedded OLE object")
        # filename tricks: trailing space/dot (Windows strips it, hiding the true type)
        if name and (name[-1] in " ." and not name.endswith("..")):
            res.add("heur.trailing_space_ext", "SUSPICIOUS", "filename ends with space/dot — hides true extension")
        # reserved Windows device name used as a filename
        if Path(name).stem.upper() in {"CON", "PRN", "AUX", "NUL",
                                        *(f"COM{i}" for i in range(1, 10)),
                                        *(f"LPT{i}" for i in range(1, 10))}:
            res.add("heur.reserved_device_name", "SUSPICIOUS", "reserved device name as filename")
        if ext in SCRIPT_EXT or (not is_pe and ext in {"", ".txt"} and b"\x00" not in head[:4096]):
            self._script_heuristics(head, res)
        if ext in OFFICE_EXT:
            self._office_heuristics(head, res)
        if ext in TEXTISH_EXT and not is_pe and data[:4] != b"PK\x03\x04" and len(data) > 2048:
            e = entropy(data)
            if e > 7.2:
                res.add("heur.entropy_masquerade", "SUSPICIOUS", f"entropy {e:.2f} in a {ext} file — likely encrypted/packed payload")

        # base64-encoded payloads hidden in text/scripts (dropper trick)
        if not is_pe and (ext in SCRIPT_EXT or ext in TEXTISH_EXT or ext in {"", ".html", ".hta"}):
            self._encoded_payload(head, res)

        # 3. look inside archives (zip, and zip-based office/jar/apk)
        if data[:4] == b"PK\x03\x04" and len(data) < ARCHIVE_MAX_BYTES:
            if _depth < ARCHIVE_MAX_DEPTH:
                self._scan_archive(data, res, _depth)
            else:
                res.add("heur.deeply_nested_archive", "SUSPICIOUS", f"archive nested deeper than {ARCHIVE_MAX_DEPTH} — common evasion")

        # 4. YARA community rules
        if self.yara is not None and self.yara.active:
            for rule_name, sev, cat in self.yara.scan(data):
                res.add(f"yara.{cat}.{rule_name}", sev, "YARA rule match")

        # 5. cloud hash reputation (VirusTotal) — opt-in. Look up REAL files: a standalone file,
        #    or files unpacked from an archive (depth 1). Never the zip wrapper itself — malware
        #    feeds re-zip samples, so the container hash is unique and VT has never seen it; the
        #    payload inside is what carries the known, widely-flagged hash.
        if (_depth <= 1 and data[:4] != b"PK\x03\x04"
                and self.intel is not None and self.intel.enabled):
            v = self.intel.lookup_hash(res.sha256)
            if v["found"] and v["verdict"] in ("MALICIOUS", "SUSPICIOUS"):
                res.add("intel.virustotal", v["verdict"], f"{v['malicious']}/{v['total']} engines flagged")

        # 6. classification — what is it, and how sure (also downgrades PUA from "trojan")
        if _depth == 0:
            from .classify import classify
            classify(res, name)
        return res

    def _encoded_payload(self, data: bytes, res: ScanResult) -> None:
        for m in re.finditer(rb"[A-Za-z0-9+/]{200,}={0,2}", data[:1_000_000]):
            chunk = m.group()
            try:
                dec = base64.b64decode(chunk[: (len(chunk) // 4) * 4])
            except Exception:
                continue
            if dec[:2] == b"MZ":
                res.add("heur.base64_embedded_pe", "MALICIOUS", "base64-encoded Windows executable embedded in text")
                return
            if dec[:4] == b"PK\x03\x04":
                res.add("heur.base64_embedded_zip", "SUSPICIOUS", "base64-encoded archive embedded in text")
                return

    def _scan_archive(self, data: bytes, res: ScanResult, depth: int) -> None:
        try:
            zf = _ZipReader(io.BytesIO(data))
        except (zipfile.BadZipFile, OSError):
            res.add("heur.corrupt_archive", "SUSPICIOUS", "declares itself a zip but is malformed")
            return
        for m in zf.infolist()[:ARCHIVE_MAX_MEMBERS]:
            if m.is_dir():
                continue
            if m.filename.lower().endswith("vbaproject.bin"):
                res.add("heur.office_vba_project", "SUSPICIOUS", f"embedded macro project ({m.filename})")
            if m.compress_size and m.file_size > 1_000_000 and m.file_size / m.compress_size > 100:
                res.add("heur.zip_bomb", "SUSPICIOUS", f"{m.filename}: {m.file_size // m.compress_size}x compression ratio")
            if ".." in m.filename.replace("\\", "/").split("/") or m.filename.startswith(("/", "\\")) or (len(m.filename) > 1 and m.filename[1] == ":"):
                res.add("heur.zip_path_traversal", "MALICIOUS", f"zip-slip path escape ({m.filename})")
            mext = Path(m.filename).suffix.lower()
            if mext in (EXEC_EXT | SCRIPT_EXT):
                res.add("heur.script_in_archive", "SUSPICIOUS", f"executable/script inside archive ({m.filename})")
            if m.file_size > ARCHIVE_MEMBER_MAX:
                continue
            blob = None
            try:
                zf.setpassword(None)
                with zf.open(m) as fh:
                    blob = fh.read(ARCHIVE_MEMBER_MAX)
            except (RuntimeError, zipfile.BadZipFile, OSError, ValueError):
                # Encrypted member: retry with the known research passwords. Covers legacy
                # ZipCrypto and (with pyzipper) WinZip-AES.
                for pwd in ARCHIVE_PASSWORDS:
                    try:
                        zf.setpassword(pwd)
                        with zf.open(m) as fh:
                            blob = fh.read(ARCHIVE_MEMBER_MAX)
                        break
                    except (RuntimeError, zipfile.BadZipFile, OSError, ValueError):
                        continue
            if blob is None:
                res.add("heur.encrypted_archive_member", "SUSPICIOUS", m.filename)
                continue
            inner = self.scan_bytes(blob, name=m.filename, _depth=depth + 1)
            if inner.verdict != "CLEAN":
                for f in inner.findings:
                    res.add(f"archive.{f.rule}", f.severity, f"{m.filename}: {f.detail}")

    def _script_heuristics(self, text: bytes, res: ScanResult) -> None:
        t = text.lower()
        score = 0
        hits = []
        for name, (rx, w) in SCRIPT_CHECKS.items():
            if re.search(rx, t, re.S):
                score += w
                hits.append(name)
        if score >= 3:
            res.add("heur.script_malicious", "MALICIOUS", ", ".join(hits))
        elif score >= 1:
            res.add("heur.script_suspicious", "SUSPICIOUS", ", ".join(hits))

    def _office_heuristics(self, text: bytes, res: ScanResult) -> None:
        t = text.lower()
        macro = re.search(rb"auto_?open|document_open|workbook_open|autoexec", t)
        danger = re.search(rb"shell\s*\(|wscript\.shell|createobject\s*\(|powershell|cmd\.exe|urldownloadtofile", t)
        if macro and danger:
            res.add("heur.office_macro_dropper", "MALICIOUS", "auto-run macro + shell/download call")
        elif macro or danger:
            res.add("heur.office_macro", "SUSPICIOUS", "macro keywords present")

    # ---------- files ----------
    def scan_file(self, path: str | os.PathLike) -> ScanResult:
        p = Path(path)
        try:
            data = p.read_bytes()
        except OSError as e:
            r = ScanResult(path=str(p), sha256="", size=0)
            r.add("io.unreadable", "SUSPICIOUS", str(e))
            return r
        res = self.scan_bytes(data, name=p.name)
        res.path = str(p)
        return res

    def scan_dir(self, root: str | os.PathLike, exclude: set[Path] | None = None) -> list[ScanResult]:
        root = Path(root)
        exclude = {Path(e).resolve() for e in (exclude or set())} | {self.quarantine_dir.resolve()}
        out: list[ScanResult] = []
        for dp, dns, fns in os.walk(root):
            dpr = Path(dp).resolve()
            if any(dpr == e or e in dpr.parents for e in exclude):
                dns[:] = []
                continue
            for fn in fns:
                out.append(self.scan_file(Path(dp) / fn))
        return out

    def quarantine(self, res: ScanResult) -> str | None:
        """Move file to vault. Never deletes — restore is always possible."""
        src = Path(res.path)
        if not src.exists():
            return None
        self.quarantine_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        dst = self.quarantine_dir / f"{stamp}_{res.sha256[:12]}_{src.name}.quar"
        shutil.move(str(src), str(dst))
        meta = {"original_path": str(src), "sha256": res.sha256, "verdict": res.verdict,
                "malware_class": res.malware_class, "category": res.category,
                "findings": [asdict(f) for f in res.findings], "quarantined_at": stamp}
        dst.with_suffix(".quar.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        res.quarantined_to = str(dst)
        return str(dst)

    def restore(self, quar_file: str | os.PathLike) -> str:
        q = Path(quar_file)
        meta = json.loads(q.with_suffix(".quar.json").read_text(encoding="utf-8"))
        dst = Path(meta["original_path"])
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(q), str(dst))
        q.with_suffix(".quar.json").unlink(missing_ok=True)
        return str(dst)

    def list_quarantine(self) -> list[dict]:
        """Every item in the vault, from its metadata sidecar (newest first)."""
        out = []
        if not self.quarantine_dir.exists():
            return out
        for meta in sorted(self.quarantine_dir.glob("*.quar.json"), reverse=True):
            try:
                d = json.loads(meta.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            quar = meta.with_suffix("")  # strip .json -> ...name.quar
            d["quar_file"] = str(quar)
            d["exists"] = quar.exists()
            out.append(d)
        return out

    def delete_quarantine(self, quar_file: str | os.PathLike) -> None:
        """Permanently remove a quarantined item and its metadata."""
        q = Path(quar_file)
        q.unlink(missing_ok=True)
        q.with_suffix(".quar.json").unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="sentinel", description="Sentinel static scanner")
    ap.add_argument("target", help="file or folder")
    ap.add_argument("--quarantine", action="store_true", help="move MALICIOUS files to the vault")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    s = Scanner()
    t = Path(a.target)
    results = s.scan_dir(t) if t.is_dir() else [s.scan_file(t)]
    bad = 0
    for r in results:
        if r.verdict == "MALICIOUS" and a.quarantine:
            s.quarantine(r)
        if r.verdict != "CLEAN":
            bad += 1
        if a.json:
            print(json.dumps(r.to_dict()))
        elif r.verdict != "CLEAN":
            why = "; ".join(f"{f.rule}({f.detail})" for f in r.findings)
            print(f"[{r.verdict:10}] {r.path}  <- {why}" + (f"  => {r.quarantined_to}" if r.quarantined_to else ""))
    print(f"\nScanned {len(results)} files — {bad} flagged.")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
