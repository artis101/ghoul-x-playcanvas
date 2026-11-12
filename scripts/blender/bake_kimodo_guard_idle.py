"""Bake SOMA BVH torso motion onto the existing GHOUL guard idle."""

import argparse
import math
import sys
from bisect import bisect_right
from pathlib import Path

import bpy
from mathutils import Matrix, Quaternion, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from combatant_glb_animation import CombatantGlbAnimation, gltf_quaternion

# Collapse the extra SOMA spine and neck joints onto the GHOUL hierarchy.
# These GHOUL joints have model-aligned rest axes in the source GLB.
JOINTS = {
    "Bone_TORSO_LOWER_ABDOMEN": ("Hips", "Spine2"),
    "Bone_TORSO_UPPER_THORAX": ("Spine2", "Chest"),
    "Bone_NECK_CERVICAL": ("Chest", "Neck2"),
    "Bone_HEAD_CRANIUM": ("Neck2", "Head"),
}
BLENDER_TO_GLTF = Quaternion((1, 0, 0), -math.pi / 2)


def load_source(path):
    bpy.ops.import_anim.bvh(
        filepath=str(path), axis_forward="-Z", axis_up="Y", global_scale=0.01,
        frame_start=1, rotate_mode="QUATERNION", update_scene_fps=True,
    )
    return bpy.context.object


def source_rotations(source, frame):
    whole_frame = math.floor(frame)
    bpy.context.scene.frame_set(whole_frame, subframe=frame - whole_frame)
    axes = BLENDER_TO_GLTF @ source.matrix_world.to_quaternion()
    result = {}
    for target, (parent_name, child_name) in JOINTS.items():
        parent, child = (source.pose.bones[name] for name in (parent_name, child_name))
        parent_rest = parent.bone.matrix_local.to_quaternion()
        child_rest = child.bone.matrix_local.to_quaternion()
        rest = parent_rest.inverted() @ child_rest
        pose = parent.matrix.to_quaternion().inverted() @ child.matrix.to_quaternion()
        basis = axes @ parent_rest
        result[target] = basis @ pose @ rest.inverted() @ basis.inverted()
    return result


def looped_motion(source, times):
    scene = bpy.context.scene
    fps = scene.render.fps / scene.render.fps_base
    start, end = source.animation_data.action.frame_range
    duration = times[-1] - times[0]
    crossfade = min(0.45, duration / 4)
    if end - start < (duration + crossfade) * fps:
        raise ValueError("SOMA take must cover the guard idle plus its loop crossfade")
    start += ((end - start) - (duration - crossfade) * fps) / 2
    reference = source_rotations(source, start)
    for time in times:
        seconds = time - times[0]
        sample = source_rotations(source, start + seconds * fps)
        if seconds > duration - crossfade:
            preroll = source_rotations(source, start + (seconds - duration) * fps)
            t = (seconds - duration + crossfade) / crossfade
            weight = t * t * (3 - 2 * t)
            sample = {name: rotation.slerp(preroll[name], weight) for name, rotation in sample.items()}
        yield {name: (rotation @ reference[name].inverted()).normalized()
               for name, rotation in sample.items()}


def close_base_loop(glb, sampler, path, times):
    mode = sampler.get("interpolation", "LINEAR")
    if mode not in {"LINEAR", "STEP"}:
        raise ValueError("Expected a linear or step guard-idle sampler")
    is_rotation = path == "rotation"
    raw = glb.read(sampler["output"], "VEC4" if is_rotation else "VEC3", 4 if is_rotation else 3)
    values = [gltf_quaternion(value) if is_rotation else Vector(value) for value in raw]
    if all(value == values[0] for value in values):
        return None
    keys = [time for time, in glb.read(sampler["input"], "SCALAR", 1)]
    interpolate = Quaternion.slerp if is_rotation else Vector.lerp
    crossfade = min(0.45, (times[-1] - times[0]) / 4)
    fade_start = times[-1] - crossfade
    samples = []
    for time in times:
        right = min(len(keys) - 1, max(1, bisect_right(keys, time)))
        fraction = min(1, max(0, (time - keys[right - 1]) / (keys[right] - keys[right - 1])))
        if mode == "STEP" and fraction < 1:
            fraction = 0
        pose = interpolate(values[right - 1], values[right], fraction)
        fade = max(0, (time - fade_start) / crossfade)
        samples.append(interpolate(pose, values[0], fade * fade * (3 - 2 * fade)))
    return samples


def bake(glb, source):
    for suffix in ("", "_Southpaw"):
        clip = glb.add_variant("UnsuspectingIdle" + suffix, "UnsuspectingIdle_Kimodo" + suffix)
        inputs = {s["input"] for s in clip["samplers"]}
        time_index = max(sorted(inputs), key=lambda i: glb.doc["accessors"][i]["count"])
        times = [time for time, in glb.read(time_index, "SCALAR", 1)]
        motion = list(looped_motion(source, times))
        for name, node, path, sampler in glb.channels(clip):
            base = close_base_loop(glb, sampler, path, times)
            apply_motion = path == "rotation" and name in JOINTS
            if base is None and not apply_motion:
                continue
            if apply_motion:
                if node.get("rotation", [0, 0, 0, 1]) != [0, 0, 0, 1]:
                    raise ValueError(f"{name} no longer uses the expected rest axes")
                if base is None:
                    first = gltf_quaternion(glb.read(sampler["output"], "VEC4", 4)[0])
                    base = [first] * len(times)
                for index, sample in enumerate(motion):
                    delta = sample[name]
                    if suffix:
                        # Reflect the motion about the character's sagittal plane.
                        delta = Quaternion((delta.w, delta.x, -delta.y, -delta.z))
                    base[index] = base[index] @ delta
            sampler["input"] = time_index
            sampler["interpolation"] = "LINEAR"
            if path == "rotation":
                glb.replace_rotations(sampler, base)
            else:
                glb.replace_vectors(sampler, base)


def attach_reference_prop(arm, path, rest):
    existing = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=str(path), bone_heuristic="BLENDER")
    imported = set(bpy.context.scene.objects) - existing
    holder = bpy.data.objects.new("M4A1 grip reference", None)
    bpy.context.collection.objects.link(holder)
    for obj in imported:
        if obj.parent not in imported:
            obj.parent = holder

    def palm(name, offset):
        bone = arm.pose.bones[name]
        pose = arm.matrix_world @ bone.matrix
        blender_rest = (arm.matrix_world @ bone.bone.matrix_local).to_quaternion()
        axis = blender_rest.inverted() @ BLENDER_TO_GLTF.inverted() @ rest[name] @ Vector((0, offset, 0))
        position = pose.translation + pose.to_quaternion() @ axis
        return BLENDER_TO_GLTF @ position

    trigger = palm("Bone_HAND_RIGHT", 0.052)
    support = palm("Bone_HAND_LEFT", 0.05)
    forward = (support - trigger - Vector((0, 0.032, 0))).normalized()
    right = forward.cross(Vector((0, 1, 0))).normalized()
    up = right.cross(forward)
    prop_rotation = Matrix((right, up, -forward)).transposed().to_quaternion()
    prop_position = trigger - prop_rotation @ Vector((0, -0.05, 0.023))
    to_blender = BLENDER_TO_GLTF.inverted()
    rotation = to_blender @ prop_rotation @ BLENDER_TO_GLTF
    transform = Matrix.Translation(to_blender @ prop_position) @ rotation.to_matrix().to_4x4()
    holder.parent = arm
    holder.parent_type = "BONE"
    holder.parent_bone = "Bone_HAND_RIGHT"
    bpy.context.view_layer.update()
    holder.matrix_world = transform


def save_blend(path, output, prop, rest):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(output), bone_heuristic="BLENDER")
    arm = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
    track = arm.animation_data.nla_tracks["UnsuspectingIdle_Kimodo"]
    strip = track.strips[0]
    arm.animation_data.action = strip.action
    arm.animation_data.action_slot = strip.action_slot
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    for obj in bpy.context.scene.objects:
        if obj.name.startswith(("Organ_", "Skelet_", "Gear_")):
            obj.hide_set(True)
    scene = bpy.context.scene
    scene.frame_start, scene.frame_end = map(int, strip.action.frame_range)
    scene.frame_set(scene.frame_start)
    if prop:
        attach_reference_prop(arm, prop.resolve(), rest)
        bpy.ops.object.select_all(action="DESELECT")
        bpy.context.view_layer.objects.active = arm
        arm.select_set(True)
    bpy.ops.wm.save_as_mainfile(filepath=str(path))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bvh", type=Path)
    parser.add_argument("combatant_glb", type=Path)
    parser.add_argument("output_glb", type=Path)
    parser.add_argument("--blend", type=Path, help="Save the baked actions in an editable Blender file")
    parser.add_argument("--m4a1-reference", type=Path, help="M4A1 GLB to attach in the authoring blend")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    if args.m4a1_reference and not args.blend:
        parser.error("--m4a1-reference requires --blend")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    glb = CombatantGlbAnimation(args.combatant_glb)
    bake(glb, load_source(args.bvh.resolve()))
    glb.write(args.output_glb)
    if args.blend:
        save_blend(args.blend.resolve(), args.output_glb.resolve(), args.m4a1_reference,
                   glb.model_rest_rotations())


if __name__ == "__main__":
    main()
