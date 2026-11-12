"""Transfer a full SOMA pose to the GHOUL combatant's glTF bone hierarchy."""

import math

import bpy
from mathutils import Quaternion, Vector

PELVIS = "Bone_PELVIS_GROIN"
TO_GLTF = Quaternion((1, 0, 0), -math.pi / 2)
MIDLINE = {
    "PELVIS_GROIN": "Hips",
    "TORSO_LOWER_ABDOMEN": "Spine2",
    "TORSO_UPPER_THORAX": "Chest",
    "NECK_CERVICAL": "Neck2",
    "HEAD_CRANIUM": "Head",
    "HEAD_FACE_JAW": "Jaw",
}
LIMBS = {
    "SHOULDER": ("Shoulder", "Arm"),
    "UPPER_ARM": ("Arm", "ForeArm"),
    "FOREARM": ("ForeArm", "Hand"),
    "HAND": ("Hand", "HandMiddle1"),
    "THIGH": ("Leg", "Shin"),
    "KNEE": ("Shin", "Foot"),
    "SHIN": ("Shin", "Foot"),
    "FOOT": ("Foot", "ToeBase"),
}


def mirrored_rotation(rotation):
    return Quaternion((rotation.w, rotation.x, -rotation.y, -rotation.z))


def mirrored_vector(vector):
    return Vector((-vector.x, vector.y, vector.z))


def load_soma(path):
    bpy.ops.import_anim.bvh(
        filepath=str(path.resolve()), axis_forward="-Z", axis_up="Y", global_scale=0.01,
        frame_start=1, rotate_mode="QUATERNION", update_scene_fps=True,
    )
    return bpy.context.object


class CombatantRetarget:
    def __init__(self, glb, source, first_frame, mirror, travel_frame=None):
        self.source = source
        self.axes = TO_GLTF @ source.matrix_world.to_quaternion()
        self.reflect = mirror
        self.offsets = {}
        self.drivers = {}
        self.parents = {}
        self.model_rest = glb.model_rest_rotations()

        def visit(index, parent):
            node = glb.doc["nodes"][index]
            name = node.get("name", "")
            if name.startswith("Bone_"):
                self.parents[name] = parent
                self.offsets[name] = Vector(node.get("translation", (0, 0, 0)))
                self.drivers[name] = self.make_driver(name, mirror)
                parent = name
            for child in node.get("children", []):
                visit(child, parent)

        for root in glb.doc["scenes"][glb.doc.get("scene", 0)]["nodes"]:
            visit(root, None)

        if travel_frame is None:
            self.seek(first_frame)
            forward = self.motion_rotation("Hips") @ Vector((0, 0, 1))
        else:
            # A prone body's hips face the floor, so take the heading from where it travels.
            self.seek(travel_frame)
            destination = self.position("Hips")
            self.seek(first_frame)
            forward = destination - self.position("Hips")
        self.heading = Quaternion((0, 1, 0), -math.atan2(forward.x, forward.z))
        self.origin = self.position("Hips")
        self.height_scale = self.offsets[PELVIS].y / self.rest_position("Hips").y
        initial = self.sample(first_frame, False)
        self.floor_adjustment = -self.lowest_contact(initial)

    def source_vector(self, value):
        value = self.axes @ value
        return mirrored_vector(value) if self.reflect else value

    def rest_position(self, name):
        return self.source_vector(self.source.data.bones[name].head_local)

    def position(self, name):
        return self.source_vector(self.source.pose.bones[name].head)

    def motion_rotation(self, name):
        bone = self.source.pose.bones[name]
        delta = bone.matrix.to_quaternion() @ bone.bone.matrix_local.to_quaternion().inverted()
        rotation = self.axes @ delta @ self.axes.inverted()
        return mirrored_rotation(rotation) if self.reflect else rotation

    def make_driver(self, name, mirror):
        zone = name.removeprefix("Bone_")
        if zone in MIDLINE:
            return MIDLINE[zone], self.model_rest[name]
        limb, side = zone.rsplit("_", 1)
        source_side = side.title()
        # GHOUL's suffixes name model sides. SOMA names anatomical sides.
        if not mirror:
            source_side = "Left" if side == "RIGHT" else "Right"
        joint, tip = (source_side + key for key in LIMBS[limb])
        source_dir = (self.rest_position(tip) - self.rest_position(joint)).normalized()
        rest = self.model_rest[name]
        correction = (rest @ Vector((0, 1, 0))).rotation_difference(source_dir)
        return joint, correction @ rest

    def seek(self, frame):
        integer = math.floor(frame)
        bpy.context.scene.frame_set(integer, subframe=frame - integer)

    def sample(self, frame, traveling, xz_scale=0):
        self.seek(frame)
        world = {}
        local = {}
        for name, (driver, bind) in self.drivers.items():
            rotation = self.heading @ self.motion_rotation(driver) @ bind
            parent = self.parents[name]
            world[name] = rotation
            local[name, "rotation"] = world[parent].inverted() @ rotation if parent else rotation
        displacement = self.heading @ (self.position("Hips") - self.origin) * self.height_scale
        displacement.x *= xz_scale
        displacement.z *= xz_scale
        displacement.y += self.offsets[PELVIS].y
        local[PELVIS, "translation"] = displacement
        if hasattr(self, "floor_adjustment"):
            displacement.y += self.floor_adjustment
            if not traveling:
                displacement.y += max(0, -self.lowest_contact(local))
        return local

    def lowest_contact(self, sample):
        world = {}
        contacts = []
        for name, parent in self.parents.items():
            rotation = sample[name, "rotation"]
            if parent:
                parent_rotation, parent_position = world[parent]
                position = parent_position + parent_rotation @ self.offsets[name]
                rotation = parent_rotation @ rotation
            else:
                position = sample[name, "translation"]
            world[name] = rotation, position
            if name.startswith("Bone_FOOT"):
                toe = position + rotation @ Vector((0, 0.17, 0))
                contacts.append(min(position.y - 0.07, toe.y - 0.025))
            elif name.startswith(("Bone_HAND", "Bone_KNEE")):
                contacts.append(position.y - 0.045)
        return min(contacts)
