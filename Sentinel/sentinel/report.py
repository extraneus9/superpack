"""Sentinel — scan report export (CSV + PDF), pure standard library.

build_csv(entry) and build_pdf(entry) turn a stored scan-history entry into a downloadable
report. The PDF is written by hand (a minimal, valid PDF) so there are no third-party deps.
"""
from __future__ import annotations

import csv
import io


# ---------------------------------------------------------------- CSV
def build_csv(entry: dict) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Sentinel scan report"])
    w.writerow(["Date", entry.get("when", "")])
    w.writerow(["Scan type", entry.get("mode", "")])
    w.writerow(["Location", entry.get("root", "")])
    c = entry.get("counts", {})
    w.writerow(["Scanned", entry.get("scanned", 0)])
    w.writerow(["Malicious", c.get("MALICIOUS", 0), "Suspicious", c.get("SUSPICIOUS", 0),
                "Clean", c.get("CLEAN", 0)])
    w.writerow(["Flagged", entry.get("flagged", 0), "Elapsed (s)", entry.get("elapsed", 0)])
    w.writerow([])
    w.writerow(["path", "verdict", "class", "category", "confidence", "findings"])
    for r in entry.get("results", []):
        w.writerow([r.get("path", ""), r.get("verdict", ""), r.get("malware_class", ""),
                    r.get("category", ""), r.get("confidence", ""),
                    "; ".join(f.get("rule", "") for f in r.get("findings", []))])
    return buf.getvalue().encode("utf-8-sig")


# ---------------------------------------------------------------- PDF
def _esc(s: str) -> str:
    out = s.encode("latin-1", "replace").decode("latin-1")
    return out.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def _trunc(s: str, n: int) -> str:
    return s if len(s) <= n else "..." + s[-(n - 3):]


def _report_lines(entry: dict):
    """Yield (text, bold, size) report lines."""
    L = []
    def add(t="", b=False, s=11): L.append((t, b, s))
    add("SENTINEL", True, 22)
    add("Scan Report  ·  by alva", False, 11)
    add("")
    add(f"Date:      {entry.get('when','')}")
    add(f"Scan type: {entry.get('mode','')}")
    add(f"Location:  {_trunc(str(entry.get('root','')), 90)}")
    add("")
    add("Summary", True, 15)
    c = entry.get("counts", {})
    add(f"Files scanned:  {entry.get('scanned',0)}")
    add(f"Malicious: {c.get('MALICIOUS',0)}    Suspicious: {c.get('SUSPICIOUS',0)}    Clean: {c.get('CLEAN',0)}")
    add(f"Flagged: {entry.get('flagged',0)}    Time: {entry.get('elapsed',0)}s")
    add("")
    results = entry.get("results", [])
    add(f"Flagged files ({len(results)})", True, 15)
    if not results:
        add("Nothing flagged. Clean.")
    for r in results:
        head = f"[{r.get('verdict','')}] {r.get('malware_class','')}  -  {r.get('category','')}"
        if r.get("confidence"):
            head += f"  ({r['confidence'].lower()} conf)"
        add(head, True, 11)
        add(_trunc(str(r.get("path", "")), 95), False, 10)
        rules = ", ".join(f.get("rule", "") for f in r.get("findings", [])[:5])
        if rules:
            add("   " + _trunc(rules, 95), False, 9)
        add("")
    return L


def build_pdf(entry: dict) -> bytes:
    lines = _report_lines(entry)
    top, bottom, lh, x = 760, 56, 16, 50
    # paginate into pages of (text, bold, size, y)
    pages, cur, y = [], [], top
    for (txt, bold, size) in lines:
        if y < bottom:
            pages.append(cur); cur = []; y = top
        cur.append((txt, bold, size, y))
        y -= lh
    if cur:
        pages.append(cur)
    if not pages:
        pages = [[("Empty report", False, 11, top)]]

    objs: list[bytes] = []
    def add_obj(b: bytes) -> int:
        objs.append(b)
        return len(objs)  # 1-based object number

    # reserve ordering: catalog(1), pages(2), F1(3), F2(4), then page+content pairs
    catalog_n = 1; pages_n = 2; f1_n = 3; f2_n = 4
    objs.extend([b"", b"", b"", b""])  # placeholders for 1..4

    page_refs = []
    for pg in pages:
        parts = []
        for (txt, bold, size, yy) in pg:
            fnt = f2_n if bold else f1_n
            parts.append(f"BT /F{fnt} {size} Tf {x} {yy} Td ({_esc(txt)}) Tj ET".encode("latin-1"))
        stream = b"\n".join(parts)
        content_n = add_obj(b"%PDF_PLACEHOLDER_CONTENT%")
        objs[content_n - 1] = (f"{content_n} 0 obj\n<< /Length {len(stream)} >>\nstream\n".encode()
                               + stream + b"\nendstream\nendobj\n")
        page_n = add_obj(b"")
        objs[page_n - 1] = (f"{page_n} 0 obj\n<< /Type /Page /Parent {pages_n} 0 R "
                            f"/MediaBox [0 0 612 792] /Contents {content_n} 0 R "
                            f"/Resources << /Font << /F{f1_n} {f1_n} 0 R /F{f2_n} {f2_n} 0 R >> >> >>\n"
                            f"endobj\n").encode()
        page_refs.append(page_n)

    objs[catalog_n - 1] = f"{catalog_n} 0 obj\n<< /Type /Catalog /Pages {pages_n} 0 R >>\nendobj\n".encode()
    kids = " ".join(f"{n} 0 R" for n in page_refs)
    objs[pages_n - 1] = (f"{pages_n} 0 obj\n<< /Type /Pages /Kids [{kids}] /Count {len(page_refs)} >>\n"
                         f"endobj\n").encode()
    objs[f1_n - 1] = f"{f1_n} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n".encode()
    objs[f2_n - 1] = f"{f2_n} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n".encode()

    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for ob in objs:
        offsets.append(out.tell())
        out.write(ob)
    xref_pos = out.tell()
    n = len(objs)
    out.write(f"xref\n0 {n + 1}\n".encode())
    out.write(b"0000000000 65535 f \n")
    for off in offsets:
        out.write(f"{off:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {n + 1} /Root {catalog_n} 0 R >>\nstartxref\n{xref_pos}\n%%EOF".encode())
    return out.getvalue()
