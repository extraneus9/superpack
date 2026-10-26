"""3D joints → a block mannequin (capsules for limbs, a chest block, a head), one mesh with fixed topology,
so every frame is just new vertex positions (Blender Mesh Cache). People = blocks: it reads like a clay previz.

Joints follow COCO-WholeBody (133): 0 nose · 3/4 ears · 5/6 shoulders · 7/8 elbows · 9/10 wrists · 11/12 hips ·
13/14 knees · 15/16 ankles · 17/20 big toes · 18/21 small toes · 91.. left hand · 112.. right hand (+9 = middle knuckle).
Coordinates: whatever space the joints are in (to_blender wants the camera's: x right, y down, z forward, metres).
"""
import numpy as np

# (from joint(s), to joint(s), radius at start, radius at end) — a list of joints means "their midpoint"
LIMBS = [
    ((5,), (7,), 0.060, 0.050), ((6,), (8,), 0.060, 0.050),          # upper arms
    ((7,), (9,), 0.048, 0.040), ((8,), (10,), 0.048, 0.040),         # forearms
    ((91,), (100,), 0.050, 0.055), ((112,), (121,), 0.050, 0.055),   # fists (reads as gloves too)
    ((11,), (13,), 0.085, 0.065), ((12,), (14,), 0.085, 0.065),      # thighs
    ((13,), (15,), 0.060, 0.045), ((14,), (16,), 0.060, 0.045),      # shins
    ((15,), (17, 18), 0.045, 0.040), ((16,), (20, 21), 0.045, 0.040),  # feet
    ((11,), (12,), 0.095, 0.095),                                    # pelvis
    ((5,), (6,), 0.070, 0.070),                                      # shoulder line
    ((11, 12), (5, 6), 0.130, 0.150),                                # torso
    ((5, 6), (3, 4), 0.050, 0.050),                                  # neck
]
HEAD = (0, 3, 4)   # head centre = mean of nose and ears
SEG, RINGS = 14, 6  # capsule resolution: around × per hemisphere


def _capsule_template():
    """Unit capsule along +z from 0 to 1, cylinder radius 1: (unit positions, which end each vertex follows, faces)."""
    verts, end, rings = [], [], []
    for cap, z0 in ((0, 0.0), (1, 1.0)):
        rng = range(RINGS, -1, -1) if cap == 0 else range(0, RINGS + 1)
        for k in rng:
            a = (np.pi / 2) * k / RINGS
            r, dz = np.cos(a), np.sin(a) * (-1 if cap == 0 else 1)
            ring = []
            for j in range(SEG):
                t = 2 * np.pi * j / SEG
                ring.append(len(verts))
                verts.append((r * np.cos(t), r * np.sin(t), dz))
                end.append(cap)
            rings.append(ring)
    faces = []
    for a, b in zip(rings[:-1], rings[1:]):
        for j in range(SEG):
            p, q, r_, s = a[j], a[(j + 1) % SEG], b[j], b[(j + 1) % SEG]
            faces += [(p, q, s), (p, s, r_)]
    return np.array(verts, np.float32), np.array(end), np.array(faces)


_T, _END, _F = _capsule_template()


def _frame(axis):
    """Two unit vectors perpendicular to each axis (rows), stable for any direction."""
    ref = np.where(np.abs(axis[:, 1:2]) < 0.9, np.array([[0, 1.0, 0]]), np.array([[1.0, 0, 0]]))
    u = np.cross(axis, ref); u /= np.linalg.norm(u, axis=1, keepdims=True) + 1e-9
    v = np.cross(axis, u)
    return u, v


def _place(p0, p1, r0, r1):
    """Capsule between p0 and p1 (each [T, 3]) → vertices [T, Vc, 3]."""
    d = p1 - p0
    length = np.linalg.norm(d, axis=1, keepdims=True)
    axis = d / (length + 1e-9)
    u, v = _frame(axis)
    r = np.where(_END == 0, r0, r1)[None, :, None]                     # radius per vertex
    base = np.where(_END[None, :, None] == 0, p0[:, None], p1[:, None])  # which end it rides on
    off = (_T[None, :, 0:1] * u[:, None] + _T[None, :, 1:2] * v[:, None]) * r + _T[None, :, 2:3] * axis[:, None] * r
    return base + off


def build(joints, scale=1.0):
    """joints [T, 133, 3] → (verts [T, V, 3] float32, faces [F, 3]). `scale` thickens/thins every part together."""
    j = np.asarray(joints, np.float32)
    pick = lambda ids: j[:, list(ids)].mean(1)
    parts, faces, n = [], [], 0
    for a, b, r0, r1 in LIMBS:
        parts.append(_place(pick(a), pick(b), r0 * scale, r1 * scale))
    head = pick(HEAD)
    up = pick((5, 6)) - head  # head capsule leans along the neck, slightly elongated
    up /= np.linalg.norm(up, axis=1, keepdims=True) + 1e-9
    parts.append(_place(head + up * 0.03, head - up * 0.05, 0.105 * scale, 0.095 * scale))
    for p in parts:
        faces.append(_F + n); n += p.shape[1]
    return np.concatenate(parts, 1).astype(np.float32), np.concatenate(faces)
