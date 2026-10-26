"""Clip → 3D motion capture of every person → a Blender scene. Our own pipeline, no gated models.

1  people.py        find + follow each person (SAM 2.1), their box on every frame        (this environment)
2  mocap/rtm_joints 133 whole-body 3D joints per person per frame (RTMW3D, OpenMMLab)  (its own environment)
3  mannequin.py     joints → a block mannequin per person (capsules), fixed topology
4  to_blender.py    floor from the feet, Z-up world, the clip's camera, clay set from the clip's depth
5  blender/build_scene.py   scene.blend + clay preview; then preview.mp4 and check.mp4 (clip | preview)

CLI:  python mocap.py clip.mp4 --start 8 --end 12 --out <folder>
The RTMW3D environment's python is DEPTHMOTION_RTM_PY (default Z:\\APPS\\mocap\\venv-rtm\\Scripts\\python.exe).
"""
import argparse
import glob
import os
import subprocess

import cv2
import numpy as np

import depthmotion as dm
import mannequin
import people as ppl
import to_blender

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RTM_PY = os.environ.get("DEPTHMOTION_RTM_PY", r"Z:\APPS\mocap\venv-rtm\Scripts\python.exe")
NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def blender_exe():
    found = sorted(glob.glob(os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "Blender Foundation", "Blender *", "blender.exe")))
    if not found:
        raise RuntimeError("Blender wasn't found. Install it from blender.org, then try again.")
    return found[-1]  # the newest


def focal_px(width, hfov_deg=55.0):
    """Lens guess when nothing better is known: a ~35 mm-equivalent field of view."""
    return width / (2 * np.tan(np.radians(hfov_deg) / 2))


def run(video, start=0.0, end=None, out=None, colors=None, say=None):
    say = say or (lambda f, m: print(f"[{f:4.0%}] {m}", flush=True))
    frames, fps = dm.read_frames(video, start, end)
    t_, h, w = frames.shape[:3]
    name = os.path.splitext(os.path.basename(video))[0]
    tag = f"_{start:g}-{end:g}s" if (start or end) else ""
    out = out or os.path.join(dm.DEFAULT_OUT, f"{name}{tag}_blender")
    os.makedirs(os.path.join(out, "frames"), exist_ok=True)

    say(0.02, "Finding the people")
    found = ppl.find(frames[0], min_score=0.85, min_aspect=0.8)  # mocap wants whole, upright-ish bodies — not posts or ropes
    if not found:
        raise RuntimeError("Nobody found on the first frame — move the in point to a frame where everyone is visible.")
    labels = ppl.track(frames, found, lambda f, m: say(0.04 + 0.16 * f, m))
    boxes = np.full((len(found), t_, 4), np.nan, np.float32)
    for t in range(t_):
        cv2.imwrite(os.path.join(out, "frames", f"{t:05d}.jpg"), cv2.cvtColor(frames[t], cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
        for i in range(len(found)):
            ys, xs = np.nonzero(labels[t] == i + 1)
            if len(xs) >= 200:
                pad = 0.06 * max(np.ptp(xs), np.ptp(ys))  # a little air around the body helps the pose model
                boxes[i, t] = [max(0, xs.min() - pad), max(0, ys.min() - pad), min(w - 1, xs.max() + pad), min(h - 1, ys.max() + pad)]
    focal = focal_px(w)
    np.savez(os.path.join(out, "track.npz"), boxes=boxes, focal=focal, width=w, height=h, fps=fps)

    say(0.22, "Capturing the bodies")
    p = subprocess.Popen([RTM_PY, os.path.join(HERE, "mocap", "rtm_joints.py"), out], stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, text=True, creationflags=NOWIN)
    log = []
    for line in p.stdout:
        log.append(line)
        if line.startswith("PROGRESS"):
            say(0.22 + 0.48 * float(line.split()[1]), "Capturing the bodies")
    if p.wait() != 0 or not any("JOINTS_OK" in l for l in log):
        raise RuntimeError("Body capture failed:\n" + "".join(log[-15:]))
    joints = np.load(os.path.join(out, "joints.npz"))["joints"]

    say(0.72, "Building the mannequins and the set")
    colors = colors or ppl.COLORS
    keep = [i for i in range(len(found)) if not np.isnan(joints[i]).all()]
    placed, up, floor_pt = to_blender.place_on_floor([joints[i] for i in keep], focal, w, h)
    people, faces = [], None
    for i, jp in zip(keep, placed):
        v, faces = mannequin.build(jp)
        people.append({"name": f"PERSON_{i + 1}", "color": colors[i % len(colors)], "verts": v})
    model = dm.load_model("vits")
    raw, _ = model.infer_video_depth(frames[: min(t_, 32)], fps, input_size=518, device="cuda", fp32=False)
    disp = dm.normalize(np.asarray(raw))[0]
    to_blender.build(out, people, faces, focal, w, h, fps, disp, labels[0], floor=(up, floor_pt))

    say(0.80, "Building the Blender scene")
    r = subprocess.run([blender_exe(), "-b", "--factory-startup", "--python", os.path.join(HERE, "blender", "build_scene.py"), "--", out],
                       capture_output=True, text=True, creationflags=NOWIN)
    if "DEPTHMOTION_BLEND_OK" not in r.stdout:
        raise RuntimeError("Blender couldn't build the scene:\n" + (r.stdout + r.stderr)[-1500:])

    say(0.95, "Making the preview")
    ff = dm.ffmpeg()
    subprocess.run([ff, "-v", "error", "-y", "-framerate", f"{fps:.6f}", "-i", os.path.join(out, "preview", "f_%04d.png"),
                    "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", os.path.join(out, "preview.mp4")], check=True, creationflags=NOWIN)
    subprocess.run([ff, "-v", "error", "-y", "-framerate", f"{fps:.6f}", "-i", os.path.join(out, "frames", "%05d.jpg"),
                    "-i", os.path.join(out, "preview.mp4"), "-filter_complex", "[0][1]hstack", "-c:v", "libx264", "-crf", "18",
                    "-pix_fmt", "yuv420p", os.path.join(out, "check.mp4")], check=True, creationflags=NOWIN)
    say(1.0, "Done")
    return {"blend": os.path.join(out, "scene.blend"), "preview": os.path.join(out, "preview.mp4"),
            "check": os.path.join(out, "check.mp4"), "folder": out}


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="DepthMotion mocap — clip to a Blender scene")
    ap.add_argument("video")
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--end", type=float, default=None)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    print(run(a.video, a.start, a.end, a.out))
