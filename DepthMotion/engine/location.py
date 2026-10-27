"""New location: the real people from a clip, in a set built in Blender, through the clip's own camera move.

Light enough for anyone (no pose model): everything about the people comes from their masks + the clip's depth.
1  people.py           find + follow everyone (SAM 2.1)
2  depth               the clip's depth (Video Depth Anything), made metric from the people's size where they're
                       fully in frame
3  camera_solve.py     how the real camera moved, from the background
4  floor + places      the floor from where feet touch it, each person's place and distance on every frame
5  blender/build_env   the chosen location style laid out around them, rendered through the solved camera
6  relocate.py         merged per pixel (nearer wins) → Depth + people, clay, check

CLI:  python location.py clip.mp4 --start 8.4 --end 10.4 --style ruins --seed 7 --sun 18
"""
import argparse
import glob
import json
import os
import subprocess

import cv2
import numpy as np

import camera_solve
import depthmotion as dm
import people as ppl
import relocate
import to_blender

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
STYLES = ("ruins", "studio", "street")
STANCE_H = 1.65  # a standing / fighting-stance person, head to feet (m) — only used to size the world


def blender_exe():
    found = sorted(glob.glob(os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "Blender Foundation", "Blender *", "blender.exe")))
    if not found:
        raise RuntimeError("New location needs Blender (free, blender.org). Install it, then try again.")
    return found[-1]


def anchor(labels, k, h):
    """The frame where person k is most fully seen (not touching the top or bottom edge), and their height there."""
    best = (0, -1)
    for t in range(len(labels)):
        ys = np.nonzero((labels[t] == k).any(1))[0]
        if len(ys) and ys.min() > 3 and ys.max() < h - 4:
            best = max(best, (ys.max() - ys.min(), t))
    return best[1], best[0]


def run(*a, **k):
    """One heavy job at a time on this PC, below normal priority, sized to the memory that's free."""
    import guard
    with guard.one_job(dm.HOME, k.get("say")):
        guard.be_polite()
        return _run(*a, **k)


def _run(video, start=0.0, end=None, style="ruins", seed=7, sun=18.0, quality="fast", colors=None, out=None, say=None,
         people=None):
    """people: the person's own pick — [{"box": [x1, y1, x2, y2] fractions, "color": "#hex" or None}] (None = stays grey).
    Without it everyone found is cut out and kept grey."""
    say = say or (lambda f, m: print(f"[{f:4.0%}] {m}", flush=True))
    import guard
    info = dm.probe(video)
    span = ((end or info["dur"]) - (start or 0)) or info["dur"]
    res = guard.plan(int(span * info["fps"]) + 1, info["w"], info["h"], people=True, location=True)
    frames, fps = dm.read_frames(video, start, end, max_res=res)
    guard.check("reading the clip")
    t_, h, w = frames.shape[:3]
    name = os.path.splitext(os.path.basename(video))[0]
    tag = f"_{start:g}-{end:g}s" if (start or end) else ""
    out = out or os.path.join(dm.DEFAULT_OUT, f"{name}{tag}_{style}")
    os.makedirs(os.path.join(out, "frames"), exist_ok=True)
    for t in range(t_):
        cv2.imwrite(os.path.join(out, "frames", f"{t:05d}.jpg"), cv2.cvtColor(frames[t], cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])

    say(0.02, "Finding the people")
    found = [p["box"] for p in people] if people else ppl.find(frames[0], min_score=0.85, min_aspect=0.8)  # not posts or ropes
    picked = [p.get("color") for p in people] if people else (colors or [None] * len(found))
    if not found:
        raise RuntimeError("Nobody found on the first frame — move the in point to a frame where everyone is visible.")
    labels = ppl.track(frames, found, lambda f, m: say(0.04 + 0.14 * f, m))
    ids = [i + 1 for i in range(len(found))]

    say(0.19, "Reading the depth")
    model = dm.load_model("vitl" if quality == "best" else "vits", lambda f, m: say(0.19, m))
    raw, _ = model.infer_video_depth(frames, fps, input_size=518, device="cuda", fp32=False)
    disp = dm.normalize(np.asarray(raw)).astype(np.float16)  # half-size in RAM
    del raw
    np.savez_compressed(os.path.join(out, "disp.npz"), disp=disp.astype(np.float16))
    np.savez_compressed(os.path.join(out, "labels.npz"), labels=labels)
    focal = w / (2 * np.tan(np.radians(55) / 2))

    # metres: each person's distance where they're fully in frame, from their size → 1/z = a·disp + b
    pz, pd = [], []
    for k in ids:
        t, hp = anchor(labels, k, h)
        if t >= 0 and hp > 40:
            pz.append(focal * STANCE_H / hp); pd.append(float(np.median(disp[t][labels[t] == k])))
    if not pz:  # nobody is ever fully in frame: assume the biggest person is ~3 m away
        k = max(ids, key=lambda k: (labels[0] == k).sum())
        pz, pd = [3.0], [float(np.median(disp[0][labels[0] == k]))]
    a = b = None
    if len(pz) >= 2 and np.ptp(pd) > 0.05:
        a, b = np.linalg.lstsq(np.stack([pd, np.ones(len(pd))], 1), 1 / np.array(pz), rcond=None)[0]
    if a is None or a <= 0 or b < 1 / 200.0:  # an unphysical fit (far things nearer than near ones): one-anchor rule
        i = int(np.argmax(pd))
        b = 1 / 30.0; a = max((1 / pz[i] - b) / max(pd[i], 1e-3), 1e-3)
    zmap = lambda t: camera_solve.metric_depth(disp[t], a, b)

    say(0.40, "Tracking the camera")
    R, C, agree = camera_solve.solve(frames, labels > 0, disp, a, b, focal, lambda f, m: say(0.40 + 0.2 * f, m))

    # the camera's travel is known only up to scale: pick the scale that keeps the people on their patch of ground
    # (they shift and bob; the camera does the travelling)
    ray_pts = {k: [] for k in ids}
    for t in range(t_):
        z = zmap(t)
        for k in ids:
            m = labels[t] == k
            if m.sum() >= 80:
                ys, xs = np.nonzero(m); zk = float(np.median(z[m]))
                ray_pts[k].append((t, R[t] @ np.array([(xs.mean() - w / 2) * zk / focal, (ys.mean() - h / 2) * zk / focal, zk])))
    def travel(lam):
        tot = 0.0
        for k in ids:
            pts = np.array([p + lam * C[t] for t, p in ray_pts[k]])
            if len(pts) > 1:
                tot += np.linalg.norm(np.diff(pts, axis=0), axis=1).sum()
        return tot
    lams = np.exp(np.linspace(np.log(0.3), np.log(6.0), 40))
    lam = float(lams[np.argmin([travel(l) for l in lams])])
    C = C * lam

    say(0.61, "Finding the floor")
    feet, places, dists = [], {k: [] for k in ids}, {k: [] for k in ids}
    for t in range(t_):
        z = zmap(t)
        for k in ids:
            m = labels[t] == k
            if m.sum() < 80:
                places[k].append(None); dists[k].append(None); continue
            ys, xs = np.nonzero(m)
            zk = float(np.median(z[m]))
            dists[k].append(zk)
            cam = lambda u, v, zz: np.array([(u - w / 2) * zz / focal, (v - h / 2) * zz / focal, zz])
            places[k].append(R[t] @ cam(xs.mean(), ys.mean(), zk) + C[t])
            if ys.max() < h - 4:  # their feet are in frame: the lowest point touches the floor, at the body's distance
                v = ys.max(); u = float(np.median(xs[ys >= v - 3]))
                feet.append(R[t] @ cam(u, v, zk) + C[t])
    feet = np.array(feet) if feet else np.array([R[0] @ np.array([0, h * 0.4 * 3 / focal, 3.0]) + C[0]])
    # the floor: a plane under the feet with height + tilt, no roll (cameras rarely roll; two people = two blobs)
    slope = np.polyfit(feet[:, 2], feet[:, 1], 1)[0] if len(feet) > 20 and np.ptp(feet[:, 2]) > 0.4 else 0.0
    up = np.array([0.0, -1.0, slope]); up /= np.linalg.norm(up)
    floor_pt = np.median(feet, 0)
    if -(floor_pt @ up) < 0.2:  # the camera under the floor can't be right: a level floor 1.5 m below the lens
        up = np.array([0.0, -1.0, 0.0]); floor_pt = np.array([0.0, 1.5, 0.0])
    Rb, origin = to_blender.world_basis(up, floor_pt)

    # → scene.json for Blender: camera per frame, everyone's place on the floor, their distance per frame
    track = []
    for Rk, Ck in zip(R, C):
        mtx = np.eye(4)
        mtx[:3, 0] = Rb @ (Rk @ [1.0, 0, 0]); mtx[:3, 1] = Rb @ (Rk @ [0, -1.0, 0]); mtx[:3, 2] = Rb @ (Rk @ [0, 0, -1.0])
        mtx[:3, 3] = to_blender.to_world(Ck, Rb, origin)
        track.append(mtx.tolist())
    cast = []
    for n, k in enumerate(ids):
        pl = [p for p in places[k] if p is not None]
        if not pl:
            continue
        xy = to_blender.to_world(np.median(np.array(pl), 0), Rb, origin)[:2]
        d = dists[k]; known = [x for x in d if x is not None]
        d = [x if x is not None else float(np.median(known)) for x in d]
        cast.append({"name": f"PERSON_{k}", "id": k, "color": picked[n] if n < len(picked) else None,
                     "xy": [float(xy[0]), float(xy[1])], "dist": d})
    S = {"fps": float(fps), "frames": t_, "width": w, "height": h, "lens_mm": float(focal * 36 / w),
         "camera_matrix": track[0], "camera_track": track, "people": cast,
         "style": style, "seed": int(seed), "sun_deg": float(sun), "camera_height_m": float(track[0][2][3]),
         "camera_points_agree": float(np.median(agree[1:])) if t_ > 1 else 1.0, "camera_travel_scale": lam}
    json.dump(S, open(os.path.join(out, "scene.json"), "w", encoding="utf-8"), indent=1)

    render(out, say)
    say(0.92, "Merging the people into the location")
    paths = relocate.run(out, quality, lambda f, m: say(0.92 + 0.08 * f, m))
    paths["blend"] = os.path.join(out, "env.blend")
    return paths, out


def render(out, say=None, blend=None):
    """Build (or, with blend=, re-render the person's own edited) location through the solved camera."""
    say = say or (lambda f, m: None)
    say(0.63, "Building the location in Blender")
    for d in ("env_clay", "env_depth"):
        for f in glob.glob(os.path.join(out, d, "*")):
            os.remove(f)
    args = [blender_exe(), "-b", "--factory-startup"] + ([blend] if blend else []) + \
           ["--python", os.path.join(HERE, "blender", "build_env.py"), "--", out] + (["--reuse"] if blend else [])
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, creationflags=NOWIN)
    log = []
    for line in p.stdout:
        log.append(line)
        if line.startswith("FRAME"):
            say(0.66 + 0.25 * float(line.split()[1]), "Rendering the location")
    if p.wait() != 0 or not any("DEPTHMOTION_ENV_OK" in l for l in log):
        raise RuntimeError("Blender couldn't build the location:\n" + "".join(log[-12:]))


def remerge(out, quality="fast", say=None):
    """After editing env.blend by hand: re-render it through the same camera and merge again."""
    render(out, say, blend=os.path.join(out, "env.blend"))
    return relocate.run(out, quality, say)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="DepthMotion — real people, new location")
    ap.add_argument("video")
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--end", type=float, default=None)
    ap.add_argument("--style", default="ruins", choices=STYLES)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--sun", type=float, default=18.0, help="sun height in degrees (5 = dusk, 60 = midday)")
    ap.add_argument("--best", action="store_true")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    print(run(a.video, a.start, a.end, a.style, a.seed, a.sun, "best" if a.best else "fast", out=a.out))
