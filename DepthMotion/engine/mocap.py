"""Clip → 3D motion capture of every person → a Blender scene. Our own pipeline, no gated models.

1  people.py        find + follow each person (SAM 2.1), their box on every frame        (this environment)
2  mocap/rtm_joints 133 whole-body 3D joints per person per frame (RTMW3D, OpenMMLab)  (its own environment)
3  mannequin.py     joints → a block mannequin per person (capsules), fixed topology
4  to_blender.py    floor from the feet, Z-up world, the clip's camera, clay set from the clip's depth
5  blender/build_scene.py   scene.blend + clay preview; then preview.mp4 and check.mp4 (clip | preview)

CLI:  python mocap.py clip.mp4 --start 8 --end 12 --out <folder>
The RTMW3D environment's python is DEPTHMOTION_RTM_PY (default: <DepthMotion home>/mocap/venv-rtm).
"""
import argparse
import glob
import json
import os
import subprocess

import cv2
import numpy as np

import depthmotion as dm
import mannequin
import people as ppl
import to_blender

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RTM_PY = os.environ.get("DEPTHMOTION_RTM_PY", os.path.join(dm.HOME, "mocap", "venv-rtm", "Scripts", "python.exe"))
NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
BLENDER_PROFILE = os.path.join(dm.HOME, "blender-user")


def blender_exe():
    found = sorted(glob.glob(os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "Blender Foundation", "Blender *", "blender.exe")))
    if not found:
        raise RuntimeError("Blender wasn't found. Install it from blender.org, then try again.")
    return found[-1]  # the newest


def focal_px(width, hfov_deg=55.0):
    """Lens guess when nothing better is known: a ~35 mm-equivalent field of view."""
    return width / (2 * np.tan(np.radians(hfov_deg) / 2))


def match_score(out, labels, ids):
    """How well each rendered body covers the real person, per frame: IoU (overlap ÷ union) of silhouettes."""
    files = sorted(glob.glob(os.path.join(out, "masks", "m_*.png")))
    per = {k: [] for k in ids}
    for t, f in enumerate(files):
        img = cv2.imread(f, cv2.IMREAD_UNCHANGED)
        if img is None or t >= len(labels):
            continue
        rgb = img[..., 2::-1].astype(int); alpha = img[..., 3] > 127
        for n, k in enumerate(ids):
            want = np.zeros(3, int); want[[0, 1, 2, 0, 0, 1][n]] = 255
            rend = alpha & (np.abs(rgb - want).sum(-1) < 120)
            real = labels[t] == k
            u = (rend | real).sum()
            per[k].append(float((rend & real).sum() / u) if u else 0.0)
    out_ = {f"person_{k}": {"median": round(float(np.median(v)), 3), "worst": round(float(np.min(v)), 3)} for k, v in per.items() if v}
    json.dump({"iou": out_, "per_frame": per}, open(os.path.join(out, "match.json"), "w"))
    return out_


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

    say(0.72, "Finding the floor and the camera")
    colors = colors or ppl.COLORS
    keep = [i for i in range(len(found)) if not np.isnan(joints[i]).all()]
    model = dm.load_model("vits")
    raw, _ = model.infer_video_depth(frames, fps, input_size=518, device="cuda", fp32=False)
    disp = dm.normalize(np.asarray(raw))
    # 1) the camera, in a world sized by the people's own (rough) sizes on the first frame
    z0 = [float(np.median(joints[i][0][:, 2])) for i in keep]
    a, b = to_blender.depth_scale(disp[0], labels[0], z0, ids=[i + 1 for i in keep])
    import camera_solve
    Rc, Cc, agree = camera_solve.solve(frames, labels > 0, disp, a, b, focal, lambda f, m: say(0.73 + 0.05 * f, m))
    print(f"camera: moved {np.linalg.norm(Cc[-1] - Cc[0]):.2f} m, points agreeing {np.median(agree[1:]):.0%}", flush=True)
    # 2) the floor, from every frame at once
    up, cam_h = to_blender.solve_floor_moving([joints[i] for i in keep], focal, Rc, Cc)
    # the camera's travel is only known up to scale: pick the scale that keeps the fighters on their patch of
    # floor (they shift and bob, the camera does the travelling), then solve the floor again with it
    def travel(lam):
        W = to_blender.plant([joints[i] for i in keep], focal, up, cam_h, Rc, Cc * lam)
        return sum(np.linalg.norm(np.diff((x[:, 11] + x[:, 12]) / 2, axis=0), axis=1).sum() for x in W)
    lams = np.exp(np.linspace(np.log(0.4), np.log(5.0), 25))
    lam = float(lams[np.argmin([travel(l) for l in lams])])
    Cc = Cc * lam
    up, cam_h = to_blender.solve_floor_moving([joints[i] for i in keep], focal, Rc, Cc)
    print(f"camera travel scale x{lam:.2f}, camera {cam_h:.2f} m up", flush=True)
    # 3) everyone planted on it, frame by frame
    floor_pt = -cam_h * up
    world = to_blender.plant([joints[i] for i in keep], focal, up, cam_h, Rc, Cc)

    say(0.78, "Building the bodies and the set")
    people, faces = [], None
    for i, jw in zip(keep, world):
        v, faces = mannequin.build(jw)
        people.append({"name": f"PERSON_{i + 1}", "color": colors[i % len(colors)], "verts": v, "joints": jw})
    to_blender.build(out, people, faces, focal, w, h, fps, disp[0], labels[0], floor=(up, floor_pt), cam_track=(Rc, Cc))

    say(0.80, "Building the Blender scene")
    # Blender runs with DepthMotion's OWN profile (MPFB lives there), never the person's own add-ons and settings
    env = {**os.environ, "BLENDER_USER_RESOURCES": BLENDER_PROFILE}
    r = subprocess.run([blender_exe(), "-b", "--python", os.path.join(HERE, "blender", "build_scene.py"), "--", out],
                       capture_output=True, text=True, creationflags=NOWIN, env=env)
    if "DEPTHMOTION_BLEND_OK" not in r.stdout:
        raise RuntimeError("Blender couldn't build the scene:\n" + (r.stdout + r.stderr)[-1500:])

    say(0.92, "Measuring the match")
    np.savez_compressed(os.path.join(out, "labels.npz"), labels=labels)
    subprocess.run([blender_exe(), "-b", os.path.join(out, "scene.blend"), "--python", os.path.join(HERE, "blender", "build_scene.py"),
                    "--", out, "--no-render", "--masks"], capture_output=True, text=True, creationflags=NOWIN, env=env)
    score = match_score(out, labels, [i + 1 for i in keep])
    print("MATCH", json.dumps(score), flush=True)

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
