"""Run Blender with the extracted source .blend, then --python this script -- OUTPUT.glb."""
import sys

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector

# Every grip is described in PlayCanvas weapon space (x right, y up, -z toward the muzzle):
#   knuckles  where the middle of the knuckle line sits
#   fingers   direction from the wrist to the knuckles
#   back      direction the back of the hand faces
#   elbow     direction from the wrist toward the elbow
#   curl      how far the gripping fingers, the index finger and the thumb close (1 = tight fist)
# The shotgun's support arm is mounted to Bone_Pump at runtime.
RIGHT_ELBOW = (0.30, -0.50, 0.80)
LEFT_ELBOW = (-0.36, -0.36, 0.86)


def trigger_hand(knuckles, fingers=(-0.22, -0.10, -1), back=(1, 0.05, -0.25), index=0.12):
    return dict(knuckles=knuckles, fingers=fingers, back=back, elbow=RIGHT_ELBOW,
                curl=dict(grip=1.0, index=index, thumb=0.55))


def forend_hand(knuckles, grip=0.72):
    return dict(knuckles=knuckles, fingers=(0.8, 0.18, -0.6), back=(-0.25, -1, 0.05), elbow=LEFT_ELBOW,
                curl=dict(grip=grip, index=grip, thumb=0.25))


POSES = {
    'm4a1_carbine': {
        'r': trigger_hand((0.034, -0.068, -0.010)),
        # The carbine's support hand takes the vertical foregrip like a second pistol grip.
        'l': dict(knuckles=(-0.032, -0.078, -0.290), fingers=(0.22, -0.05, -1), back=(-1, 0.05, -0.25),
                  elbow=LEFT_ELBOW, curl=dict(grip=1.0, index=1.0, thumb=0.55)),
    },
    'm590_shotgun': {
        'r': trigger_hand((0.034, -0.048, 0.076), fingers=(-0.22, 0.02, -1)),
        'l': forend_hand((0.004, -0.056, -0.290)),
    },
    'silver_talon_50ae': {
        'r': trigger_hand((0.034, -0.062, 0.012)),
        'l': dict(knuckles=(-0.040, -0.082, -0.004), fingers=(0.30, -0.30, -1), back=(-1, -0.15, -0.25),
                  elbow=LEFT_ELBOW, curl=dict(grip=1.0, index=1.0, thumb=0.45)),
    },
    'msg90_sniper': {
        'r': trigger_hand((0.036, -0.074, -0.008)),
        'l': forend_hand((0.004, -0.050, -0.300)),
    },
    'frag_grenade': {
        'r': dict(knuckles=(0.040, -0.014, -0.022), fingers=(-0.25, 0.15, -1), back=(1, -0.10, -0.25),
                  elbow=RIGHT_ELBOW, curl=dict(grip=0.62, index=0.62, thumb=0.50)),
    },
}
# Source rig units to metres: makes the glove 19 cm from wrist to middle fingertip.
SCALE = 0.235
FINGERS = ('index', 'middle', 'ring', 'pinky', 'thumb')
# Radians closed at the knuckle, middle and end joint of a finger in a tight fist.
FIST_JOINT_CURL = (0.95, 1.55, 0.95)
# Source-rig distance from the wrist over which the glove cuff blends into the forearm.
CUFF_BLEND_START = 0.10
CUFF_BLEND_LENGTH = 0.42


def blender_vector(point):
    x, y, z = point
    return Vector((x, -z, y))


def palm_basis(forward, across):
    across = across.normalized()
    forward = (forward - across * forward.dot(across)).normalized()
    return Matrix((forward, across, forward.cross(across))).transposed()


def curl_fingers(bone, inward, curl):
    for finger in FINGERS:
        amount = curl['thumb'] if finger == 'thumb' else curl['index'] if finger == 'index' else curl['grip']
        for joint, fist_curl in enumerate(FIST_JOINT_CURL, start=1):
            digit = bone(f'{finger}_{joint:02}')
            tangent = (digit.tail - digit.head).normalized()
            axis = digit.matrix.to_quaternion().inverted() @ tangent.cross(inward)
            if axis.length < 1e-5:
                continue
            # The little finger closes furthest, so the grip tapers the way a real fist does.
            taper = 1.08 if finger == 'pinky' else 1.0
            digit.rotation_mode = 'QUATERNION'
            digit.rotation_quaternion = Quaternion(axis.normalized(), fist_curl * amount * taper)
    bpy.context.view_layer.update()


def upper_arm_straightener(source, bone, edit, forearm_axis):
    """Returns a function that unbends the elbow, so the arm leaves the view as one straight limb."""
    elbow = bone('lowerarm').head.copy()
    upper_axis = (bone('upperarm').head - elbow).normalized()
    unbend = upper_axis.rotation_difference(forearm_axis)
    upper_groups = {
        group.index for group in source.vertex_groups
        if group.name.split('_')[0] in ('upperarm', 'clavicle')
    }
    deform = edit.verts.layers.deform.active

    def straighten(vertex):
        weight = sum(value for group, value in vertex[deform].items() if group in upper_groups) if deform else 0
        if weight <= 0:
            return vertex.co
        offset = vertex.co - elbow
        along = offset.dot(upper_axis)
        straight = elbow + forearm_axis * along + unbend @ (offset - upper_axis * along)
        return vertex.co.lerp(straight, min(1, weight))

    return straighten


def bake_arm(source, rig, weapon, side, pose):
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
    # The palm faces along +normal on the left hand and -normal on the right.
    palm_sign = 1 if side == 'l' else -1
    inward = basis.col[2] * palm_sign

    target_forward = blender_vector(pose['fingers']).normalized()
    target_palm = -blender_vector(pose['back'])
    target_across = (target_palm * palm_sign).cross(target_forward)
    rotation = palm_basis(target_forward, target_across) @ basis.transposed()
    curl_fingers(bone, inward, pose['curl'])

    center = blender_vector(pose['knuckles'])
    target_wrist = center + rotation @ (wrist - knuckles) * SCALE
    old_arm = bone('lowerarm').head - wrist
    old_axis = old_arm.normalized()
    new_axis = blender_vector(pose['elbow']).normalized()

    evaluated = source.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = bpy.data.meshes.new_from_object(evaluated)
    edit = bmesh.new()
    edit.from_mesh(mesh)
    # The two arms are disconnected islands. Use their undeformed side to split them.
    sign = 1 if side == 'l' else -1
    remove = [vertex for vertex in edit.verts if source.data.vertices[vertex.index].co.x * sign < 0]
    bmesh.ops.delete(edit, geom=remove, context='VERTS')
    follow = (rotation @ old_axis).rotation_difference(new_axis)
    straighten = upper_arm_straightener(source, bone, edit, old_axis)
    for vertex in edit.verts:
        offset = straighten(vertex) - wrist
        along = offset.dot(old_axis)
        # Blend out of the glove cuff into the forearm, which keeps its natural length.
        blend = min(1, max(0, (along - CUFF_BLEND_START) / CUFF_BLEND_LENGTH))
        blend = blend * blend * (3 - 2 * blend)
        cross_section = offset - old_axis * along
        forearm = target_wrist + (new_axis * along + follow @ (rotation @ cross_section)) * SCALE
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
    for weapon, hands in POSES.items():
        for side, pose in hands.items():
            arm = bake_arm(source, rig, weapon, side, pose)
            arm.select_set(True)
    output = sys.argv[sys.argv.index('--') + 1]
    bpy.ops.export_scene.gltf(filepath=output, use_selection=True)


if __name__ == '__main__':
    main()
