"""Runs inside Blender: a clean previz location — ancient stone ruins in white clay — built around a fight.

Layout (world Z up, metres, floor z = 0), laid out from where the fighters stand and where the camera looks:
  FLOOR       cracked flagstones in the fighting area, faceted ground beyond
  MIDGROUND   broken column stumps + half-buried fallen slabs on a ring around the fighters, open toward the camera
  FOREGROUND  one fallen drum + one rock beside the camera's path (never in it)
  BACKGROUND  a ruined colonnade (columns, broken lintels, stepped wall) behind the fighters, rock cliffs far out
Everything is flat-shaded with beveled edges, so it reads like a sculpted maquette. Deterministic (seeded).
"""
import math
import random

import bmesh
import bpy
from mathutils import Matrix, Vector


def _mat():
    m = bpy.data.materials.get("RUINS_clay") or bpy.data.materials.new("RUINS_clay")
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (0.70, 0.68, 0.64, 1)
    b.inputs["Roughness"].default_value = 0.85
    m.diffuse_color = (0.70, 0.68, 0.64, 1)
    return m


def _finish(ob, coll, bevel=0.03):
    for c in ob.users_collection:
        c.objects.unlink(ob)
    coll.objects.link(ob)
    ob.data.materials.append(_mat())
    if bevel:
        bv = ob.modifiers.new("BEVEL", "BEVEL"); bv.width = bevel; bv.segments = 1; bv.limit_method = "ANGLE"
    for p in ob.data.polygons:
        p.use_smooth = False
    return ob


def _mesh(name, bm, coll, loc=(0, 0, 0), rot=(0, 0, 0), bevel=0.03):
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me)
    ob.location = loc; ob.rotation_euler = rot
    bpy.context.scene.collection.objects.link(ob)
    return _finish(ob, coll, bevel)


def box(name, coll, size, loc, rot=(0, 0, 0), bevel=0.03):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    return _mesh(name, bm, coll, loc, rot, bevel)


def _drum(radius, h, segs=20):
    """One fluted drum: the ring alternates in/out so the flutes catch the light."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segs, radius1=radius, radius2=radius * 0.985, depth=h)
    for v in bm.verts:
        ang = math.atan2(v.co.y, v.co.x)
        if round(ang / (2 * math.pi / segs)) % 2 and math.hypot(v.co.x, v.co.y) > radius * 0.5:
            v.co.x *= 0.93; v.co.y *= 0.93
    return bm


def _append(dst, src, offset=(0, 0, 0), rot_z=0.0):
    me = bpy.data.meshes.new("tmp"); src.to_mesh(me); src.free()
    me.transform(Matrix.Translation(offset) @ Matrix.Rotation(rot_z, 4, "Z"))
    dst.from_mesh(me); bpy.data.meshes.remove(me)


def column(name, coll, rng, loc, height, radius=0.42, broken=True, fluted=True):
    """A real column: plinth, a stack of fluted drums each a little off-axis, a capital if it's whole, a
    snapped, chipped top if it isn't."""
    bm = bmesh.new()
    plinth = bmesh.new(); bmesh.ops.create_cube(plinth, size=1.0)
    bmesh.ops.scale(plinth, vec=(radius * 2.7, radius * 2.7, 0.32), verts=plinth.verts)
    _append(bm, plinth, (0, 0, 0.16))
    base = bmesh.new(); bmesh.ops.create_cone(base, cap_ends=True, segments=20, radius1=radius * 1.15, radius2=radius * 1.02, depth=0.18)
    _append(bm, base, (0, 0, 0.41))
    z, k = 0.5, 0
    while z < height + 0.5 - 0.05:
        dh = min(rng.uniform(0.7, 1.0), height + 0.5 - z)
        r = radius * (1 - 0.06 * (z / max(height, 1)))  # entasis: thinner toward the top
        _append(bm, _drum(r, dh - 0.02), (rng.uniform(-0.015, 0.015), rng.uniform(-0.015, 0.015), z + dh / 2), rng.uniform(-0.06, 0.06))
        z += dh; k += 1
    if broken:
        tilt = Vector((rng.uniform(-0.7, 0.7), rng.uniform(-0.7, 0.7), 1)).normalized()
        cut = Vector((0, 0, z - rng.uniform(0.15, 0.5)))
        res = bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=cut, plane_no=tilt, clear_outer=True)
        edges = [e for e in res["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
        if edges:
            bmesh.ops.holes_fill(bm, edges=edges)
        for v in bm.verts:  # chip the broken edge
            if v.co.z > cut.z - 0.25 and rng.random() < 0.5:
                v.co.z -= rng.uniform(0, 0.12)
    else:
        ech = bmesh.new(); bmesh.ops.create_cone(ech, cap_ends=True, segments=20, radius1=radius * 0.95, radius2=radius * 1.3, depth=0.25)
        _append(bm, ech, (0, 0, z + 0.125))
        aba = bmesh.new(); bmesh.ops.create_cube(aba, size=1.0)
        bmesh.ops.scale(aba, vec=(radius * 2.9, radius * 2.9, 0.22), verts=aba.verts)
        _append(bm, aba, (0, 0, z + 0.36))
    return _mesh(name, bm, coll, loc, (0, 0, rng.uniform(0, math.pi)), 0.015)


def rubble(name, coll, rng, around, n=6, spread=1.4):
    """Broken bits at the foot of a ruin: small tumbled blocks."""
    for k in range(n):
        a = rng.uniform(0, 6.28); r = rng.uniform(0.5, spread)
        sz = rng.uniform(0.15, 0.45)
        box(f"{name}_{k}", coll, (sz * rng.uniform(0.8, 1.6), sz, sz * rng.uniform(0.6, 1.0)),
            (around[0] + r * math.cos(a), around[1] + r * math.sin(a), sz * 0.35),
            (rng.uniform(-.4, .4), rng.uniform(-.4, .4), rng.uniform(0, 6.28)), 0.02)


def rock(name, coll, rng, loc, size, flat=1.0):
    """A faceted boulder: a rough icosphere, jittered, squashed, sunk into the ground."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=2, radius=1.0)
    for v in bm.verts:
        v.co *= 1 + rng.uniform(-0.22, 0.22)
    bmesh.ops.scale(bm, vec=(size[0], size[1], size[2] * flat), verts=bm.verts)
    ob = _mesh(name, bm, coll, (loc[0], loc[1], loc[2] - size[2] * 0.25), (rng.uniform(-.2, .2), rng.uniform(-.2, .2), rng.uniform(0, 6.28)), 0)
    dec = ob.modifiers.new("FACETS", "DECIMATE"); dec.ratio = 0.35
    return ob


def ground(coll, rng, center, clear_r):
    """Faceted ground with gentle swells, dead flat inside the fighting area (feet must meet it)."""
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=70, y_segments=70, size=45)
    for v in bm.verts:
        d = math.hypot(v.co.x + 0 - 0, v.co.y)
        dc = math.hypot(v.co.x - center[0], v.co.y - center[1])
        if dc > clear_r + 1.5:
            fall = min(1.0, (dc - clear_r - 1.5) / 8)
            v.co.z = fall * (0.25 * math.sin(v.co.x * 0.31 + 1.7) * math.cos(v.co.y * 0.27) + rng.uniform(-0.12, 0.12))
    ob = _mesh("GROUND", bm, coll, bevel=0)
    dec = ob.modifiers.new("FACETS", "DECIMATE"); dec.ratio = 0.25
    return ob


def flagstones(coll, rng, center, radius):
    """Cracked paving under the fighters: slightly uneven slabs with thin gaps (reads in depth as texture)."""
    tile = 0.9
    n = int(radius / tile) + 1
    k = 0
    for i in range(-n, n + 1):
        for j in range(-n, n + 1):
            x, y = center[0] + i * tile, center[1] + j * tile
            if math.hypot(x - center[0], y - center[1]) > radius or rng.random() < 0.08:
                continue
            h = 0.07 + rng.uniform(0, 0.03)
            tilt = (rng.uniform(-0.015, 0.015), rng.uniform(-0.015, 0.015), rng.uniform(-0.04, 0.04))
            if rng.random() < 0.35:  # split slab (a crack), the halves settle differently
                for hx in (-0.25, 0.25):
                    box(f"FLAG_{k}", coll, (tile / 2 - 0.05, tile - 0.06, h), (x + hx * tile, y, h / 2 - 0.05 + rng.uniform(-0.015, 0.01)),
                        (tilt[0] + rng.uniform(-0.02, 0.02), tilt[1], tilt[2]), 0.012); k += 1
            else:
                box(f"FLAG_{k}", coll, (tile - 0.06, tile - 0.06, h), (x, y, h / 2 - 0.05), tilt, 0.012); k += 1


def build(people_xy, cam_xy, cam_dir_xy, seed=7):  # (the shared style signature)
    """people_xy: fighters' (x, y) · cam_xy: the camera's ground position at the first frame · cam_dir_xy: where
    it looks (unit). → the SET collection."""
    rng = random.Random(seed)
    coll = bpy.data.collections.new("SET"); bpy.context.scene.collection.children.link(coll)
    cx = sum(p[0] for p in people_xy) / len(people_xy); cy = sum(p[1] for p in people_xy) / len(people_xy)
    centre = (cx, cy)
    fwd = Vector((cx - cam_xy[0], cy - cam_xy[1], 0)).normalized()     # from camera toward the fight
    side = Vector((-fwd.y, fwd.x, 0))
    to_cam = math.atan2(-fwd.y, -fwd.x)                                  # the direction the ring must stay open
    clear_r = 3.6

    ground(coll, rng, centre, clear_r)
    flagstones(coll, rng, centre, clear_r + 0.8)

    # midground ring: stumps and fallen slabs, open toward the camera (a ±50° gap)
    for k in range(13):
        a = to_cam + math.radians(50) + k * math.radians(260 / 12) + rng.uniform(-0.08, 0.08)
        r = rng.uniform(6.0, 8.0)
        p = (cx + r * math.cos(a), cy + r * math.sin(a), 0)
        if k % 3 == 1:
            box(f"SLAB_{k}", coll, (rng.uniform(1.8, 2.6), rng.uniform(0.7, 1.0), rng.uniform(0.35, 0.5)),
                (p[0], p[1], 0.12), (rng.uniform(-0.12, 0.12), rng.uniform(-0.25, 0.25), a + rng.uniform(-0.5, 0.5)), 0.04)
        elif k % 3 == 2:
            rock(f"ROCK_M{k}", coll, rng, p, (rng.uniform(0.6, 1.1), rng.uniform(0.5, 0.9), rng.uniform(0.5, 0.9)))
        else:
            column(f"STUMP_{k}", coll, rng, p, rng.uniform(0.9, 2.6))
            rubble(f"RUBBLE_{k}", coll, rng, p)

    # background colonnade behind the fighters (relative to the camera), with a ruined wall
    back = Vector((cx, cy, 0)) + fwd * 14
    for k in range(-4, 5):
        p = back + side * (k * 3.0)
        h = 6.5 if k % 3 else rng.uniform(2.0, 4.5)
        column(f"COLUMN_{k}", coll, rng, p, h, 0.55, broken=h < 6.4)
        if h < 6.4:
            rubble(f"RUBBLE_C{k}", coll, rng, p, n=8, spread=2.0)
    for k in (-4, -3, 0, 1, 2):  # lintels still standing on intact neighbours
        mid = back + side * (k * 3.0 + 1.5)
        box(f"LINTEL_{k}", coll, (3.3, 0.9, 0.7), (mid.x, mid.y, 7.2), (0, 0, math.atan2(side.y, side.x)), 0.04)
    wall = back + fwd * 2.5
    ang = math.atan2(side.y, side.x)
    course_h, length = 0.55, 28.0
    for c in range(8):  # masonry courses: block lengths vary, joints stagger, the top crumbles away
        zc = c * course_h
        u = -length / 2 + (0.6 if c % 2 else 0.0)
        while u < length / 2:
            L = rng.uniform(0.9, 1.7)
            top = 4.4 - abs(u) * 0.22 + 1.1 * math.sin(u * 0.7 + 1.3) + rng.uniform(-0.5, 0.3)
            if zc < top and not (c > 2 and rng.random() < 0.12):
                p = wall + side * (u + L / 2)
                box(f"WALL_{c}_{int(u * 10)}", coll, (L - 0.04, 1.1 + rng.uniform(-0.05, 0.05), course_h - 0.03),
                    (p.x, p.y, zc + course_h / 2), (0, 0, ang + rng.uniform(-0.02, 0.02)), 0.03)
            u += L

    # far cliffs: big faceted rocks closing the horizon behind and to the sides
    for k in range(16):
        a = math.atan2(fwd.y, fwd.x) + rng.uniform(-1.4, 1.4)
        r = rng.uniform(30, 40)
        p = (cx + r * math.cos(a), cy + r * math.sin(a), 0)
        s = rng.uniform(5, 9)
        rock(f"CLIFF_{k}", coll, rng, p, (s, s * 0.8, s * rng.uniform(0.9, 1.6)))

    # foreground: a fallen drum and a rock beside the camera's path (lateral 2.2 m, so the push-in never hits them)
    cam = Vector((cam_xy[0], cam_xy[1], 0))
    fg1 = cam + fwd * 2.8 - side * 2.4
    drum = column("FG_DRUM", coll, rng, fg1, 0.9, 0.5, broken=False)
    drum.rotation_euler = (math.pi / 2, 0, math.atan2(fwd.y, fwd.x) + 0.6)
    drum.location.z = 0.5
    rock("FG_ROCK", coll, rng, cam + fwd * 4.5 + side * 2.6, (0.7, 0.6, 0.55))
    return coll
