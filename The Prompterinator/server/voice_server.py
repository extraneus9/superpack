# -*- coding: utf-8 -*-
"""
The Prompterinator — local voice engine + app server.

  • Serves the prompter app over http://127.0.0.1:8787  (secure context: mic + display APIs work)
  • Streams microphone speech through faster-whisper (CUDA if present) and pushes
    partial/final transcripts to the app over ws://127.0.0.1:8788
  • 100% offline. No cloud speech, no internet needed.

Run:      python voice_server.py
Self-test: python voice_server.py --selftest        (no mic; feeds canned phrases)
           python voice_server.py --devices         (list microphones and exit)
"""
from __future__ import annotations
import argparse, asyncio, json, os, queue, sys, threading, time, http.server, socketserver, functools, webbrowser, io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
ROOT = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.join(ROOT, "app")
CONFIG_PATH = os.path.join(ROOT, "config.json")

DEFAULTS = {
    "http_port": 8787,
    "ws_port": 8788,
    "model": "small",              # tiny | base | small | medium | large-v3
    "language": "en",              # en | es | auto
    "input_device": None,          # index, or null = system default
    "input_device_name": None,     # remembered name (recovers after re-index)
    "window_seconds": 6.0,         # rolling audio window sent to whisper
    "step_seconds": 0.7,           # how often we transcribe
    "vad": True,
    "open_browser": True,
}

def load_config() -> dict:
    cfg = dict(DEFAULTS)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg.update(json.load(f) or {})
        except Exception as e:
            print("config.json unreadable, using defaults:", e)
    return cfg

def save_config(cfg: dict):
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
    except Exception as e:
        print("could not save config:", e)

# ───────────────────────── microphones ─────────────────────────
def list_input_devices():
    """One entry per physical mic (Windows exposes each 4×); WASAPI preferred."""
    import sounddevice as sd
    try:
        devs = sd.query_devices(); apis = sd.query_hostapis()
    except Exception as e:
        return [], f"audio system error: {e}"
    prio = {"Windows WASAPI": 0, "MME": 1, "Windows DirectSound": 2, "Windows WDM-KS": 3, "Core Audio": 0, "ALSA": 0}
    best = {}
    for i, d in enumerate(devs):
        if d.get("max_input_channels", 0) < 1:
            continue
        name = (d.get("name") or "").strip()
        api = apis[d["hostapi"]]["name"] if d.get("hostapi") is not None and d["hostapi"] < len(apis) else ""
        key = name.split(" (")[0].lower()
        rank = prio.get(api, 5)
        cur = best.get(key)
        if cur is None or rank < cur["rank"]:
            best[key] = {"index": i, "name": name, "api": api, "rank": rank,
                         "rate": int(d.get("default_samplerate") or 16000),
                         "channels": int(d.get("max_input_channels") or 1)}
    try:
        default_in = sd.default.device[0]
    except Exception:
        default_in = -1
    out = []
    for v in best.values():
        v = dict(v); rank = v.pop("rank", 5)
        name_l = v["name"].lower()
        # penalise dead or low-quality endpoints (Bluetooth Hands-Free, mix/loopback, driver phantoms)
        bad = any(k in name_l for k in ("hands-free", "handsfree", "bthhfenum", "stereo mix", "mezcla", "wave out", "loopback", "primary sound"))
        thin = v["rate"] and v["rate"] < 16000
        v["is_default"] = (v["index"] == default_in)
        v["quality"] = (0 if v["is_default"] and not bad else 1) + rank * 0.1 + (10 if bad else 0) + (5 if thin else 0) + (0 if v["api"] in ("Windows WASAPI", "MME", "Core Audio", "ALSA") else 2)
        v["suspect"] = bool(bad or thin)
        out.append(v)
    out.sort(key=lambda d: (d["quality"], d["name"].lower()))
    return out, None

def device_candidates(cfg):
    """Ordered list to try: pinned → OS default (if healthy) → best quality → the rest.
    Windows exposes dead Bluetooth 'Hands-Free' / WDM-KS phantoms that fail to open (whisper-flow v7.1)."""
    devs, err = list_input_devices()
    if err or not devs:
        return [], (err or "no microphone found")
    want_i, want_n = cfg.get("input_device"), (cfg.get("input_device_name") or "").lower()
    ordered, seen = [], set()
    def push(d):
        if d and d["index"] not in seen:
            seen.add(d["index"]); ordered.append(d)
    if want_i is not None:
        push(next((d for d in devs if d["index"] == want_i and (not want_n or want_n in d["name"].lower())), None))
    if want_n:
        push(next((d for d in devs if want_n in d["name"].lower()), None))
    push(next((d for d in devs if d["is_default"] and not d["suspect"]), None))
    for d in devs:
        if not d["suspect"]: push(d)
    for d in devs: push(d)          # last resort: even the suspect ones
    return ordered, None

# ───────────────────────── ASR worker ─────────────────────────
class VoiceEngine:
    def __init__(self, cfg, on_event):
        self.cfg = cfg; self.on_event = on_event
        self.model = None; self.model_name = None
        self.thread = None; self.stop_flag = threading.Event()
        self.running = False; self.device_label = ""

    def ensure_model(self):
        name = self.cfg.get("model", "small")
        if self.model is not None and self.model_name == name:
            return
        from faster_whisper import WhisperModel
        self.on_event({"type": "status", "state": "loading", "msg": f"loading model {name}…"})
        try:
            self.model = WhisperModel(name, device="cuda", compute_type="float16")
            dev = "cuda"
        except Exception:
            self.model = WhisperModel(name, device="cpu", compute_type="int8")
            dev = "cpu"
        self.device = dev
        self.model_name = name
        self.on_event({"type": "status", "state": "ready", "msg": f"model {name} on {dev}"})

    def start(self):
        if self.running: return
        self.stop_flag.clear(); self.thread = threading.Thread(target=self._run, daemon=True); self.thread.start()

    def stop(self):
        self.stop_flag.set(); self.running = False
        self.on_event({"type": "status", "state": "stopped", "msg": "microphone off"})

    def _run(self):
        import numpy as np, sounddevice as sd
        try:
            self.ensure_model()
        except Exception as e:
            self.on_event({"type": "error", "msg": f"model load failed: {e}"}); return
        cands, err = device_candidates(self.cfg)
        if err:
            self.on_event({"type": "error", "msg": err}); return
        SR = 16000
        q: "queue.Queue[np.ndarray]" = queue.Queue()

        def cb(indata, frames, t, status):
            q.put(indata[:, 0].copy())

        stream = None; native = SR; dev = None; last = None; tried = []
        for cand in cands[:6]:
            for rate in dict.fromkeys([SR, int(cand["rate"] or SR)]):    # 16k first, then the device's own rate
                try:
                    st = sd.InputStream(device=cand["index"], channels=1, samplerate=rate,
                                        blocksize=int(rate * 0.1), dtype="float32", callback=cb)
                    st.start()
                    stream, native, dev = st, rate, cand; break
                except Exception as e:
                    last = e; tried.append(f'{cand["name"][:28]}@{rate}')
            if stream: break
        if stream is None:
            self.on_event({"type": "error", "msg": f"could not open any microphone ({len(tried)} tried). Last error: {last}"}); return
        self.device_label = f'{dev["name"]} ({dev["api"]} {native} Hz)'
        if tried:
            print("  skipped:", ", ".join(tried[:5]))

        self.running = True
        self.on_event({"type": "status", "state": "listening", "msg": self.device_label})
        win = float(self.cfg.get("window_seconds", 6.0)); step = float(self.cfg.get("step_seconds", 0.7))
        buf = np.zeros(0, dtype="float32"); last_t = 0.0; last_text = ""
        try:
            while not self.stop_flag.is_set():
                try:
                    chunk = q.get(timeout=0.3)
                except queue.Empty:
                    continue
                if native != SR:                              # resample to 16 kHz
                    n = int(len(chunk) * SR / native)
                    chunk = np.interp(np.linspace(0, len(chunk), n, endpoint=False), np.arange(len(chunk)), chunk).astype("float32")
                buf = np.concatenate([buf, chunk])[-int(win * SR):]
                now = time.time()
                if now - last_t < step or len(buf) < SR * 0.6:
                    continue
                last_t = now
                if float(np.sqrt(np.mean(buf[-int(SR*0.5):] ** 2))) < 0.004:   # silence gate
                    continue
                lang = self.cfg.get("language", "en")
                try:
                    segs, _ = self.model.transcribe(
                        buf, language=None if lang == "auto" else lang,
                        beam_size=1, temperature=0.0, condition_on_previous_text=False,
                        vad_filter=bool(self.cfg.get("vad", True)),
                        vad_parameters={"min_silence_duration_ms": 300},
                    )
                    text = " ".join(s.text.strip() for s in segs).strip()
                except Exception as e:
                    # an NVIDIA card without a full CUDA 12 runtime loads the model but fails here (cublas…):
                    # switch to the CPU once and keep following the speaker instead of failing every line
                    low = str(e).lower()
                    if getattr(self, "device", "cpu") == "cuda" and any(k in low for k in ("cublas", "cudnn", "cuda")):
                        from faster_whisper import WhisperModel
                        self.on_event({"type": "status", "state": "loading", "msg": "GPU unavailable, switching to CPU…"})
                        try:
                            self.model = WhisperModel(self.model_name, device="cpu", compute_type="int8"); self.device = "cpu"
                            self.on_event({"type": "status", "state": "ready", "msg": f"model {self.model_name} on cpu"})
                        except Exception as e2:
                            self.on_event({"type": "error", "msg": f"transcribe: {e2}"})
                        continue
                    self.on_event({"type": "error", "msg": f"transcribe: {e}"}); continue
                if text and text != last_text:
                    last_text = text
                    self.on_event({"type": "partial", "text": text, "t": now})
        finally:
            try: stream.stop(); stream.close()
            except Exception: pass
            self.running = False

# ───────────────────────── WebSocket bridge ─────────────────────────
class Bridge:
    def __init__(self, cfg, selftest=False):
        self.cfg = cfg; self.clients = set(); self.loop = None; self.selftest = selftest
        self.engine = VoiceEngine(cfg, self.emit)

    def emit(self, payload: dict):
        if self.loop is None: return
        asyncio.run_coroutine_threadsafe(self._broadcast(payload), self.loop)

    async def _broadcast(self, payload: dict):
        dead = []
        for ws in list(self.clients):
            try: await ws.send(json.dumps(payload))
            except Exception: dead.append(ws)
        for d in dead: self.clients.discard(d)

    async def handler(self, ws):
        self.clients.add(ws)
        devs, err = list_input_devices()
        await ws.send(json.dumps({"type": "hello", "app": "prompter-voice", "v": 1,
                                  "devices": devs, "error": err, "config": self.cfg,
                                  "listening": self.engine.running, "selftest": self.selftest}))
        try:
            async for raw in ws:
                try: msg = json.loads(raw)
                except Exception: continue
                cmd = msg.get("cmd")
                if cmd == "start":
                    if self.selftest: asyncio.create_task(self._fake_stream())
                    else: self.engine.start()
                elif cmd == "stop":
                    self.engine.stop()
                elif cmd == "config":
                    for k in ("model", "language", "input_device", "input_device_name", "window_seconds", "step_seconds", "vad"):
                        if k in msg: self.cfg[k] = msg[k]
                    save_config(self.cfg)
                    await ws.send(json.dumps({"type": "config", "config": self.cfg}))
                    if self.engine.running:      # re-open with the new device/model
                        self.engine.stop(); await asyncio.sleep(0.3); self.engine.start()
                elif cmd == "devices":
                    devs, err = list_input_devices()
                    await ws.send(json.dumps({"type": "devices", "devices": devs, "error": err}))
                elif cmd == "say":               # manual injection (tests)
                    await self._broadcast({"type": "partial", "text": msg.get("text", ""), "t": time.time()})
        except Exception:
            pass
        finally:
            self.clients.discard(ws)

    async def _fake_stream(self):
        """--selftest: canned phrases so the whole client path can be verified without a mic."""
        await self._broadcast({"type": "status", "state": "listening", "msg": "SELFTEST (no microphone)"})
        for phrase in ["hello and welcome to the show",
                       "thanks for having me", "today we talk about three things",
                       "and the first one is the most important"]:
            await asyncio.sleep(1.0)
            await self._broadcast({"type": "partial", "text": phrase, "t": time.time()})

# ───────────────────────── ports / single instance ─────────────
def port_free(port):
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s0:
        s0.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s0.bind(("127.0.0.1", int(port))); return True
        except OSError:
            return False

def pick_port(start, tries=25):
    p = int(start)
    for i in range(tries):
        if port_free(p + i):
            return p + i
    return int(start)

def already_running(http_port):
    """If another copy is already serving, return its URL (so we just focus it)."""
    import urllib.request, json as _j
    for p in range(int(http_port), int(http_port) + 6):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{p}/engine.json", timeout=0.6) as r:
                d = _j.loads(r.read().decode("utf-8"))
                if d.get("app") == "prompterinator":
                    return f"http://127.0.0.1:{p}/index.html"
        except Exception:
            pass
    return None

# ───────────────────────── HTTP (app) ─────────────────────────
def serve_app(cfg):
    if not os.path.isdir(APP_DIR):
        print(f"! app folder missing: {APP_DIR}"); return None
    info = {"app": "prompterinator", "ws_port": int(cfg["ws_port"]), "http_port": int(cfg["http_port"]), "v": 1}
    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw): super().__init__(*a, directory=APP_DIR, **kw)
        def log_message(self, *a): pass
        def do_GET(self):
            if self.path.split("?")[0] in ("/engine.json", "/engine"):
                body = json.dumps(info).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body))); self.send_header("Cache-Control", "no-store")
                self.end_headers(); self.wfile.write(body); return
            return super().do_GET()
    class Q(socketserver.TCPServer):
        allow_reuse_address = True
        def handle_error(self, *a): pass
    cfg["http_port"] = pick_port(cfg["http_port"]); info["http_port"] = int(cfg["http_port"])
    httpd = Q(("127.0.0.1", int(cfg["http_port"])), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd

async def main_async(cfg, selftest):
    import websockets
    bridge = Bridge(cfg, selftest=selftest)
    bridge.loop = asyncio.get_running_loop()
    cfg["ws_port"] = pick_port(cfg["ws_port"])
    # only the prompter page itself may talk to the engine (any other website could otherwise read live transcripts)
    hp = int(cfg["http_port"])
    origins = [f"http://127.0.0.1:{hp}", f"http://localhost:{hp}", "null", None]  # null = the standalone .html opened from disk
    async with websockets.serve(bridge.handler, "127.0.0.1", int(cfg["ws_port"]), max_size=2**22, origins=origins):
        url = f'http://127.0.0.1:{cfg["http_port"]}/index.html'
        print(f"The Prompterinator — local voice engine")
        print(f"  app:    {url}")
        print(f"  voice:  ws://127.0.0.1:{cfg['ws_port']}  (model {cfg['model']}, lang {cfg['language']})")
        print("  Ctrl+C to quit.")
        if cfg.get("open_browser") and not selftest:
            try: webbrowser.open(url)
            except Exception: pass
        await asyncio.Future()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true", help="no microphone; stream canned phrases")
    ap.add_argument("--devices", action="store_true", help="list microphones and exit")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--model"); ap.add_argument("--language"); ap.add_argument("--http-port", type=int); ap.add_argument("--ws-port", type=int)
    a = ap.parse_args()
    cfg = load_config()
    for k, v in (("model", a.model), ("language", a.language), ("http_port", a.http_port), ("ws_port", a.ws_port)):
        if v: cfg[k] = v
    if a.no_browser: cfg["open_browser"] = False
    if a.devices:
        devs, err = list_input_devices()
        print(json.dumps({"devices": devs, "error": err}, indent=2, ensure_ascii=False)); return
    serve_app(cfg)
    try:
        asyncio.run(main_async(cfg, a.selftest))
    except KeyboardInterrupt:
        print("\nbye")

if __name__ == "__main__":
    main()
