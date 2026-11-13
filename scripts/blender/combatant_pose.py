"""Forward and inverse kinematics on the combatant's glTF skeleton, for bake-time pose edits.

A frame is the bake's dict: `(bone, "rotation")` -> local Quaternion and `(PELVIS, "translation")`
-> Vector, all in glTF model space (Y up, the character facing +Z, its left on +X).
"""

import math

from mathutils import Quaternion, Vector

Y_AXIS = Vector((0, 1, 0))


class Skeleton:
    def __init__(self, glb):
        self.parents = {}
        self.offsets = {}
        self.rest = {}

        def visit(index, parent):
            node = glb.doc["nodes"][index]
            name = node.get("name", "")
            if name.startswith("Bone_"):
                self.parents[name] = parent
                self.offsets[name] = Vector(node.get("translation", (0, 0, 0)))
                x, y, z, w = node.get("rotation", (0, 0, 0, 1))
                self.rest[name] = Quaternion((w, x, y, z))
                parent = name
            for child in node.get("children", []):
                visit(child, parent)

        for root in glb.doc["scenes"][glb.doc.get("scene", 0)]["nodes"]:
            visit(root, None)

    def pose(self, frame):
        """World (model-space) rotation and position of every bone."""
        rotations, positions = {}, {}
        for name, parent in self.parents.items():
            local = frame.get((name, "rotation"), self.rest[name])
            if parent is None:
                rotations[name] = local.copy()
                positions[name] = Vector(frame.get((name, "translation"), self.offsets[name]))
            else:
                rotations[name] = rotations[parent] @ local
                positions[name] = positions[parent] + rotations[parent] @ self.offsets[name]
        return Pose(rotations, positions)

    def set_world_rotation(self, frame, pose, name, rotation):
        parent = self.parents[name]
        frame[name, "rotation"] = (pose.rot[parent].inverted() @ rotation) if parent else rotation.copy()


class Pose:
    def __init__(self, rotations, positions):
        self.rot = rotations
        self.pos = positions

    def axis(self, name, local=Y_AXIS):
        return self.rot[name] @ local


def frame_from_forward(forward, up_hint=Y_AXIS):
    """The rotation whose -Z is `forward` and whose +Y leans to `up_hint` (a gun's frame)."""
    z = -forward.normalized()
    x = up_hint.cross(z)
    if x.length < 1e-6:
        x = Vector((1, 0, 0)).cross(z)
    x.normalize()
    y = z.cross(x)
    from mathutils import Matrix
    return Matrix((x, y, z)).transposed().to_quaternion()


def swing_twist(rotation, axis=Y_AXIS):
    """Splits `rotation` into swing @ twist, the twist about `axis` (unit)."""
    vector = Vector((rotation.x, rotation.y, rotation.z))
    projected = axis * vector.dot(axis)
    twist = Quaternion((rotation.w, projected.x, projected.y, projected.z))
    if twist.magnitude < 1e-9:
        return rotation.copy(), Quaternion()
    twist.normalize()
    swing = rotation @ twist.inverted()
    return swing, twist


def smoothstep(edge0, edge1, x):
    if edge1 <= edge0:
        return 1.0 if x >= edge1 else 0.0
    t = min(1.0, max(0.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)


def two_bone_ik(shoulder, elbow, wrist, target, pole):
    """New elbow and wrist positions that put the wrist on `target`, bending toward `pole`.

    Returns (elbow, wrist, shortfall): shortfall is how far the target lies past the arm's reach.
    """
    upper = (elbow - shoulder).length
    lower = (wrist - elbow).length
    to_target = target - shoulder
    distance = to_target.length
    shortfall = max(0.0, distance - (upper + lower))
    reach = min(max(distance, abs(upper - lower) + 1e-4), upper + lower - 1e-4)
    direction = to_target.normalized()
    bend = pole - shoulder
    bend -= direction * bend.dot(direction)
    if bend.length < 1e-6:
        bend = (elbow - shoulder) - direction * (elbow - shoulder).dot(direction)
    bend.normalize()
    cos_a = (upper * upper + reach * reach - lower * lower) / (2 * upper * reach)
    sin_a = math.sqrt(max(0.0, 1 - cos_a * cos_a))
    new_elbow = shoulder + direction * (upper * cos_a) + bend * (upper * sin_a)
    return new_elbow, shoulder + direction * reach, shortfall
