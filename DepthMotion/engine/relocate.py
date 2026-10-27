"""Put the real fighters into a new location, in depth.

The fighters' shape and motion come from the FOOTAGE's own depth (exact, every frame). The location is a Blender
set (blender/ruins.py) rendered through the camera move solved from that footage (env_clay + env_depth). Per pixel
the nearer surface wins, so set pieces in front hide the fighters and the fighters hide what's behind them.

Outputs in the scene folder:
  relocated_tinted.mp4   grey depth of the new location, each fighter tinted their colour (the generation reference)
  relocated_clay.mp4     the location as lit clay with the fighters as tinted clay
  relocated_check.mp4    footage | tinted | clay, side by side
"""
import glob
import json
import os
import subprocess
import sys

import cv2
import numpy as np
import OpenEXR

import depthmotion as dm
import people as ppl


def env_depth(path):
    f = OpenEXR.File(path)
    for part in f.parts:
        for name, ch in part.channels.items():
            if name.endswith("Depth.Z"):
                return np.asarray(ch.pixels, np.float32)
    raise ValueError("no depth in " + path)


def run(folder, quality="fast", say=None):
    say = say or (lambda f, m: print(f"[{f:4.0%}] {m}", flush=True))
    S = json.load(open(os.path.join(folder, "scene.json"), encoding="utf-8"))
    frames = np.stack([cv2.cvtColor(cv2.imread(p), cv2.COLOR_BGR2RGB) for p in sorted(glob.glob(os.path.join(folder, "frames", "*.jpg")))])
    labels = np.load(os.path.join(folder, "labels.npz"))["labels"]
    t_, h, w = frames.shape[:3]
    cache = os.path.join(folder, "disp.npz")
    if os.path.exists(cache):                                  # the depth the location step already read
        disp = np.load(cache)["disp"].astype(np.float32)
    else:
        say(0.05, "Reading the fighters' depth from the footage")
        raw, _ = dm.load_model("vitl" if quality == "best" else "vits").infer_video_depth(frames, S["fps"], input_size=518, device="cuda", fp32=False)
        disp = dm.normalize(np.asarray(raw))                  # near = 1, one range for the whole clip

    # each fighter's distance from the camera on every frame
    ids, dist, tints = [], [], []
    for n, p in enumerate(S["people"]):
        k = int(p.get("id") or p["name"].split("_")[-1])
        if p.get("dist"):                                      # measured straight from the depth (location.py)
            d = p["dist"]
        else:                                                  # from a full mocap scene (mocap.py)
            jw = np.load(os.path.join(folder, p["joints"]))
            root = (jw[:, 11] + jw[:, 12]) / 2
            d = []
            for t in range(t_):
                M = np.array(S["camera_track"][t]); q = (root[t] - M[:3, 3]) @ M[:3, :3]
                d.append(-q[2])                                # Blender camera looks down −Z
        ids.append(k); dist.append(np.array(d, float)); tints.append(ppl.rgb(p["color"]) if p.get("color") else None)

    say(0.3, "Merging them into the new location")
    import guard
    Z = np.zeros((t_, h, w), np.float16); who = np.zeros((t_, h, w), np.uint8)  # half-size floats: depth to ~1 cm
    for t in range(t_):
        z = env_depth(os.path.join(folder, "env_depth", f"d_{t + 1:04d}.exr"))
        z = np.where(np.isfinite(z) & (z > 0), z, 1e4)
        for n, k in enumerate(ids):
            m = labels[t] == k
            if m.sum() < 50:
                continue
            dm_ = np.median(disp[t][m])
            zp = dist[n][t] * dm_ / np.clip(disp[t], 1e-3, None)  # the body's own relief, at its real distance
            front = m & (zp < z + 0.5)  # the floor under their feet never cuts them; real set pieces in front still do
            z[front] = zp[front]; who[t][front] = n + 1
        Z[t] = z
        if t % 10 == 0:
            guard.check("merging")

    say(0.6, "Writing the passes")
    lo, hi = np.percentile(1 / Z[:, ::4, ::4].astype(np.float32), [2, 99.5])  # one range for the clip, from a sample
    # near = white; the gentle curve lifts the set's mid and far planes so it still reads next to the much nearer people
    near_of = lambda t: np.clip((1 / Z[t].astype(np.float32) - lo) / (hi - lo), 0, 1) ** 0.6
    name = "relocated"
    paths = {k: os.path.join(folder, f"{name}_{k}.mp4") for k in ("tinted", "clay", "check")}
    codec = dm.video_codec(3)
    wt = dm.Writer(paths["tinted"], w, h, S["fps"], codec); wc = dm.Writer(paths["clay"], w, h, S["fps"], codec)
    wk = dm.Writer(paths["check"], w * 3 // 2, h // 2, S["fps"], codec)
    for t in range(t_):
        g = near_of(t)
        tinted = np.dstack([g * 255] * 3)
        clay_bg = cv2.cvtColor(cv2.imread(os.path.join(folder, "env_clay", f"c_{t + 1:04d}.png")), cv2.COLOR_BGR2RGB).astype(np.float32)
        body = dm.clay(disp[t])
        for n, tint in enumerate(tints):
            sel = who[t] == n + 1
            if tint is None:  # not coloured: plain depth, plain grey clay
                clay_bg[sel] = body[sel, None] * np.array([232, 228, 222], np.float32)
                continue
            tinted[sel] = g[sel, None] * 255 * (0.45 + 0.55 * tint)
            clay_bg[sel] = body[sel, None] * (60 + 195 * tint)
        tinted = np.clip(tinted, 0, 255).astype(np.uint8); clay = np.clip(clay_bg, 0, 255).astype(np.uint8)
        wt.write(tinted); wc.write(clay)
        small = lambda a: cv2.resize(a, (w // 2, h // 2))
        wk.write(np.hstack([small(frames[t]), small(tinted), small(clay)]))
    for x in (wt, wc, wk):
        x.close()
    say(1.0, "Done")
    return paths


if __name__ == "__main__":
    print(run(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "fast"))
