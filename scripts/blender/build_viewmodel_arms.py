"""Run Blender with the extracted source .blend, then --python this script -- OUTPUT.glb."""
import sys

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector

# Glove knuckle line, finger direction and forearm endpoint in PlayCanvas model space.
# The shotgun's support arm is mounted to Bone_Pump at runtime.
POSES = {
    'm4a1_carbine': [
        ('r', (0.032, -0.061, 0.015), (0, 0.34, -1), (0.13, -0.20, 0.30)),
        ('l', (-0.032, -0.066, -0.283), (0, 0.22, -1), (-0.14, -0.22, 0.05)),
    ],
    'm590_shotgun': [
        ('r', (0.032, -0.024, 0.059), (0, 0.28, -1), (0.13, -0.17, 0.34)),
        ('l', (-0.023, -0.044, -0.343), (1, 0.28, -0.32), (-0.14, -0.20, 0.00)),
    ],
    'silver_talon_50ae': [
        ('r', (0.035, -0.058, 0.009), (0, 0.34, -1), (0.13, -0.20, 0.29)),
        ('l', (-0.038, -0.075, -0.012), (0, 0.38, -1), (-0.15, -0.22, 0.24)),
    ],
    'msg90_sniper': [
        ('r', (0.035, -0.069, 0.016), (0, 0.28, -1), (0.14, -0.21, 0.30)),
        ('l', (-0.022, -0.032, -0.300), (1, 0.28, -0.32), (-0.15, -0.19, 0.04)),
    ],
    'frag_grenade': [
        ('r', (0.043, -0.010, -0.012), (-0.12, 0.20, -1), (0.13, -0.18, 0.28)),
    ],
}
SCALE = 0.155
FINGERS = ('index', 'middle', 'ring', 'pinky', 'thumb')


def blender_point(point):
    x, y, z = point
    return Vector((x, -z, y))


def palm_basis(forward, across):
    across = across.normalized()
    forward = (forward - across * forward.dot(across)).normalized()
    return Matrix((forward, across, forward.cross(across))).transposed()


def curl_fingers(bone, inward, extended_index, loose_support):
    for finger in FINGERS:
        for joint, curl in enumerate((0.64, 0.84, 0.48), start=1):
            digit = bone(f'{finger}_{joint:02}')
            tangent = (digit.tail - digit.head).normalized()
            axis = digit.matrix.to_quaternion().inverted() @ tangent.cross(inward)
            if axis.length < 1e-5:
                continue
            if finger == 'thumb':
                curl *= 0.30
            elif finger == 'index' and extended_index:
                curl = -0.22
            elif loose_support:
                curl *= 0.65
            digit.rotation_mode = 'QUATERNION'
            digit.rotation_quaternion = Quaternion(axis.normalized(), curl)
    bpy.context.view_layer.update()


def bake_arm(source, rig, weapon, side, center, direction, elbow_end):
    def bone(name):
        return rig.pose.bones[f'{name}_{side}']

    for digit in rig.pose.bones:
        if digit.name.endswith(f'_{side}') and digit.name.split('_')[0] in FINGERS:
            digit.matrix_basis.identity()
    bpy.context.view_layer.update()
    wrist = bone('hand').head.copy()
    knuckles = (bone('index_01').head + bone('pinky_01').head) / 2
    across = bone('index_01').head - bone('pinky_01').head
    basis = palm_basis(knuckles - wrist, across)
    horizontal = side == 'l' and weapon in ('m590_shotgun', 'msg90_sniper')
    target_across = (0, 0, -1) if horizontal else (0, 1, direction[1])
    target_basis = palm_basis(blender_point(direction), blender_point(target_across))
    rotation = target_basis @ basis.transposed()
    inward = basis.col[2] * (1 if side == 'l' else -1)
    curl_fingers(bone, inward, side == 'r' and weapon != 'frag_grenade', horizontal)

    center = blender_point(center)
    target_wrist = center + rotation @ (wrist - knuckles) * SCALE
    old_arm = bone('lowerarm').head - wrist
    old_axis = old_arm.normalized()
    new_arm = blender_point(elbow_end) - target_wrist

    evaluated = source.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = bpy.data.meshes.new_from_object(evaluated)
    edit = bmesh.new()
    edit.from_mesh(mesh)
    # The two arms are disconnected islands. Use their undeformed side to split them.
    sign = 1 if side == 'l' else -1
    remove = [vertex for vertex in edit.verts if source.data.vertices[vertex.index].co.x * sign < 0]
    bmesh.ops.delete(edit, geom=remove, context='VERTS')
    follow = (rotation @ old_axis).rotation_difference(new_arm.normalized())
    for vertex in edit.verts:
        offset = vertex.co - wrist
        along = offset.dot(old_axis)
        # Blend out of the glove cuff into the repositioned forearm.
        blend = min(1, max(0, (along - 0.12) / 0.50))
        blend = blend * blend * (3 - 2 * blend)
        cross_section = offset - old_axis * along
        forearm = target_wrist + new_arm * (along / old_arm.length) + follow @ (rotation @ cross_section) * SCALE
        hand = center + rotation @ (vertex.co - knuckles) * SCALE
        vertex.co = hand.lerp(forearm, blend)
    deform = edit.verts.layers.deform.active
    if deform:
        edit.verts.layers.deform.remove(deform)
    edit.to_mesh(mesh)
    edit.free()
    mesh.validate()
    mesh.update()
    obj = bpy.data.objects.new(f'{weapon}_{side}', mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def prepare_textures(material, shader):
    color = shader.inputs['Base Color'].links[0].from_node.image
    for node in material.node_tree.nodes:
        if node.type != 'TEX_IMAGE':
            continue
        image = node.image
        image.scale(512, 512)
        if image == color:
            pixels = list(image.pixels[:])
            for index in range(0, len(pixels), 4):
                red, green, blue = pixels[index:index + 3]
                # Tone down exposed skin under the arena lighting. The charcoal glove is neutral.
                weight = min(1, max(0, (red - blue - 0.05) / 0.08))
                pixels[index] = red * (1 - weight * 0.17)
                pixels[index + 1] = green * (1 - weight * 0.22)
                pixels[index + 2] = blue * (1 - weight * 0.24)
            image.pixels.foreach_set(pixels)
        image.pack()


def main():
    source = bpy.data.objects['Manos:Body']
    rig = bpy.data.objects['Manos']
    material = source.data.materials[0]
    material.name = 'Gloves and forearms'
    shader = next(node for node in material.node_tree.nodes if node.type == 'BSDF_PRINCIPLED')
    shader.inputs['Roughness'].default_value = 0.72
    shader.inputs['Metallic'].default_value = 0
    prepare_textures(material, shader)

    bpy.ops.object.select_all(action='DESELECT')
    for weapon, poses in POSES.items():
        for side, center, direction, elbow in poses:
            arm = bake_arm(source, rig, weapon, side, center, direction, elbow)
            arm.select_set(True)
    output = sys.argv[sys.argv.index('--') + 1]
    bpy.ops.export_scene.gltf(filepath=output, use_selection=True)


if __name__ == '__main__':
    main()
