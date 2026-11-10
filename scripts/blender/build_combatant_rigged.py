#!/usr/bin/env python3
"""
Procedural Blender 5.2.1 LTS Pipeline — GHOUL-X Rigged & Animated Tactical Combatant.

Generates:
  - public/models/ghoul_combatant.glb
  - public/models/blend_sources/ghoul_combatant.blend

Coordinate Convention:
  - PlayCanvas / glTF 2.0 (+Y Up):
      Feet grounded at y = 0.00m, Crown at y = 1.80m, Character facing +Z (+X = anatomical left/right per GHOUL_ZONE_HIERARCHY: -X = Left, +X = Right).
  - Blender 5.2 (+Z Up, -Y Forward):
      pc_to_bl(x, y, z) = Vector((x, -z, y))
      When exported with `export_yup=True`, Blender (x, -z, y) maps 1:1 to glTF (x, y, z).

Submeshes (31 total, all manifold, UV-unwrapped, PBR-materialized, and skinned to `GhoulArmature`):
  - 22 GHOUL Gore Zone Submeshes (`Zone_PELVIS_GROIN` .. `Zone_FOOT_RIGHT`)
  - 2 Toggleable Ballistic Armor Submeshes (`Gear_ESAPI_PlateCarrier`, `Gear_PASGT_Helmet`)
  - 7 Internal X-Ray Anatomy Submeshes (`Organ_Brain`, `Organ_Heart`, `Organ_Lungs`, `Organ_Liver`,
    `Skelet_Skull`, `Skelet_RibcageSpine`, `Skelet_Pelvis`)

Animations (5 Baked NLA Tracks @ 24 FPS):
  1. CombatReadyIdle
  2. UnsuspectingIdle
  3. HitStaggerChest
  4. DiaphragmDropKneel
  5. LegCollapseCrawl
"""

import math
import os
from typing import Dict, List, Optional, Sequence, Tuple

import bmesh
import bpy
from mathutils import Euler, Matrix, Quaternion, Vector


REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_GLB = os.path.join(REPO_ROOT, "public", "models", "ghoul_combatant.glb")
OUT_BLEND = os.path.join(REPO_ROOT, "public", "models", "blend_sources", "ghoul_combatant.blend")


def pc_to_bl(x: float, y: float, z: float) -> Vector:
    """Convert PlayCanvas/glTF (+X, +Y up, +Z forward) to Blender (+X, -Y forward, +Z up)."""
    return Vector((x, -z, y))


def pc_vec_to_bl(v: Tuple[float, float, float]) -> Vector:
    return Vector((v[0], -v[2], v[1]))


# ---------------------------------------------------------------------------
# PBR Material Factory (Blender 5.2 Principled BSDF)
# ---------------------------------------------------------------------------

def make_pbr_material(
    name: str,
    base_color: Tuple[float, float, float, float],
    roughness: float = 0.65,
    metallic: float = 0.0,
    emission_color: Optional[Tuple[float, float, float, float]] = None,
    emission_strength: float = 0.0,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name=name)
    if mat.node_tree is None:
        mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    if bsdf is None:
        bsdf = nodes.new(type="ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = base_color
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission_color is not None and "Emission Color" in bsdf.inputs:
        bsdf.inputs["Emission Color"].default_value = emission_color
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


def build_palette() -> Dict[str, bpy.types.Material]:
    return {
        "bdu_olive": make_pbr_material("Mat_BDU_OliveDrab", (0.19, 0.23, 0.16, 1.0), roughness=0.82),
        "shirt_charcoal": make_pbr_material("Mat_CombatShirt_Charcoal", (0.13, 0.15, 0.17, 1.0), roughness=0.78),
        "webbing_tan": make_pbr_material("Mat_TacticalWebbing_Coyote", (0.34, 0.28, 0.19, 1.0), roughness=0.76),
        "boot_leather": make_pbr_material("Mat_CombatBoot_Leather", (0.07, 0.07, 0.08, 1.0), roughness=0.58),
        "polymer_dark": make_pbr_material("Mat_Polymer_ArmorPad", (0.09, 0.10, 0.11, 1.0), roughness=0.42, metallic=0.12),
        "skin_tone": make_pbr_material("Mat_Skin_Tactical", (0.64, 0.47, 0.37, 1.0), roughness=0.62),
        "balaclava": make_pbr_material("Mat_HeadCap_Slate", (0.11, 0.12, 0.13, 1.0), roughness=0.84),
        "visor_glass": make_pbr_material("Mat_EyePro_Visor", (0.04, 0.06, 0.09, 1.0), roughness=0.14, metallic=0.65),
        "glove_leather": make_pbr_material("Mat_Glove_NomexLeather", (0.10, 0.11, 0.10, 1.0), roughness=0.66),
        "esapi_plate": make_pbr_material("Mat_ESAPI_PlateCarrier", (0.24, 0.25, 0.20, 1.0), roughness=0.68, metallic=0.08),
        "helmet_kevlar": make_pbr_material("Mat_PASGT_Kevlar", (0.17, 0.21, 0.16, 1.0), roughness=0.64, metallic=0.05),
        "organ_brain": make_pbr_material(
            "Mat_Organ_Brain", (0.82, 0.52, 0.56, 1.0), roughness=0.36,
            emission_color=(0.35, 0.10, 0.14, 1.0), emission_strength=0.18
        ),
        "organ_heart": make_pbr_material(
            "Mat_Organ_Heart", (0.72, 0.07, 0.09, 1.0), roughness=0.30,
            emission_color=(0.45, 0.03, 0.04, 1.0), emission_strength=0.25
        ),
        "organ_lungs": make_pbr_material(
            "Mat_Organ_Lungs", (0.76, 0.34, 0.38, 1.0), roughness=0.45,
            emission_color=(0.25, 0.07, 0.09, 1.0), emission_strength=0.15
        ),
        "organ_liver": make_pbr_material(
            "Mat_Organ_Liver", (0.42, 0.10, 0.08, 1.0), roughness=0.34,
            emission_color=(0.22, 0.04, 0.03, 1.0), emission_strength=0.15
        ),
        "bone_cortical": make_pbr_material(
            "Mat_Bone_Cortical", (0.88, 0.85, 0.76, 1.0), roughness=0.48,
            emission_color=(0.20, 0.19, 0.16, 1.0), emission_strength=0.10
        ),
    }


# ---------------------------------------------------------------------------
# Procedural BMesh Anatomical Sculpting Helpers
# ---------------------------------------------------------------------------

def assign_box_uvs(bm: bmesh.types.BMesh, scale: float = 2.0) -> None:
    uv_layer = bm.loops.layers.uv.verify()
    for face in bm.faces:
        n = face.normal
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        for loop in face.loops:
            co = loop.vert.co
            if az >= ax and az >= ay:
                u, v = co.x * scale + 0.5, co.y * scale + 0.5
            elif ax >= ay and ax >= az:
                u, v = co.y * scale + 0.5, co.z * scale + 0.5
            else:
                u, v = co.x * scale + 0.5, co.z * scale + 0.5
            loop[uv_layer].uv = (u, v)


def add_lofted_tube_along_segment(
    bm: bmesh.types.BMesh,
    p_start_pc: Tuple[float, float, float],
    p_end_pc: Tuple[float, float, float],
    stations: Sequence[Tuple[float, float, float, float, float]],
    sides: int = 12,
    mat_index: int = 0,
    cap_ends: bool = True,
    end_dome_scale: float = 0.32,
) -> List[bmesh.types.BMVert]:
    """
    Loft a sculpted anatomical segment from `p_start_pc` to `p_end_pc` in PlayCanvas space.
    Each station tuple is `(t, radius_right, radius_forward, offset_right, offset_forward)`.
    Builds closed manifold geometry with spherical joint domes so animated joints never show gaps.
    """
    p0 = pc_vec_to_bl(p_start_pc)
    p1 = pc_vec_to_bl(p_end_pc)
    axis = p1 - p0
    seg_len = max(1e-4, axis.length)
    tangent = axis / seg_len

    # Forward reference in Blender is -Y (glTF +Z)
    fwd_ref = Vector((0.0, -1.0, 0.0))
    if abs(tangent.dot(fwd_ref)) > 0.94:
        fwd_ref = Vector((0.0, 0.0, 1.0))

    right = tangent.cross(fwd_ref).normalized()
    # Ensure consistent orientation: tangent x fwd_ref may point -X or +X depending on up/down segment
    # Re-derive orthonormal basis so `basis_right` aligns with +X when vertical, `basis_fwd` aligns with -Y (glTF +Z)
    basis_right = fwd_ref.cross(tangent).normalized()
    if basis_right.length < 1e-4:
        basis_right = right
    basis_fwd = tangent.cross(basis_right).normalized()
    # In Blender: for tangent=(0,0,1) [up] and fwd_ref=(0,-1,0) [front]:
    # fwd_ref.cross(tangent) = (0,-1,0) x (0,0,1) = (-1, 0, 0). Flip so +offset_right is +X!
    if basis_right.x < 0 and abs(tangent.x) < 0.7:
        basis_right = -basis_right
    basis_fwd = tangent.cross(basis_right).normalized()
    if basis_fwd.y > 0 and abs(tangent.y) < 0.7:
        basis_fwd = -basis_fwd

    rings: List[List[bmesh.types.BMVert]] = []
    created_verts: List[bmesh.types.BMVert] = []

    for t, rr, rf, off_r, off_f in stations:
        center = p0 + axis * t + basis_right * off_r + basis_fwd * off_f
        ring_verts: List[bmesh.types.BMVert] = []
        for s in range(sides):
            theta = (2.0 * math.pi * s) / sides
            ct = math.cos(theta)
            st = math.sin(theta)
            pt = center + basis_right * (ct * rr) + basis_fwd * (st * rf)
            v = bm.verts.new(pt)
            ring_verts.append(v)
            created_verts.append(v)
        rings.append(ring_verts)

    for r_idx in range(len(rings) - 1):
        r0 = rings[r_idx]
        r1 = rings[r_idx + 1]
        for s in range(sides):
            sn = (s + 1) % sides
            f = bm.faces.new((r0[s], r0[sn], r1[sn], r1[s]))
            f.material_index = mat_index
            f.smooth = True

    if cap_ends and len(rings) >= 2:
        t0, rr0, rf0, or0, of0 = stations[0]
        c_start = (
            p0
            + axis * t0
            + basis_right * or0
            + basis_fwd * of0
            - tangent * (0.5 * (rr0 + rf0) * end_dome_scale)
        )
        v_cap0 = bm.verts.new(c_start)
        created_verts.append(v_cap0)
        for s in range(sides):
            sn = (s + 1) % sides
            f = bm.faces.new((v_cap0, rings[0][sn], rings[0][s]))
            f.material_index = mat_index
            f.smooth = True

        tn, rrn, rfn, orn, ofn = stations[-1]
        c_end = (
            p0
            + axis * tn
            + basis_right * orn
            + basis_fwd * ofn
            + tangent * (0.5 * (rrn + rfn) * end_dome_scale)
        )
        v_cap1 = bm.verts.new(c_end)
        created_verts.append(v_cap1)
        for s in range(sides):
            sn = (s + 1) % sides
            f = bm.faces.new((v_cap1, rings[-1][s], rings[-1][sn]))
            f.material_index = mat_index
            f.smooth = True

    return created_verts


def add_beveled_box_pc(
    bm: bmesh.types.BMesh,
    center_pc: Tuple[float, float, float],
    half_extents_pc: Tuple[float, float, float],
    bevel_width: float = 0.008,
    mat_index: int = 0,
    euler_deg_pc: Tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> List[bmesh.types.BMVert]:
    hx, hy, hz = half_extents_pc
    ret = bmesh.ops.create_cube(bm, size=2.0)
    verts: List[bmesh.types.BMVert] = ret["verts"]

    rot = Euler(
        (
            math.radians(euler_deg_pc[0]),
            math.radians(-euler_deg_pc[2]),
            math.radians(euler_deg_pc[1]),
        ),
        "XYZ",
    ).to_matrix()

    c_bl = pc_vec_to_bl(center_pc)
    for v in verts:
        # Scale in Blender axes: x = hx, y = hz, z = hy
        local = Vector((v.co.x * hx, v.co.y * hz, v.co.z * hy))
        v.co = c_bl + (rot @ local)

    vert_set = set(verts)
    box_edges = [e for e in bm.edges if e.verts[0] in vert_set and e.verts[1] in vert_set]
    box_faces = [f for f in bm.faces if all(v in vert_set for v in f.verts)]
    for f in box_faces:
        f.material_index = mat_index
        f.smooth = False

    if bevel_width > 1e-4 and box_edges:
        bev = bmesh.ops.bevel(
            bm,
            geom=box_edges,
            offset=bevel_width,
            offset_type="OFFSET",
            segments=2,
            profile=0.5,
            affect="EDGES",
        )
        for f in bev.get("faces", []):
            f.material_index = mat_index
            f.smooth = True
        verts = list(vert_set.union(bev.get("verts", [])))

    return verts


def finalize_skinned_mesh_object(
    name: str,
    bm: bmesh.types.BMesh,
    materials: Sequence[bpy.types.Material],
    armature_obj: bpy.types.Object,
    bone_weights: Sequence[Tuple[str, float]],
    collection: bpy.types.Collection,
) -> bpy.types.Object:
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    assign_box_uvs(bm, scale=2.2)

    mesh = bpy.data.meshes.new(name=name)
    bm.to_mesh(mesh)
    bm.free()

    for mat in materials:
        mesh.materials.append(mat)

    obj = bpy.data.objects.new(name=name, object_data=mesh)
    collection.objects.link(obj)
    obj.parent = armature_obj

    mod = obj.modifiers.new(name="Armature", type="ARMATURE")
    mod.object = armature_obj

    all_v_indices = list(range(len(mesh.vertices)))
    total_w = sum(w for _, w in bone_weights) or 1.0
    for bone_name, weight in bone_weights:
        vg = obj.vertex_groups.new(name=bone_name)
        vg.add(all_v_indices, weight / total_w, "REPLACE")

    return obj


# ---------------------------------------------------------------------------
# 22-Bone GHOUL Armature Definition (Tactical Rest Pose, 1.80m Tall)
# ---------------------------------------------------------------------------

# Each entry: (bone_name, parent_bone_or_None, head_pc, tail_pc)
GHOUL_BONE_SPECS: List[Tuple[str, Optional[str], Tuple[float, float, float], Tuple[float, float, float]]] = [
    ("Bone_PELVIS_GROIN", None, (0.0, 0.92, 0.0), (0.0, 1.02, 0.0)),
    ("Bone_TORSO_LOWER_ABDOMEN", "Bone_PELVIS_GROIN", (0.0, 1.02, 0.0), (0.0, 1.22, 0.0)),
    ("Bone_TORSO_UPPER_THORAX", "Bone_TORSO_LOWER_ABDOMEN", (0.0, 1.22, 0.0), (0.0, 1.50, 0.0)),
    ("Bone_NECK_CERVICAL", "Bone_TORSO_UPPER_THORAX", (0.0, 1.50, 0.0), (0.0, 1.60, 0.0)),
    ("Bone_HEAD_CRANIUM", "Bone_NECK_CERVICAL", (0.0, 1.60, 0.0), (0.0, 1.80, 0.0)),
    ("Bone_HEAD_FACE_JAW", "Bone_HEAD_CRANIUM", (0.0, 1.63, 0.02), (0.0, 1.58, 0.105)),

    # Left Arm (-X in GHOUL_ZONE_HIERARCHY) — natural tactical A-pose
    ("Bone_SHOULDER_LEFT", "Bone_TORSO_UPPER_THORAX", (-0.12, 1.45, 0.0), (-0.21, 1.44, 0.0)),
    ("Bone_UPPER_ARM_LEFT", "Bone_SHOULDER_LEFT", (-0.21, 1.44, 0.0), (-0.34, 1.20, 0.02)),
    ("Bone_FOREARM_LEFT", "Bone_UPPER_ARM_LEFT", (-0.34, 1.20, 0.02), (-0.43, 0.98, 0.10)),
    ("Bone_HAND_LEFT", "Bone_FOREARM_LEFT", (-0.43, 0.98, 0.10), (-0.47, 0.88, 0.15)),

    # Right Arm (+X in GHOUL_ZONE_HIERARCHY)
    ("Bone_SHOULDER_RIGHT", "Bone_TORSO_UPPER_THORAX", (0.12, 1.45, 0.0), (0.21, 1.44, 0.0)),
    ("Bone_UPPER_ARM_RIGHT", "Bone_SHOULDER_RIGHT", (0.21, 1.44, 0.0), (0.34, 1.20, 0.02)),
    ("Bone_FOREARM_RIGHT", "Bone_UPPER_ARM_RIGHT", (0.34, 1.20, 0.02), (0.43, 0.98, 0.10)),
    ("Bone_HAND_RIGHT", "Bone_FOREARM_RIGHT", (0.43, 0.98, 0.10), (0.47, 0.88, 0.15)),

    # Left Leg (-X)
    ("Bone_THIGH_LEFT", "Bone_PELVIS_GROIN", (-0.115, 0.89, 0.0), (-0.12, 0.51, 0.01)),
    ("Bone_KNEE_LEFT", "Bone_THIGH_LEFT", (-0.12, 0.51, 0.01), (-0.12, 0.42, 0.015)),
    ("Bone_SHIN_LEFT", "Bone_KNEE_LEFT", (-0.12, 0.42, 0.015), (-0.12, 0.09, 0.0)),
    ("Bone_FOOT_LEFT", "Bone_SHIN_LEFT", (-0.12, 0.09, 0.0), (-0.12, 0.03, 0.17)),

    # Right Leg (+X)
    ("Bone_THIGH_RIGHT", "Bone_PELVIS_GROIN", (0.115, 0.89, 0.0), (0.12, 0.51, 0.01)),
    ("Bone_KNEE_RIGHT", "Bone_THIGH_RIGHT", (0.12, 0.51, 0.01), (0.12, 0.42, 0.015)),
    ("Bone_SHIN_RIGHT", "Bone_KNEE_RIGHT", (0.12, 0.42, 0.015), (0.12, 0.09, 0.0)),
    ("Bone_FOOT_RIGHT", "Bone_SHIN_RIGHT", (0.12, 0.09, 0.0), (0.12, 0.03, 0.17)),
]


def build_ghoul_armature(collection: bpy.types.Collection) -> bpy.types.Object:
    arm_data = bpy.data.armatures.new(name="GhoulArmature")
    arm_obj = bpy.data.objects.new(name="GhoulArmature", object_data=arm_data)
    collection.objects.link(arm_obj)

    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode="EDIT")

    edit_bones: Dict[str, bpy.types.EditBone] = {}
    for b_name, parent_name, head_pc, tail_pc in GHOUL_BONE_SPECS:
        eb = arm_data.edit_bones.new(b_name)
        eb.head = pc_vec_to_bl(head_pc)
        eb.tail = pc_vec_to_bl(tail_pc)
        eb.use_connect = False
        if parent_name is not None:
            eb.parent = edit_bones[parent_name]
        # Align local Z toward forward (-Y in Blender = +Z in glTF) or up when bone points forward
        bone_dir = (eb.tail - eb.head).normalized()
        fwd_bl = Vector((0.0, -1.0, 0.0))
        if abs(bone_dir.dot(fwd_bl)) > 0.90:
            eb.align_roll(Vector((0.0, 0.0, 1.0)))
        else:
            eb.align_roll(fwd_bl)
        edit_bones[b_name] = eb

    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in arm_obj.pose.bones:
        pb.rotation_mode = "QUATERNION"

    return arm_obj


# ---------------------------------------------------------------------------
# Build All 22 Sculpted GHOUL Zone Submeshes + 9 Gear/Internal Submeshes
# ---------------------------------------------------------------------------

def build_all_combatant_submeshes(
    arm_obj: bpy.types.Object,
    pal: Dict[str, bpy.types.Material],
    collection: bpy.types.Collection,
) -> List[bpy.types.Object]:
    objs: List[bpy.types.Object] = []

    # 1. Zone_PELVIS_GROIN — Bloused tactical seat + utility belt + front buckle + rear dump pouch
    bm = bmesh.new()
    add_lofted_tube_along_segment(
        bm, (0.0, 0.85, 0.0), (0.0, 1.01, 0.0),
        [
            (0.00, 0.145, 0.105, 0.0, -0.005),
            (0.35, 0.168, 0.118, 0.0, 0.000),
            (0.75, 0.162, 0.116, 0.0, 0.004),
            (1.00, 0.156, 0.112, 0.0, 0.002),
        ],
        sides=16, mat_index=0,
    )
    # Tactical rigger belt ring
    add_lofted_tube_along_segment(
        bm, (0.0, 0.965, 0.0), (0.0, 1.015, 0.0),
        [(0.0, 0.165, 0.122, 0.0, 0.002), (1.0, 0.165, 0.122, 0.0, 0.002)],
        sides=16, mat_index=1, cap_ends=True, end_dome_scale=0.05,
    )
    add_beveled_box_pc(bm, (0.0, 0.99, 0.124), (0.032, 0.024, 0.012), bevel_width=0.004, mat_index=2)
    add_beveled_box_pc(bm, (0.0, 0.95, -0.128), (0.065, 0.055, 0.028), bevel_width=0.008, mat_index=1)
    objs.append(finalize_skinned_mesh_object(
        "Zone_PELVIS_GROIN", bm,
        [pal["bdu_olive"], pal["webbing_tan"], pal["polymer_dark"]],
        arm_obj, [("Bone_PELVIS_GROIN", 1.0)], collection,
    ))

    # 2. Zone_TORSO_LOWER_ABDOMEN — Tapered waist, obliques, side IFAK/utility pouches
    bm = bmesh.new()
    add_lofted_tube_along_segment(
        bm, (0.0, 0.99, 0.0), (0.0, 1.23, 0.0),
        [
            (0.00, 0.154, 0.110, 0.0, 0.002),
            (0.45, 0.150, 0.112, 0.0, 0.005),
            (1.00, 0.166, 0.122, 0.0, 0.006),
        ],
        sides=16, mat_index=0,
    )
    for sx in (-1.0, 1.0):
        add_beveled_box_pc(bm, (sx * 0.162, 1.07, 0.02), (0.024, 0.048, 0.045), bevel_width=0.006, mat_index=1)
    objs.append(finalize_skinned_mesh_object(
        "Zone_TORSO_LOWER_ABDOMEN", bm,
        [pal["shirt_charcoal"], pal["webbing_tan"]],
        arm_obj, [("Bone_TORSO_LOWER_ABDOMEN", 0.88), ("Bone_PELVIS_GROIN", 0.12)], collection,
    ))

    # 3. Zone_TORSO_UPPER_THORAX — Sculpted V-taper chest, pectorals, lats, collar
    bm = bmesh.new()
    add_lofted_tube_along_segment(
        bm, (0.0, 1.20, 0.0), (0.0, 1.50, 0.0),
        [
            (0.00, 0.164, 0.120, 0.0, 0.005),
            (0.38, 0.184, 0.134, 0.0, 0.010),
            (0.72, 0.196, 0.136, 0.0, 0.008),
            (0.92, 0.165, 0.108, 0.0, 0.000),
            (1.00, 0.095, 0.082, 0.0, -0.004),
        ],
        sides=18, mat_index=0,
    )
    # Sculpted pectoral plates / tactical shirt seam panels
    for sx in (-1.0, 1.0):
        add_beveled_box_pc(
            bm, (sx * 0.075, 1.37, 0.122), (0.058, 0.055, 0.018),
            bevel_width=0.010, mat_index=0, euler_deg_pc=(-6.0, sx * 8.0, 0.0)
        )
    objs.append(finalize_skinned_mesh_object(
        "Zone_TORSO_UPPER_THORAX", bm,
        [pal["shirt_charcoal"], pal["bdu_olive"]],
        arm_obj, [("Bone_TORSO_UPPER_THORAX", 0.90), ("Bone_TORSO_LOWER_ABDOMEN", 0.10)], collection,
    ))

    # 4. Zone_NECK_CERVICAL — Muscular neck + rolled combat collar
    bm = bmesh.new()
    add_lofted_tube_along_segment(
        bm, (0.0, 1.48, -0.005), (0.0, 1.61, 0.005),
        [
            (0.00, 0.078, 0.074, 0.0, 0.0),
            (0.32, 0.072, 0.068, 0.0, 0.0),
            (0.65, 0.062, 0.062, 0.0, 0.003),
            (1.00, 0.064, 0.066, 0.0, 0.005),
        ],
        sides=14, mat_index=0,
    )
    add_lofted_tube_along_segment(
        bm, (0.0, 1.485, -0.005), (0.0, 1.535, 0.0),
        [(0.0, 0.086, 0.082, 0.0, 0.0), (1.0, 0.078, 0.075, 0.0, 0.0)],
        sides=14, mat_index=1, cap_ends=True, end_dome_scale=0.05,
    )
    objs.append(finalize_skinned_mesh_object(
        "Zone_NECK_CERVICAL", bm,
        [pal["skin_tone"], pal["shirt_charcoal"]],
        arm_obj, [("Bone_NECK_CERVICAL", 0.85), ("Bone_TORSO_UPPER_THORAX", 0.15)], collection,
    ))

    # 5. Zone_HEAD_CRANIUM — Cranial vault, brow ridge, ears, tactical skullcap
    bm = bmesh.new()
    add_lofted_tube_along_segment(
        bm, (0.0, 1.61, -0.008), (0.0, 1.795, -0.005),
        [
            (0.00, 0.074, 0.086, 0.0, 0.002),
            (0.28, 0.086, 0.102, 0.0, 0.005),
            (0.58, 0.092, 0.108, 0.0, 0.002),
            (0.84, 0.082, 0.096, 0.0, -0.003),
            (1.00, 0.052, 0.062, 0.0, -0.006),
        ],
        sides=16, mat_index=0, end_dome_scale=0.42,
    )
    # Brow ridge + ballistic wrap-around eye-pro visor
    add_beveled_box_pc(bm, (0.0, 1.675, 0.088), (0.074, 0.018, 0.022), bevel_width=0.006, mat_index=2)
    for sx in (-1.0, 1.0):
        add_beveled_box_pc(bm, (sx * 0.090, 1.655, -0.005), (0.012, 0.024, 0.016), bevel_width=0.004, mat_index=1)
    objs.append(finalize_skinned_mesh_object(
        "Zone_HEAD_CRANIUM", bm,
        [pal["balaclava"], pal["skin_tone"], pal["visor_glass"]],
        arm_obj, [("Bone_HEAD_CRANIUM", 1.0)], collection,
    ))

    # 6. Zone_HEAD_FACE_JAW — Sculpted cheekbones, nose bridge, maxilla, strong mandible/chin
    bm = bmesh.new()
    add_lofted_tube_along_segment(
        bm, (0.0, 1.568, 0.032), (0.0, 1.668, 0.038),
        [
            (0.00, 0.048, 0.052, 0.0, 0.018),
            (0.35, 0.064, 0.060, 0.0, 0.012),
            (0.75, 0.074, 0.062, 0.0, 0.006),
            (1.00, 0.072, 0.058, 0.0, 0.002),
        ],
        sides=14, mat_index=0, end_dome_scale=0.22,
    )
    # Sculpted nose bridge
    add_beveled_box_pc(
        bm, (0.0, 1.642, 0.096), (0.013, 0.022, 0.016),
        bevel_width=0.005, mat_index=0, euler_deg_pc=(-14.0, 0.0, 0.0)
    )
    objs.append(finalize_skinned_mesh_object(
        "Zone_HEAD_FACE_JAW", bm,
        [pal["skin_tone"]],
        arm_obj, [("Bone_HEAD_FACE_JAW", 0.85), ("Bone_HEAD_CRANIUM", 0.15)], collection,
    ))

    # 7 & 11. Left & Right Arms (Shoulders, Upper Arms, Forearms, Hands)
    for side_label, sx in (("LEFT", -1.0), ("RIGHT", 1.0)):
        # Shoulder Deltoid Cap + Patch Panel
        bm = bmesh.new()
        add_lofted_tube_along_segment(
            bm, (sx * 0.13, 1.445, 0.0), (sx * 0.235, 1.425, 0.005),
            [
                (0.00, 0.068, 0.072, 0.0, 0.0),
                (0.55, 0.078, 0.080, 0.0, 0.0),
                (1.00, 0.064, 0.066, 0.0, 0.0),
            ],
            sides=14, mat_index=0, end_dome_scale=0.45,
        )
        add_beveled_box_pc(
            bm, (sx * 0.238, 1.425, 0.005), (0.014, 0.042, 0.036),
            bevel_width=0.004, mat_index=1, euler_deg_pc=(0.0, 0.0, sx * -22.0)
        )
        objs.append(finalize_skinned_mesh_object(
            f"Zone_SHOULDER_{side_label}", bm,
            [pal["bdu_olive"], pal["webbing_tan"]],
            arm_obj, [(f"Bone_SHOULDER_{side_label}", 0.85), ("Bone_TORSO_UPPER_THORAX", 0.15)], collection,
        ))

        # Upper Arm (Bicep/Tricep BDU Sleeve + Rolled Cuff)
        bm = bmesh.new()
        add_lofted_tube_along_segment(
            bm, (sx * 0.21, 1.44, 0.0), (sx * 0.34, 1.20, 0.02),
            [
                (0.00, 0.060, 0.062, 0.0, 0.0),
                (0.38, 0.064, 0.068, 0.0, 0.006),
                (0.75, 0.056, 0.058, 0.0, 0.003),
                (1.00, 0.050, 0.052, 0.0, 0.0),
            ],
            sides=14, mat_index=0, end_dome_scale=0.42,
        )
        objs.append(finalize_skinned_mesh_object(
            f"Zone_UPPER_ARM_{side_label}", bm,
            [pal["bdu_olive"]],
            arm_obj, [(f"Bone_UPPER_ARM_{side_label}", 0.90), (f"Bone_SHOULDER_{side_label}", 0.10)], collection,
        ))

        # Forearm (Tapered Muscular Forearm + Elbow Pad + Wrist Watch/Cuff)
        bm = bmesh.new()
        add_lofted_tube_along_segment(
            bm, (sx * 0.34, 1.20, 0.02), (sx * 0.43, 0.98, 0.10),
            [
                (0.00, 0.050, 0.052, 0.0, 0.0),
                (0.28, 0.054, 0.055, 0.0, 0.0),
                (0.72, 0.042, 0.044, 0.0, 0.0),
                (1.00, 0.036, 0.038, 0.0, 0.0),
            ],
            sides=12, mat_index=0, end_dome_scale=0.40,
        )
        # Elbow protector cap
        add_beveled_box_pc(
            bm, (sx * 0.345, 1.195, -0.022), (0.032, 0.042, 0.016),
            bevel_width=0.006, mat_index=1, euler_deg_pc=(18.0, 0.0, sx * -20.0)
        )
        objs.append(finalize_skinned_mesh_object(
            f"Zone_FOREARM_{side_label}", bm,
            [pal["skin_tone"], pal["polymer_dark"]],
            arm_obj, [(f"Bone_FOREARM_{side_label}", 0.90), (f"Bone_UPPER_ARM_{side_label}", 0.10)], collection,
        ))

        # Hand (Gloved Tactical Palm + Knuckle Guard + Articulated Thumb & Finger Block)
        bm = bmesh.new()
        add_lofted_tube_along_segment(
            bm, (sx * 0.43, 0.98, 0.10), (sx * 0.47, 0.88, 0.15),
            [
                (0.00, 0.035, 0.026, 0.0, 0.0),
                (0.45, 0.044, 0.024, 0.0, 0.0),
                (0.85, 0.040, 0.020, 0.0, 0.0),
                (1.00, 0.032, 0.015, 0.0, 0.0),
            ],
            sides=12, mat_index=0, end_dome_scale=0.25,
        )
        # Opposable thumb + hard carbon knuckle strip
        add_beveled_box_pc(
            bm, (sx * 0.415, 0.935, 0.135), (0.014, 0.030, 0.014),
            bevel_width=0.004, mat_index=0, euler_deg_pc=(-25.0, 0.0, sx * 18.0)
        )
        add_beveled_box_pc(
            bm, (sx * 0.455, 0.930, 0.118), (0.036, 0.012, 0.012),
            bevel_width=0.003, mat_index=1
        )
        objs.append(finalize_skinned_mesh_object(
            f"Zone_HAND_{side_label}", bm,
            [pal["glove_leather"], pal["polymer_dark"]],
            arm_obj, [(f"Bone_HAND_{side_label}", 1.0)], collection,
        ))

    # 15..22. Left & Right Legs (Thighs, Knees, Shins, Boots)
    for side_label, sx in (("LEFT", -1.0), ("RIGHT", 1.0)):
        # Thigh — Quadriceps/Hamstring BDU + Side Cargo Pocket + Drop-Leg Strap
        bm = bmesh.new()
        add_lofted_tube_along_segment(
            bm, (sx * 0.115, 0.89, 0.0), (sx * 0.12, 0.51, 0.01),
            [
                (0.00, 0.092, 0.098, 0.0, 0.0),
                (0.32, 0.090, 0.096, 0.0, 0.006),
                (0.72, 0.076, 0.080, 0.0, 0.004),
                (1.00, 0.066, 0.068, 0.0, 0.0),
            ],
            sides=14, mat_index=0, end_dome_scale=0.38,
        )
        add_beveled_box_pc(
            bm, (sx * 0.198, 0.69, 0.01), (0.022, 0.085, 0.058),
            bevel_width=0.006, mat_index=1
        )
        objs.append(finalize_skinned_mesh_object(
            f"Zone_THIGH_{side_label}", bm,
            [pal["bdu_olive"], pal["webbing_tan"]],
            arm_obj, [(f"Bone_THIGH_{side_label}", 0.92), ("Bone_PELVIS_GROIN", 0.08)], collection,
        ))

        # Knee — Articulated Joint + Curved Hard-Shell Tactical Kneepad + Elastic Straps
        bm = bmesh.new()
        add_lofted_tube_along_segment(
            bm, (sx * 0.12, 0.52, 0.01), (sx * 0.12, 0.41, 0.015),
            [
                (0.00, 0.065, 0.067, 0.0, 0.0),
                (0.50, 0.062, 0.066, 0.0, 0.004),
                (1.00, 0.058, 0.062, 0.0, 0.0),
            ],
            sides=14, mat_index=0, end_dome_scale=0.35,
        )
        add_beveled_box_pc(
            bm, (sx * 0.12, 0.468, 0.072), (0.052, 0.056, 0.020),
            bevel_width=0.010, mat_index=1
        )
        objs.append(finalize_skinned_mesh_object(
            f"Zone_KNEE_{side_label}", bm,
            [pal["bdu_olive"], pal["polymer_dark"]],
            arm_obj, [(f"Bone_KNEE_{side_label}", 0.85), (f"Bone_THIGH_{side_label}", 0.15)], collection,
        ))

        # Shin — Gastrocnemius Calf Contour + Bloused Boot-Top BDU Cuff
        bm = bmesh.new()
        add_lofted_tube_along_segment(
            bm, (sx * 0.12, 0.42, 0.015), (sx * 0.12, 0.11, 0.0),
            [
                (0.00, 0.058, 0.062, 0.0, 0.0),
                (0.28, 0.064, 0.070, 0.0, -0.010),
                (0.68, 0.054, 0.056, 0.0, -0.004),
                (0.90, 0.058, 0.060, 0.0, 0.0),
                (1.00, 0.048, 0.050, 0.0, 0.0),
            ],
            sides=14, mat_index=0, end_dome_scale=0.32,
        )
        objs.append(finalize_skinned_mesh_object(
            f"Zone_SHIN_{side_label}", bm,
            [pal["bdu_olive"]],
            arm_obj, [(f"Bone_SHIN_{side_label}", 0.90), (f"Bone_KNEE_{side_label}", 0.10)], collection,
        ))

        # Foot — Sculpted Combat Boot: Ankle Collar, Instep, Reinforced Toe Cap, Lugged Rubber Sole (grounded at y=0.00)
        bm = bmesh.new()
        # Ankle shaft
        add_lofted_tube_along_segment(
            bm, (sx * 0.12, 0.03, -0.01), (sx * 0.12, 0.125, 0.0),
            [
                (0.00, 0.048, 0.056, 0.0, 0.0),
                (0.50, 0.046, 0.052, 0.0, 0.0),
                (1.00, 0.048, 0.052, 0.0, 0.0),
            ],
            sides=12, mat_index=0,
        )
        # Foot upper vamp & toe box
        add_beveled_box_pc(bm, (sx * 0.12, 0.042, 0.062), (0.048, 0.028, 0.115), bevel_width=0.012, mat_index=0)
        # Reinforced toe cap
        add_beveled_box_pc(bm, (sx * 0.12, 0.034, 0.148), (0.046, 0.022, 0.038), bevel_width=0.010, mat_index=1)
        # Lugged rubber outsole grounded cleanly at y = 0.000
        add_beveled_box_pc(bm, (sx * 0.12, 0.012, 0.064), (0.051, 0.012, 0.122), bevel_width=0.004, mat_index=1)
        objs.append(finalize_skinned_mesh_object(
            f"Zone_FOOT_{side_label}", bm,
            [pal["boot_leather"], pal["polymer_dark"]],
            arm_obj, [(f"Bone_FOOT_{side_label}", 1.0)], collection,
        ))

    # -----------------------------------------------------------------------
    # Toggleable Ballistic Armor Submeshes
    # -----------------------------------------------------------------------

    # 23. Gear_ESAPI_PlateCarrier — Exact swimmer-cut ESAPI strike plates:
    #     x in [-0.125, 0.125], y in [1.18, 1.46] leaving armpits (|x|>0.13) and collarbone (y>1.46) exposed!
    bm = bmesh.new()
    for sz in (-1.0, 1.0):
        # Lower thoracic plate body
        add_beveled_box_pc(
            bm, (0.0, 1.28, sz * 0.136), (0.125, 0.10, 0.016),
            bevel_width=0.008, mat_index=0
        )
        # Upper swimmer-cut tapered chest section (exposes armpits & supraclavicular notch)
        add_beveled_box_pc(
            bm, (0.0, 1.415, sz * 0.134), (0.096, 0.045, 0.015),
            bevel_width=0.008, mat_index=0
        )
    # Shoulder carrier straps + side cummerbunds + 3 front STANAG pouches
    for sx in (-1.0, 1.0):
        add_beveled_box_pc(bm, (sx * 0.095, 1.475, 0.0), (0.026, 0.016, 0.135), bevel_width=0.005, mat_index=1)
        add_beveled_box_pc(bm, (sx * 0.168, 1.255, 0.0), (0.014, 0.052, 0.118), bevel_width=0.004, mat_index=1)
    for pouch_x in (-0.078, 0.0, 0.078):
        add_beveled_box_pc(bm, (pouch_x, 1.255, 0.162), (0.033, 0.068, 0.018), bevel_width=0.005, mat_index=1)
    objs.append(finalize_skinned_mesh_object(
        "Gear_ESAPI_PlateCarrier", bm,
        [pal["esapi_plate"], pal["webbing_tan"]],
        arm_obj, [("Bone_TORSO_UPPER_THORAX", 1.0)], collection,
    ))

    # 24. Gear_PASGT_Helmet — Sculpted Kevlar dome + ear flares + front visor brim + NVG shroud
    bm = bmesh.new()
    add_lofted_tube_along_segment(
        bm, (0.0, 1.665, -0.008), (0.0, 1.825, -0.006),
        [
            (0.00, 0.106, 0.116, 0.0, -0.006),
            (0.32, 0.112, 0.122, 0.0, 0.002),
            (0.68, 0.102, 0.112, 0.0, 0.000),
            (1.00, 0.060, 0.068, 0.0, -0.004),
        ],
        sides=18, mat_index=0, end_dome_scale=0.38,
    )
    # PASGT ear-protection flares + front NVG mount plate
    for sx in (-1.0, 1.0):
        add_beveled_box_pc(bm, (sx * 0.104, 1.662, -0.015), (0.014, 0.032, 0.048), bevel_width=0.006, mat_index=0)
    add_beveled_box_pc(bm, (0.0, 1.735, 0.116), (0.024, 0.026, 0.010), bevel_width=0.003, mat_index=1)
    objs.append(finalize_skinned_mesh_object(
        "Gear_PASGT_Helmet", bm,
        [pal["helmet_kevlar"], pal["polymer_dark"]],
        arm_obj, [("Bone_HEAD_CRANIUM", 1.0)], collection,
    ))

    # -----------------------------------------------------------------------
    # Internal X-Ray Anatomical Submeshes (7 Organs & Cortical Skeletons)
    # -----------------------------------------------------------------------

    # 25. Organ_Brain — Bi-hemispheric cerebrum + cerebellum inside cranium
    bm = bmesh.new()
    for sx in (-1.0, 1.0):
        add_lofted_tube_along_segment(
            bm, (sx * 0.032, 1.665, -0.008), (sx * 0.030, 1.765, -0.006),
            [
                (0.00, 0.032, 0.062, 0.0, 0.0),
                (0.50, 0.038, 0.074, 0.0, 0.004),
                (1.00, 0.026, 0.055, 0.0, 0.0),
            ],
            sides=12, mat_index=0, end_dome_scale=0.35,
        )
    objs.append(finalize_skinned_mesh_object(
        "Organ_Brain", bm, [pal["organ_brain"]],
        arm_obj, [("Bone_HEAD_CRANIUM", 1.0)], collection,
    ))

    # 26. Organ_Heart — Conical myocardium + aortic arch at (-0.02, 1.33, 0.015)
    bm = bmesh.new()
    add_lofted_tube_along_segment(
        bm, (-0.032, 1.285, 0.025), (-0.010, 1.385, 0.005),
        [
            (0.00, 0.022, 0.022, 0.0, 0.0),
            (0.45, 0.044, 0.042, 0.0, 0.0),
            (0.85, 0.038, 0.036, 0.0, 0.0),
            (1.00, 0.018, 0.018, 0.0, 0.0),
        ],
        sides=12, mat_index=0, end_dome_scale=0.40,
    )
    # Ascending aortic trunk
    add_lofted_tube_along_segment(
        bm, (-0.010, 1.375, 0.005), (0.005, 1.435, -0.012),
        [(0.0, 0.014, 0.014, 0.0, 0.0), (1.0, 0.012, 0.012, 0.0, 0.0)],
        sides=10, mat_index=0,
    )
    objs.append(finalize_skinned_mesh_object(
        "Organ_Heart", bm, [pal["organ_heart"]],
        arm_obj, [("Bone_TORSO_UPPER_THORAX", 1.0)], collection,
    ))

    # 27. Organ_Lungs — Paired Left & Right Pulmonary Lobes flanking Heart
    bm = bmesh.new()
    for sx in (-1.0, 1.0):
        add_lofted_tube_along_segment(
            bm, (sx * 0.085, 1.255, 0.008), (sx * 0.072, 1.445, 0.004),
            [
                (0.00, 0.056, 0.066, 0.0, 0.0),
                (0.42, 0.062, 0.072, 0.0, 0.004),
                (0.80, 0.048, 0.056, 0.0, 0.0),
                (1.00, 0.026, 0.032, 0.0, 0.0),
            ],
            sides=12, mat_index=0, end_dome_scale=0.35,
        )
    objs.append(finalize_skinned_mesh_object(
        "Organ_Lungs", bm, [pal["organ_lungs"]],
        arm_obj, [("Bone_TORSO_UPPER_THORAX", 1.0)], collection,
    ))

    # 28. Organ_Liver — Wedge-shaped Right-Hypochondrium Parenchyma (+X right side)
    bm = bmesh.new()
    add_lofted_tube_along_segment(
        bm, (-0.025, 1.195, 0.025), (0.105, 1.165, 0.015),
        [
            (0.00, 0.026, 0.035, 0.0, 0.0),
            (0.45, 0.052, 0.062, 0.0, 0.0),
            (0.85, 0.060, 0.068, 0.0, 0.0),
            (1.00, 0.038, 0.045, 0.0, 0.0),
        ],
        sides=12, mat_index=0, end_dome_scale=0.35,
    )
    objs.append(finalize_skinned_mesh_object(
        "Organ_Liver", bm, [pal["organ_liver"]],
        arm_obj, [("Bone_TORSO_LOWER_ABDOMEN", 0.85), ("Bone_TORSO_UPPER_THORAX", 0.15)], collection,
    ))

    # 29. Skelet_Skull — Calvarium + Zygomatic Cheekbones + Mandible
    bm = bmesh.new()
    add_lofted_tube_along_segment(
        bm, (0.0, 1.635, -0.005), (0.0, 1.778, -0.005),
        [
            (0.00, 0.064, 0.076, 0.0, 0.0),
            (0.45, 0.078, 0.090, 0.0, 0.004),
            (0.85, 0.070, 0.082, 0.0, 0.0),
            (1.00, 0.045, 0.054, 0.0, 0.0),
        ],
        sides=14, mat_index=0, end_dome_scale=0.38,
    )
    add_beveled_box_pc(bm, (0.0, 1.598, 0.048), (0.052, 0.032, 0.042), bevel_width=0.008, mat_index=0)
    objs.append(finalize_skinned_mesh_object(
        "Skelet_Skull", bm, [pal["bone_cortical"]],
        arm_obj, [("Bone_HEAD_CRANIUM", 0.85), ("Bone_HEAD_FACE_JAW", 0.15)], collection,
    ))

    # 30. Skelet_RibcageSpine — Vertebral Column + Sternum + 8 Pairs of Curved Thoracic Ribs
    bm = bmesh.new()
    # Spine column (lumbar + thoracic + cervical)
    add_lofted_tube_along_segment(
        bm, (0.0, 0.98, -0.045), (0.0, 1.58, -0.018),
        [
            (0.00, 0.026, 0.028, 0.0, 0.0),
            (0.35, 0.024, 0.026, 0.0, -0.006),
            (0.75, 0.022, 0.024, 0.0, 0.004),
            (1.00, 0.018, 0.020, 0.0, 0.0),
        ],
        sides=10, mat_index=0,
    )
    # Sternum manubrium + body
    add_beveled_box_pc(bm, (0.0, 1.355, 0.092), (0.020, 0.085, 0.009), bevel_width=0.004, mat_index=0)
    # Rib pairs
    for rib_i in range(7):
        frac = rib_i / 6.0
        ry = 1.24 + frac * 0.21
        rx_span = 0.135 - abs(frac - 0.42) * 0.045
        rz_front = 0.088 - abs(frac - 0.45) * 0.022
        for sx in (-1.0, 1.0):
            # Back-to-side rib arc
            add_lofted_tube_along_segment(
                bm, (sx * 0.02, ry + 0.01, -0.042), (sx * rx_span, ry, 0.015),
                [(0.0, 0.008, 0.007, 0.0, 0.0), (1.0, 0.008, 0.007, 0.0, 0.0)],
                sides=6, mat_index=0,
            )
            # Side-to-sternum rib arc
            if rib_i >= 1:
                add_lofted_tube_along_segment(
                    bm, (sx * rx_span, ry, 0.015), (sx * 0.022, ry - 0.012, rz_front),
                    [(0.0, 0.008, 0.007, 0.0, 0.0), (1.0, 0.007, 0.006, 0.0, 0.0)],
                    sides=6, mat_index=0,
                )
    objs.append(finalize_skinned_mesh_object(
        "Skelet_RibcageSpine", bm, [pal["bone_cortical"]],
        arm_obj,
        [("Bone_TORSO_UPPER_THORAX", 0.68), ("Bone_TORSO_LOWER_ABDOMEN", 0.22), ("Bone_NECK_CERVICAL", 0.10)],
        collection,
    ))

    # 31. Skelet_Pelvis — Iliac Wings + Sacrum + Pubic Arch
    bm = bmesh.new()
    add_beveled_box_pc(bm, (0.0, 0.945, -0.042), (0.045, 0.048, 0.022), bevel_width=0.008, mat_index=0)
    for sx in (-1.0, 1.0):
        add_beveled_box_pc(
            bm, (sx * 0.095, 0.955, 0.0), (0.052, 0.058, 0.068),
            bevel_width=0.014, mat_index=0, euler_deg_pc=(8.0, sx * 18.0, sx * -12.0)
        )
    add_beveled_box_pc(bm, (0.0, 0.895, 0.048), (0.058, 0.018, 0.020), bevel_width=0.006, mat_index=0)
    objs.append(finalize_skinned_mesh_object(
        "Skelet_Pelvis", bm, [pal["bone_cortical"]],
        arm_obj, [("Bone_PELVIS_GROIN", 1.0)], collection,
    ))

    return objs


# ---------------------------------------------------------------------------
# Armature-Space Pose Helper & 5 Baked NLA Animation Clips
# ---------------------------------------------------------------------------

def reset_armature_pose(arm_obj: bpy.types.Object) -> None:
    for pb in arm_obj.pose.bones:
        pb.location = (0.0, 0.0, 0.0)
        pb.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
        pb.scale = (1.0, 1.0, 1.0)
    bpy.context.view_layer.update()


def aim_pose_bone_pc(
    arm_obj: bpy.types.Object,
    bone_name: str,
    target_dir_pc: Tuple[float, float, float],
    twist_deg: float = 0.0,
) -> None:
    """
    Rotate `bone_name` in armature space so its longitudinal axis points along `target_dir_pc`
    (specified in intuitive PlayCanvas coordinates: +X right, +Y up, +Z forward!).
    """
    bpy.context.view_layer.update()
    pb = arm_obj.pose.bones[bone_name]
    cur_mat = pb.matrix.copy()
    cur_head = cur_mat.translation.copy()
    cur_y = cur_mat.col[1].to_3d().normalized()

    desired_y = pc_vec_to_bl(target_dir_pc).normalized()
    if desired_y.length < 1e-6:
        return

    rot_diff = cur_y.rotation_difference(desired_y)
    if abs(twist_deg) > 1e-4:
        twist_q = Quaternion(desired_y, math.radians(twist_deg))
        rot_diff = twist_q @ rot_diff

    new_rot3 = rot_diff.to_matrix() @ cur_mat.to_3x3()
    new_mat = new_rot3.to_4x4()
    new_mat.translation = cur_head
    pb.matrix = new_mat
    bpy.context.view_layer.update()


def set_pelvis_offset_pc(arm_obj: bpy.types.Object, dx: float, dy: float, dz: float) -> None:
    bpy.context.view_layer.update()
    pb = arm_obj.pose.bones["Bone_PELVIS_GROIN"]
    rest_head = pb.bone.head_local.copy()
    cur_mat = pb.matrix.copy()
    cur_mat.translation = rest_head + pc_to_bl(dx, dy, dz)
    pb.matrix = cur_mat
    bpy.context.view_layer.update()


def keyframe_all_pose_bones(arm_obj: bpy.types.Object, frame: int) -> None:
    for pb in arm_obj.pose.bones:
        pb.keyframe_insert(data_path="location", frame=frame)
        pb.keyframe_insert(data_path="rotation_quaternion", frame=frame)


def push_action_to_nla(arm_obj: bpy.types.Object, action: bpy.types.Action, name: str) -> None:
    slot = getattr(arm_obj.animation_data, "action_slot", None)
    track = arm_obj.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 1, action)
    strip.name = name
    if slot is not None and hasattr(strip, "action_slot"):
        strip.action_slot = slot
    track.mute = False
    arm_obj.animation_data.action = None


def apply_combat_ready_pose(arm_obj: bpy.types.Object, breath: float = 0.0) -> None:
    reset_armature_pose(arm_obj)
    set_pelvis_offset_pc(arm_obj, 0.0, -0.035 + breath * 0.008, 0.0)
    # Slight forward lean & tactical blade
    aim_pose_bone_pc(arm_obj, "Bone_PELVIS_GROIN", (0.0, 1.0, 0.06), twist_deg=-12.0)
    aim_pose_bone_pc(arm_obj, "Bone_TORSO_LOWER_ABDOMEN", (0.0, 1.0, 0.10 + breath * 0.02), twist_deg=-8.0)
    aim_pose_bone_pc(arm_obj, "Bone_TORSO_UPPER_THORAX", (0.0, 1.0, 0.14 + breath * 0.03), twist_deg=-6.0)
    aim_pose_bone_pc(arm_obj, "Bone_NECK_CERVICAL", (0.0, 1.0, 0.06), twist_deg=14.0)
    aim_pose_bone_pc(arm_obj, "Bone_HEAD_CRANIUM", (0.0, 1.0, 0.02), twist_deg=12.0)

    # Rifle ready arms: right hand at trigger/receiver, left hand forward supporting handguard
    aim_pose_bone_pc(arm_obj, "Bone_UPPER_ARM_RIGHT", (0.28, -0.82, 0.42))
    aim_pose_bone_pc(arm_obj, "Bone_FOREARM_RIGHT", (-0.52, 0.24, 0.82))
    aim_pose_bone_pc(arm_obj, "Bone_HAND_RIGHT", (-0.12, 0.05, 0.98))

    aim_pose_bone_pc(arm_obj, "Bone_UPPER_ARM_LEFT", (-0.18, -0.68, 0.70))
    aim_pose_bone_pc(arm_obj, "Bone_FOREARM_LEFT", (0.46, 0.20, 0.86))
    aim_pose_bone_pc(arm_obj, "Bone_HAND_LEFT", (0.15, 0.10, 0.98))

    # Athletic flexed knees
    aim_pose_bone_pc(arm_obj, "Bone_THIGH_LEFT", (-0.06, -0.96, 0.24))
    aim_pose_bone_pc(arm_obj, "Bone_KNEE_LEFT", (-0.02, -0.98, -0.14))
    aim_pose_bone_pc(arm_obj, "Bone_SHIN_LEFT", (-0.02, -0.98, -0.18))
    aim_pose_bone_pc(arm_obj, "Bone_FOOT_LEFT", (-0.04, -0.25, 0.97))

    aim_pose_bone_pc(arm_obj, "Bone_THIGH_RIGHT", (0.08, -0.97, -0.16))
    aim_pose_bone_pc(arm_obj, "Bone_KNEE_RIGHT", (0.04, -0.98, -0.18))
    aim_pose_bone_pc(arm_obj, "Bone_SHIN_RIGHT", (0.04, -0.97, -0.22))
    aim_pose_bone_pc(arm_obj, "Bone_FOOT_RIGHT", (0.08, -0.25, 0.96))


def bake_all_combatant_animations(arm_obj: bpy.types.Object) -> None:
    bpy.context.scene.render.fps = 24
    arm_obj.animation_data_create()

    # 1. CombatReadyIdle (frames 1..49 seamless loop)
    act = bpy.data.actions.new(name="CombatReadyIdle")
    arm_obj.animation_data.action = act
    for frame, b in [(1, 0.0), (13, 0.6), (25, 1.0), (37, 0.4), (49, 0.0)]:
        apply_combat_ready_pose(arm_obj, breath=b)
        keyframe_all_pose_bones(arm_obj, frame)
    push_action_to_nla(arm_obj, act, "CombatReadyIdle")

    # 2. UnsuspectingIdle (frames 1..61 relaxed patrol guard stance + head scan)
    act = bpy.data.actions.new(name="UnsuspectingIdle")
    arm_obj.animation_data.action = act
    for frame, scan_yaw, breath in [(1, 0.0, 0.0), (16, 14.0, 0.5), (31, 0.0, 1.0), (46, -14.0, 0.5), (61, 0.0, 0.0)]:
        reset_armature_pose(arm_obj)
        set_pelvis_offset_pc(arm_obj, 0.0, breath * 0.005, 0.0)
        aim_pose_bone_pc(arm_obj, "Bone_TORSO_UPPER_THORAX", (0.0, 1.0, 0.02 + breath * 0.015))
        aim_pose_bone_pc(arm_obj, "Bone_HEAD_CRANIUM", (0.0, 1.0, 0.02), twist_deg=scan_yaw)
        # Low slung rifle / relaxed arms
        aim_pose_bone_pc(arm_obj, "Bone_UPPER_ARM_LEFT", (-0.24, -0.95, 0.14))
        aim_pose_bone_pc(arm_obj, "Bone_FOREARM_LEFT", (0.45, -0.45, 0.76))
        aim_pose_bone_pc(arm_obj, "Bone_UPPER_ARM_RIGHT", (0.24, -0.95, 0.12))
        aim_pose_bone_pc(arm_obj, "Bone_FOREARM_RIGHT", (-0.42, -0.52, 0.74))
        keyframe_all_pose_bones(arm_obj, frame)
    push_action_to_nla(arm_obj, act, "UnsuspectingIdle")

    # 3. HitStaggerChest (frames 1..28 thoracic kinetic impact recoil stagger)
    act = bpy.data.actions.new(name="HitStaggerChest")
    arm_obj.animation_data.action = act
    apply_combat_ready_pose(arm_obj, breath=0.0)
    keyframe_all_pose_bones(arm_obj, 1)

    # Frame 5: Violent backward snap of thorax & head
    reset_armature_pose(arm_obj)
    set_pelvis_offset_pc(arm_obj, 0.0, -0.06, -0.08)
    aim_pose_bone_pc(arm_obj, "Bone_TORSO_LOWER_ABDOMEN", (0.0, 0.96, -0.26), twist_deg=10.0)
    aim_pose_bone_pc(arm_obj, "Bone_TORSO_UPPER_THORAX", (0.05, 0.88, -0.46), twist_deg=18.0)
    aim_pose_bone_pc(arm_obj, "Bone_NECK_CERVICAL", (0.06, 0.82, -0.56))
    aim_pose_bone_pc(arm_obj, "Bone_HEAD_CRANIUM", (0.08, 0.76, -0.64))
    aim_pose_bone_pc(arm_obj, "Bone_UPPER_ARM_LEFT", (-0.65, -0.55, 0.52))
    aim_pose_bone_pc(arm_obj, "Bone_FOREARM_LEFT", (-0.30, 0.45, 0.84))
    aim_pose_bone_pc(arm_obj, "Bone_UPPER_ARM_RIGHT", (0.68, -0.50, 0.52))
    aim_pose_bone_pc(arm_obj, "Bone_FOREARM_RIGHT", (0.25, 0.35, 0.90))
    aim_pose_bone_pc(arm_obj, "Bone_THIGH_LEFT", (-0.08, -0.94, 0.32))
    aim_pose_bone_pc(arm_obj, "Bone_SHIN_LEFT", (-0.04, -0.95, -0.30))
    aim_pose_bone_pc(arm_obj, "Bone_THIGH_RIGHT", (0.10, -0.92, -0.36))
    keyframe_all_pose_bones(arm_obj, 6)

    # Frame 14: Heavy forward catch/hunch
    reset_armature_pose(arm_obj)
    set_pelvis_offset_pc(arm_obj, 0.0, -0.09, -0.14)
    aim_pose_bone_pc(arm_obj, "Bone_TORSO_LOWER_ABDOMEN", (0.0, 0.94, 0.32))
    aim_pose_bone_pc(arm_obj, "Bone_TORSO_UPPER_THORAX", (0.0, 0.88, 0.46))
    aim_pose_bone_pc(arm_obj, "Bone_HEAD_CRANIUM", (0.0, 0.95, 0.30))
    aim_pose_bone_pc(arm_obj, "Bone_UPPER_ARM_LEFT", (-0.32, -0.78, 0.52))
    aim_pose_bone_pc(arm_obj, "Bone_FOREARM_LEFT", (0.48, 0.25, 0.84))
    aim_pose_bone_pc(arm_obj, "Bone_UPPER_ARM_RIGHT", (0.30, -0.80, 0.50))
    aim_pose_bone_pc(arm_obj, "Bone_FOREARM_RIGHT", (-0.45, 0.22, 0.86))
    keyframe_all_pose_bones(arm_obj, 15)

    # Frame 28: Recover to combat ready
    apply_combat_ready_pose(arm_obj, breath=0.2)
    keyframe_all_pose_bones(arm_obj, 28)
    push_action_to_nla(arm_obj, act, "HitStaggerChest")

    # 4. DiaphragmDropKneel (frames 1..42: Stage-4 clutching solar plexus & dropping to one knee gasping)
    act = bpy.data.actions.new(name="DiaphragmDropKneel")
    arm_obj.animation_data.action = act
    apply_combat_ready_pose(arm_obj, breath=0.0)
    keyframe_all_pose_bones(arm_obj, 1)

    # Frame 8: Solar plexus gut-fold
    reset_armature_pose(arm_obj)
    set_pelvis_offset_pc(arm_obj, 0.0, -0.14, -0.04)
    aim_pose_bone_pc(arm_obj, "Bone_TORSO_LOWER_ABDOMEN", (0.0, 0.84, 0.54))
    aim_pose_bone_pc(arm_obj, "Bone_TORSO_UPPER_THORAX", (0.0, 0.72, 0.69))
    aim_pose_bone_pc(arm_obj, "Bone_HEAD_CRANIUM", (0.0, 0.65, 0.76))
    # Left hand clutches solar plexus!
    aim_pose_bone_pc(arm_obj, "Bone_UPPER_ARM_LEFT", (-0.15, -0.82, 0.55))
    aim_pose_bone_pc(arm_obj, "Bone_FOREARM_LEFT", (0.85, 0.20, 0.48))
    aim_pose_bone_pc(arm_obj, "Bone_UPPER_ARM_RIGHT", (0.32, -0.88, 0.35))
    aim_pose_bone_pc(arm_obj, "Bone_FOREARM_RIGHT", (-0.25, -0.10, 0.96))
    aim_pose_bone_pc(arm_obj, "Bone_THIGH_LEFT", (-0.06, -0.82, 0.56))
    aim_pose_bone_pc(arm_obj, "Bone_SHIN_LEFT", (-0.02, -0.96, -0.28))
    aim_pose_bone_pc(arm_obj, "Bone_THIGH_RIGHT", (0.08, -0.95, -0.30))
    aim_pose_bone_pc(arm_obj, "Bone_SHIN_RIGHT", (0.04, -0.55, -0.83))
    keyframe_all_pose_bones(arm_obj, 9)

    # Frame 24..42: Dropped onto right knee, clutching diaphragm, gasping
    for frame, gasp in [(24, 0.0), (33, 0.14), (42, 0.04)]:
        reset_armature_pose(arm_obj)
        set_pelvis_offset_pc(arm_obj, 0.0, -0.38, 0.02)
        aim_pose_bone_pc(arm_obj, "Bone_TORSO_LOWER_ABDOMEN", (0.0, 0.86, 0.50 - gasp))
        aim_pose_bone_pc(arm_obj, "Bone_TORSO_UPPER_THORAX", (0.0, 0.78 + gasp * 0.5, 0.62 - gasp))
        aim_pose_bone_pc(arm_obj, "Bone_NECK_CERVICAL", (0.0, 0.88, 0.46))
        aim_pose_bone_pc(arm_obj, "Bone_HEAD_CRANIUM", (0.0, 0.94, 0.34 - gasp))
        # Left arm clutching solar plexus/abdomen
        aim_pose_bone_pc(arm_obj, "Bone_UPPER_ARM_LEFT", (-0.12, -0.85, 0.51))
        aim_pose_bone_pc(arm_obj, "Bone_FOREARM_LEFT", (0.88, 0.28, 0.38))
        # Right arm holding weapon low/wavering forward
        aim_pose_bone_pc(arm_obj, "Bone_UPPER_ARM_RIGHT", (0.26, -0.85, 0.45))
        aim_pose_bone_pc(arm_obj, "Bone_FOREARM_RIGHT", (-0.22, 0.08, 0.97))
        # Left leg planted forward bent 90 deg; right knee down on ground, shin trailing back
        aim_pose_bone_pc(arm_obj, "Bone_THIGH_LEFT", (-0.08, -0.18, 0.98))
        aim_pose_bone_pc(arm_obj, "Bone_KNEE_LEFT", (-0.02, -0.98, -0.12))
        aim_pose_bone_pc(arm_obj, "Bone_SHIN_LEFT", (-0.02, -0.99, -0.08))
        aim_pose_bone_pc(arm_obj, "Bone_FOOT_LEFT", (-0.04, -0.15, 0.98))
        aim_pose_bone_pc(arm_obj, "Bone_THIGH_RIGHT", (0.08, -0.98, 0.14))
        aim_pose_bone_pc(arm_obj, "Bone_KNEE_RIGHT", (0.04, -0.25, -0.96))
        aim_pose_bone_pc(arm_obj, "Bone_SHIN_RIGHT", (0.04, -0.06, -0.99))
        aim_pose_bone_pc(arm_obj, "Bone_FOOT_RIGHT", (0.04, -0.95, -0.30))
        keyframe_all_pose_bones(arm_obj, frame)
    push_action_to_nla(arm_obj, act, "DiaphragmDropKneel")

    # 5. LegCollapseCrawl (frames 1..48: canStand=false prone collapse with functional arms aiming forward)
    act = bpy.data.actions.new(name="LegCollapseCrawl")
    arm_obj.animation_data.action = act
    apply_combat_ready_pose(arm_obj, breath=0.0)
    keyframe_all_pose_bones(arm_obj, 1)

    # Frame 12: Femur/spine gives way — legs buckle sideways/back, pelvis drops rapidly
    reset_armature_pose(arm_obj)
    set_pelvis_offset_pc(arm_obj, 0.03, -0.46, -0.08)
    aim_pose_bone_pc(arm_obj, "Bone_TORSO_LOWER_ABDOMEN", (0.04, 0.78, 0.62))
    aim_pose_bone_pc(arm_obj, "Bone_TORSO_UPPER_THORAX", (0.02, 0.68, 0.73))
    aim_pose_bone_pc(arm_obj, "Bone_HEAD_CRANIUM", (0.0, 0.85, 0.52))
    aim_pose_bone_pc(arm_obj, "Bone_UPPER_ARM_LEFT", (-0.35, -0.70, 0.62))
    aim_pose_bone_pc(arm_obj, "Bone_UPPER_ARM_RIGHT", (0.35, -0.70, 0.62))
    aim_pose_bone_pc(arm_obj, "Bone_THIGH_LEFT", (-0.28, -0.60, -0.75))
    aim_pose_bone_pc(arm_obj, "Bone_SHIN_LEFT", (-0.12, -0.20, -0.97))
    aim_pose_bone_pc(arm_obj, "Bone_THIGH_RIGHT", (0.32, -0.65, -0.68))
    aim_pose_bone_pc(arm_obj, "Bone_SHIN_RIGHT", (0.18, -0.25, -0.95))
    keyframe_all_pose_bones(arm_obj, 12)

    # Frame 28..48: Grounded prone crawl state — pelvis/legs flat on ground, chest propped on elbows aiming +Z!
    for frame, crawl_shift in [(28, 0.0), (38, 0.04), (48, 0.0)]:
        reset_armature_pose(arm_obj)
        set_pelvis_offset_pc(arm_obj, 0.0, -0.78, -0.10 + crawl_shift)
        aim_pose_bone_pc(arm_obj, "Bone_PELVIS_GROIN", (0.0, 0.22, 0.97))
        aim_pose_bone_pc(arm_obj, "Bone_TORSO_LOWER_ABDOMEN", (0.0, 0.26, 0.96))
        aim_pose_bone_pc(arm_obj, "Bone_TORSO_UPPER_THORAX", (0.0, 0.42, 0.91))
        aim_pose_bone_pc(arm_obj, "Bone_NECK_CERVICAL", (0.0, 0.78, 0.62))
        aim_pose_bone_pc(arm_obj, "Bone_HEAD_CRANIUM", (0.0, 0.96, 0.28))
        # Propped on elbows, both functional hands aiming weapon forward along +Z!
        aim_pose_bone_pc(arm_obj, "Bone_UPPER_ARM_LEFT", (-0.42, -0.65, 0.63))
        aim_pose_bone_pc(arm_obj, "Bone_FOREARM_LEFT", (0.42, 0.18, 0.89))
        aim_pose_bone_pc(arm_obj, "Bone_HAND_LEFT", (0.10, 0.08, 0.99))
        aim_pose_bone_pc(arm_obj, "Bone_UPPER_ARM_RIGHT", (0.42, -0.65, 0.63))
        aim_pose_bone_pc(arm_obj, "Bone_FOREARM_RIGHT", (-0.42, 0.18, 0.89))
        aim_pose_bone_pc(arm_obj, "Bone_HAND_RIGHT", (-0.10, 0.08, 0.99))
        # Disabled legs trailing behind on ground (-Z)
        aim_pose_bone_pc(arm_obj, "Bone_THIGH_LEFT", (-0.18, -0.06, -0.98))
        aim_pose_bone_pc(arm_obj, "Bone_KNEE_LEFT", (-0.10, -0.04, -0.99))
        aim_pose_bone_pc(arm_obj, "Bone_SHIN_LEFT", (-0.08, 0.02, -0.99))
        aim_pose_bone_pc(arm_obj, "Bone_FOOT_LEFT", (-0.10, -0.85, -0.52))
        aim_pose_bone_pc(arm_obj, "Bone_THIGH_RIGHT", (0.22, -0.06, -0.97))
        aim_pose_bone_pc(arm_obj, "Bone_KNEE_RIGHT", (0.14, -0.04, -0.99))
        aim_pose_bone_pc(arm_obj, "Bone_SHIN_RIGHT", (0.12, 0.02, -0.99))
        aim_pose_bone_pc(arm_obj, "Bone_FOOT_RIGHT", (0.12, -0.85, -0.52))
        keyframe_all_pose_bones(arm_obj, frame)
    push_action_to_nla(arm_obj, act, "LegCollapseCrawl")

    # Reset armature to clean Rest Pose for export & inspection
    reset_armature_pose(arm_obj)


def main() -> None:
    os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
    os.makedirs(os.path.dirname(OUT_BLEND), exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0

    combatant_col = bpy.data.collections.new("GhoulCombatant")
    scene.collection.children.link(combatant_col)

    pal = build_palette()
    arm_obj = build_ghoul_armature(combatant_col)
    submeshes = build_all_combatant_submeshes(arm_obj, pal, combatant_col)
    bake_all_combatant_animations(arm_obj)

    # Save native .blend source for Blender 5.2.1 GUI inspection
    bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND)

    # Export glTF 2.0 binary (.glb)
    bpy.ops.export_scene.gltf(
        filepath=OUT_GLB,
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_skins=True,
        export_all_influences=False,
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_rest_position_armature=True,
        export_lights=False,
    )

    total_tris = sum(len(o.data.polygons) for o in submeshes)
    total_verts = sum(len(o.data.vertices) for o in submeshes)
    size_kb = os.path.getsize(OUT_GLB) / 1024.0
    print(
        f"[GHOUL Combatant] Exported {len(submeshes)} submeshes, "
        f"{len(arm_obj.data.bones)} bones, {len(arm_obj.animation_data.nla_tracks)} NLA clips | "
        f"{total_verts} verts, {total_tris} polys | {size_kb:.1f} KB -> {OUT_GLB}"
    )


if __name__ == "__main__":
    main()
