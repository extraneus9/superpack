"""Runs inside Blender: a real human body (MPFB / MakeHuman, CC0 assets) driven by DepthMotion's 3D joints.

Each captured joint becomes an animated empty in MOCAP_TARGETS; the body's Mixamo-style rig aims every bone at the
next joint (Damped Track), the hips and head also turn to face the right way (Locked Track). The targets stay live in
the .blend, so the motion can be touched up by hand: move an empty, the body follows.
Joints follow COCO-WholeBody: 5/6 shoulders · 7/8 elbows · 9/10 wrists · 11/12 hips · 13/14 knees · 15/16 ankles ·
17/20 big toes · 0 nose · 3/4 ears · 100/121 middle knuckles (left/right hand).
"""
import bpy
import numpy as np
from mathutils import Vector

from bl_ext.blender_org.mpfb.services.humanservice import HumanService

P = "mixamorig:"
AIM = {  # bone → joint (or joints, averaged) it points at
    "LeftArm": (7,), "LeftForeArm": (9,), "LeftHand": (100,),
    "RightArm": (8,), "RightForeArm": (10,), "RightHand": (121,),
    "LeftUpLeg": (13,), "LeftLeg": (15,), "LeftFoot": (17,),
    "RightUpLeg": (14,), "RightLeg": (16,), "RightFoot": (20,),
    "Spine": (5, 6), "Neck": (0, 3, 4),
}


def _targets(name, joints, coll):
    """One animated empty per joint position we use. → {key: empty}"""
    keys = {k for v in AIM.values() for k in [v]} | {(11, 12), (0, 3, 4), (0,), (11,), (12,)}
    out = {}
    for key in keys:
        e = bpy.data.objects.new(f"{name}_J_{'_'.join(map(str, key))}", None)
        e.empty_display_size = 0.04
        coll.objects.link(e)
        pos = joints[:, list(key)].mean(1)
        for t, p in enumerate(pos):
            e.location = p
            e.keyframe_insert("location", frame=t + 1)
        out[key] = e
    # a point above the head (the head bone aims up through the skull), from the neck → head direction
    head = joints[:, [0, 3, 4]].mean(1); neck = joints[:, [5, 6]].mean(1)
    up = head - neck; up /= np.linalg.norm(up, axis=1, keepdims=True) + 1e-9
    e = bpy.data.objects.new(f"{name}_J_headtop", None); e.empty_display_size = 0.04; coll.objects.link(e)
    for t, p in enumerate(head + up * 0.15):
        e.location = p; e.keyframe_insert("location", frame=t + 1)
    out["headtop"] = e
    return out


def _axis_toward(rig, bone_name, world_dir):
    """Which local axis of a bone (at rest) points closest to a world direction → a Locked Track axis name."""
    m = (rig.matrix_world @ rig.data.bones[bone_name].matrix_local).to_3x3().normalized()
    best = max(((s * (m @ Vector(a)).dot(Vector(world_dir)), n if s > 0 else "NEGATIVE_" + n)
                for n, a in (("X", (1, 0, 0)), ("Z", (0, 0, 1))) for s in (1, -1)))
    return "TRACK_" + best[1]


def _fists(rig):
    """Curl every finger into a fist (fighters, gloves). Each segment bends ~75° around whichever of its side axes
    actually closes the hand — tested, not guessed: the fingertip must end nearer the wrist."""
    import math
    pb = rig.pose.bones
    for side in ("Left", "Right"):
        wrist = (rig.matrix_world @ pb[P + side + "Hand"].head)
        for finger in ("Index", "Middle", "Ring", "Pinky"):
            for seg in (1, 2, 3):
                b = pb.get(f"{P}{side}Hand{finger}{seg}")
                if b is None:
                    continue
                b.rotation_mode = "XYZ"
                best = None
                for axis in (0, 2):
                    for sign in (1, -1):
                        b.rotation_euler = (0, 0, 0)
                        b.rotation_euler[axis] = sign * math.radians(75 if seg < 3 else 60)
                        bpy.context.view_layer.update()
                        tip = rig.matrix_world @ pb[f"{P}{side}Hand{finger}3"].tail
                        d = (tip - wrist).length
                        if best is None or d < best[0]:
                            best = (d, axis, sign)
                b.rotation_euler = (0, 0, 0)
                b.rotation_euler[best[1]] = best[2] * math.radians(75 if seg < 3 else 60)
                bpy.context.view_layer.update()


def build(name, color_rgba, joints, coll, heavy=False):
    """joints: [T, 133, 3] world coords (Z up, metres). → the rig object (the body mesh is parented to it)."""
    macro = {"gender": 1.0, "age": 0.45, "muscle": 1.0 if heavy else 0.85, "weight": 1.0 if heavy else 0.55,
             "proportions": 0.5 if heavy else 0.6, "height": 0.7 if heavy else 0.5, "cupsize": 0.5, "firmness": 0.6,
             "race": {"asian": 0.33, "caucasian": 0.34, "african": 0.33}}
    body = HumanService.create_human(macro_detail_dict=macro, feet_on_ground=True, scale=0.1)
    rig = HumanService.add_builtin_rig(body, "mixamo")
    body.name, rig.name = f"{name}_BODY", name
    for ob in (body, rig):
        for c in ob.users_collection:
            c.objects.unlink(ob)
        coll.objects.link(ob)

    # size: their measured thigh + shin against the rig's
    b = rig.data.bones
    rest_leg = (b[P + "LeftUpLeg"].length + b[P + "LeftLeg"].length + b[P + "RightUpLeg"].length + b[P + "RightLeg"].length) / 2
    leg = np.median(np.linalg.norm(joints[:, 11] - joints[:, 13], axis=1) + np.linalg.norm(joints[:, 13] - joints[:, 15], axis=1))
    s = float(leg / rest_leg)
    rig.scale = (s, s, s)
    bpy.context.view_layer.update()

    tg = _targets(name, joints, coll)
    pb = rig.pose.bones
    hips = pb[P + "Hips"]
    c = hips.constraints.new("COPY_LOCATION"); c.target = tg[(11, 12)]
    c = hips.constraints.new("DAMPED_TRACK"); c.target = tg[(5, 6)]
    c = hips.constraints.new("LOCKED_TRACK"); c.target = tg[(11,)]; c.lock_axis = "LOCK_Y"
    c.track_axis = _axis_toward(rig, P + "Hips", (1, 0, 0))      # the character's left (MPFB humans face −Y)
    for bone, key in AIM.items():
        # limbs STRETCH from joint to joint, so hands and feet land exactly where the real person's are (the
        # capture's limb lengths wobble a little); the spine and neck only aim, so the torso keeps its shape
        if bone in ("Spine", "Neck"):
            c = pb[P + bone].constraints.new("DAMPED_TRACK")
        else:
            c = pb[P + bone].constraints.new("STRETCH_TO"); c.volume = "NO_VOLUME"; c.keep_axis = "SWING_Y"
        c.target = tg[key]
    head = pb[P + "Head"]
    c = head.constraints.new("DAMPED_TRACK"); c.target = tg["headtop"]
    c = head.constraints.new("LOCKED_TRACK"); c.target = tg[(0,)]; c.lock_axis = "LOCK_Y"
    c.track_axis = _axis_toward(rig, P + "Head", (0, -1, 0))      # the face looks toward the nose

    _fists(rig)

    # look: one smooth colour, like a painted maquette
    mat = bpy.data.materials.new(f"{name}_skin"); mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = color_rgba
    bsdf.inputs["Roughness"].default_value = 0.42
    mat.diffuse_color = color_rgba
    body.data.materials.clear(); body.data.materials.append(mat)
    for poly in body.data.polygons:
        poly.material_index = 0
    body.modifiers.new("SMOOTH", "SUBSURF").levels = 1
    for poly in body.data.polygons:
        poly.use_smooth = True
    return rig
