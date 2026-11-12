"""The combatant's body: a heavy-set soldier in a T-shirt and combat trousers, as continuous skinned surfaces.

Joint centres follow GHOUL_BONE_SPECS in build_combatant_rigged.py; the skeleton is unchanged.
Hands, boots and the head are built by that script and overlap the ends of these chains.
"""

import math
from typing import Callable, Dict, List

import bpy
import numpy as np

from combatant_body_loft import Station, ZoneMesh, build_chain, finalize_zone

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


# The short sleeve ends here on the rest-pose upper arm.
SLEEVE_HEM_Y = 1.325


def _bump(x: float, width: float) -> float:
    return math.exp(-((x / width) ** 2))


def _torso_stations() -> List[Station]:
    # y, half-width, front depth, back depth, centre z, squareness, zone
    rows = [
        (0.800, 0.064, 0.052, 0.058, -0.004, 2.0, "PELVIS_GROIN"),
        (0.830, 0.130, 0.090, 0.100, -0.004, 2.0, None),
        (0.870, 0.178, 0.108, 0.118, -0.004, 2.1, None),
        (0.915, 0.186, 0.112, 0.122, -0.003, 2.1, None),
        (0.960, 0.176, 0.112, 0.116, -0.001, 2.1, None),
        (1.000, 0.166, 0.110, 0.110, 0.001, 2.1, "TORSO_LOWER_ABDOMEN"),
        (1.050, 0.157, 0.108, 0.104, 0.003, 2.1, None),
        (1.100, 0.153, 0.106, 0.102, 0.004, 2.1, None),
        (1.150, 0.160, 0.110, 0.106, 0.005, 2.15, None),
        (1.195, 0.174, 0.118, 0.112, 0.006, 2.2, "TORSO_UPPER_THORAX"),
        (1.250, 0.190, 0.128, 0.118, 0.007, 2.25, None),
        (1.320, 0.205, 0.136, 0.124, 0.008, 2.3, None),
        (1.390, 0.208, 0.136, 0.126, 0.006, 2.3, None),
        (1.440, 0.198, 0.124, 0.122, 0.002, 2.2, None),
        (1.472, 0.180, 0.106, 0.114, -0.001, 2.1, None),
        (1.494, 0.140, 0.088, 0.102, -0.003, 2.0, None),
        (1.508, 0.098, 0.072, 0.086, -0.004, 2.0, "NECK_CERVICAL"),
        (1.522, 0.078, 0.064, 0.076, -0.005, 2.0, None),
        (1.540, 0.068, 0.058, 0.070, -0.008, 2.0, None),
        (1.575, 0.061, 0.054, 0.064, -0.011, 2.0, None),
        (1.612, 0.052, 0.048, 0.052, -0.014, 2.0, None),
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
        (0.112, 0.560, 0.009, 0.070, 0.074, 0.070, None),
        (0.114, 0.535, 0.010, 0.066, 0.068, 0.066, "KNEE"),
        (0.115, 0.490, 0.011, 0.064, 0.067, 0.064, None),
        (0.115, 0.450, 0.012, 0.062, 0.063, 0.064, None),
        (0.115, 0.425, 0.012, 0.061, 0.060, 0.067, "SHIN"),
        (0.115, 0.370, 0.010, 0.064, 0.058, 0.076, None),
        (0.115, 0.310, 0.008, 0.062, 0.056, 0.076, None),
        (0.115, 0.250, 0.004, 0.056, 0.054, 0.064, None),
        (0.115, 0.205, 0.000, 0.056, 0.057, 0.060, None),  # trouser bloused over the boot
        (0.115, 0.180, -0.004, 0.050, 0.052, 0.054, None),
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
    upper = [(0.035, 0.058, 0.068, None), (0.085, 0.060, 0.068, None), (0.140, 0.057, 0.063, None),
             (0.190, 0.050, 0.054, None), (0.235, 0.045, 0.048, "FOREARM")]
    for t, rx, rf, zone in upper:
        stations.append(Station(tuple(joint + arm * t), rx, rf, zone=zone))
    lower = [(0.0, 0.043, 0.045), (0.040, 0.049, 0.048), (0.085, 0.050, 0.046), (0.140, 0.044, 0.041),
             (0.195, 0.035, 0.035), (0.232, 0.0285, 0.030), (0.250, 0.025, 0.027)]
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
    sleeve = 0.004 if y > SLEEVE_HEM_Y else 0.0
    return deltoid + bicep + tricep + forearm + sleeve


def _arm_material(zone: str, center: np.ndarray) -> int:
    """Upper-arm slots are [shirt, skin]: a short sleeve over a bare arm."""
    return 1 if zone == "UPPER_ARM" and center[1] <= SLEEVE_HEM_Y else 0


def build_body_zones(
    armature: bpy.types.Object,
    pal: Dict[str, bpy.types.Material],
    collection: bpy.types.Collection,
    add_patch: Callable,
) -> List[bpy.types.Object]:
    """Builds the sixteen body zone meshes. `add_patch` is add_curved_shell_patch_pc."""
    objects: List[bpy.types.Object] = []

    def finish(zone: str, mesh: ZoneMesh, materials, suffix: str = "") -> None:
        parent = PARENT[zone]
        parent_suffix = suffix if parent in ("SHOULDER", "UPPER_ARM", "THIGH", "KNEE") else ""
        objects.append(finalize_zone(
            f"Zone_{zone}{suffix}", mesh, materials, armature, f"Bone_{zone}{suffix}",
            f"Bone_{parent}{parent_suffix}" if parent else None, collection,
        ))

    torso = build_chain(
        _torso_stations(), sides=18, spacing=0.034, sculpt=_torso_sculpt, uv_tile=0.6,
        blends={"PELVIS_GROIN": None, "TORSO_LOWER_ABDOMEN": (0.0, 0.07),
                "TORSO_UPPER_THORAX": (0.0, 0.07), "NECK_CERVICAL": (0.0, 0.03)},
    )
    full = (-math.pi * 0.99, math.pi * 0.99)
    pelvis = torso["PELVIS_GROIN"].bm
    add_patch(pelvis, 0.962, 1.012, *full, 0.171, 0.116, 0.009, cols=28, rows=2, mat_index=1)  # rigger belt
    add_patch(pelvis, 0.968, 1.008, -0.16, 0.16, 0.180, 0.124, 0.007, cols=4, rows=2, mat_index=2)  # buckle
    add_patch(pelvis, 0.905, 0.985, math.pi - 0.36, math.pi + 0.36, 0.170, 0.126, 0.030, cols=6, rows=3, mat_index=1)
    abdomen = torso["TORSO_LOWER_ABDOMEN"].bm
    for sx in (-1.0, 1.0):
        centre = sx * math.pi * 0.5
        add_patch(abdomen, 1.03, 1.115, centre - 0.28, centre + 0.28, 0.154, 0.106, 0.024, cols=5, rows=3, mat_index=1)
    add_patch(torso["NECK_CERVICAL"].bm, 1.502, 1.530, *full, 0.082, 0.076, 0.010,
              center_xz=(0.0, -0.004), cols=16, rows=2, mat_index=1)  # shirt collar
    finish("PELVIS_GROIN", torso["PELVIS_GROIN"], [pal["bdu_olive"], pal["webbing_tan"], pal["polymer_dark"]])
    finish("TORSO_LOWER_ABDOMEN", torso["TORSO_LOWER_ABDOMEN"], [pal["shirt_charcoal"], pal["webbing_tan"]])
    finish("TORSO_UPPER_THORAX", torso["TORSO_UPPER_THORAX"], [pal["shirt_charcoal"], pal["bdu_olive"]])
    finish("NECK_CERVICAL", torso["NECK_CERVICAL"], [pal["skin_tone"], pal["shirt_charcoal"]])

    for label, sx in (("_LEFT", -1.0), ("_RIGHT", 1.0)):
        arm = build_chain(
            _arm_stations(sx), sides=12, side=sx, spacing=0.032, sculpt=_arm_sculpt, uv_tile=0.3, material=_arm_material,
            blends={"SHOULDER": (0.006, 0.03), "UPPER_ARM": (0.0, 0.12), "FOREARM": (0.0, 0.08)},
        )
        finish("SHOULDER", arm["SHOULDER"], [pal["shirt_charcoal"]], label)
        finish("UPPER_ARM", arm["UPPER_ARM"], [pal["shirt_charcoal"], pal["skin_tone"]], label)
        finish("FOREARM", arm["FOREARM"], [pal["skin_tone"], pal["polymer_dark"]], label)

        leg = build_chain(
            _leg_stations(sx), sides=14, side=sx, spacing=0.038, sculpt=_leg_sculpt, uv_tile=0.45,
            blends={"THIGH": (0.0, 0.115), "KNEE": (0.0, 0.07), "SHIN": (0.0, 0.03)},
        )
        outer = sx * math.pi * 0.5
        add_patch(leg["THIGH"].bm, 0.60, 0.77, outer - 0.42, outer + 0.42, 0.086, 0.094, 0.016,
                  center_xz=(sx * 0.105, 0.004), cols=6, rows=4, mat_index=1)  # cargo pocket
        add_patch(leg["KNEE"].bm, 0.436, 0.522, -0.68, 0.68, 0.065, 0.069, 0.015,
                  center_xz=(sx * 0.115, 0.011), cols=8, rows=4, mat_index=1)  # knee pad
        finish("THIGH", leg["THIGH"], [pal["bdu_olive"], pal["webbing_tan"]], label)
        finish("KNEE", leg["KNEE"], [pal["bdu_olive"], pal["polymer_dark"]], label)
        finish("SHIN", leg["SHIN"], [pal["bdu_olive"]], label)
    return objects
