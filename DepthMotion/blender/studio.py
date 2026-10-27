"""Location style: a clean studio infinity cove — the floor sweeps up into the back wall, no horizon.
A neutral stage for pure motion. Apple boxes and two flags at the sides give scale without competing."""
import math
import random

import bmesh
import bpy
from mathutils import Vector

from ruins import _mesh, box


def cove(coll, centre, fwd, side, width=24.0, depth_back=8.0, height=7.0, radius=2.5):
    """Floor + quarter-round sweep + wall, as one smooth-swept faceted surface facing the camera."""
    bm = bmesh.new()
    profile = [(-12.0, 0.0), (depth_back - radius, 0.0)]
    for k in range(1, 9):  # the sweep
        a = (math.pi / 2) * k / 8
        profile.append((depth_back - radius + radius * math.sin(a), radius - radius * math.cos(a)))
    profile.append((depth_back, height))
    cols = []
    for u in (-width / 2, width / 2):
        col = []
        for d, z in profile:
            p = Vector((centre[0], centre[1], 0)) + fwd * d + side * u
            col.append(bm.verts.new((p.x, p.y, z)))
        cols.append(col)
    for i in range(len(profile) - 1):
        bm.faces.new((cols[0][i], cols[1][i], cols[1][i + 1], cols[0][i + 1]))
    return _mesh("COVE", bm, coll, bevel=0)


def build(people_xy, cam_xy, cam_dir_xy, seed=7):
    rng = random.Random(seed)
    coll = bpy.data.collections.new("SET"); bpy.context.scene.collection.children.link(coll)
    cx = sum(p[0] for p in people_xy) / len(people_xy); cy = sum(p[1] for p in people_xy) / len(people_xy)
    fwd = Vector((cx - cam_xy[0], cy - cam_xy[1], 0)).normalized(); side = Vector((-fwd.y, fwd.x, 0))
    ang = math.atan2(side.y, side.x)
    cove(coll, (cx, cy), fwd, side, depth_back=rng.uniform(6.5, 9.0))
    # scale cues at the edges: apple boxes and two flags on stands
    for s in (-1, 1):
        base = Vector((cx, cy, 0)) + side * s * rng.uniform(4.5, 5.5) + fwd * rng.uniform(-1, 2)
        for k in range(rng.randint(2, 3)):
            hh = 0.2 * (k + 1)
            box(f"APPLE_{s}_{k}", coll, (0.5, 0.3, 0.2), (base.x + 0.05 * k, base.y, hh - 0.1), (0, 0, ang + rng.uniform(-0.2, 0.2)), 0.01)
        stand = base + fwd * 1.5 + side * s * 0.6
        bm = bmesh.new(); bmesh.ops.create_cone(bm, cap_ends=True, segments=8, radius1=0.03, radius2=0.03, depth=2.2)
        _mesh(f"STAND_{s}", bm, coll, (stand.x, stand.y, 1.1), (0, 0, 0), 0)
        box(f"FLAG_{s}", coll, (1.2, 0.03, 0.9), (stand.x, stand.y, 2.05), (0, 0, ang + s * 0.5), 0.005)
    return coll
