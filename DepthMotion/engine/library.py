"""The scene library: real folders on disk (default Videos\\DepthMotion), so any file explorer sees the same thing.

A *scene* is a folder holding a DepthMotion result (depthmotion.json + its videos). Everything else is a folder.
Status colours are written the way Foldernator writes them — the folder's desktop.ini:
    [.ShellClassInfo]  IconResource=<Foldernator's coloured folder icon>,0
    [alva]             Status=<key>   Color=#hex
so a status set here shows in Foldernator (and in Windows Explorer, through the icon), and the other way round.
"""
import glob
import json
import os
import subprocess
import time

import depthmotion as dm

APPDATA = os.environ.get("APPDATA", os.path.expanduser("~"))
FN_SETTINGS = os.path.join(APPDATA, "Foldernator", "settings.json")
FN_ICONS = os.path.join(APPDATA, "alva explorer", "icons")  # Foldernator keeps its icons where it started
DEFAULT_STATUSES = [
    {"key": "unpublished", "label": "Not published", "color": "#f83a22"},
    {"key": "neutral", "label": "Neutral", "color": "#8f8f8f"},
    {"key": "scheduled", "label": "Scheduled", "color": "#ffad46"},
    {"key": "published", "label": "Published", "color": "#16a765"},
]
NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
MARK = "depthmotion.json"


def root():
    r = dm.DEFAULT_OUT
    os.makedirs(r, exist_ok=True)
    return r


def inside(path):
    """Only ever touch things inside the library."""
    r = os.path.normcase(os.path.abspath(root()))
    p = os.path.normcase(os.path.abspath(path))
    return p == r or p.startswith(r + os.sep)


def statuses():
    try:
        s = json.load(open(FN_SETTINGS, encoding="utf-8")).get("statuses")
        if s:
            return [{"key": x["key"], "label": x["label"], "color": x["color"]} for x in s]
    except Exception:
        pass
    return DEFAULT_STATUSES


def read_status(folder):
    ini = os.path.join(folder, "desktop.ini")
    st, color = None, None
    try:
        sect = None
        for line in open(ini, encoding="utf-8", errors="ignore"):
            line = line.strip()
            if line.startswith("["):
                sect = line.lower()
            elif sect == "[alva]" and "=" in line:
                k, v = line.split("=", 1)
                if k.strip().lower() == "status":
                    st = v.strip() or None
                elif k.strip().lower() == "color":
                    color = v.strip() or None
    except OSError:
        pass
    return st, color


def write_status(folder, key):
    """Set (or clear, key=None) a folder's status — in Foldernator's own desktop.ini format."""
    ini = os.path.join(folder, "desktop.ini")
    if os.path.exists(ini):
        subprocess.run(["attrib", "-s", "-h", "-r", ini], creationflags=NOWIN, capture_output=True)
    if not key:
        if os.path.exists(ini):
            os.remove(ini)
        return
    color = next((s["color"] for s in statuses() if s["key"] == key), "#8f8f8f")
    icon = os.path.join(FN_ICONS, f"folder-v1-flat-{color.lstrip('#').lower()}.ico")
    lines = []
    if os.path.exists(icon):
        lines += ["[.ShellClassInfo]", f"IconResource={icon},0"]
    lines += ["[alva]", f"Status={key}", f"Color={color}"]
    with open(ini, "w", encoding="utf-8", newline="\r\n") as f:
        f.write("\n".join(lines) + "\n")
    subprocess.run(["attrib", "+s", "+h", ini], creationflags=NOWIN, capture_output=True)
    subprocess.run(["attrib", "+r", folder], creationflags=NOWIN, capture_output=True)  # Windows only reads it then


def scene_info(folder):
    meta = {}
    try:
        meta = json.load(open(os.path.join(folder, MARK), encoding="utf-8"))
    except Exception:
        pass
    st, color = read_status(folder)
    thumb = os.path.join(folder, "thumb.jpg")
    vids = sorted(glob.glob(os.path.join(folder, "*.mp4")))
    if not os.path.exists(thumb) and vids:  # older results: make the thumbnail once, from the first frame
        src = next((v for v in vids if v.endswith(("_compare.mp4", "_check.mp4"))), vids[0])
        subprocess.run([dm.ffmpeg(), "-v", "error", "-y", "-i", src, "-frames:v", "1", "-vf", "scale=320:-2", thumb],
                       creationflags=NOWIN, capture_output=True)
    if "kind" not in meta:
        meta["kind"] = "location" if any(os.path.basename(v).startswith("relocated_") for v in vids) else "extract"
    return {"name": os.path.basename(folder), "path": folder, "kind": meta.get("kind", "extract"),
            "status": st, "color": color, "thumb": thumb if os.path.exists(thumb) else None,
            "made": meta.get("made"), "clip": meta.get("clip"), "style": meta.get("style")}


def is_scene(folder):
    return os.path.exists(os.path.join(folder, MARK)) or bool(glob.glob(os.path.join(folder, "*_tinted.mp4")) or
                                                               glob.glob(os.path.join(folder, "*_clay.mp4")) or
                                                               glob.glob(os.path.join(folder, "relocated_*.mp4")))


def tree(folder=None, depth=0):
    folder = folder or root()
    st, color = read_status(folder)
    node = {"name": os.path.basename(folder) if depth else "Library", "path": folder, "status": st, "color": color,
            "folders": [], "scenes": []}
    try:
        entries = sorted(os.scandir(folder), key=lambda e: e.name.lower())
    except OSError:
        return node
    for e in entries:
        if not e.is_dir() or e.name.startswith((".", "_")) or e.name in ("frames", "env_clay", "env_depth", "masks", "preview"):
            continue
        if is_scene(e.path):
            node["scenes"].append(scene_info(e.path))
        elif depth < 6:
            node["folders"].append(tree(e.path, depth + 1))
    return node


def mkdir(parent, name):
    name = "".join(c for c in name if c not in '<>:"/\\|?*').strip() or "New folder"
    p = os.path.join(parent, name)
    k = 2
    while os.path.exists(p):
        p = os.path.join(parent, f"{name} ({k})"); k += 1
    os.makedirs(p)
    return p


def rename(path, name):
    name = "".join(c for c in name if c not in '<>:"/\\|?*').strip()
    if not name:
        raise ValueError("That name can't be used.")
    to = os.path.join(os.path.dirname(path), name)
    if os.path.exists(to):
        raise ValueError("Something with that name is already there.")
    os.rename(path, to)
    return to


def move(path, into):
    to = os.path.join(into, os.path.basename(path))
    if os.path.exists(to):
        raise ValueError("Something with that name is already there.")
    if os.path.normcase(into).startswith(os.path.normcase(path) + os.sep):
        raise ValueError("A folder can't go inside itself.")
    os.rename(path, to)
    return to


def trash(path):
    """To the Recycle Bin (never a hard delete)."""
    kind = "DeleteDirectory" if os.path.isdir(path) else "DeleteFile"
    ps = (f"Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::{kind}("
          f"'{path.replace(chr(39), chr(39) * 2)}', 'OnlyErrorDialogs', 'SendToRecycleBin')")
    r = subprocess.run(["powershell", "-NoProfile", "-Command", ps], creationflags=NOWIN, capture_output=True, text=True)
    if r.returncode != 0 or os.path.exists(path):
        raise RuntimeError("Couldn't move it to the Recycle Bin.")


def foldernator():
    """Foldernator's Start-menu shortcut, if it's installed."""
    for base in (os.path.join(APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"),
                 os.path.join(os.environ.get("ProgramData", r"C:\ProgramData"), "Microsoft", "Windows", "Start Menu", "Programs"),
                 os.path.join(os.path.expanduser("~"), "Desktop")):
        hit = glob.glob(os.path.join(base, "**", "Foldernator.lnk"), recursive=True)
        if hit:
            return hit[0]
    return None


def open_in(path, app="foldernator"):
    lnk = foldernator() if app == "foldernator" else None
    if lnk:
        os.startfile(lnk, arguments=f'"{path}"')
    else:
        subprocess.Popen(["explorer", os.path.normpath(path)])


def scope_in_foldernator():
    """Whether Foldernator shows status colours for the library (its 'Use status colors here' list)."""
    try:
        sc = json.load(open(FN_SETTINGS, encoding="utf-8")).get("statusScopes") or []
        r = os.path.normcase(root())
        return any(os.path.normcase(s.rstrip("\\*")) in (r, os.path.dirname(r)) or r.startswith(os.path.normcase(s.rstrip("\\*"))) for s in sc)
    except Exception:
        return False


def stamp(folder, kind, clip, extra=None, frame=None):
    """Mark a result folder as a scene: what made it, from which clip, plus a thumbnail."""
    meta = {"kind": kind, "clip": clip, "made": time.strftime("%Y-%m-%d %H:%M"), **(extra or {})}
    json.dump(meta, open(os.path.join(folder, MARK), "w", encoding="utf-8"), indent=1)
    if frame is not None:
        import cv2
        h, w = frame.shape[:2]
        small = cv2.resize(frame, (320, round(320 * h / w)))
        cv2.imwrite(os.path.join(folder, "thumb.jpg"), cv2.cvtColor(small, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 82])
