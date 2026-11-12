"""Create the editable combatant scene with an optional held-prop reference."""

import bpy
from mathutils import Matrix, Vector

from retarget_soma_combatant import TO_GLTF as BLENDER_TO_GLTF


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
    hand_axis = (trigger - palm("Bone_HAND_RIGHT", 0)) / 0.052
    hand_axis.y *= 0.35
    forward = (hand_axis * 0.32 + Vector((0, 0, 0.68))).normalized()
    span = support - trigger - Vector((0, 0.032, 0))
    if span.length > 0.08 and span.z > 0.07:
        forward = span.normalized()
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
    arm = bpy.data.objects["GhoulArmature"]
    strip = arm.animation_data.nla_tracks["CombatReadyIdle"].strips[0]
    arm.animation_data.action = strip.action
    arm.animation_data.action_slot = strip.action_slot
    for obj in bpy.context.scene.objects:
        obj.hide_set(obj.name.startswith(("Organ_", "Skelet_", "Gear_")))
    scene = bpy.context.scene
    scene.frame_start, scene.frame_end = map(round, strip.action.frame_range)
    scene.frame_set(scene.frame_start)
    if prop:
        attach_reference_prop(arm, prop.resolve(), rest)
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.wm.save_as_mainfile(filepath=str(path))
