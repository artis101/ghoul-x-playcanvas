"""The combatant's body: a broad, sturdy man as continuous skinned surfaces.

Clothing is painted on (see combatant_skin_designs.py), so the same body serves every character.

Joint centres follow GHOUL_BONE_SPECS in build_combatant_rigged.py; the skeleton is unchanged.
Hands, boots and the head are built by that script and overlap the ends of these chains.
"""

import math
from typing import Dict, List, Tuple

import bpy
import numpy as np

from combatant_body_loft import Station, ZoneMesh, build_chain, finalize_zone
from combatant_skin_atlas import ChainMap

PARENT = {
    "PELVIS_GROIN": None,
    "TORSO_LOWER_ABDOMEN": "PELVIS_GROIN",
    "TORSO_UPPER_THORAX": "TORSO_LOWER_ABDOMEN",
    "NECK_CERVICAL": "TORSO_UPPER_THORAX",
    "SHOULDER": "TORSO_UPPER_THORAX",
    "UPPER_ARM": "SHOULDER",
    "FOREARM": "UPPER_ARM",
    "THIGH": "PELVIS_GROIN",
    "KNEE": "THIGH",
    "SHIN": "KNEE",
}


def _bump(x: float, width: float) -> float:
    return math.exp(-((x / width) ** 2))


def _torso_stations() -> List[Station]:
    # y, half-width, front depth, back depth, centre z, squareness, zone
    rows = [
        (0.800, 0.064, 0.052, 0.058, -0.004, 2.0, "PELVIS_GROIN"),
        (0.830, 0.130, 0.090, 0.100, -0.004, 2.0, None),
        (0.870, 0.176, 0.110, 0.118, -0.004, 2.1, None),
        (0.915, 0.182, 0.114, 0.122, -0.003, 2.1, None),
        (0.960, 0.176, 0.114, 0.116, -0.001, 2.1, None),
        (1.000, 0.170, 0.114, 0.112, 0.001, 2.1, "TORSO_LOWER_ABDOMEN"),
        (1.050, 0.165, 0.113, 0.108, 0.003, 2.1, None),
        (1.100, 0.163, 0.112, 0.106, 0.004, 2.1, None),
        (1.150, 0.168, 0.114, 0.108, 0.005, 2.15, None),
        (1.195, 0.179, 0.120, 0.113, 0.006, 2.2, "TORSO_UPPER_THORAX"),
        (1.250, 0.190, 0.128, 0.118, 0.007, 2.25, None),
        (1.320, 0.205, 0.136, 0.124, 0.008, 2.3, None),
        (1.390, 0.208, 0.136, 0.126, 0.006, 2.3, None),
        (1.440, 0.198, 0.124, 0.122, 0.002, 2.2, None),
        (1.472, 0.180, 0.106, 0.114, -0.001, 2.1, None),
        (1.494, 0.140, 0.088, 0.102, -0.003, 2.0, None),
        (1.508, 0.102, 0.074, 0.088, -0.004, 2.0, "NECK_CERVICAL"),
        (1.522, 0.084, 0.067, 0.079, -0.005, 2.0, None),
        (1.540, 0.074, 0.062, 0.074, -0.008, 2.0, None),
        (1.575, 0.067, 0.058, 0.068, -0.011, 2.0, None),
        (1.612, 0.058, 0.052, 0.056, -0.014, 2.0, None),
    ]
    return [Station((0.0, y, cz), rx, rf, rb, zone, exponent=e) for y, rx, rf, rb, cz, e, zone in rows]


def _torso_sculpt(center: np.ndarray, _travel: float, theta: float) -> float:
    y, side = float(center[1]), abs(theta)
    pecs = 0.018 * _bump(y - 1.365, 0.06) * _bump(side - 0.45, 0.36)
    sternum = -0.005 * _bump(theta, 0.10) * _bump(y - 1.36, 0.08)
    shoulder_blades = 0.010 * _bump(y - 1.36, 0.07) * _bump(side - (math.pi - 0.55), 0.35)
    lats = 0.010 * _bump(y - 1.28, 0.07) * _bump(side - (math.pi * 0.5 + 0.35), 0.30)
    traps = 0.014 * _bump(y - 1.485, 0.03) * _bump(side - (math.pi - 0.6), 0.5)
    spine = -0.007 * _bump(side - math.pi, 0.10) * _bump(y - 1.25, 0.20)
    glutes = 0.020 * _bump(y - 0.895, 0.055) * _bump(side - (math.pi - 0.52), 0.36)
    lumbar = -0.006 * _bump(y - 1.06, 0.06) * max(0.0, -math.cos(theta))
    return pecs + sternum + shoulder_blades + lats + traps + spine + glutes + lumbar

def _leg_stations(sx: float) -> List[Station]:
    # x, y, z, half-width, front depth, back depth, zone
    rows = [
        (0.088, 0.935, -0.004, 0.076, 0.086, 0.094, "THIGH"),
        (0.095, 0.880, -0.004, 0.094, 0.104, 0.106, None),
        (0.098, 0.810, -0.002, 0.096, 0.106, 0.102, None),
        (0.103, 0.720, 0.002, 0.090, 0.100, 0.094, None),
        (0.108, 0.630, 0.006, 0.080, 0.088, 0.082, None),
        (0.112, 0.560, 0.009, 0.073, 0.077, 0.073, None),
        (0.114, 0.535, 0.010, 0.070, 0.073, 0.070, "KNEE"),
        (0.115, 0.490, 0.011, 0.069, 0.072, 0.068, None),
        (0.115, 0.450, 0.012, 0.067, 0.068, 0.068, None),
        (0.115, 0.425, 0.012, 0.066, 0.065, 0.071, "SHIN"),
        (0.115, 0.370, 0.010, 0.067, 0.062, 0.078, None),
        (0.115, 0.310, 0.008, 0.066, 0.061, 0.077, None),
        (0.115, 0.250, 0.004, 0.063, 0.061, 0.068, None),
        (0.115, 0.205, 0.000, 0.062, 0.062, 0.064, None),  # trouser bloused over the boot
        (0.115, 0.180, -0.004, 0.054, 0.055, 0.057, None),
        (0.115, 0.160, -0.006, 0.038, 0.041, 0.043, None),
    ]
    return [Station((sx * x, y, z), rx, rf, rb, zone) for x, y, z, rx, rf, rb, zone in rows]


def _leg_sculpt(center: np.ndarray, _travel: float, theta: float) -> float:
    y = float(center[1])
    front, back = max(0.0, math.cos(theta)), max(0.0, -math.cos(theta))
    quad = 0.009 * _bump(y - 0.72, 0.12) * front
    hamstring = 0.004 * _bump(y - 0.70, 0.10) * back
    kneecap = 0.005 * _bump(y - 0.485, 0.035) * _bump(theta, 0.55)
    calf = 0.012 * _bump(y - 0.34, 0.07) * back ** 2
    return quad + hamstring + kneecap + calf


def _arm_stations(sx: float) -> List[Station]:
    joint = np.array([sx * 0.215, 1.43, 0.0])
    elbow = np.array([sx * 0.325, 1.18, 0.01])
    wrist = np.array([sx * 0.405, 0.95, 0.08])
    arm = (elbow - joint) / np.linalg.norm(elbow - joint)
    forearm = (wrist - elbow) / np.linalg.norm(wrist - elbow)
    out = np.array([-sx * arm[1], sx * arm[0], 0.0])
    out /= np.linalg.norm(out)
    armpit = joint - out * 0.060
    stations: List[Station] = []
    # The deltoid fans around the armpit, from inside the chest to square across the arm.
    last = math.degrees(math.atan2(abs(out[0]), out[1]))
    fan = [(-25.0, 0.030, 0.064), (-12.0, 0.032, 0.068), (2.0, 0.035, 0.071), (15.0, 0.039, 0.073),
           (35.0, 0.046, 0.074), (52.0, 0.053, 0.072), (last, 0.058, 0.070)]
    for index, (angle, reach, depth) in enumerate(fan):
        radial = np.array([sx * math.sin(math.radians(angle)), math.cos(math.radians(angle)), 0.0])
        # The outer deltoid belongs to the upper arm, so it follows the arm as it swings.
        zone = "SHOULDER" if index == 0 else "UPPER_ARM" if index == 3 else None
        stations.append(Station(tuple(armpit + radial * reach), reach * 0.94, depth, zone=zone, right=tuple(radial)))
    upper = [(0.035, 0.060, 0.070, None), (0.085, 0.063, 0.071, None), (0.140, 0.061, 0.067, None),
             (0.190, 0.054, 0.058, None), (0.235, 0.049, 0.052, "FOREARM")]
    for t, rx, rf, zone in upper:
        stations.append(Station(tuple(joint + arm * t), rx, rf, zone=zone))
    lower = [(0.0, 0.047, 0.049), (0.040, 0.053, 0.052), (0.085, 0.054, 0.050), (0.140, 0.048, 0.045),
             (0.195, 0.039, 0.039), (0.232, 0.032, 0.033), (0.250, 0.028, 0.030)]
    for u, rx, rf in lower:
        stations.append(Station(tuple(elbow + forearm * u), rx, rf))
    return stations


def _arm_sculpt(center: np.ndarray, _travel: float, theta: float) -> float:
    y = float(center[1])
    front, back = max(0.0, math.cos(theta)), max(0.0, -math.cos(theta))
    outward = max(0.0, math.sin(theta))
    deltoid = 0.008 * _bump(y - 1.40, 0.05) * outward
    bicep = 0.010 * _bump(y - 1.30, 0.055) * front
    tricep = 0.008 * _bump(y - 1.32, 0.06) * back
    forearm = 0.005 * _bump(y - 1.12, 0.05) * max(outward, back)
    return deltoid + bicep + tricep + forearm


# Distance from the start of the arm chain's shoulder fan to the shoulder joint, set by build_body_zones.
ARM_JOINT_MARK = "JOINT"


def build_body_zones(
    armature: bpy.types.Object,
    skin: bpy.types.Material,
    collection: bpy.types.Collection,
) -> Tuple[List[bpy.types.Object], Dict[str, ChainMap]]:
    """Builds the sixteen body zone meshes, all on the one skin material.

    Also returns each chain's map (TORSO, ARM_LEFT, ARM_RIGHT, LEG_LEFT, LEG_RIGHT) for the skin painters.
    """
    objects: List[bpy.types.Object] = []
    chains: Dict[str, ChainMap] = {}

    def finish(zone: str, mesh: ZoneMesh, suffix: str = "") -> None:
        parent = PARENT[zone]
        parent_suffix = suffix if parent in ("SHOULDER", "UPPER_ARM", "THIGH", "KNEE") else ""
        objects.append(finalize_zone(
            f"Zone_{zone}{suffix}", mesh, [skin], armature, f"Bone_{zone}{suffix}",
            f"Bone_{parent}{parent_suffix}" if parent else None, collection,
        ))

    torso, chains["TORSO"] = build_chain(
        _torso_stations(), sides=12, spacing=0.068, sculpt=_torso_sculpt, rect="TORSO",
        blends={"PELVIS_GROIN": None, "TORSO_LOWER_ABDOMEN": (0.0, 0.07),
                "TORSO_UPPER_THORAX": (0.0, 0.07), "NECK_CERVICAL": (0.0, 0.03)},
    )
    for zone, mesh in torso.items():
        finish(zone, mesh)

    for label, sx in (("_LEFT", -1.0), ("_RIGHT", 1.0)):
        stations = _arm_stations(sx)
        arm, arm_map = build_chain(
            stations, sides=8, side=sx, spacing=0.062, sculpt=_arm_sculpt, rect=f"ARM{label}",
            blends={"SHOULDER": (0.006, 0.03), "UPPER_ARM": (0.0, 0.12), "FOREARM": (0.0, 0.08)},
        )
        # The first station past the fan sits 35 mm down the arm from the shoulder joint.
        joint = np.array([sx * 0.215, 1.43, 0.0])
        nearest = int(np.argmin(np.linalg.norm(arm_map.centers - (np.array(stations[7].center)), axis=1)))
        arm_map.marks[ARM_JOINT_MARK] = float(arm_map.travel[nearest] - np.linalg.norm(np.array(stations[7].center) - joint))
        chains[f"ARM{label}"] = arm_map
        for zone, mesh in arm.items():
            finish(zone, mesh, label)

        leg, chains[f"LEG{label}"] = build_chain(
            _leg_stations(sx), sides=10, side=sx, spacing=0.078, sculpt=_leg_sculpt, rect=f"LEG{label}",
            blends={"THIGH": (0.0, 0.115), "KNEE": (0.0, 0.07), "SHIN": (0.0, 0.03)},
        )
        for zone, mesh in leg.items():
            finish(zone, mesh, label)
    return objects, chains
