"""Write selected Blender combatant bone rotations back into the game GLB."""

import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Quaternion

sys.path.insert(0, str(Path(__file__).resolve().parent))
from combatant_glb_animation import CombatantGlbAnimation

GLTF_TO_BLENDER = Quaternion((1, 0, 0), math.pi / 2)


def export_rotations(glb, arm, clip_name, bones):
    scene = bpy.context.scene
    fps = scene.render.fps / scene.render.fps_base
    animation = arm.animation_data
    track = animation.nla_tracks.get(clip_name)
    if not track or len(track.strips) != 1:
        raise ValueError(f"Expected one NLA strip for {clip_name}")

    for other in animation.nla_tracks:
        other.mute = True
    strip = track.strips[0]
    animation.action = strip.action
    animation.action_slot = strip.action_slot
    clip = glb.clip(clip_name)
    channels = {name: sampler for name, _, sampler in glb.rotation_channels(clip)}
    inputs = [glb.read(index, "SCALAR", 1) for index in {s["input"] for s in clip["samplers"]}]
    start = min(times[0][0] for times in inputs)
    end = max(times[-1][0] for times in inputs)
    frames = range(round(start * fps), round(end * fps) + 1)
    times = [frame / fps for frame in frames]
    rest = glb.model_rest_rotations()

    for name in bones:
        bone = arm.pose.bones[name]
        sampler = channels[name]
        # The glTF importer may rotate a bone's local axes to point at its children.
        blender_rest = (arm.matrix_world @ bone.bone.matrix_local).to_quaternion()
        to_bone_axes = blender_rest.inverted() @ GLTF_TO_BLENDER @ rest[name]
        local_rest = glb.local_rest(name)
        rotations = []
        for frame in frames:
            scene.frame_set(frame)
            delta = bone.matrix_basis.to_quaternion()
            rotations.append(local_rest @ to_bone_axes.inverted() @ delta @ to_bone_axes)
        glb.replace_times(sampler, times)
        sampler["interpolation"] = "LINEAR"
        glb.replace_rotations(sampler, rotations)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("game_glb", type=Path)
    parser.add_argument("output_glb", type=Path)
    parser.add_argument("--clip", required=True, help="Exact Blender action name")
    parser.add_argument("--bones", nargs="+", required=True, help="Exact Blender bone names")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    arm = bpy.data.objects.get("GhoulArmature")
    if arm is None or arm.type != "ARMATURE":
        raise ValueError("Open the combatant authoring blend before running this script")
    glb = CombatantGlbAnimation(args.game_glb)
    export_rotations(glb, arm, args.clip, args.bones)
    glb.write(args.output_glb)


if __name__ == "__main__":
    main()
