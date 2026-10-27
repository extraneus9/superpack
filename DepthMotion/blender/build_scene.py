"""Runs INSIDE Blender (blender -b --python build_scene.py -- <scene folder>).

Reads scene.json written by engine/to_blender.py and builds a ready-to-shoot .blend:
  world Z-up, metres, floor at z = 0
  CAM          the footage's camera (lens + height + tilt), at frame 1 it frames the shot exactly like the clip
  PERSON_n     one mannequin per person, animated by a Mesh Cache (.pc2) of the captured motion, in their colour
  SET          the real set as simple clay relief (from the clip's depth) — or an empty stage
  FLOOR        a big floor plane
Then saves scene.blend and renders a clay preview (PNG frames → mp4 is done by the caller).
"""
import json
import math
import os
import sys

import bpy
from mathutils import Matrix

folder = sys.argv[sys.argv.index("--") + 1]
S = json.load(open(os.path.join(folder, "scene.json"), encoding="utf-8"))
render_preview = "--no-render" not in sys.argv

# ---------- clean slate ----------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = "METRIC"
scene.render.fps = round(S["fps"])
scene.render.fps_base = round(S["fps"]) / S["fps"]
scene.frame_start, scene.frame_end = 1, S["frames"]
scene.render.resolution_x, scene.render.resolution_y = S["width"], S["height"]


def hex_rgba(h, a=1.0):
    h = h.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return (*lin, a)


def clay(name, color, rough=0.62):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = color
    b.inputs["Roughness"].default_value = rough
    m.diffuse_color = color  # what Workbench / the viewport's "Material" colour shows
    return m


def import_obj(path, name):
    bpy.ops.wm.obj_import(filepath=path, forward_axis="Y", up_axis="Z")
    ob = bpy.context.selected_objects[0]
    ob.name = name
    ob.data.name = name
    return ob


col_people = bpy.data.collections.new("PEOPLE"); scene.collection.children.link(col_people)
col_set = bpy.data.collections.new("SET"); scene.collection.children.link(col_set)

# ---------- camera (the footage's) ----------
cam_data = bpy.data.cameras.new("CAM")
cam_data.sensor_fit = "HORIZONTAL"
cam_data.sensor_width = 36.0
cam_data.lens = S["lens_mm"]
cam_data.clip_start, cam_data.clip_end = 0.05, 500
cam = bpy.data.objects.new("CAM", cam_data)
scene.collection.objects.link(cam)
cam.matrix_world = Matrix(S["camera_matrix"])  # rows
scene.camera = cam
for f, m in enumerate(S.get("camera_track") or []):  # the real camera's move, solved from the footage
    cam.matrix_world = Matrix(m)
    cam.keyframe_insert("location", frame=f + 1)
    cam.keyframe_insert("rotation_euler", frame=f + 1)

# ---------- people ----------
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import numpy as np
    import human  # MPFB bodies; missing extension → block mannequins
except ImportError as e:
    human = None
    print("DEPTHMOTION_NO_MPFB", e)
legs = [p.get("leg_m", 0) for p in S["people"]]
for i, p in enumerate(S["people"]):
    if human and p.get("joints"):
        human.build(p["name"], hex_rgba(p["color"]), np.load(os.path.join(folder, p["joints"])), col_people,
                    heavy=len(legs) > 1 and p.get("leg_m", 0) == max(legs))
        continue
    ob = import_obj(os.path.join(folder, p["obj"]), p["name"])
    for c in ob.users_collection:
        c.objects.unlink(ob)
    col_people.objects.link(ob)
    mod = ob.modifiers.new("MOTION", "MESH_CACHE")
    mod.cache_format = "PC2"
    mod.filepath = "//" + p["pc2"]
    mod.frame_start = 1
    mod.forward_axis, mod.up_axis = "POS_Y", "POS_Z"
    ob.data.materials.append(clay(p["name"] + "_clay", hex_rgba(p["color"])))
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True); bpy.context.view_layer.objects.active = ob
    bpy.ops.object.shade_smooth()
    ob["depthmotion_color"] = p["color"]

# ---------- set ----------
grey = clay("SET_clay", hex_rgba("#c9c6c0"), 0.85)
if S.get("set_obj"):
    st = import_obj(os.path.join(folder, S["set_obj"]), "SET")
    for c in st.users_collection:
        c.objects.unlink(st)
    col_set.objects.link(st)
    st.data.materials.append(grey)
    # blockout look: a few big angular facets instead of a noisy scan
    dec = st.modifiers.new("BLOCKOUT", "DECIMATE"); dec.ratio = 0.04; dec.use_collapse_triangulate = True
    for poly in st.data.polygons:
        poly.use_smooth = False
bpy.ops.mesh.primitive_plane_add(size=S.get("floor_size", 80), location=(0, 0, 0))
floor = bpy.context.active_object; floor.name = "FLOOR"
for c in floor.users_collection:
    c.objects.unlink(floor)
col_set.objects.link(floor)
floor.data.materials.append(grey)

# ---------- light + world: the soft, single-key clay look ----------
sun = bpy.data.objects.new("KEY", bpy.data.lights.new("KEY", "SUN"))
sun.data.energy = 3.2
sun.data.angle = math.radians(12)
sun.rotation_euler = (math.radians(52), 0, math.radians(-38))
scene.collection.objects.link(sun)
world = bpy.data.worlds.new("WORLD"); scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.55, 0.56, 0.58, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.7

# ---------- preview render: EEVEE, white world, warm low sun, soft shadows — a clean previz ----------
sun.data.energy = 5.0
sun.data.color = (1.0, 0.94, 0.86)
sun.data.angle = 0.06  # crisp, readable shadows (the previz look), still a little soft
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.72, 0.76, 0.82, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.35
scene.render.engine = "BLENDER_EEVEE"
scene.eevee.taa_render_samples = 32
try:
    scene.eevee.use_shadows = True
    scene.eevee.use_raytracing = True
except AttributeError:
    pass
scene.view_settings.view_transform = "AgX"
scene.view_settings.look = "AgX - Medium High Contrast"
scene.view_settings.exposure = -0.3
if False:  # (Workbench, kept for a fast mode)
    scene.render.engine = "BLENDER_WORKBENCH"
sh = scene.display.shading
sh.light = "STUDIO"
sh.color_type = "MATERIAL"
sh.show_cavity = True
sh.cavity_type = "WORLD"
sh.show_shadows = True
sh.shadow_intensity = 0.35
scene.display.light_direction = (0.45, -0.35, 0.82)
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = os.path.join(folder, "preview", "f_")

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(folder, "scene.blend"), relative_remap=True)
if render_preview:
    bpy.ops.render.render(animation=True)
if "--masks" in sys.argv:
    # QA: every person as a flat pure colour on black, nothing else — compared with the footage's own masks
    for ob in col_set.objects:
        ob.hide_render = True
    ids = [(1, 0, 0, 1), (0, 1, 0, 1), (0, 0, 1, 1), (1, 1, 0, 1), (1, 0, 1, 1), (0, 1, 1, 1)]
    for ob in col_people.all_objects:
        if ob.type == "MESH":
            k = next(i for i, p in enumerate(S["people"]) if ob.name.startswith(p["name"]))
            ob.color = ids[k]
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "FLAT"
    scene.display.shading.color_type = "OBJECT"
    scene.display.shading.show_cavity = False
    scene.display.shading.show_shadows = False
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0
    scene.display.shading.background_type = "VIEWPORT" if hasattr(scene.display.shading, "background_type") else None
    scene.render.film_transparent = True
    scene.view_settings.view_transform = "Standard"; scene.view_settings.look = "None"; scene.view_settings.exposure = 0
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.filepath = os.path.join(folder, "masks", "m_")
    bpy.ops.render.render(animation=True)
print("DEPTHMOTION_BLEND_OK", os.path.join(folder, "scene.blend"))
