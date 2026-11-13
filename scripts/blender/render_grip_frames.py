"""Render combatant clips with the gun held the way the game holds it, to check grips.

    blender -b --python-exit-code 1 --python scripts/blender/render_grip_frames.py -- \
      baked.glb public/models out_dir --clips LongGunAim:m4a1_carbine PistolAim:silver_talon_50ae

The gun is glued to the trigger hand through the contract in `weapon_grips.json` (the long-gun
fist grip, or the pistol's one- or two-handed one), exactly as the runtime glues it, so what
shows here is what the game shows before its few-centimetre support IK. Writes
`<out>/<clip>_<weapon>_<view>_<index>.png` from the front three-quarter, side and top.
"""

import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from combatant_glb_animation import CombatantGlbAnimation
from combatant_grip_pass import LONG, PISTOL, PALM_TRIGGER_M, SPECS, gun_grip, sided
from render_clip_frames import find_action, find_armature, setup_scene
from retarget_soma_combatant import TO_GLTF

# The game's trigger points per gun (combatantWeaponGrip.ts TRIGGER_GRIPS), M4 palm offset added.
TRIGGER_POINTS = {
    "m4a1_carbine": Vector((0.027, -0.05, 0.023)),
    "m590_shotgun": Vector((0, -0.016, 0.068)),
    "msg90_sniper": Vector((0, -0.06, 0.027)),
    "silver_talon_50ae": Vector((0, -0.045, 0.02)),
}


def import_gun(path):
    existing = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=str(path), bone_heuristic="BLENDER")
    imported = set(bpy.context.scene.objects) - existing
    holder = bpy.data.objects.new(path.stem, None)
    bpy.context.collection.objects.link(holder)
    for obj in imported:
        if obj.parent not in imported:
            obj.parent = holder
    return holder


def gltf_hand(arm, rest, name):
    """The hand bone's glTF model-space rotation and position from Blender's evaluated pose."""
    bone = arm.pose.bones[name]
    pose = arm.matrix_world @ bone.matrix
    blender_rest = (arm.matrix_world @ bone.bone.matrix_local).to_quaternion()
    rotation = TO_GLTF @ pose.to_quaternion() @ blender_rest.inverted() @ TO_GLTF.inverted() @ rest[name]
    return rotation, TO_GLTF @ pose.translation


def place_gun(holder, arm, rest, clip, weapon):
    place, side, *_ = SPECS.get(clip, ("shoulder", "RIGHT"))
    kind = gun_grip(place)
    hand_rot, hand_pos = gltf_hand(arm, rest, f"Bone_HAND_{side}")
    if kind == "long":
        gun_rot = hand_rot @ sided(LONG, side)["trigger_hand"].inverted()
    else:
        contract = sided(PISTOL, side)
        gun_rot = hand_rot @ contract["two_hand" if kind == "pistol2" else "one_hand"]
    point = TRIGGER_POINTS[weapon].copy()
    if side == "LEFT":
        point.x = -point.x
    palm = hand_pos + hand_rot @ Vector((0, PALM_TRIGGER_M, 0))
    gun_pos = palm - gun_rot @ point
    to_blender = TO_GLTF.inverted()
    rotation = to_blender @ gun_rot @ TO_GLTF
    holder.matrix_world = Matrix.Translation(to_blender @ gun_pos) @ rotation.to_matrix().to_4x4()


def add_camera(scene, name, yaw_deg, pitch_deg=8, distance=2.0, height=1.25):
    camera = bpy.data.objects.new(name, bpy.data.cameras.new(name))
    scene.collection.objects.link(camera)
    yaw, pitch = math.radians(yaw_deg), math.radians(pitch_deg)
    target = Vector((0, 0, height))
    camera.location = target + Vector((math.sin(yaw) * math.cos(pitch), -math.cos(yaw) * math.cos(pitch),
                                       math.sin(pitch))) * distance
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.lens = 50
    return camera


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("glb", type=Path)
    parser.add_argument("models", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--clips", nargs="+", required=True, help="clip:weapon pairs")
    parser.add_argument("--frames", type=int, default=4)
    parser.add_argument("--height", type=float, default=1.25)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    args.out.mkdir(parents=True, exist_ok=True)
    rest = CombatantGlbAnimation(args.glb.resolve()).model_rest_rotations()
    scene = setup_scene(args.glb.resolve())
    scene.render.resolution_x = 360
    scene.render.resolution_y = 360
    arm = find_armature()
    arm.animation_data_create()
    guns = {}
    cameras = {
        "front": add_camera(scene, "front", 35, height=args.height),
        "side": add_camera(scene, "side", 95, height=args.height),
        "top": add_camera(scene, "top", 20, pitch_deg=60, distance=1.6, height=args.height),
    }
    for pair in args.clips:
        clip, weapon = pair.split(":")
        if weapon not in guns:
            guns[weapon] = import_gun(args.models / f"{weapon}.glb")
        for name, holder in guns.items():
            for obj in [holder, *holder.children_recursive]:
                obj.hide_render = name != weapon
        action = find_action(clip)
        if action is None:
            print(f"missing clip {clip}")
            continue
        arm.animation_data.action = action
        if hasattr(arm.animation_data, "action_slot") and action.slots:
            arm.animation_data.action_slot = action.slots[0]
        start, end = action.frame_range
        for index in range(args.frames):
            frame = start + (end - start) * index / max(1, args.frames - 1)
            scene.frame_set(int(frame), subframe=frame - int(frame))
            place_gun(guns[weapon], arm, rest, clip, weapon)
            for view, camera in cameras.items():
                scene.camera = camera
                scene.render.filepath = str(args.out / f"{clip}_{weapon}_{view}_{index:02d}.png")
                bpy.ops.render.render(write_still=True)
        print(f"rendered {clip} with {weapon}")


if __name__ == "__main__":
    main()
