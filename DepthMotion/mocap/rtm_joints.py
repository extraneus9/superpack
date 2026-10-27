"""Step 2 of DepthMotion mocap — runs in its own environment (mmpose + mmcv-lite), apart from the main engine.

frames/  (numbered JPEGs) + track.npz (each person's box per frame, from people.py)  →  joints.npz
joints.npz: joints [P, T, 133, 3] in the camera's space (x right, y down, z forward, METRES), scores [P, T, 133].

RTMW3D (OpenMMLab, Apache-2.0) gives, per person, 3D joints whose x/y are the image position (scaled) and whose z is
learned relative depth — not real-world size. So each person is:
  sized  from their own clearly-seen limbs against average human proportions (one size for the whole clip),
  placed at the distance where that size matches how big they look in the frame through the clip's lens.
Weights load in PyTorch's data-only mode; the only extra types allowed are NumPy's plain number formats.
"""
import argparse
import codecs
import glob
import os
import sys

import cv2
import numpy as np
import torch

ROOT = os.environ.get("RTM_ROOT", os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "DepthMotion", "mocap"))
sys.path.insert(0, os.path.join(ROOT, "mmpose", "projects", "rtmpose3d"))
import rtmpose3d  # noqa: E402,F401  (registers the RTMW3D head and codec)
from mmpose.apis import inference_topdown, init_model  # noqa: E402

CONFIG = os.path.join(ROOT, "mmpose", "projects", "rtmpose3d", "configs", "depthmotion-rtmw3d-x.py")
WEIGHTS = os.path.join(ROOT, "weights", "rtmw3d-x_8xb64_cocktail14-384x288-b0a0eab7_20240626.pth")
SAFE = [np.core.multiarray._reconstruct, np.ndarray, np.dtype, codecs.encode,
        *[getattr(np.dtypes, n) for n in dir(np.dtypes) if n.endswith("DType")]]

# average adult segment lengths (m): (joint a, joint b, length)
BONES = [(11, 13, 0.44), (12, 14, 0.44), (13, 15, 0.42), (14, 16, 0.42), (5, 7, 0.30), (6, 8, 0.30),
         (7, 9, 0.26), (8, 10, 0.26), (5, 6, 0.38), (11, 12, 0.26), (5, 11, 0.50), (6, 12, 0.50)]


def smooth(x, sigma):
    if sigma <= 0 or len(x) < 3:
        return x
    r = int(3 * sigma)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2); k /= k.sum()
    pad = np.concatenate([np.repeat(x[:1], r, 0), x, np.repeat(x[-1:], r, 0)])
    return np.tensordot(k, np.stack([pad[i:i + len(x)] for i in range(2 * r + 1)]), axes=(0, 0))


def main(folder):
    tr = np.load(os.path.join(folder, "track.npz"))
    boxes, focal, w, h = tr["boxes"], float(tr["focal"]), int(tr["width"]), int(tr["height"])
    P, T = boxes.shape[:2]
    frames = sorted(glob.glob(os.path.join(folder, "frames", "*.jpg")))
    with torch.serialization.safe_globals(SAFE):
        model = init_model(CONFIG, WEIGHTS, device="cuda:0")
    raw = np.full((P, T, 133, 3), np.nan, np.float32)
    px = np.full((P, T, 133, 2), np.nan, np.float32)
    sc = np.zeros((P, T, 133), np.float32)
    for t in range(T):
        live = [i for i in range(P) if not np.isnan(boxes[i, t, 0])]
        if not live:
            continue
        img = cv2.imread(frames[t])
        res = inference_topdown(model, img, boxes[live, t])
        for i, r in zip(live, res):
            p = r.pred_instances
            raw[i, t] = np.asarray(p.keypoints).reshape(133, 3)
            px[i, t] = np.asarray(p.transformed_keypoints).reshape(133, 2)
            sc[i, t] = np.asarray(p.keypoint_scores).reshape(133)
        if t % 10 == 0:
            print(f"PROGRESS {t / T:.3f}", flush=True)

    joints = np.full((P, T, 133, 3), np.nan, np.float32)
    for i in range(P):
        seen = ~np.isnan(raw[i, :, 0, 0])
        if not seen.any() or sc[i, seen, :17].mean() < 0.5:  # not confidently a person (a post, a rope, a blur)
            print(f"PERSON {i + 1}: skipped (pose confidence {sc[i, seen, :17].mean() if seen.any() else 0:.2f})", flush=True)
            continue
        # metres per model unit, from this person's clearly-seen limbs over the whole clip
        ratios = []
        for a, b, L in BONES:
            ok = seen & (sc[i, :, a] > 0.6) & (sc[i, :, b] > 0.6)
            seg = raw[i, ok, a] - raw[i, ok, b]
            side_on = np.abs(seg[:, 2]) < 0.35 * np.linalg.norm(seg[:, :2], axis=1)  # limbs pointing at the camera mislead
            if side_on.sum() >= 3:
                ratios.append(L / np.median(np.linalg.norm(seg[side_on], axis=1)))
        s = float(np.median(ratios)) if ratios else 1 / 220 * 1.75 / 1.0  # (fallback never expected)
        for t in np.nonzero(seen)[0]:
            k, u, q = raw[i, t], px[i, t], sc[i, t]
            good = q[:23] > 0.4
            if good.sum() < 4:
                good = q[:23] > 0
            a = np.polyfit(k[:23][good, 0], u[:23][good, 0], 1)[0]  # pixels per model unit, this frame
            root_k = (k[11] + k[12]) / 2
            root_u = (u[11] + u[12]) / 2
            Z = focal * s / a  # the distance at which a person this size looks this big
            centre = np.array([(root_u[0] - w / 2) * Z / focal, (root_u[1] - h / 2) * Z / focal, Z])
            joints[i, t] = (k - root_k) * s + centre
        # fill hidden frames from the nearest seen one, then smooth (depth jitters most)
        idx = np.nonzero(seen)[0]
        for t in range(T):
            if not seen[t]:
                joints[i, t] = joints[i, idx[np.argmin(np.abs(idx - t))]]
        root = (joints[i, :, 11] + joints[i, :, 12]) / 2
        rel = joints[i] - root[:, None]
        # joints the model couldn't see (out of frame, hidden) are guesses: hold the last confident pose instead
        conf = sc[i] > 0.35
        for t in range(T):
            if t and seen[t]:
                rel[t, ~conf[t]] = rel[t - 1, ~conf[t]]
        first = np.argmax(conf, axis=0)  # a joint never seen early keeps its first confident position backwards
        for jt in range(133):
            if conf[:, jt].any():
                rel[: first[jt], jt] = rel[first[jt], jt]
        root[:, 2] = smooth(root[:, 2], 3.0)
        root = smooth(root, 1.0)
        joints[i] = smooth(rel, 1.0) + root[:, None]
        print(f"PERSON {i + 1}: scale {s:.4f} m/unit, distance {np.median(root[:, 2]):.2f} m", flush=True)
    np.savez_compressed(os.path.join(folder, "joints.npz"), joints=joints, scores=sc)
    print("JOINTS_OK", flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    main(ap.parse_args().folder)
