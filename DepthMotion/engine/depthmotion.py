"""DepthMotion engine — any video in, motion-reference passes out.

Depth comes from Video-Depth-Anything (ByteDance, Apache-2.0 code), running locally on an NVIDIA GPU.
Passes:
  depth    grey depth, near = white          (Kling motion, Wan VACE, depth ControlNets)
  clay     depth re-lit as matte grey clay   (Seedance 2.5 "white model" / blockout reference)
  normal   RGB normal map                    (normal ControlNets, relighting, compositing)
  color    depth through a colour ramp       (reading the scene by eye)
  tinted   grey depth with each person tinted their colour (depth AND who is who — the previz look)
  people   each person in their own flat colour (who is who; segmentation ControlNets, compositing)
  compare  source | depth side by side       (review)
  png16    16-bit PNG depth frames           (Blender, Resolve, Nuke)

CLI:  python depthmotion.py clip.mp4 --start 12.5 --end 18 --passes depth,clay --isolate 0.35 --people auto
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
import warnings

import cv2
import numpy as np

warnings.filterwarnings("ignore")
ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(ROOT, "vda"))

HOME = os.environ.get("DEPTHMOTION_HOME") or os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "DepthMotion")
MODELS = os.path.join(HOME, "models")
DEFAULT_OUT = os.path.join(os.path.expanduser("~"), "Videos", "DepthMotion")

MODEL_CONFIGS = {
    "vits": {"encoder": "vits", "features": 64, "out_channels": [48, 96, 192, 384]},
    "vitl": {"encoder": "vitl", "features": 256, "out_channels": [256, 512, 1024, 1024]},
}
WEIGHTS = {
    "vits": ("https://huggingface.co/depth-anything/Video-Depth-Anything-Small/resolve/main/video_depth_anything_vits.pth", 116440756),
    "vitl": ("https://huggingface.co/depth-anything/Video-Depth-Anything-Large/resolve/main/video_depth_anything_vitl.pth", 1538392012),
}
RAMPS = {"inferno": cv2.COLORMAP_INFERNO, "turbo": cv2.COLORMAP_TURBO, "magma": cv2.COLORMAP_MAGMA,
         "viridis": cv2.COLORMAP_VIRIDIS, "plasma": cv2.COLORMAP_PLASMA}
PASSES = ("depth", "clay", "tinted", "normal", "color", "people", "compare", "png16")
_models = {}


def ffmpeg():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def weights_path(encoder):
    return os.path.join(MODELS, f"video_depth_anything_{encoder}.pth")


def has_weights(encoder):
    p = weights_path(encoder)
    return os.path.exists(p) and os.path.getsize(p) == WEIGHTS[encoder][1]


def fetch_weights(encoder, say=None):
    """Download a model once into DEPTHMOTION_HOME/models (resumes nothing; writes .part then renames)."""
    if has_weights(encoder):
        return weights_path(encoder)
    os.makedirs(MODELS, exist_ok=True)
    url, size = WEIGHTS[encoder]
    part = weights_path(encoder) + ".part"
    with urllib.request.urlopen(url) as r, open(part, "wb") as f:
        got = 0
        while chunk := r.read(1 << 20):
            f.write(chunk)
            got += len(chunk)
            if say:
                say(got / size, f"Downloading the {'Large' if encoder == 'vitl' else 'Small'} model · {got / 1e6:.0f} of {size / 1e6:.0f} MB")
    os.replace(part, weights_path(encoder))
    return weights_path(encoder)


def load_model(encoder="vitl", say=None):
    if encoder not in _models:
        import torch
        from video_depth_anything.video_depth import VideoDepthAnything
        if not torch.cuda.is_available():
            raise RuntimeError("DepthMotion needs an NVIDIA graphics card (CUDA was not found).")
        fetch_weights(encoder, say)
        m = VideoDepthAnything(**MODEL_CONFIGS[encoder])
        m.load_state_dict(torch.load(weights_path(encoder), map_location="cpu"), strict=True)
        _models.clear()  # one model in VRAM at a time
        _models[encoder] = m.to("cuda").eval()
    return _models[encoder]


def probe(path):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise ValueError("This file can't be opened as a video.")
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    n = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    cap.release()
    return {"w": w, "h": h, "fps": fps, "dur": n / fps if n > 0 else 0.0}


def read_frames(path, start=0.0, end=None, max_res=1280):
    """Decode [start, end) with ffmpeg, scaled so the long side <= max_res (even dims)."""
    info = probe(path)
    scale = min(1.0, max_res / max(info["w"], info["h"]))
    w = int(round(info["w"] * scale / 2) * 2)
    h = int(round(info["h"] * scale / 2) * 2)
    cmd = [ffmpeg(), "-v", "error", "-ss", str(start or 0)]
    if end:
        cmd += ["-to", str(end)]
    cmd += ["-i", path, "-vf", f"scale={w}:{h}:flags=lanczos", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
    frames = np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)
    if len(frames) == 0:
        raise ValueError("No frames in that range — check the in and out points.")
    return frames, info["fps"]


def normalize(depths, lo_pct=1.0, hi_pct=99.0):
    """Clip-wide robust normalisation to 0..1 (near = 1). One range for the whole clip = no flicker."""
    sample = depths[:: max(1, len(depths) // 60)].ravel()
    lo, hi = np.percentile(sample, [lo_pct, hi_pct])
    return np.clip((depths - lo) / max(hi - lo, 1e-6), 0, 1).astype(np.float32)


def matte(d, cutoff, feather=0.06):
    """0..1 mask: 1 for everything nearer than `cutoff`, soft edge. cutoff 0 = keep the whole scene."""
    if cutoff <= 0:
        return np.ones_like(d)
    return np.clip((d - cutoff) / feather, 0, 1)


def normals(d, relief=2.5):
    z = cv2.GaussianBlur(d, (0, 0), 3.0)
    gy, gx = np.gradient(z * max(d.shape) * relief)
    gx, gy = np.clip(gx, -2.5, 2.5), np.clip(gy, -2.5, 2.5)  # depth cliffs at silhouettes stay soft
    n = np.dstack([-gx, -gy, np.ones_like(z)])
    return n / np.linalg.norm(n, axis=2, keepdims=True), z


def clay(d):
    """Shade a normalised float depth frame as matte grey clay: key light top-left + fill + ambient."""
    n, z = normals(d)
    key = np.array([-0.5, -0.6, 0.62]); key /= np.linalg.norm(key)
    fill = np.array([0.6, 0.2, 0.77]); fill /= np.linalg.norm(fill)
    shade = 0.12 + 0.78 * np.clip(n @ key, 0, 1) + 0.15 * np.clip(n @ fill, 0, 1)
    shade *= 0.55 + 0.45 * z  # atmospheric falloff: far things recede
    return np.clip(shade, 0, 1)


def normal_rgb(d):
    """Tangent-space style normal map: R = right, G = up, B = toward camera (flat = #8080ff)."""
    n, _ = normals(d)
    rgb = np.dstack([n[..., 0], -n[..., 1], n[..., 2]])
    return ((rgb * 0.5 + 0.5) * 255).astype(np.uint8)


def colorize(d, ramp="inferno"):
    return cv2.cvtColor(cv2.applyColorMap((d * 255).astype(np.uint8), RAMPS[ramp]), cv2.COLOR_BGR2RGB)


class Writer:
    def __init__(self, path, w, h, fps):
        self.p = subprocess.Popen(
            [ffmpeg(), "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}",
             "-r", f"{fps:.6f}", "-i", "-", "-c:v", "libx264", "-crf", "14", "-preset", "medium",
             "-pix_fmt", "yuv420p", "-movflags", "+faststart", path],
            stdin=subprocess.PIPE, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    def write(self, rgb):
        self.p.stdin.write(np.ascontiguousarray(rgb, np.uint8).tobytes())

    def close(self):
        self.p.stdin.close()
        self.p.wait()


def run(video, start=0.0, end=None, passes=("depth", "clay", "compare"), quality="best",
        cutoff=0.0, invert=False, ramp="inferno", out_dir=None, progress=None, name=None, people=None, only_people=False):
    """people: None (off), "auto" (find them on the first frame), or [{"box": [x1, y1, x2, y2] as fractions, "color": "#hex"}]."""
    t0 = time.time()
    say = progress or (lambda frac, msg: print(f"[{frac:4.0%}] {msg}", flush=True))
    encoder = "vitl" if quality == "best" else "vits"
    model = load_model(encoder, lambda f, m: say(0.02 + 0.08 * f, m))
    say(0.10, "Reading the clip")
    frames, fps = read_frames(video, start, end)
    n, h, w = frames.shape[:3]

    say(0.15, f"Reading depth from {n} frames")
    raw, _ = model.infer_video_depth(frames, fps, input_size=518, device="cuda", fp32=False)
    d = normalize(np.asarray(raw))
    if invert:
        d = 1 - d

    labels, tints = None, []
    if people or "people" in passes or "tinted" in passes:
        import people as ppl
        if people in (None, "auto"):
            say(0.55, "Finding the people")
            people = [{"box": b, "color": ppl.COLORS[i % len(ppl.COLORS)]} for i, b in enumerate(ppl.find(frames[0]))]
        if people:
            labels = ppl.track(frames, [p["box"] for p in people], lambda f, m: say(0.56 + 0.14 * f, m))
            tints = [ppl.rgb(p["color"]) for p in people]

    name = name or os.path.splitext(os.path.basename(video))[0]
    tag = f"_{start:g}-{end:g}s" if (start or end) else ""
    out_dir = out_dir or os.path.join(DEFAULT_OUT, f"{name}{tag}")
    os.makedirs(out_dir, exist_ok=True)
    files = {p: os.path.join(out_dir, f"{name}{tag}_{p}" + ("" if p == "png16" else ".mp4")) for p in passes}
    if "png16" in files:
        os.makedirs(files["png16"], exist_ok=True)
    writers = {p: Writer(f, w * (2 if p == "compare" else 1), h, fps) for p, f in files.items() if p != "png16"}

    base = 0.70 if labels is not None else 0.55
    for i in range(n):
        lab = cv2.medianBlur(labels[i], 5) if labels is not None else None
        m = matte(d[i], cutoff)
        if only_people and lab is not None:
            m = m * (lab > 0)
        di = d[i] * m
        gray3 = np.dstack([(di * 255).astype(np.uint8)] * 3)
        for p, wr in writers.items():
            if p == "depth":
                wr.write(gray3)
            elif p == "color":
                wr.write(colorize(di, ramp))
            elif p == "clay":
                c = clay(d[i]) * m
                img = np.dstack([c * 232, c * 228, c * 222])
                for k, tint in enumerate(tints):  # each person is clay of their own colour, same light
                    sel = lab == k + 1
                    img[sel] = c[sel, None] * (60 + 195 * tint)
                wr.write(img.astype(np.uint8))
            elif p == "normal":
                nr = normal_rgb(d[i])
                wr.write((nr * m[..., None]).astype(np.uint8) if cutoff > 0 else nr)
            elif p == "tinted":
                img = gray3.astype(np.float32)
                for k, tint in enumerate(tints):  # pale tint: brightness still reads as depth
                    sel = lab == k + 1
                    img[sel] = di[sel, None] * 255 * (0.45 + 0.55 * tint)
                wr.write(np.clip(img, 0, 255).astype(np.uint8))
            elif p == "people":
                flat = np.zeros((h, w, 3), np.float32)
                for k, tint in enumerate(tints):
                    flat[lab == k + 1] = tint * 255
                wr.write(flat.astype(np.uint8))
            elif p == "compare":
                wr.write(np.hstack([frames[i], gray3]))
        if "png16" in files:
            cv2.imwrite(os.path.join(files["png16"], f"depth_{i:05d}.png"), (di * 65535).astype(np.uint16))
        if i % 8 == 0:
            say(base + (0.99 - base) * i / n, f"Writing passes · frame {i} of {n}")
    for wr in writers.values():
        wr.close()

    say(1.0, f"Done in {time.time() - t0:.0f}s")
    return files, out_dir


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="DepthMotion — video to motion-reference passes")
    ap.add_argument("video", nargs="?")
    ap.add_argument("--start", type=float, default=0.0, help="in point, seconds")
    ap.add_argument("--end", type=float, default=None, help="out point, seconds")
    ap.add_argument("--passes", default="depth,clay,compare", help="any of " + ",".join(PASSES))
    ap.add_argument("--fast", action="store_true", help="Small model (fast preview)")
    ap.add_argument("--isolate", type=float, default=0.0, help="0..1 — black out everything farther than this")
    ap.add_argument("--invert", action="store_true", help="near = black")
    ap.add_argument("--ramp", default="inferno", choices=list(RAMPS))
    ap.add_argument("--people", choices=["auto"], help="find, follow and colour each person")
    ap.add_argument("--only-people", action="store_true", help="black out everything but the people")
    ap.add_argument("--out", default=None)
    ap.add_argument("--prefetch", choices=["vits", "vitl"], help="only download a model, then exit")
    a = ap.parse_args()
    if a.prefetch:
        print(fetch_weights(a.prefetch, lambda f, m: print(f"{f:.0%} {m}", flush=True)))
        sys.exit(0)
    files, folder = run(a.video, a.start, a.end, tuple(a.passes.split(",")), "fast" if a.fast else "best",
                        a.isolate, a.invert, a.ramp, a.out, people=a.people, only_people=a.only_people)
    print(json.dumps(files, indent=2))
