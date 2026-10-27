"""DepthMotion local server: serves the UI, takes a clip, runs the engine, streams results back.

Listens on 127.0.0.1 only. Exits on its own a little after the app window closes (the page sends a heartbeat).
"""
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

import depthmotion as dm
import guard
import library

UI = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "ui")
INBOX = os.path.join(dm.HOME, "inbox")
CLIPS = {}            # id -> {"path", "name", "info"}
JOB = {"state": "idle", "frac": 0, "msg": "", "files": {}, "folder": "", "error": ""}
LOCK = threading.Lock()
LAST_BEAT = [time.time()]
try:  # stamped by build.js, so the launcher can tell a running engine from an older build
    BUILD = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "BUILD")).read().strip()
except OSError:
    BUILD = "dev"
SERVED = set()        # output files the page may stream
TOP = [0.0, []]       # (when, biggest RAM users) — cached for the gauge


def gpu_info():
    try:
        import torch
        if torch.cuda.is_available():
            p = torch.cuda.get_device_properties(0)
            return {"ok": True, "name": p.name.replace("NVIDIA GeForce ", ""), "vram": round(p.total_memory / 2 ** 30)}
    except Exception:
        pass
    return {"ok": False, "name": "No NVIDIA card found", "vram": 0}


GPU = gpu_info()


def work(clip, opts):
    def say(frac, msg):
        JOB.update(frac=round(frac, 4), msg=msg)
    try:
        files, folder = dm.run(clip["path"], opts["start"], opts["end"] or None, tuple(opts["passes"]), opts["quality"],
                               opts["cutoff"], opts["invert"], opts["ramp"],
                               os.path.join(dest(opts), re.sub(r'[<>:"/\\|?*]', "_", opts["folder"])), say,
                               os.path.splitext(clip["name"])[0], opts.get("people") or None, bool(opts.get("onlyPeople")))
        SERVED.update(f for f in files.values() if f.endswith(".mp4"))
        mark(folder, "extract", clip, opts, {"passes": list(opts["passes"])})
        JOB.update(state="done", files=files, folder=folder)
    except Exception as e:  # shown to the person as-is (a memory stop explains itself)
        JOB.update(state="error", error=str(e) or e.__class__.__name__)


def work_location(clip, opts):
    """New location: the real people in a Blender set, through the clip's own camera move."""
    def say(frac, msg):
        JOB.update(frac=round(frac, 4), msg=msg)
    try:
        import location
        out = os.path.join(dest(opts), re.sub(r'[<>:"/\\|?*]', "_", opts["folder"]))
        if opts.get("remerge"):
            files = location.remerge(opts["remerge"], opts["quality"], say); out = opts["remerge"]
        else:
            files, out = location.run(clip["path"], opts["start"], opts["end"] or None, opts["style"], int(opts["seed"]),
                                      float(opts["sun"]), opts["quality"], None, out, say, opts.get("people") or None)
        files = {k: v for k, v in files.items() if k != "blend"}
        SERVED.update(f for f in files.values() if f.endswith(".mp4"))
        if not opts.get("remerge"):
            mark(out, "location", clip, opts, {"style": opts["style"], "seed": opts["seed"], "sun": opts["sun"]})
        JOB.update(state="done", files=files, folder=out, blend=os.path.join(out, "env.blend"))
    except Exception as e:
        JOB.update(state="error", error=str(e) or e.__class__.__name__)


def dest(opts):
    """The library folder the person picked (never anywhere outside the library)."""
    d = opts.get("dest") or ""
    return d if d and os.path.isdir(d) and library.inside(d) else library.root()


def mark(folder, kind, clip, opts, extra):
    try:
        frame = dm.read_frames(clip["path"], float(opts.get("start") or 0), float(opts.get("start") or 0) + 0.15)[0][0]
    except Exception:
        frame = None
    library.stamp(folder, kind, clip["name"], {"start": opts.get("start"), "end": opts.get("end"),
                                                "colors": opts.get("colors") or [p.get("color") for p in (opts.get("people") or []) if isinstance(p, dict)],
                                                **extra}, frame)


def scene_files(folder):
    """A saved scene's videos, keyed like a fresh result (so the page shows it the same way)."""
    files = {}
    for f in os.listdir(folder):
        if f.endswith(".mp4"):
            k = f.rsplit("_", 1)[-1][:-4] if not f.startswith("relocated_") else f[10:-4]
            files[k] = os.path.join(folder, f)
    png = [d for d in os.listdir(folder) if d.endswith("_png16") and os.path.isdir(os.path.join(folder, d))]
    if png:
        files["png16"] = os.path.join(folder, png[0])
    return files


def blender_found():
    import glob
    return bool(glob.glob(os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "Blender Foundation", "Blender *", "blender.exe")))


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send_json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def body(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")

    def send_file(self, path):
        size = os.path.getsize(path)
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        rng = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        start, end = 0, size - 1
        if rng:
            start = int(rng.group(1) or 0)
            end = int(rng.group(2)) if rng.group(2) else size - 1
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            try:
                while left > 0 and (chunk := f.read(min(1 << 20, left))):
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
                pass

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/api/state":
            return self.send_json({"gpu": GPU, "large": dm.has_weights("vitl"), "small": dm.has_weights("vits"), "out": dm.DEFAULT_OUT,
                                   "blender": blender_found(), "build": BUILD})
        if u.path == "/api/status":
            return self.send_json(JOB)
        if u.path == "/api/resources":
            now = time.time()
            if now - TOP[0] > 6:  # the app list takes a moment; refresh it every few seconds only
                TOP[0], TOP[1] = now, guard.top_apps()
            return self.send_json({**guard.snapshot(), "top": TOP[1], "busy": JOB["state"] == "running"})
        if u.path == "/api/library":
            return self.send_json({"tree": library.tree(), "statuses": library.statuses(),
                                   "foldernator": bool(library.foldernator()), "scoped": library.scope_in_foldernator()})
        if u.path == "/api/scene":
            p = q.get("p", [""])[0]
            if not (p and os.path.isdir(p) and library.inside(p)):
                return self.send_error(404)
            files = scene_files(p)
            SERVED.update(f for f in files.values() if f.endswith(".mp4"))
            blend = os.path.join(p, "env.blend")
            return self.send_json({"files": files, "folder": p, "blend": blend if os.path.exists(blend) else "",
                                   "info": library.scene_info(p)})
        if u.path == "/thumb":
            p = q.get("p", [""])[0]
            return self.send_file(p) if p.endswith("thumb.jpg") and library.inside(p) and os.path.exists(p) else self.send_error(404)
        if u.path == "/api/beat":
            LAST_BEAT[0] = time.time()
            return self.send_json({"ok": True})
        if u.path == "/clip":
            c = CLIPS.get(q.get("id", [""])[0])
            return self.send_file(c["path"]) if c else self.send_error(404)
        if u.path == "/out":
            p = q.get("p", [""])[0]
            return self.send_file(p) if p in SERVED and os.path.exists(p) else self.send_error(404)
        f = os.path.normpath(os.path.join(UI, u.path.lstrip("/") or "index.html"))
        if f.startswith(UI) and os.path.isfile(f):
            return self.send_file(f)
        self.send_error(404)

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/api/upload":
            name = os.path.basename(unquote(self.headers.get("X-Name", "clip.mp4")))
            cid = uuid.uuid4().hex[:10]
            os.makedirs(INBOX, exist_ok=True)
            path = os.path.join(INBOX, f"{cid}_{name}")
            left = int(self.headers.get("Content-Length", 0))
            with open(path, "wb") as f:
                while left > 0 and (chunk := self.rfile.read(min(1 << 20, left))):
                    f.write(chunk)
                    left -= len(chunk)
            try:
                info = dm.probe(path)
            except Exception as e:
                os.remove(path)
                return self.send_json({"error": str(e)}, 400)
            CLIPS[cid] = {"path": path, "name": name, "info": info}
            return self.send_json({"id": cid, "name": name, "info": info})
        if u.path == "/api/quit":  # the launcher found a newer build: step aside (never mid-job)
            if JOB["state"] == "running":
                return self.send_json({"error": "busy"}, 409)
            self.send_json({"ok": True})
            threading.Timer(0.3, lambda: os._exit(0)).start()
            return
        if u.path == "/api/run":
            o = self.body()
            c = CLIPS.get(o.get("id"))
            if not c:
                return self.send_json({"error": "Drop a clip first."}, 400)
            with LOCK:
                if JOB["state"] == "running":
                    return self.send_json({"error": "Already working on a clip."}, 409)
                JOB.update(state="running", frac=0, msg="Starting", files={}, folder="", error="")
            stem = os.path.splitext(c["name"])[0]
            o["folder"] = stem + (f"_{o['start']:g}-{o['end']:g}s" if o.get("start") or o.get("end") else "")
            threading.Thread(target=work, args=(c, o), daemon=True).start()
            return self.send_json({"ok": True})
        if u.path == "/api/preflight":
            o = self.body(); c = CLIPS.get(o.get("id"))
            if not c:
                return self.send_json({"error": "no clip"}, 400)
            i = c["info"]
            span = ((o.get("end") or i["dur"]) - (o.get("start") or 0)) or i["dur"]
            loc = o.get("mode") == "location"
            return self.send_json(guard.preflight(int(span * i["fps"]) + 1, i["w"], i["h"], people=loc or bool(o.get("people")),
                                                  location=loc))
        if u.path in ("/api/location", "/api/remerge"):
            o = self.body()
            c = CLIPS.get(o.get("id"))
            if u.path == "/api/location" and not c:
                return self.send_json({"error": "Drop a clip first."}, 400)
            if not blender_found():
                return self.send_json({"error": "New location needs Blender (free, blender.org). Install it, then try again."}, 400)
            with LOCK:
                if JOB["state"] == "running":
                    return self.send_json({"error": "Already working on a clip."}, 409)
                JOB.update(state="running", frac=0, msg="Starting", files={}, folder="", error="", blend="")
            if u.path == "/api/remerge":
                o["remerge"] = o.get("folder") or ""
                if not os.path.isfile(os.path.join(o["remerge"], "env.blend")):
                    JOB.update(state="idle")
                    return self.send_json({"error": "Build a location first."}, 400)
            else:
                stem = os.path.splitext(c["name"])[0]
                o["folder"] = stem + (f"_{o['start']:g}-{o['end']:g}s" if o.get("start") or o.get("end") else "") + f"_{o['style']}"
            threading.Thread(target=work_location, args=(c, o), daemon=True).start()
            return self.send_json({"ok": True})
        if u.path.startswith("/api/library/"):
            o = self.body(); op = u.path.rsplit("/", 1)[-1]
            p = o.get("path") or ""
            if op != "mkdir" and not (p and os.path.exists(p) and library.inside(p) and os.path.normcase(p) != os.path.normcase(library.root())):
                return self.send_json({"error": "That isn't in the library."}, 400)
            try:
                if op == "mkdir":
                    parent = o.get("parent") or library.root()
                    if not library.inside(parent):
                        return self.send_json({"error": "That isn't in the library."}, 400)
                    return self.send_json({"path": library.mkdir(parent, o.get("name") or "New folder")})
                if op == "rename":
                    return self.send_json({"path": library.rename(p, o.get("name", ""))})
                if op == "move":
                    into = o.get("into") or library.root()
                    if not library.inside(into):
                        return self.send_json({"error": "That isn't in the library."}, 400)
                    return self.send_json({"path": library.move(p, into)})
                if op == "status":
                    library.write_status(p, o.get("status")); return self.send_json({"ok": True})
                if op == "trash":
                    library.trash(p); return self.send_json({"ok": True})
                if op == "open":
                    library.open_in(p, o.get("app", "foldernator")); return self.send_json({"ok": True})
            except Exception as e:
                return self.send_json({"error": str(e)}, 400)
            return self.send_error(404)
        if u.path == "/api/openblend":
            p = self.body().get("path", "")
            if p.endswith(".blend") and os.path.isfile(p):
                os.startfile(p)  # the person's own Blender, with their own settings
            return self.send_json({"ok": True})
        if u.path == "/api/people":
            # finds the people on the first frame of the selection, so the person can see who gets which colour
            o = self.body()
            c = CLIPS.get(o.get("id"))
            if not c:
                return self.send_json({"error": "Drop a clip first."}, 400)
            if JOB["state"] == "running":
                return self.send_json({"error": "Busy with a clip — try again when it's done."}, 409)
            try:
                import base64
                import cv2
                import people
                with LOCK:
                    frame = dm.read_frames(c["path"], float(o.get("start") or 0), float(o.get("start") or 0) + 0.2)[0][0]
                    boxes = people.find(frame)
                small = cv2.resize(frame, (640, round(640 * frame.shape[0] / frame.shape[1])))
                jpg = cv2.imencode(".jpg", cv2.cvtColor(small, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 85])[1]
                return self.send_json({"boxes": boxes, "colors": people.COLORS, "frame": "data:image/jpeg;base64," + base64.b64encode(jpg).decode()})
            except Exception as e:
                return self.send_json({"error": str(e) or e.__class__.__name__}, 500)
        if u.path == "/api/open":
            p = self.body().get("path", "")
            if p and os.path.exists(p):
                subprocess.Popen(["explorer", "/select,", os.path.normpath(p)] if os.path.isfile(p) else ["explorer", os.path.normpath(p)])
            return self.send_json({"ok": True})
        self.send_error(404)


def window_open():
    """The app window's Edge profile holds a lockfile while it runs. (A window in the background only sends its heartbeat
    about once a minute — Edge slows hidden pages down — so the heartbeat alone can't tell "hidden" from "closed".)"""
    return os.path.exists(os.path.join(dm.HOME, "window", "lockfile"))


def watchdog():
    """Quit once the window is gone and nothing is rendering."""
    while True:
        time.sleep(5)
        gap = time.time() - LAST_BEAT[0]
        if JOB["state"] != "running" and (gap > 600 or (gap > 25 and not window_open())):
            shutil.rmtree(INBOX, ignore_errors=True)
            os._exit(0)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 7862
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    if "--keep" not in sys.argv:
        threading.Thread(target=watchdog, daemon=True).start()
    print(f"DepthMotion on http://127.0.0.1:{port}", flush=True)
    srv.serve_forever()
