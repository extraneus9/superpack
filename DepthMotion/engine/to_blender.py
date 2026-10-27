"""Captured people (camera-space meshes per frame) → a folder Blender can build a scene from.

Input is what engine/mocap.py produces: for each person, vertices per frame in the camera's own space
(OpenCV: x right, y down, z forward, metres), the mesh's faces, the focal length in pixels.
Output folder:
  scene.json            camera, lens, fps, people, set — read by blender/build_scene.py
  person_N.obj / .pc2   the mannequin at frame 1 + every frame of its motion (Blender's Mesh Cache format)
  set.obj               the real set as a simple relief, from the clip's depth (optional)
World convention: Z up, metres, the floor (found from where the feet land) at z = 0, camera looking along +Y.
"""
import json
import os
import struct

import numpy as np


def fit_floor(people_verts, feet=None):
    """Plane under the feet. → (normal pointing up, point).
    feet: per person [T, k, 3] foot joints — only the PLANTED ones count (a foot mid-step or mid-kick is in the air).
    Without joints, the lowest mesh vertices of every frame are used."""
    pts = []
    if feet:
        for f in feet:
            speed = np.linalg.norm(np.diff(f, axis=0, prepend=f[:1]), axis=2)
            pts.append(f[speed < np.percentile(speed, 40)])
    else:
        for v in people_verts:  # [T, V, 3]
            for f in v[:: max(1, len(v) // 40)]:
                pts.append(f[f[:, 1] >= np.percentile(f[:, 1], 99.5)])  # cv y points down: the largest y = the soles
    pts = np.concatenate(pts)
    c = pts.mean(0)
    # Cameras rarely roll, and a couple of people's feet are only two clusters (any plane fits two blobs). So the
    # floor is solved as a line in the camera's up/forward plane: y = slope * z + c  (height + tilt, no roll).
    if np.ptp(pts[:, 2]) > 0.4:
        slope = np.polyfit(pts[:, 2], pts[:, 1], 1)[0]
    else:  # everyone at about the same distance: the tilt can't be read from the feet — assume a level camera
        slope = 0.0
    n = np.array([0.0, -1.0, slope])
    return n / np.linalg.norm(n), c


def place_on_floor(people_joints, focal, width, height, feet_ids=(15, 16, 17, 18, 19, 20, 21, 22), stance=1.5):
    """Everyone stands on ONE floor. people_joints: list of [T, J, 3] camera-space joints whose distances came from
    body size (wrong for very big or small people). Finds the camera height + tilt (no roll) that best agrees with
    those distances, then slides each person along the camera's line of sight — which keeps exactly how they look
    in the frame — until their lowest foot touches that floor. → (joints, up, floor point)."""
    cx, cy = width / 2, height / 2
    feet_px, z_size = [], []
    for j in people_joints:
        f = j[:, list(feet_ids)]
        low = np.argmax(f[:, :, 1] / f[:, :, 2], axis=1)            # the foot lowest on screen each frame
        p = f[np.arange(len(f)), low]
        feet_px.append(np.stack([p[:, 0] / p[:, 2] * focal, p[:, 1] / p[:, 2] * focal], 1))  # pixels from centre
        z_size.append(p[:, 2])
    def floor_z(h, phi, px):
        up = np.array([0.0, -np.cos(phi), -np.sin(phi)])           # world up, seen from a camera tilted down by phi
        d = np.stack([px[:, 0] / focal, px[:, 1] / focal, np.ones(len(px))], 1)
        den = d @ up
        return np.where(den < -1e-3, -h / np.minimum(den, -1e-3), np.inf)
    # Single-view metrology: with feet pinned to the floor, each (camera height, tilt) gives every person a size.
    # Pick the camera that makes everyone a believable size (`stance` = nose to ankles, a fighting crouch ≈ 1.5 m),
    # with a gentle pull toward a level camera.
    tall = [np.linalg.norm((j[:, 15] + j[:, 16]) / 2 - j[:, 0], axis=1) for j in people_joints]
    best = (np.inf, 1.5, 0.0)
    for phi in np.radians(np.arange(-30, 50.1, 0.5)):
        for h in np.arange(0.2, 8.0, 0.05):
            err = 0.3 * phi ** 2
            for px, zs, ht in zip(feet_px, z_size, tall):
                k = floor_z(h, phi, px) / zs
                if not np.isfinite(k).mean() > 0.8:
                    err = np.inf; break
                err += np.log(np.median(ht[np.isfinite(k)] * k[np.isfinite(k)]) / stance) ** 2
            if err < best[0]:
                best = (err, h, phi)
    _, h, phi = best
    out = []
    for j, px, zs in zip(people_joints, feet_px, z_size):
        k = floor_z(h, phi, px) / zs                                   # how much farther (or nearer) they really are
        k = np.where(np.isfinite(k) & (k > 0), k, np.nan)
        k = np.where(np.isnan(k), np.nanmedian(k), k)
        r = 3  # a jump or a lifted foot would make them bob: follow the floor smoothly
        k = np.convolve(np.pad(k, r, mode="edge"), np.ones(2 * r + 1) / (2 * r + 1), "valid")
        out.append(j * k[:, None, None])                               # scaling about the camera keeps the 2D picture
    up = np.array([0.0, -np.cos(phi), -np.sin(phi)])
    return out, up, -h * up


def solve_floor_moving(people_joints, focal, R, C, feet_ids=(15, 16, 17, 18, 19, 20, 21, 22), stance=1.5):
    """Moving camera: the ONE floor (height under the first frame's camera + tilt, no roll) that, across ALL frames,
    puts everyone's feet down AND makes them a believable size. → (up, camera height)."""
    rays, z_size, tall = [], [], []
    for j in people_joints:
        f = j[:, list(feet_ids)]
        low = np.argmax(f[:, :, 1] / f[:, :, 2], axis=1)
        p = f[np.arange(len(f)), low]
        rays.append(np.einsum("tij,tj->ti", R, p / p[:, 2:3]))
        z_size.append(p[:, 2])
        tall.append(np.linalg.norm((j[:, 15] + j[:, 16]) / 2 - j[:, 0], axis=1))
    best = (np.inf, 1.5, 0.0)
    for phi in np.radians(np.arange(-30, 50.1, 0.5)):
        up = np.array([0.0, -np.cos(phi), -np.sin(phi)])
        for hc in np.arange(0.2, 8.0, 0.05):
            err = 0.3 * phi ** 2
            for dw, zs, ht in zip(rays, z_size, tall):
                den = dw @ up
                k = np.where(den < -1e-4, (-hc - C @ up) / np.minimum(den, -1e-4), np.nan) / zs
                ok = np.isfinite(k) & (k > 0)
                if ok.mean() < 0.8:
                    err = np.inf; break
                err += np.log(np.median(ht[ok] * k[ok]) / stance) ** 2
            if err < best[0]:
                best = (err, hc, phi)
    _, hc, phi = best
    return np.array([0.0, -np.cos(phi), -np.sin(phi)]), float(hc)


def plant(people_joints, focal, up, cam_h, R, C, feet_ids=(15, 16, 17, 18, 19, 20, 21, 22)):
    """Moving camera: every frame, slide each person along that frame's line of sight until their lowest foot
    touches the ONE floor (found on the first frames). people_joints: [T, J, 3] in each frame's camera space.
    R, C: camera → world per frame (world = first frame's camera space). → joints in world, per person."""
    out = []
    for j in people_joints:
        f = j[:, list(feet_ids)]
        low = np.argmax(f[:, :, 1] / f[:, :, 2], axis=1)
        p = f[np.arange(len(f)), low]                                   # lowest foot on screen, camera space
        d = p / p[:, 2:3]                                               # its viewing ray (z = 1)
        dw = np.einsum("tij,tj->ti", R, d)                              # the ray in world
        tt = (-cam_h - C @ up) / np.where(np.abs(dw @ up) > 1e-4, dw @ up, -1e-4)
        k = tt / p[:, 2]
        k = np.where(np.isfinite(k) & (k > 0) & (k < 10), k, np.nan)
        k = np.where(np.isnan(k), np.nanmedian(k), k)
        r = 3
        k = np.convolve(np.pad(k, r, mode="edge"), np.ones(2 * r + 1) / (2 * r + 1), "valid")
        cam_pts = j * k[:, None, None]
        out.append(np.einsum("tij,tkj->tki", R, cam_pts) + C[:, None, :])
    return out


def depth_scale(disp, labels, people_z, ids=None):
    """1/z = a·disp + b from the people on one frame (their distances are known) → (a, b). ids: their label values."""
    ids = ids or [i + 1 for i in range(len(people_z))]
    pd = np.array([np.median(disp[labels == k]) for k in ids])
    pz = np.asarray(people_z, float)
    if len(pd) >= 2 and np.ptp(pd) > 0.02:
        a, b = np.linalg.lstsq(np.stack([pd, np.ones_like(pd)], 1), 1 / pz, rcond=None)[0]
    else:
        b = 1 / 25.0
        a = (1 / pz[0] - b) / max(pd[0], 1e-3)
    return float(a), float(b)


def world_basis(up, floor_pt):
    """Rotation + origin that turn camera-space points into a Z-up world with the floor at z = 0 under the camera."""
    fwd = np.array([0.0, 0.0, 1.0])
    y = fwd - fwd.dot(up) * up
    y /= np.linalg.norm(y)
    x = np.cross(y, up)
    R = np.stack([x, y, up])                      # rows: world axes expressed in camera space
    origin = -(0 - floor_pt).dot(up) * up         # camera centre dropped onto the floor plane
    return R, origin


def to_world(p, R, origin):
    return (p - origin) @ R.T


def write_obj(path, verts, faces):
    with open(path, "w", encoding="utf-8") as f:
        f.write("# DepthMotion\n")
        f.write("".join(f"v {a:.5f} {b:.5f} {c:.5f}\n" for a, b, c in verts))
        f.write("".join(f"f {a + 1} {b + 1} {c + 1}\n" for a, b, c in faces))


def write_pc2(path, frames):
    """Blender Mesh Cache .pc2: header + float32 xyz for every vertex of every frame."""
    t, v, _ = frames.shape
    with open(path, "wb") as f:
        f.write(b"POINTCACHE2\0" + struct.pack("<iiffi", 1, v, 0.0, 1.0, t))
        f.write(np.ascontiguousarray(frames, "<f4").tobytes())


def relief(disp, mask, people_z, people_disp, focal, R, origin, step=4, far=None):
    """The set as clay: the clip's relative depth turned metric by matching the people (whose distance we know)."""
    import cv2
    h, w = disp.shape
    # the set behind the people: paint over where they stood (no person-shaped holes), then calm the noise
    grow = cv2.dilate(mask.astype(np.uint8), np.ones((25, 25), np.uint8))
    disp = cv2.inpaint((disp * 65535).astype(np.uint16), grow, 12, cv2.INPAINT_TELEA).astype(np.float32) / 65535
    disp = cv2.bilateralFilter(disp, 9, 0.04, 9)
    mask = np.zeros_like(mask)
    A = np.stack([people_disp, np.ones_like(people_disp)], 1)
    if len(people_disp) >= 2 and np.ptp(people_disp) > 0.02:
        a, b = np.linalg.lstsq(A, 1 / np.asarray(people_z), rcond=None)[0]
    else:  # one person: assume the far end of the depth range is ~25 m away
        b = 1 / 25.0
        a = (1 / people_z[0] - b) / max(people_disp[0], 1e-3)
    ys, xs = np.mgrid[0:h:step, 0:w:step]
    d = disp[ys, xs]
    z = 1 / np.clip(a * d + b, 1 / 60, 1 / 0.3)
    pts = np.stack([(xs - w / 2) * z / focal, (ys - h / 2) * z / focal, z], -1)
    gh, gw = z.shape
    idx = np.arange(gh * gw).reshape(gh, gw)
    hole = mask[ys, xs]
    a_, b_, c_, d_ = idx[:-1, :-1], idx[:-1, 1:], idx[1:, :-1], idx[1:, 1:]
    zz = np.stack([z[:-1, :-1], z[:-1, 1:], z[1:, :-1], z[1:, 1:]])
    ok = zz.max(0) / zz.min(0) < 1.25  # no rubber sheets across depth cliffs
    ok &= zz.max(0) < far  # the far stands and sky become open space, like a set's backdrop
    ok &= ~(hole[:-1, :-1] | hole[:-1, 1:] | hole[1:, :-1] | hole[1:, 1:])  # the people are their own meshes
    faces = np.concatenate([np.stack([a_, c_, b_], -1)[ok], np.stack([b_, c_, d_], -1)[ok]])
    used = np.unique(faces)
    remap = -np.ones(gh * gw, int); remap[used] = np.arange(len(used))
    return to_world(pts.reshape(-1, 3)[used], R, origin), remap[faces]


def build(out, people, faces, focal, width, height, fps, disp=None, labels=None, feet=None, floor=None, cam_track=None):
    """people: [{"name", "color", "verts": [T, V, 3] camera space}] → scene folder. Returns the scene.json path."""
    os.makedirs(out, exist_ok=True)
    verts = [p["verts"] for p in people]
    up, floor_pt = floor if floor is not None else fit_floor(verts, feet)
    R, origin = world_basis(up, floor_pt)
    cam = np.eye(4)
    cam[:3, 0] = R @ np.array([1.0, 0, 0])      # camera right
    cam[:3, 1] = R @ np.array([0, -1.0, 0])     # camera up
    cam[:3, 2] = R @ np.array([0, 0, -1.0])     # camera looks down its −Z
    cam[:3, 3] = to_world(np.zeros(3), R, origin)
    if cam_track is not None:  # a moving camera: one matrix per frame, same axes rule as above
        Rt, Ct = cam_track
        track = []
        for Rk, Ck in zip(Rt, Ct):
            m = np.eye(4)
            m[:3, 0] = R @ (Rk @ np.array([1.0, 0, 0])); m[:3, 1] = R @ (Rk @ np.array([0, -1.0, 0]))
            m[:3, 2] = R @ (Rk @ np.array([0, 0, -1.0])); m[:3, 3] = to_world(Ck, R, origin)
            track.append(m.tolist())
        cam = np.array(track[0])
    S = {"fps": float(fps), "frames": int(len(verts[0])), "width": int(width), "height": int(height),
         "lens_mm": float(focal * 36.0 / width), "camera_matrix": cam.tolist(), "people": [],
         "camera_height_m": float(cam[2, 3])}
    if cam_track is not None:
        S["camera_track"] = track
    for i, p in enumerate(people):
        wv = to_world(p["verts"].reshape(-1, 3), R, origin).reshape(p["verts"].shape).astype(np.float32)
        write_obj(os.path.join(out, f"person_{i + 1}.obj"), wv[0], faces)
        write_pc2(os.path.join(out, f"person_{i + 1}.pc2"), wv)
        entry = {"name": p.get("name") or f"PERSON_{i + 1}", "color": p["color"],
                 "obj": f"person_{i + 1}.obj", "pc2": f"person_{i + 1}.pc2"}
        if p.get("joints") is not None:  # → a real human body in Blender (falls back to the block mannequin)
            wj = to_world(p["joints"].reshape(-1, 3), R, origin).reshape(p["joints"].shape).astype(np.float32)
            np.save(os.path.join(out, f"person_{i + 1}_joints.npy"), wj)
            entry["joints"] = f"person_{i + 1}_joints.npy"
            entry["leg_m"] = float(np.median(np.linalg.norm(wj[:, 11] - wj[:, 13], axis=1) + np.linalg.norm(wj[:, 13] - wj[:, 15], axis=1)))
        S["people"].append(entry)
    if disp is not None and labels is not None:
        pz, pd = [], []
        for i, p in enumerate(people):
            m = labels == i + 1
            if m.sum() > 50:
                pz.append(float(np.median(p["verts"][0][:, 2])))
                pd.append(float(np.median(disp[m])))
        if pz:
            sv, sf = relief(disp, labels > 0, np.array(pz), np.array(pd), focal * disp.shape[1] / width, R, origin,
                            far=3.5 * max(pz))
            write_obj(os.path.join(out, "set.obj"), sv, sf)
            S["set_obj"] = "set.obj"
    path = os.path.join(out, "scene.json")
    json.dump(S, open(path, "w", encoding="utf-8"), indent=2)
    return path
