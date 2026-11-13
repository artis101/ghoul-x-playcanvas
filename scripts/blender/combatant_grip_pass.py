"""Bake-time grip pass: puts the hands on the gun in every clip that holds one.

The Kimodo takes were made with empty hands, so their wrists point nowhere in particular and
the support hand floats a forearm's length off the forend. This pass places the gun from the
body, then solves both arms onto it, per frame:

- **Shouldered long gun** (carry, gaits, guard, aim): the stock sits in the right shoulder
  pocket and the barrel runs along the chest's heading (aims: straight down the body's forward,
  level), pitched down for the low-ready carry.
- **Two-handed pistol** (`PistolAim`, the end of `PistolDraw`): isosceles, the gun in front of
  the breastbone at shoulder height, both arms out.
- **One-handed pistol** (the BLAZE, kneeling and seated aims, the stump and seated draws): the
  gun arm out level along its own heading. The game turns the body by the clip's barrel angle
  (`combatantAimFacing.ts`), so the heading is kept, not squared up.
- **Hurt carry**: the trigger hand only, the gun hanging along the forearm.

The trigger hand holds the gun through the same fixed hand-to-gun offset the game glues the gun
with (`weapon_grips.json`), the arms are bent onto their grips by two-bone IK, and half of each
wrist's twist about the forearm goes into the forearm so the wrist does not wring.

Only base clips are processed (right-handed; the stump draws draw with the left hand). Their
mirror images are made at load time (`combatantClipMirror.ts`), so they come out gripped too.
"""

import json
import math
from pathlib import Path

from mathutils import Quaternion, Vector

from combatant_pose import Skeleton, frame_from_forward, smoothstep, swing_twist, two_bone_ik

GRIPS = json.loads((Path(__file__).resolve().parent / "weapon_grips.json").read_text())
PALM_TRIGGER_M = GRIPS["palm_along_hand_m"]["trigger"]
PALM_SUPPORT_M = GRIPS["palm_along_hand_m"]["support"]
LEFT = Vector((1, 0, 0))
UP = Vector((0, 1, 0))
FORWARD = Vector((0, 0, 1))
CHEST = "Bone_TORSO_UPPER_THORAX"


def euler_x(degrees):
    return Quaternion((1, 0, 0), math.radians(degrees))


def mirror_quat(q):
    return Quaternion((q.w, q.x, -q.y, -q.z))


def mirror_vec(v):
    return Vector((-v.x, v.y, v.z))


def pistol_grip_rotation(barrel, up_hint):
    """The pistol's rotation in the hand's frame (sidearmFistGrip.ts buildGrip)."""
    return frame_from_forward(Vector(barrel).normalized(), Vector(up_hint).normalized())


LONG = {
    "trigger_point": Vector(GRIPS["long_gun"]["trigger_point"]),
    "trigger_hand": euler_x(GRIPS["long_gun"]["trigger_hand_euler_x"]),
    "support_point": Vector(GRIPS["long_gun"]["support_point"]),
    "support_hand": euler_x(GRIPS["long_gun"]["support_hand_euler_x"]),
    "butt_point": Vector(GRIPS["long_gun"]["butt_point"]),
}
PISTOL = {
    "trigger_point": Vector(GRIPS["pistol"]["trigger_point"]),
    "one_hand": pistol_grip_rotation(GRIPS["pistol"]["one_hand_barrel"], GRIPS["pistol"]["slide_up_hint"]),
    "two_hand": pistol_grip_rotation(GRIPS["pistol"]["two_hand_barrel"], GRIPS["pistol"]["slide_up_hint"]),
    "support_point": Vector(GRIPS["pistol"]["support_point"]),
}
POCKET = Vector(GRIPS["long_gun"]["shoulder_pocket"])
ISOSCELES = Vector(GRIPS["pistol"]["isosceles_palm"])
ONE_HAND_REACH_M = GRIPS["pistol"]["one_hand_reach_m"]

# clip: (placement, gun hand, support hand on the gun, angle, ramp). The angle is the barrel's
# pitch for the shouldered placements and its blade toward the gun side for "arm_level".
# Placements: "shoulder", "shoulder_aim" (raise from the carry pitch to level, straight ahead),
# "isosceles", "arm_level", "forearm". `ramp` = (start, full) share of the clip over which the
# pass takes over from the take (draws, raises); None = the whole clip.
CARRY_PITCH = GRIPS["long_gun"]["carry_pitch_deg"]
GUARD_PITCH = GRIPS["long_gun"]["guard_pitch_deg"]
HURT_PITCH = GRIPS["long_gun"]["hurt_pitch_deg"]
# One-handed aims: the barrel turned this far from the body's forward toward the gun side. The
# game turns the body back by the same angle (combatantAimFacing.ts AIM_CLIP_BARREL_YAW_DEG).
BLADE = GRIPS["pistol"]["one_hand_blade_deg"]
SPECS = {
    "CombatReadyIdle": ("shoulder", "RIGHT", True, CARRY_PITCH, None),
    "UnsuspectingIdle": ("shoulder", "RIGHT", True, GUARD_PITCH, None),
    "Walk": ("shoulder", "RIGHT", True, CARRY_PITCH, None),
    # The bake makes WalkBackward from the gripped Walk frames; listed for regrip_combatant_glb.py.
    "WalkBackward": ("shoulder", "RIGHT", True, CARRY_PITCH, None),
    "Run": ("shoulder", "RIGHT", True, CARRY_PITCH, None),
    "StrafeLeft": ("shoulder", "RIGHT", True, CARRY_PITCH, None),
    "StrafeRight": ("shoulder", "RIGHT", True, CARRY_PITCH, None),
    "LongGunAim": ("shoulder_aim", "RIGHT", True, CARRY_PITCH, (0.0, 0.55)),
    # Hurt: the free hand clutches the wound, the gun hangs low from the shoulder in one hand.
    "HurtIdle": ("shoulder", "RIGHT", False, HURT_PITCH, None),
    "HurtWalk": ("shoulder", "RIGHT", False, HURT_PITCH, None),
    "PistolAim": ("isosceles", "RIGHT", True, 0, (0.0, 0.55)),
    "PistolDraw": ("isosceles", "RIGHT", True, 0, (0.55, 0.98)),
    "PistolAimOneHand": ("arm_level", "RIGHT", False, BLADE, (0.0, 0.55)),
    "KneelPistolAimOneHand": ("arm_level", "RIGHT", False, BLADE, (0.0, 0.55)),
    "SeatedPistolAim": ("arm_level", "RIGHT", False, 0, None),
    "SeatedPistolDraw": ("arm_level", "RIGHT", False, 0, (0.45, 0.9)),
    "StumpDrawRight": ("arm_level", "LEFT", False, BLADE, (0.45, 0.95)),
    "KneelStumpDrawRight": ("arm_level", "LEFT", False, BLADE, (0.45, 0.95)),
}

FOREARM_TWIST_SHARE = 0.5
CHEST_HEADING_FULL = 0.5
# Torso blades tried, in order, until the support hand reaches the forend in every frame.
BLADE_STEPS_DEG = (0, 6, 12, 18, 24, 30)
# How far the clavicle may swing forward to bring a short support arm onto the forend.
MAX_PROTRACTION_DEG = 25


def flat(vector):
    v = Vector((vector.x, 0, vector.z))
    return v.normalized() if v.length > 1e-6 else FORWARD.copy()


def pitched(heading, degrees):
    p = math.radians(degrees)
    return Vector((heading.x * math.cos(p), math.sin(p), heading.z * math.cos(p))).normalized()


def chest_heading(pose):
    forward = pose.rot[CHEST] @ FORWARD
    length = Vector((forward.x, 0, forward.z)).length
    if length < 1e-4:
        return FORWARD.copy()
    weight = min(1.0, length / CHEST_HEADING_FULL)
    return (flat(forward) * weight + FORWARD * (1 - weight)).normalized()


def gun_grip(place):
    """Which contract a placement holds the gun with: "long", "pistol2" or "pistol1"."""
    if place.startswith("shoulder") or place == "forearm":
        return "long"
    return "pistol2" if place == "isosceles" else "pistol1"


def sided(gun, side):
    """The contract for `side`: the right hand's as authored, the left hand's mirrored."""
    if side == "RIGHT":
        return gun
    return {key: (mirror_quat(value) if isinstance(value, Quaternion) else mirror_vec(value))
            for key, value in gun.items()}


def side_vector(vector, side):
    return vector if side == "RIGHT" else mirror_vec(vector)


class GripPass:
    def __init__(self, glb):
        self.skeleton = Skeleton(glb)
        self.report = {}

    def apply(self, clip, frames):
        spec = SPECS.get(clip)
        if spec is None:
            return frames
        place, _side, support, _pitch, _ramp = spec
        # The support arm is short for a forend this far out, so a shouldered two-hand hold
        # blades the torso (the support shoulder comes forward; the head stays on the target).
        # One blade for the whole clip, the smallest every frame reaches with, so nothing pops.
        steps = BLADE_STEPS_DEG if support and place.startswith("shoulder") else (0,)
        for degrees in steps:
            trial = [dict(frame) for frame in frames]
            stats = {"wrist_deg": 0.0, "trigger_cm": 0.0, "support_cm": 0.0, "blade_deg": degrees}
            for index, frame in enumerate(trial):
                self.grip_frame(frame, spec, index / max(1, len(trial) - 1), degrees, stats)
            if stats["support_cm"] < 0.5:
                break
        self.report[clip] = stats
        return trial

    def placement(self, pose, place, side, pitch, t, ramp, heading_pose=None):
        """The gun's rotation and the trigger palm's goal position and rotation.

        `heading_pose` is the pose the carry heading is read from: the take's own, before the
        torso was bladed, so blading turns the body and not the gun.
        """
        chest = pose.rot[CHEST]
        if place in ("shoulder", "shoulder_aim"):
            heading = chest_heading(heading_pose or pose)
            if place == "shoulder_aim":
                k = smoothstep(ramp[0], ramp[1], t)
                heading = heading.slerp(FORWARD, k) if heading.dot(FORWARD) > -0.99 else FORWARD
                pitch = pitch * (1 - k)
            gun_rot = frame_from_forward(pitched(heading, pitch), UP)
            pocket = pose.pos[f"Bone_UPPER_ARM_{side}"] + chest @ side_vector(POCKET, side)
            gun_pos = pocket - gun_rot @ sided(LONG, side)["butt_point"]
            contract = sided(LONG, side)
            return gun_rot, gun_pos + gun_rot @ contract["trigger_point"], gun_rot @ contract["trigger_hand"]
        contract = sided(PISTOL, side)
        if place == "isosceles":
            gun_rot = frame_from_forward(FORWARD, UP)
            mid = (pose.pos["Bone_UPPER_ARM_RIGHT"] + pose.pos["Bone_UPPER_ARM_LEFT"]) * 0.5
            palm = mid + chest @ ISOSCELES
            return gun_rot, palm, gun_rot @ contract["two_hand"].inverted()
        shoulder = pose.pos[f"Bone_UPPER_ARM_{side}"]
        hand = pose.pos[f"Bone_HAND_{side}"]
        if place == "arm_level":
            # The body's forward (the root's, which the game turns), bladed toward the gun side.
            blade = math.radians(pitch) * (-1 if side == "RIGHT" else 1)
            heading = Vector((math.sin(blade), 0, math.cos(blade)))
            gun_rot = frame_from_forward(heading, UP)
            palm = shoulder + heading * ONE_HAND_REACH_M + Vector((0, -0.03, 0))
            return gun_rot, palm, gun_rot @ contract["one_hand"].inverted()
        # "forearm": the gun hangs along the forearm, wrist as the take has it.
        forearm = (hand - pose.pos[f"Bone_FOREARM_{side}"]).normalized()
        gun_rot = frame_from_forward(forearm, UP)
        palm = hand + pose.axis(f"Bone_HAND_{side}") * PALM_TRIGGER_M
        return gun_rot, palm, gun_rot @ sided(LONG, side)["trigger_hand"]

    def grip_frame(self, frame, spec, t, blade_deg, stats):
        place, side, _support, _pitch, ramp = spec
        weight = 1.0 if ramp is None or place == "shoulder_aim" else smoothstep(ramp[0], ramp[1], t)
        if weight <= 1e-3:
            return
        heading_pose = self.skeleton.pose(frame)
        self.blade_torso(frame, side, blade_deg)
        self.grip_once(frame, spec, t, weight, stats, heading_pose)

    def blade_torso(self, frame, side, degrees):
        if not degrees:
            return
        sk = self.skeleton
        angle = math.radians(degrees) * (-1 if side == "RIGHT" else 1)
        for bone, share in (("Bone_TORSO_LOWER_ABDOMEN", 0.4), (CHEST, 0.6)):
            pose = sk.pose(frame)
            sk.set_world_rotation(frame, pose, bone, Quaternion(UP, angle * share) @ pose.rot[bone])
        pose = sk.pose(frame)
        neck = "Bone_NECK_CERVICAL"
        sk.set_world_rotation(frame, pose, neck, Quaternion(UP, -angle) @ pose.rot[neck])

    def grip_once(self, frame, spec, t, weight, stats, heading_pose):
        place, side, support, pitch, ramp = spec
        sk = self.skeleton
        pose = sk.pose(frame)
        gun_rot, palm_goal, hand_rot = self.placement(pose, place, side, pitch, t, ramp, heading_pose)
        palm_m = PALM_TRIGGER_M
        if place == "forearm":
            self.turn_hand(frame, side, hand_rot, weight, stats)
        else:
            wrist_goal = palm_goal - hand_rot @ Vector((0, palm_m, 0))
            stats["trigger_cm"] = max(stats["trigger_cm"], self.reach(frame, side, wrist_goal, hand_rot, weight, stats))
        if not support:
            return
        other = "LEFT" if side == "RIGHT" else "RIGHT"
        pose = sk.pose(frame)
        palm = pose.pos[f"Bone_HAND_{side}"] + pose.axis(f"Bone_HAND_{side}") * palm_m
        if place.startswith("shoulder"):
            contract = sided(LONG, side)
            gun_pos = palm - gun_rot @ contract["trigger_point"]
            support_rot = gun_rot @ contract["support_hand"]
        else:
            contract = sided(PISTOL, side)
            gun_pos = palm - gun_rot @ contract["trigger_point"]
            # Thumbs forward: the support hand holds the grip as the trigger hand's mirror image.
            support_rot = gun_rot @ mirror_quat(contract["two_hand"]).inverted()
        target_palm = gun_pos + gun_rot @ contract["support_point"]
        wrist_goal = target_palm - support_rot @ Vector((0, PALM_SUPPORT_M, 0))
        self.protract(frame, other, wrist_goal)
        stats["support_cm"] = max(stats["support_cm"], self.reach(frame, other, wrist_goal, support_rot, weight))

    def turn_hand(self, frame, side, hand_rot, weight, stats):
        sk = self.skeleton
        pose = sk.pose(frame)
        hand, forearm = f"Bone_HAND_{side}", f"Bone_FOREARM_{side}"
        goal = pose.rot[hand].slerp(hand_rot, weight)
        local = pose.rot[forearm].inverted() @ goal
        _, twist = swing_twist(local)
        frame[forearm, "rotation"] = frame[forearm, "rotation"] @ Quaternion().slerp(twist, FOREARM_TWIST_SHARE)
        pose = sk.pose(frame)
        sk.set_world_rotation(frame, pose, hand, goal)
        pose = sk.pose(frame)
        stats["wrist_deg"] = max(stats["wrist_deg"], math.degrees((pose.rot[forearm].inverted() @ pose.rot[hand]).angle))

    def protract(self, frame, side, wrist_goal):
        """Swings the clavicle forward (up to a limit) when the arm cannot reach its goal."""
        sk = self.skeleton
        pose = sk.pose(frame)
        clavicle, joint = f"Bone_SHOULDER_{side}", f"Bone_UPPER_ARM_{side}"
        reach = sum((pose.pos[a] - pose.pos[b]).length for a, b in (
            (f"Bone_FOREARM_{side}", joint), (f"Bone_HAND_{side}", f"Bone_FOREARM_{side}")))
        if (wrist_goal - pose.pos[joint]).length <= reach - 0.01:
            return
        base = pose.pos[clavicle]
        swing = (pose.pos[joint] - base).rotation_difference(wrist_goal - base)
        limit = math.radians(MAX_PROTRACTION_DEG)
        if swing.angle > limit:
            swing = Quaternion(swing.axis, limit)
        sk.set_world_rotation(frame, pose, clavicle, swing @ pose.rot[clavicle])

    def reach(self, frame, side, wrist_goal, hand_rot, weight, stats=None):
        """Bends the arm so the wrist lands on the goal and turns the hand; returns cm short."""
        sk = self.skeleton
        pose = sk.pose(frame)
        upper, forearm, hand = (f"Bone_{part}_{side}" for part in ("UPPER_ARM", "FOREARM", "HAND"))
        shoulder, elbow, wrist = pose.pos[upper], pose.pos[forearm], pose.pos[hand]
        goal = wrist.lerp(wrist_goal, weight)
        # The elbow hangs below the arm and a little out to its own side.
        out = pose.rot[CHEST] @ side_vector(-LEFT, side)
        pole = (shoulder + goal) * 0.5 + Vector((0, -0.4, 0)) + out * 0.2
        new_elbow, new_wrist, shortfall = two_bone_ik(shoulder, elbow, wrist, goal, pole)
        upper_rot = (elbow - shoulder).rotation_difference(new_elbow - shoulder) @ pose.rot[upper]
        sk.set_world_rotation(frame, pose, upper, upper_rot)
        pose = sk.pose(frame)
        fore_rot = (pose.pos[hand] - pose.pos[forearm]).rotation_difference(new_wrist - new_elbow) @ pose.rot[forearm]
        sk.set_world_rotation(frame, pose, forearm, fore_rot)
        self.turn_hand(frame, side, hand_rot, weight, stats if stats is not None else {"wrist_deg": 0.0})
        return shortfall * 100
