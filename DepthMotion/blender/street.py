"""Location style: an urban street running along the camera's direction, the people in the middle of the road.
Road + curbs + sidewalks, building facades both sides (recessed windows, doors, balconies, cornices), a building
closing the far end, street lamps, parked cars, dumpsters — all white clay, beveled, for a clean depth read."""
import math
import random

import bmesh
import bpy
from mathutils import Vector

from ruins import _mesh, box


def facade(coll, rng, name, origin, along, out, length, floors):
    """A building face built like a real one: the wall sits 0.3 m back; piers between the windows and bands
    between the floors sit on the face — so every window is a true recess. Door, balconies, cornice."""
    ang = math.atan2(along.y, along.x)
    fh, win_h, rec, D = 3.2, 1.5, 0.3, 6.0
    H = floors * fh + 0.6
    c = origin + along * (length / 2) - out * (D / 2 + rec)
    box(f"{name}_BODY", coll, (length, D, H), (c.x, c.y, H / 2), (0, 0, ang), 0.03)
    bays = max(2, int(length / 2.6)); bw = length / bays; win_w = min(1.2, bw - 0.6)
    face = lambda u: origin + along * u - out * (rec / 2)
    for b in range(bays + 1):  # piers
        pw = (bw - win_w) if 0 < b < bays else (bw - win_w) / 2
        u = b * bw
        p = face(min(max(u, pw / 2), length - pw / 2))
        box(f"{name}_PIER{b}", coll, (pw, rec, H), (p.x, p.y, H / 2), (0, 0, ang), 0.02)
    for f in range(floors + 1):  # bands between window rows (ground band holds the door height)
        lo = 0.0 if f == 0 else (f - 1) * fh + 1.0 + win_h
        hi = (f * fh + 1.0) if f < floors else H
        if f == 0:
            hi = 1.0
        p = face(length / 2)
        box(f"{name}_BAND{f}", coll, (length, rec, hi - lo), (p.x, p.y, (lo + hi) / 2), (0, 0, ang), 0.02)
    door = origin + along * ((bays // 2 + 0.5) * bw) + out * 0.02
    box(f"{name}_DOOR", coll, (win_w + 0.2, 0.08, 2.4), (door.x, door.y, 1.2), (0, 0, ang), 0.01)
    cor = origin + along * (length / 2) + out * 0.2
    box(f"{name}_CORNICE", coll, (length + 0.3, 0.7, 0.4), (cor.x, cor.y, H - 0.05), (0, 0, ang), 0.03)
    for f in range(1, floors):
        for b in range(bays):
            if rng.random() < 0.22:  # balconies
                p = origin + along * ((b + 0.5) * bw) + out * 0.55
                box(f"{name}_BAL{f}_{b}", coll, (win_w + 0.6, 1.1, 0.12), (p.x, p.y, f * fh + 0.95), (0, 0, ang), 0.02)
                r = p + out * 0.52
                box(f"{name}_RAIL{f}_{b}", coll, (win_w + 0.6, 0.06, 0.9), (r.x, r.y, f * fh + 1.45), (0, 0, ang), 0.01)


def lamp(coll, name, p, toward):
    bm = bmesh.new(); bmesh.ops.create_cone(bm, cap_ends=True, segments=10, radius1=0.09, radius2=0.06, depth=5.0)
    _mesh(f"{name}_POLE", bm, coll, (p.x, p.y, 2.5), (0, 0, 0), 0)
    arm = p + toward * 0.6
    box(f"{name}_ARM", coll, (1.3, 0.1, 0.1), (arm.x, arm.y, 4.95), (0, 0, math.atan2(toward.y, toward.x)), 0.01)
    head = p + toward * 1.2
    box(f"{name}_HEAD", coll, (0.6, 0.3, 0.18), (head.x, head.y, 4.85), (0, 0, math.atan2(toward.y, toward.x)), 0.02)


def car(coll, rng, name, p, along):
    ang = math.atan2(along.y, along.x) + rng.choice((0, math.pi))
    box(f"{name}_BODY", coll, (4.3, 1.8, 0.75), (p.x, p.y, 0.62), (0, 0, ang), 0.08)
    cab = p + along * rng.uniform(-0.3, 0.3)
    box(f"{name}_CAB", coll, (2.3, 1.6, 0.6), (cab.x, cab.y, 1.27), (0, 0, ang), 0.12)
    for sx in (-1.4, 1.4):
        for sy in (-0.85, 0.85):
            wpos = p + Vector((math.cos(ang), math.sin(ang), 0)) * sx + Vector((-math.sin(ang), math.cos(ang), 0)) * sy
            bm = bmesh.new(); bmesh.ops.create_cone(bm, cap_ends=True, segments=12, radius1=0.34, radius2=0.34, depth=0.25)
            _mesh(f"{name}_WHEEL", bm, coll, (wpos.x, wpos.y, 0.34), (math.pi / 2, 0, ang + math.pi / 2), 0.01)


def build(people_xy, cam_xy, cam_dir_xy, seed=7):
    rng = random.Random(seed)
    coll = bpy.data.collections.new("SET"); bpy.context.scene.collection.children.link(coll)
    cx = sum(p[0] for p in people_xy) / len(people_xy); cy = sum(p[1] for p in people_xy) / len(people_xy)
    centre = Vector((cx, cy, 0))
    fwd = Vector((cx - cam_xy[0], cy - cam_xy[1], 0)).normalized(); side = Vector((-fwd.y, fwd.x, 0))
    ang = math.atan2(fwd.y, fwd.x)
    road_w, walk_w, back, ahead = 9.0, 3.0, 25.0, 30.0
    mid = centre + fwd * (ahead - back) / 2
    box("ROAD", coll, (ahead + back, road_w, 0.1), (mid.x, mid.y, -0.05), (0, 0, ang), 0)
    for s in (-1, 1):
        w_ = mid + side * s * (road_w / 2 + walk_w / 2)
        box(f"WALK_{s}", coll, (ahead + back, walk_w, 0.15), (w_.x, w_.y, 0.075), (0, 0, ang), 0.02)
        # buildings: a row of facades of different heights and widths along the street
        u = -back
        k = 0
        while u < ahead:
            L = rng.uniform(7, 13)
            origin = centre + fwd * u + side * s * (road_w / 2 + walk_w)
            facade(coll, rng, f"BLD_{s}_{k}", origin, fwd if s < 0 else fwd, -side * s, L, rng.randint(3, 6))
            u += L + rng.uniform(0, 0.6); k += 1
        for j in range(4):  # lamps along the curb, leaning over the road
            p = centre + fwd * (-8 + j * 9 + rng.uniform(-1, 1)) + side * s * (road_w / 2 + 0.5)
            lamp(coll, f"LAMP_{s}_{j}", p, -side * s)
        for j in range(3):  # parked cars by the curb, never next to the people
            u = rng.choice((-14, -8, 9, 15)) + rng.uniform(-1.5, 1.5)
            p = centre + fwd * u + side * s * (road_w / 2 - 1.3)
            car(coll, rng, f"CAR_{s}_{j}", p, fwd)
        d = centre + fwd * rng.uniform(4, 12) + side * s * (road_w / 2 + walk_w - 0.9)
        box(f"DUMPSTER_{s}", coll, (1.9, 1.1, 1.25), (d.x, d.y, 0.78), (0, 0, ang), 0.04)
    end = centre + fwd * ahead - side * (road_w / 2 + walk_w + 6)
    facade(coll, rng, "BLD_END", end, side, -fwd, road_w + 2 * walk_w + 12, rng.randint(4, 7))
    return coll
