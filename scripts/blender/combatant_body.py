"""The combatant's body: a heavily muscled man of about eight heads, as continuous skinned surfaces.

Clothing is painted on (see combatant_skin_designs.py), so the same body serves every character.

The shape comes from a `BodyBuild`. The base build is the heavy one from the character sheets; other
builds are exported as morph targets on the same zone meshes (`BUILD_MORPHS`), so the game can mix
a lean, brute or heavy-bellied body per spawn from one GLB. A build only changes radii and sculpt
depth, never ring centres, so every build has the same vertices in the same order.

Joint centres follow GHOUL_BONE_SPECS in build_combatant_rigged.py; the skeleton is unchanged.
Hands, boots and the head are built by that script and overlap the ends of these chains.
"""

import math
from dataclasses import dataclass
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


@dataclass(frozen=True)
class BodyBuild:
    muscle: float = 1.0   # chest, shoulder, neck and arm mass, and how deep the muscles are sculpted
    girth: float = 1.0    # every radius
    belly: float = 0.0    # extra waist and gut, in front
    legs: float = 1.0     # thigh and trouser fullness


BASE_BUILD = BodyBuild()
# Morph target name -> the build it reaches at weight 1. The runtime picks weights per spawn.
BUILD_MORPHS: Dict[str, BodyBuild] = {
    "Build_Lean": BodyBuild(muscle=0.72, girth=0.93, legs=0.90),
    "Build_Brute": BodyBuild(muscle=1.16, girth=1.04, legs=1.04),
    "Build_Belly": BodyBuild(belly=1.0),
}


def _bump(x: float, width: float) -> float:
    return math.exp(-((x / width) ** 2))


def _mass(build: BodyBuild, share: float) -> float:
    """Radius factor for a part that carries `share` of the build's muscle."""
    return build.girth * (1.0 + (build.muscle - 1.0) * share)


# y, half-width, front depth, back depth, centre z, squareness, zone
_TORSO_ROWS = [
    (0.800, 0.064, 0.052, 0.058, -0.004, 2.0, "PELVIS_GROIN"),
    (0.830, 0.132, 0.092, 0.102, -0.004, 2.0, None),
    (0.870, 0.178, 0.112, 0.120, -0.004, 2.1, None),
    (0.915, 0.184, 0.116, 0.124, -0.003, 2.1, None),
    (0.960, 0.177, 0.116, 0.118, -0.001, 2.1, None),
    (1.000, 0.170, 0.106, 0.114, 0.001, 2.1, "TORSO_LOWER_ABDOMEN"),
    (1.050, 0.166, 0.104, 0.110, 0.003, 2.1, None),
    (1.100, 0.169, 0.106, 0.111, 0.004, 2.1, None),
    (1.150, 0.180, 0.114, 0.116, 0.005, 2.15, None),
    (1.195, 0.195, 0.124, 0.122, 0.006, 2.2, "TORSO_UPPER_THORAX"),
    (1.250, 0.212, 0.138, 0.129, 0.008, 2.25, None),
    (1.320, 0.228, 0.152, 0.135, 0.011, 2.3, None),
    (1.390, 0.232, 0.152, 0.137, 0.009, 2.3, None),
    (1.440, 0.226, 0.138, 0.134, 0.004, 2.2, None),
    (1.472, 0.214, 0.120, 0.128, -0.001, 2.1, None),
    (1.494, 0.188, 0.100, 0.118, -0.004, 2.0, None),
    (1.508, 0.142, 0.084, 0.104, -0.006, 2.0, "NECK_CERVICAL"),
    (1.522, 0.112, 0.076, 0.092, -0.008, 2.0, None),
    (1.540, 0.093, 0.070, 0.083, -0.010, 2.0, None),
    (1.575, 0.079, 0.064, 0.073, -0.012, 2.0, None),
    (1.612, 0.062, 0.054, 0.058, -0.014, 2.0, None),
]


def _torso_stations(build: BodyBuild) -> List[Station]:
    stations = []
    for y, rx, rf, rb, cz, e, zone in _TORSO_ROWS:
        chest = 0.0 if y < 1.0 else min(1.0, (y - 1.0) / 0.25)
        k = _mass(build, 0.65 * chest)
        if y < 0.98:
            k = build.girth * build.legs ** 0.3
        if y > 1.56:   # the top of the neck stays tucked inside the head
            k = 1.0 + (k - 1.0) * max(0.0, (1.612 - y) / 0.05)
        gut = build.belly * _bump(y - 1.07, 0.10)
        stations.append(Station((0.0, y, cz), rx * k + 0.022 * gut, rf * k + 0.040 * gut, rb * k, zone, exponent=e))
    return stations


def _torso_sculpt(build: BodyBuild):
    m = build.muscle

    def sculpt(center: np.ndarray, _travel: float, theta: float) -> float:
        y, side = float(center[1]), abs(theta)
        pecs = 0.022 * m * _bump(y - 1.365, 0.06) * _bump(side - 0.45, 0.36)
        sternum = -0.005 * m * _bump(theta, 0.10) * _bump(y - 1.36, 0.08)
        shoulder_blades = 0.010 * m * _bump(y - 1.36, 0.07) * _bump(side - (math.pi - 0.55), 0.35)
        lats = 0.016 * m * _bump(y - 1.28, 0.07) * _bump(side - (math.pi * 0.5 + 0.35), 0.30)
        traps = 0.020 * m * _bump(y - 1.488, 0.035) * _bump(side - (math.pi - 0.7), 0.7)
        spine = -0.007 * m * _bump(side - math.pi, 0.10) * _bump(y - 1.25, 0.20)
        glutes = 0.020 * _bump(y - 0.895, 0.055) * _bump(side - (math.pi - 0.52), 0.36)
        lumbar = -0.006 * _bump(y - 1.06, 0.06) * max(0.0, -math.cos(theta))
        return pecs + sternum + shoulder_blades + lats + traps + spine + glutes + lumbar
    return sculpt


# x, y, z, half-width, front depth, back depth, zone; cut like loose cargo trousers bloused over the boot.
_LEG_ROWS = [
    (0.088, 0.935, -0.004, 0.078, 0.088, 0.096, "THIGH"),
    (0.095, 0.880, -0.004, 0.098, 0.108, 0.110, None),
    (0.098, 0.810, -0.002, 0.101, 0.110, 0.106, None),
    (0.103, 0.720, 0.002, 0.096, 0.104, 0.098, None),
    (0.108, 0.630, 0.006, 0.086, 0.092, 0.086, None),
    (0.112, 0.560, 0.009, 0.079, 0.082, 0.077, None),
    (0.114, 0.535, 0.010, 0.080, 0.084, 0.079, "KNEE"),
    (0.115, 0.490, 0.011, 0.080, 0.084, 0.078, None),
    (0.115, 0.450, 0.012, 0.079, 0.080, 0.078, None),
    (0.115, 0.425, 0.012, 0.078, 0.078, 0.080, "SHIN"),
    (0.115, 0.370, 0.010, 0.078, 0.076, 0.084, None),
    (0.115, 0.310, 0.008, 0.078, 0.076, 0.083, None),
    (0.115, 0.255, 0.004, 0.079, 0.079, 0.080, None),   # trouser bloused over the boot
    (0.115, 0.228, 0.001, 0.074, 0.075, 0.075, None),
    (0.115, 0.205, -0.003, 0.057, 0.058, 0.060, None),
    (0.115, 0.185, -0.006, 0.040, 0.043, 0.045, None),
]


def _leg_stations(sx: float, build: BodyBuild) -> List[Station]:
    k = build.girth * build.legs
    out = []
    for x, y, z, rx, rf, rb, zone in _LEG_ROWS:
        f = 1.0 if y > 0.24 else 1.0 + (k - 1.0) * 0.3   # the cuff stays on the boot
        kk = k if y > 0.24 else f
        out.append(Station((sx * x, y, z), rx * kk, rf * kk, rb * kk, zone))
    return out


def _leg_sculpt(build: BodyBuild):
    m = build.muscle

    def sculpt(center: np.ndarray, _travel: float, theta: float) -> float:
        y = float(center[1])
        front, back = max(0.0, math.cos(theta)), max(0.0, -math.cos(theta))
        outer = max(0.0, math.sin(theta))
        quad = 0.007 * m * _bump(y - 0.72, 0.12) * front
        seat = 0.004 * _bump(y - 0.70, 0.10) * back
        kneecap = 0.005 * _bump(y - 0.485, 0.035) * _bump(theta, 0.55)
        cargo = 0.012 * _bump(y - 0.672, 0.045) * _bump(theta - math.pi / 2, 0.42) * outer   # thigh pocket
        calf = 0.006 * m * _bump(y - 0.34, 0.07) * back ** 2
        return quad + seat + kneecap + cargo + calf
    return sculpt


def _arm_stations(sx: float, build: BodyBuild) -> List[Station]:
    joint = np.array([sx * 0.215, 1.43, 0.0])
    elbow = np.array([sx * 0.325, 1.18, 0.01])
    wrist = np.array([sx * 0.405, 0.95, 0.08])
    arm = (elbow - joint) / np.linalg.norm(elbow - joint)
    forearm = (wrist - elbow) / np.linalg.norm(wrist - elbow)
    out = np.array([-sx * arm[1], sx * arm[0], 0.0])
    out /= np.linalg.norm(out)
    armpit = joint - out * 0.060
    delt, upper_k, lower_k = _mass(build, 0.95), _mass(build, 0.85), _mass(build, 0.6)
    stations: List[Station] = []
    # The deltoid fans around the armpit, from inside the chest to square across the arm.
    last = math.degrees(math.atan2(abs(out[0]), out[1]))
    fan = [(-25.0, 0.032, 0.070), (-12.0, 0.035, 0.076), (2.0, 0.039, 0.080), (15.0, 0.046, 0.088),
           (35.0, 0.056, 0.090), (52.0, 0.068, 0.090), (last, 0.076, 0.088)]
    for index, (angle, reach, depth) in enumerate(fan):
        radial = np.array([sx * math.sin(math.radians(angle)), math.cos(math.radians(angle)), 0.0])
        # The outer deltoid belongs to the upper arm, so it follows the arm as it swings.
        zone = "SHOULDER" if index == 0 else "UPPER_ARM" if index == 3 else None
        stations.append(Station(tuple(armpit + radial * reach), reach * 0.94 * delt, depth * delt, zone=zone, right=tuple(radial)))
    upper = [(0.035, 0.077, 0.087, None), (0.085, 0.079, 0.089, None), (0.140, 0.076, 0.085, None),
             (0.190, 0.065, 0.071, None), (0.235, 0.058, 0.061, "FOREARM")]
    for t, rx, rf, zone in upper:
        stations.append(Station(tuple(joint + arm * t), rx * upper_k, rf * upper_k, zone=zone))
    lower = [(0.0, 0.056, 0.058), (0.040, 0.065, 0.061), (0.085, 0.064, 0.058), (0.140, 0.055, 0.050),
             (0.195, 0.042, 0.041), (0.232, 0.034, 0.034), (0.250, 0.029, 0.031)]
    for u, rx, rf in lower:
        k = 1.0 + (lower_k - 1.0) * (1.0 - u / 0.25) ** 0.5   # the wrist stays inside the hand
        stations.append(Station(tuple(elbow + forearm * u), rx * k, rf * k))
    return stations


def _arm_sculpt(build: BodyBuild):
    m = build.muscle

    def sculpt(center: np.ndarray, _travel: float, theta: float) -> float:
        y = float(center[1])
        front, back = max(0.0, math.cos(theta)), max(0.0, -math.cos(theta))
        outward = max(0.0, math.sin(theta))
        deltoid = 0.012 * m * _bump(y - 1.40, 0.05) * outward
        bicep = 0.014 * m * _bump(y - 1.30, 0.055) * front
        tricep = 0.011 * m * _bump(y - 1.32, 0.06) * back
        forearm = 0.008 * m * _bump(y - 1.12, 0.05) * max(outward, back)
        return deltoid + bicep + tricep + forearm
    return sculpt


# Distance from the start of the arm chain's shoulder fan to the shoulder joint, set by build_body_zones.
ARM_JOINT_MARK = "JOINT"


def _build_chains(build: BodyBuild) -> Dict[str, Tuple[Dict[str, ZoneMesh], ChainMap, list]]:
    """Every chain of one build: name -> (zone meshes, chain map, stations)."""
    chains = {}
    stations = _torso_stations(build)
    torso, torso_map = build_chain(
        stations, sides=12, spacing=0.068, sculpt=_torso_sculpt(build), rect="TORSO",
        blends={"PELVIS_GROIN": None, "TORSO_LOWER_ABDOMEN": (0.0, 0.07),
                "TORSO_UPPER_THORAX": (0.0, 0.07), "NECK_CERVICAL": (0.0, 0.03)},
    )
    chains["TORSO"] = (torso, torso_map, stations)
    for label, sx in (("_RIGHT", -1.0), ("_LEFT", 1.0)):
        stations = _arm_stations(sx, build)
        arm, arm_map = build_chain(
            stations, sides=8, side=sx, spacing=0.062, sculpt=_arm_sculpt(build), rect=f"ARM{label}",
            blends={"SHOULDER": (0.006, 0.03), "UPPER_ARM": (0.0, 0.12), "FOREARM": (0.0, 0.08)},
        )
        chains[f"ARM{label}"] = (arm, arm_map, stations)
        stations = _leg_stations(sx, build)
        leg, leg_map = build_chain(
            stations, sides=10, side=sx, spacing=0.078, sculpt=_leg_sculpt(build), rect=f"LEG{label}",
            blends={"THIGH": (0.0, 0.115), "KNEE": (0.0, 0.07), "SHIN": (0.0, 0.03)},
        )
        chains[f"LEG{label}"] = (leg, leg_map, stations)
    return chains


def _add_morph(obj: bpy.types.Object, name: str, coords: List) -> None:
    if obj.data.shape_keys is None:
        obj.shape_key_add(name="Basis", from_mix=False)
    key = obj.shape_key_add(name=name, from_mix=False)
    key.slider_min, key.slider_max, key.value = 0.0, 1.0, 0.0   # exported as the mesh's default weight
    for point, co in zip(key.data, coords):
        point.co = co


def build_body_zones(
    armature: bpy.types.Object,
    skin: bpy.types.Material,
    collection: bpy.types.Collection,
) -> Tuple[List[bpy.types.Object], Dict[str, ChainMap]]:
    """Builds the sixteen body zone meshes, all on the one skin material, with a morph target per
    entry in BUILD_MORPHS.

    Also returns each chain's map (TORSO, ARM_RIGHT, ARM_LEFT, LEG_RIGHT, LEG_LEFT) for the skin painters.
    """
    base = _build_chains(BASE_BUILD)
    variants = {name: _build_chains(build) for name, build in BUILD_MORPHS.items()}
    objects: List[bpy.types.Object] = []
    chains: Dict[str, ChainMap] = {}

    for chain_name, (zones, chain_map, stations) in base.items():
        suffix = chain_name[chain_name.index("_"):] if "_" in chain_name else ""
        if chain_name.startswith("ARM"):
            # The first station past the fan sits 35 mm down the arm from the shoulder joint.
            joint = np.array([(-0.215 if suffix == "_RIGHT" else 0.215), 1.43, 0.0])
            first = np.array(stations[7].center)
            nearest = int(np.argmin(np.linalg.norm(chain_map.centers - first, axis=1)))
            chain_map.marks[ARM_JOINT_MARK] = float(chain_map.travel[nearest] - np.linalg.norm(first - joint))
        chains[chain_name] = chain_map
        for zone, mesh in zones.items():
            morph_coords = {}
            for morph, variant in variants.items():
                other = variant[chain_name][0][zone].bm
                other.verts.ensure_lookup_table()
                if len(other.verts) != len(mesh.bm.verts):
                    raise RuntimeError(f"{morph} changes the topology of {zone}{suffix}")
                morph_coords[morph] = [v.co.copy() for v in other.verts]
                other.free()
            parent = PARENT[zone]
            parent_suffix = suffix if parent in ("SHOULDER", "UPPER_ARM", "THIGH", "KNEE") else ""
            obj = finalize_zone(
                f"Zone_{zone}{suffix}", mesh, [skin], armature, f"Bone_{zone}{suffix}",
                f"Bone_{parent}{parent_suffix}" if parent else None, collection,
            )
            for morph, coords in morph_coords.items():
                _add_morph(obj, morph, coords)
            objects.append(obj)
    return objects, chains
