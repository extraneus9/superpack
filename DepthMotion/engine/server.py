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

UI = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "ui")
INBOX = os.path.join(dm.HOME, "inbox")
CLIPS = {}            # id -> {"path", "name", "info"}
JOB = {"state": "idle", "frac": 0, "msg": "", "files": {}, "folder": "", "error": ""}
LOCK = threading.Lock()
LAST_BEAT = [time.time()]
SERVED = set()        # output files the page may stream


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
                               os.path.join(dm.DEFAULT_OUT, re.sub(r'[<>:"/\\|?*]', "_", opts["folder"])), say,
                               os.path.splitext(clip["name"])[0], opts.get("people") or None, bool(opts.get("onlyPeople")))
        SERVED.update(f for f in files.values() if f.endswith(".mp4"))
        JOB.update(state="done", files=files, folder=folder)
    except Exception as e:  # shown to the person as-is
        JOB.update(state="error", error=str(e) or e.__class__.__name__)


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
            return self.send_json({"gpu": GPU, "large": dm.has_weights("vitl"), "small": dm.has_weights("vits"), "out": dm.DEFAULT_OUT})
        if u.path == "/api/status":
            return self.send_json(JOB)
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


def watchdog():
    """Quit once the window has been gone for a while (no heartbeat) and nothing is rendering."""
    while True:
        time.sleep(5)
        if time.time() - LAST_BEAT[0] > 25 and JOB["state"] != "running":
            shutil.rmtree(INBOX, ignore_errors=True)
            os._exit(0)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 7862
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    if "--keep" not in sys.argv:
        threading.Thread(target=watchdog, daemon=True).start()
    print(f"DepthMotion on http://127.0.0.1:{port}", flush=True)
    srv.serve_forever()
