"""Runs INSIDE Blender:
  blender -b --factory-startup --python build_env.py -- <scene folder> [--still N]
  blender -b --factory-startup <scene folder>/env.blend --python build_env.py -- <scene folder> --reuse

A new location for a real shot. Reads scene.json (solved camera track, where the people stand, location style,
layout seed, sun height), builds the chosen style around them (styles: ruins / studio / street), lights it,
saves env.blend, and renders
  env_clay/c_####.png    the set as lit white clay
  env_depth/d_####.exr   its true depth per pixel (metres along the view axis)
--reuse keeps an env.blend the person edited by hand and only renders it again.
No bodies are rendered here: the people come from the footage's own depth, which is exact.
"""
import importlib
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

folder = sys.argv[sys.argv.index("--") + 1]
still = int(sys.argv[sys.argv.index("--still") + 1]) if "--still" in sys.argv else None
reuse = "--reuse" in sys.argv
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
S = json.load(open(os.path.join(folder, "scene.json"), encoding="utf-8"))


def people_xy():
    out = []
    for p in S["people"]:
        if p.get("xy"):
            out.append(tuple(p["xy"]))
        else:  # a full mocap scene: their median hip position
            j = np.load(os.path.join(folder, p["joints"]))
            out.append(tuple(np.median(((j[:, 11] + j[:, 12]) / 2)[:, :2], axis=0)))
    return out


def setup_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.fps = round(S["fps"]); sc.render.fps_base = round(S["fps"]) / S["fps"]
    sc.frame_start, sc.frame_end = 1, S["frames"]
    sc.render.resolution_x, sc.render.resolution_y = S["width"], S["height"]
    # the real camera, solved from the footage
    cd = bpy.data.cameras.new("CAM"); cd.sensor_fit = "HORIZONTAL"; cd.sensor_width = 36.0; cd.lens = S["lens_mm"]
    cd.clip_start, cd.clip_end = 0.05, 400
    cam = bpy.data.objects.new("CAM", cd); sc.collection.objects.link(cam); sc.camera = cam
    track = S.get("camera_track") or [S["camera_matrix"]]
    for f, m in enumerate(track):
        cam.matrix_world = Matrix(m)
        cam.keyframe_insert("location", frame=f + 1); cam.keyframe_insert("rotation_euler", frame=f + 1)
    m0 = Matrix(track[0])
    look = m0.to_3x3() @ Vector((0, 0, -1)); look.z = 0; look.normalize()
    # the location, laid out around the people and kept clear of the camera's path
    style = importlib.import_module(S.get("style", "ruins"))
    style.build(people_xy(), (m0.translation.x, m0.translation.y), (look.x, look.y), seed=S.get("seed", 7))
    # light: a low warm sun from behind-left of the people → rim light + long shadows toward the camera
    elev = S.get("sun_deg", 18.0)
    sun = bpy.data.objects.new("SUN", bpy.data.lights.new("SUN", "SUN"))
    warm = max(0.0, min(1.0, (40 - elev) / 35))               # lower sun = warmer
    sun.data.energy = 3.0 + 2.0 * (1 - warm); sun.data.color = (1.0, 0.95 - 0.12 * warm, 0.9 - 0.25 * warm)
    sun.data.angle = math.radians(1.5)
    yaw = math.atan2(look.y, look.x) + math.radians(150)
    sun.rotation_euler = (math.radians(90 - elev), 0, yaw + math.pi / 2)
    sc.collection.objects.link(sun)
    world = bpy.data.worlds.new("SKY"); sc.world = world; world.use_nodes = True
    nt = world.node_tree; bg = nt.nodes["Background"]
    sky = nt.nodes.new("ShaderNodeTexSky")
    try:
        sky.sky_type = "PREETHAM"; sky.turbidity = 2.5
        sky.sun_direction = sun.matrix_world.to_3x3() @ Vector((0, 0, 1))
    except Exception:
        pass
    nt.links.new(sky.outputs["Color"], bg.inputs["Color"]); bg.inputs["Strength"].default_value = 0.35
    sc.render.engine = "BLENDER_EEVEE"
    sc.eevee.taa_render_samples = 48
    for attr, val in (("use_shadows", True), ("use_raytracing", True), ("use_gtao", True)):
        try:
            setattr(sc.eevee, attr, val)
        except AttributeError:
            pass
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.look = "AgX - Medium High Contrast"
    sc.view_layers[0].use_pass_z = True
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(folder, "env.blend"), relative_remap=True)
    return sc


def render(sc):
    im = sc.render.image_settings
    frames = [still] if still else list(range(1, S["frames"] + 1))
    for n, f in enumerate(frames):
        sc.frame_set(f)
        if hasattr(im, "media_type"):
            im.media_type = "IMAGE"
        im.file_format = "PNG"; im.color_mode = "RGB"
        sc.render.filepath = os.path.join(folder, "env_clay", f"c_{f:04d}.png")
        bpy.ops.render.render(write_still=True)
        if hasattr(im, "media_type"):  # Blender 5: multilayer EXR is a media type
            im.media_type = "MULTI_LAYER_IMAGE"
        im.file_format = "OPEN_EXR_MULTILAYER"; im.color_depth = "32"
        sc.render.filepath = os.path.join(folder, "env_depth", f"d_{f:04d}.exr")
        bpy.ops.render.render(write_still=True)
        print(f"FRAME {(n + 1) / len(frames):.3f}", flush=True)


sc = bpy.context.scene if reuse else setup_scene()
sc.view_layers[0].use_pass_z = True
render(sc)
print("DEPTHMOTION_ENV_OK", flush=True)
