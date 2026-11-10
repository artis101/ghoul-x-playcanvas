#!/usr/bin/env python3
"""
Procedural Blender 5.2.1 LTS Pipeline — GHOUL-X Detailed & Animated 3D Weapon Arsenal.

Generates:
  - public/models/m590_shotgun.glb
  - public/models/silver_talon_50ae.glb
  - public/models/msg90_sniper.glb
  - public/models/m4a1_carbine.glb
  - public/models/frag_grenade.glb
  - public/models/blend_sources/weapons_arsenal.blend

Coordinate Convention (PlayCanvas First-Person Camera Viewmodel):
  - +X = Right (ejection port side)
  - +Y = Up (top Picatinny rail / optic sights)
  - -Z = Barrel / Muzzle Forward (matches PlayCanvas `cameraEntity` forward axis `-Z` and
    `ArsenalManager` viewmodel child at `(0.24, -0.22, -0.48)`!)
  - Blender 5.2 internal mapping: `pc_to_bl(x, y, z) = Vector((x, -z, y))` so exporting with
    `export_yup=True` produces exact PlayCanvas `(x, y, z)` coordinates with CCW outward normals.
"""

import math
import os
from typing import Dict, List, Optional, Sequence, Tuple

import bmesh
import bpy
from mathutils import Euler, Quaternion, Vector


REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_DIR = os.path.join(REPO_ROOT, "public", "models")
OUT_BLEND = os.path.join(OUT_DIR, "blend_sources", "weapons_arsenal.blend")


def pc_to_bl(x: float, y: float, z: float) -> Vector:
    return Vector((x, -z, y))


def pc_vec_to_bl(v: Tuple[float, float, float]) -> Vector:
    return Vector((v[0], -v[2], v[1]))


# ---------------------------------------------------------------------------
# PBR Weapon Materials
# ---------------------------------------------------------------------------

def make_pbr_material(
    name: str,
    base_color: Tuple[float, float, float, float],
    roughness: float = 0.45,
    metallic: float = 0.0,
    emission_color: Optional[Tuple[float, float, float, float]] = None,
    emission_strength: float = 0.0,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name=name)
    if mat.node_tree is None:
        mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = nodes.get("Principled BSDF") or nodes.new(type="ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = base_color
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission_color is not None and "Emission Color" in bsdf.inputs:
        bsdf.inputs["Emission Color"].default_value = emission_color
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


def build_weapon_materials() -> Dict[str, bpy.types.Material]:
    return {
        "parkerized_steel": make_pbr_material("Mat_ParkerizedSteel", (0.14, 0.15, 0.16, 1.0), roughness=0.42, metallic=0.86),
        "anodized_black": make_pbr_material("Mat_AnodizedReceiver", (0.08, 0.09, 0.10, 1.0), roughness=0.36, metallic=0.78),
        "brushed_chrome": make_pbr_material("Mat_BrushedSilverChrome", (0.83, 0.85, 0.88, 1.0), roughness=0.20, metallic=0.96),
        "bolt_steel": make_pbr_material("Mat_BoltSteel_Polished", (0.52, 0.54, 0.57, 1.0), roughness=0.26, metallic=0.92),
        "polymer_grip": make_pbr_material("Mat_PolymerFurniture", (0.07, 0.07, 0.08, 1.0), roughness=0.74, metallic=0.04),
        "polymer_fde": make_pbr_material("Mat_TacticalPolymer_FDE", (0.30, 0.25, 0.18, 1.0), roughness=0.68, metallic=0.04),
        "olive_drab": make_pbr_material("Mat_M67_OliveDrab", (0.20, 0.26, 0.14, 1.0), roughness=0.58, metallic=0.18),
        "fuze_zinc": make_pbr_material("Mat_FuzeZincSteel", (0.56, 0.55, 0.48, 1.0), roughness=0.35, metallic=0.88),
        "shell_red": make_pbr_material("Mat_Shotshell_Crimson", (0.68, 0.08, 0.09, 1.0), roughness=0.44, metallic=0.05),
        "brass_gold": make_pbr_material("Mat_BrassCasing", (0.82, 0.64, 0.24, 1.0), roughness=0.28, metallic=0.92),
        "optic_glass": make_pbr_material(
            "Mat_OpticLens_Coated", (0.06, 0.24, 0.28, 1.0), roughness=0.08, metallic=0.85,
            emission_color=(0.08, 0.45, 0.36, 1.0), emission_strength=0.35
        ),
        "tritium_sight": make_pbr_material(
            "Mat_TritiumNightSight", (0.20, 0.95, 0.35, 1.0), roughness=0.20, metallic=0.10,
            emission_color=(0.20, 0.98, 0.35, 1.0), emission_strength=1.40
        ),
    }


# ---------------------------------------------------------------------------
# Hard-Surface BMesh Primitives (in PlayCanvas Viewmodel Coordinates)
# ---------------------------------------------------------------------------

def assign_box_uvs(bm: bmesh.types.BMesh, scale: float = 4.0) -> None:
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


def add_box_pc(
    bm: bmesh.types.BMesh,
    center_pc: Tuple[float, float, float],
    half_extents_pc: Tuple[float, float, float],
    bevel: float = 0.0025,
    mat_idx: int = 0,
    pitch_deg: float = 0.0,
) -> List[bmesh.types.BMVert]:
    hx, hy, hz = half_extents_pc
    ret = bmesh.ops.create_cube(bm, size=2.0)
    verts: List[bmesh.types.BMVert] = ret["verts"]
    # Pitch in PlayCanvas around +X maps directly to rotation around +X in Blender!
    rot = Euler((math.radians(pitch_deg), 0.0, 0.0), "XYZ").to_matrix()
    c_bl = pc_vec_to_bl(center_pc)
    for v in verts:
        local = Vector((v.co.x * hx, v.co.y * hz, v.co.z * hy))
        v.co = c_bl + (rot @ local)

    vset = set(verts)
    edges = [e for e in bm.edges if e.verts[0] in vset and e.verts[1] in vset]
    for f in bm.faces:
        if all(v in vset for v in f.verts):
            f.material_index = mat_idx
            f.smooth = False

    if bevel > 1e-5 and edges:
        bev = bmesh.ops.bevel(
            bm, geom=edges, offset=bevel, offset_type="OFFSET", segments=1, profile=0.5, affect="EDGES"
        )
        for f in bev.get("faces", []):
            f.material_index = mat_idx
            f.smooth = False
        verts = list(vset.union(bev.get("verts", [])))
    return verts


def add_cylinder_z_pc(
    bm: bmesh.types.BMesh,
    x_pc: float,
    y_pc: float,
    z_start_pc: float,
    z_end_pc: float,
    radius_start: float,
    radius_end: Optional[float] = None,
    sides: int = 16,
    mat_idx: int = 0,
    smooth: bool = True,
) -> List[bmesh.types.BMVert]:
    """Build a closed manifold cylinder/frustum aligned along the barrel axis (PlayCanvas Z)."""
    if radius_end is None:
        radius_end = radius_start
    p0 = pc_to_bl(x_pc, y_pc, z_start_pc)
    p1 = pc_to_bl(x_pc, y_pc, z_end_pc)

    r0_verts: List[bmesh.types.BMVert] = []
    r1_verts: List[bmesh.types.BMVert] = []
    for s in range(sides):
        ang = (2.0 * math.pi * s) / sides
        dx = math.cos(ang)
        dz = math.sin(ang)  # Blender Z = PlayCanvas Y
        r0_verts.append(bm.verts.new(Vector((p0.x + dx * radius_start, p0.y, p0.z + dz * radius_start))))
        r1_verts.append(bm.verts.new(Vector((p1.x + dx * radius_end, p1.y, p1.z + dz * radius_end))))

    # Ensure outward winding regardless of z_start_pc vs z_end_pc ordering
    flip = p1.y < p0.y
    for s in range(sides):
        sn = (s + 1) % sides
        quad = (r0_verts[s], r1_verts[s], r1_verts[sn], r0_verts[sn]) if flip else (r0_verts[s], r0_verts[sn], r1_verts[sn], r1_verts[s])
        f = bm.faces.new(quad)
        f.material_index = mat_idx
        f.smooth = smooth

    c0 = bm.verts.new(p0)
    c1 = bm.verts.new(p1)
    for s in range(sides):
        sn = (s + 1) % sides
        f0 = bm.faces.new((c0, r0_verts[s], r0_verts[sn]) if flip else (c0, r0_verts[sn], r0_verts[s]))
        f1 = bm.faces.new((c1, r1_verts[sn], r1_verts[s]) if flip else (c1, r1_verts[s], r1_verts[sn]))
        f0.material_index = mat_idx
        f1.material_index = mat_idx
        f0.smooth = False
        f1.smooth = False

    return r0_verts + r1_verts + [c0, c1]


def add_uv_sphere_pc(
    bm: bmesh.types.BMesh,
    center_pc: Tuple[float, float, float],
    radii_pc: Tuple[float, float, float],
    segments: int = 18,
    rings: int = 12,
    mat_idx: int = 0,
) -> List[bmesh.types.BMVert]:
    ret = bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=1.0)
    verts: List[bmesh.types.BMVert] = ret["verts"]
    c_bl = pc_vec_to_bl(center_pc)
    rx, ry, rz = radii_pc
    vset = set(verts)
    for v in verts:
        v.co = c_bl + Vector((v.co.x * rx, v.co.y * rz, v.co.z * ry))
    for f in bm.faces:
        if all(v in vset for v in f.verts):
            f.material_index = mat_idx
            f.smooth = True
    return verts


def create_weapon_armature(
    name: str,
    bone_specs: Sequence[Tuple[str, Optional[str], Tuple[float, float, float], Tuple[float, float, float]]],
    collection: bpy.types.Collection,
) -> bpy.types.Object:
    arm_data = bpy.data.armatures.new(name=name)
    arm_obj = bpy.data.objects.new(name=name, object_data=arm_data)
    collection.objects.link(arm_obj)

    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode="EDIT")
    ebones: Dict[str, bpy.types.EditBone] = {}
    for b_name, parent_name, head_pc, tail_pc in bone_specs:
        eb = arm_data.edit_bones.new(b_name)
        eb.head = pc_vec_to_bl(head_pc)
        eb.tail = pc_vec_to_bl(tail_pc)
        eb.use_connect = False
        if parent_name is not None:
            eb.parent = ebones[parent_name]
        # Align roll so bone Z points +Z in Blender (+Y Up in PlayCanvas)
        bdir = (eb.tail - eb.head).normalized()
        if abs(bdir.z) > 0.92:
            eb.align_roll(Vector((0.0, 1.0, 0.0)))
        else:
            eb.align_roll(Vector((0.0, 0.0, 1.0)))
        ebones[b_name] = eb
    bpy.ops.object.mode_set(mode="OBJECT")

    for pb in arm_obj.pose.bones:
        pb.rotation_mode = "QUATERNION"
    return arm_obj


def finalize_weapon_part(
    name: str,
    bm: bmesh.types.BMesh,
    materials: Sequence[bpy.types.Material],
    arm_obj: bpy.types.Object,
    bone_name: str,
    collection: bpy.types.Collection,
) -> bpy.types.Object:
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    assign_box_uvs(bm, scale=4.5)
    mesh = bpy.data.meshes.new(name=name)
    bm.to_mesh(mesh)
    bm.free()
    for m in materials:
        mesh.materials.append(m)

    obj = bpy.data.objects.new(name=name, object_data=mesh)
    collection.objects.link(obj)
    obj.parent = arm_obj
    mod = obj.modifiers.new(name="Armature", type="ARMATURE")
    mod.object = arm_obj

    vg = obj.vertex_groups.new(name=bone_name)
    vg.add(list(range(len(mesh.vertices))), 1.0, "REPLACE")
    return obj


def add_muzzle_socket(
    name: str,
    muzzle_pc: Tuple[float, float, float],
    arm_obj: bpy.types.Object,
    collection: bpy.types.Collection,
) -> bpy.types.Object:
    empty = bpy.data.objects.new(name=name, object_data=None)
    empty.empty_display_type = "ARROWS"
    empty.empty_display_size = 0.04
    empty.location = pc_vec_to_bl(muzzle_pc)
    empty.parent = arm_obj
    collection.objects.link(empty)
    return empty


def set_weapon_bone_pose_pc(
    arm_obj: bpy.types.Object,
    bone_name: str,
    offset_pc: Tuple[float, float, float] = (0.0, 0.0, 0.0),
    euler_deg_pc: Tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> None:
    """Apply intuitive PlayCanvas translation `(dx, dy, dz)` and rotation `(pitchX, yawY, rollZ)` to `bone_name`."""
    bpy.context.view_layer.update()
    pb = arm_obj.pose.bones[bone_name]
    rest_mat = pb.bone.matrix_local.copy()

    # Delta transform in Blender armature space
    delta_t = pc_vec_to_bl(offset_pc)
    delta_r = Euler(
        (
            math.radians(euler_deg_pc[0]),
            math.radians(-euler_deg_pc[2]),
            math.radians(euler_deg_pc[1]),
        ),
        "XYZ",
    ).to_matrix().to_4x4()

    # Rotate around rest bone head, then translate
    pivot = rest_mat.translation.copy()
    t_to_origin = delta_r.copy()
    t_to_origin.identity()
    t_to_origin.translation = -pivot
    t_back = delta_r.copy()
    t_back.identity()
    t_back.translation = pivot + delta_t

    pb.matrix = t_back @ delta_r @ t_to_origin @ rest_mat
    bpy.context.view_layer.update()


def reset_weapon_pose(arm_obj: bpy.types.Object) -> None:
    for pb in arm_obj.pose.bones:
        pb.location = (0.0, 0.0, 0.0)
        pb.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
        pb.scale = (1.0, 1.0, 1.0)
    bpy.context.view_layer.update()


def keyframe_weapon_bones(arm_obj: bpy.types.Object, frame: int) -> None:
    for pb in arm_obj.pose.bones:
        pb.keyframe_insert(data_path="location", frame=frame)
        pb.keyframe_insert(data_path="rotation_quaternion", frame=frame)


def push_weapon_nla(arm_obj: bpy.types.Object, action: bpy.types.Action, name: str) -> None:
    slot = getattr(arm_obj.animation_data, "action_slot", None)
    track = arm_obj.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 1, action)
    strip.name = name
    if slot is not None and hasattr(strip, "action_slot"):
        strip.action_slot = slot
    track.mute = False
    arm_obj.animation_data.action = None


def export_collection_glb(collection: bpy.types.Collection, filepath: str) -> int:
    bpy.ops.object.select_all(action="DESELECT")
    poly_count = 0
    for obj in collection.objects:
        obj.select_set(True)
        if obj.type == "MESH" and obj.data is not None:
            poly_count += len(obj.data.polygons)
    bpy.ops.export_scene.gltf(
        filepath=filepath,
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=False,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_skins=True,
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_rest_position_armature=True,
        export_lights=False,
    )
    return poly_count


# ---------------------------------------------------------------------------
# 1. Mossberg 590 Tactical 12-Gauge (`m590_shotgun.glb`)
# ---------------------------------------------------------------------------

def build_m590_shotgun(mats: Dict[str, bpy.types.Material], scene_col: bpy.types.Collection) -> bpy.types.Collection:
    col = bpy.data.collections.new("Weapon_M590_Shotgun")
    scene_col.children.link(col)

    arm = create_weapon_armature(
        "M590Armature",
        [
            ("Bone_Root", None, (0.0, 0.0, 0.0), (0.0, 0.0, -0.25)),
            ("Bone_Pump", "Bone_Root", (0.0, -0.012, -0.28), (0.0, -0.012, -0.44)),
            ("Bone_Bolt", "Bone_Root", (0.016, 0.014, -0.05), (0.016, 0.014, -0.14)),
            ("Bone_Shell", "Bone_Root", (0.0, -0.032, -0.08), (0.0, -0.032, -0.15)),
            ("Bone_Muzzle", "Bone_Root", (0.0, 0.026, -0.645), (0.0, 0.026, -0.685)),
        ],
        col,
    )

    # Receiver + Barrel + Ventilated Heatshield + Mag Tube + Stock + Ghost-Ring Sights
    bm = bmesh.new()
    # Milled aluminum receiver
    add_box_pc(bm, (0.0, 0.008, -0.07), (0.022, 0.034, 0.115), bevel=0.003, mat_idx=1)
    # Top Picatinny rail + ghost-ring rear aperture wings
    add_box_pc(bm, (0.0, 0.046, -0.07), (0.011, 0.005, 0.095), bevel=0.001, mat_idx=1)
    add_box_pc(bm, (0.0, 0.058, 0.005), (0.012, 0.010, 0.012), bevel=0.002, mat_idx=0)
    add_box_pc(bm, (0.0, 0.062, 0.005), (0.004, 0.004, 0.004), bevel=0.001, mat_idx=4)
    # 20" Heavy cylinder bore barrel + under-barrel 8-shot magazine tube
    add_cylinder_z_pc(bm, 0.0, 0.026, -0.18, -0.64, 0.0135, 0.0130, sides=18, mat_idx=0)
    add_cylinder_z_pc(bm, 0.0, -0.008, -0.18, -0.60, 0.0125, 0.0125, sides=16, mat_idx=0)
    add_cylinder_z_pc(bm, 0.0, -0.008, -0.60, -0.625, 0.0145, 0.0140, sides=16, mat_idx=1)  # Mag cap
    # Barrel clamp + bayonet lug + winged front tritium sight
    add_box_pc(bm, (0.0, 0.009, -0.56), (0.016, 0.028, 0.014), bevel=0.002, mat_idx=1)
    add_box_pc(bm, (0.0, 0.050, -0.61), (0.009, 0.012, 0.014), bevel=0.0015, mat_idx=0)
    add_box_pc(bm, (0.0, 0.058, -0.61), (0.0025, 0.004, 0.004), bevel=0.0005, mat_idx=4)
    # Ventilated barrel heatshieldribs
    for rib_i in range(9):
        rz = -0.21 - rib_i * 0.034
        add_box_pc(bm, (0.0, 0.036, rz), (0.0155, 0.008, 0.010), bevel=0.0015, mat_idx=1)
    # Pistol grip + Synthetic buttstock + rubber recoil pad + trigger guard
    add_box_pc(bm, (0.0, -0.058, 0.035), (0.017, 0.050, 0.024), bevel=0.004, mat_idx=2, pitch_deg=24.0)
    add_box_pc(bm, (0.0, -0.012, 0.165), (0.019, 0.044, 0.125), bevel=0.005, mat_idx=2, pitch_deg=6.0)
    add_box_pc(bm, (0.0, -0.020, 0.292), (0.020, 0.056, 0.014), bevel=0.004, mat_idx=2)
    add_box_pc(bm, (0.0, -0.034, -0.015), (0.008, 0.014, 0.028), bevel=0.002, mat_idx=1)
    finalize_weapon_part(
        "M590_ReceiverBarrelStock", bm,
        [mats["parkerized_steel"], mats["anodized_black"], mats["polymer_grip"], mats["bolt_steel"], mats["tritium_sight"]],
        arm, "Bone_Root", col,
    )

    # Ribbed Corn-Cob Tactical Pump Forend (`Bone_Pump`)
    bm = bmesh.new()
    add_cylinder_z_pc(bm, 0.0, -0.010, -0.24, -0.44, 0.024, 0.023, sides=16, mat_idx=0)
    for g_i in range(7):
        gz = -0.26 - g_i * 0.026
        add_cylinder_z_pc(bm, 0.0, -0.010, gz, gz - 0.014, 0.0265, 0.0265, sides=16, mat_idx=1)
    finalize_weapon_part(
        "M590_PumpForend", bm, [mats["polymer_grip"], mats["polymer_fde"]], arm, "Bone_Pump", col
    )

    # Steel Bolt Carrier (`Bone_Bolt`)
    bm = bmesh.new()
    add_box_pc(bm, (0.012, 0.014, -0.085), (0.011, 0.012, 0.042), bevel=0.0015, mat_idx=0)
    finalize_weapon_part("M590_BoltCarrier", bm, [mats["bolt_steel"]], arm, "Bone_Bolt", col)

    # 12-Gauge Crimson/Brass Shell (`Bone_Shell`)
    bm = bmesh.new()
    add_cylinder_z_pc(bm, 0.0, -0.024, -0.065, -0.120, 0.010, 0.010, sides=14, mat_idx=0)
    add_cylinder_z_pc(bm, 0.0, -0.024, -0.048, -0.065, 0.0105, 0.0105, sides=14, mat_idx=1)
    finalize_weapon_part(
        "M590_Shell12G", bm, [mats["shell_red"], mats["brass_gold"]], arm, "Bone_Shell", col
    )

    add_muzzle_socket("MuzzleSocket", (0.0, 0.026, -0.645), arm, col)

    # Animations: Idle, FirePump, ReloadShell
    arm.animation_data_create()
    bpy.context.scene.render.fps = 24

    act = bpy.data.actions.new("Idle")
    arm.animation_data.action = act
    for f, dy, pitch in [(1, 0.0, 0.0), (25, 0.003, 0.35), (49, 0.0, 0.0)]:
        reset_weapon_pose(arm)
        set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, dy, 0.0), (pitch, 0.0, 0.0))
        keyframe_weapon_bones(arm, f)
    push_weapon_nla(arm, act, "Idle")

    act = bpy.data.actions.new("FirePump")
    arm.animation_data.action = act
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 1)
    # Frame 3: Heavy 12G recoil kick (+Z toward shoulder + muzzle climb)
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, 0.018, 0.065), (9.5, 0.0, -1.5))
    keyframe_weapon_bones(arm, 3)
    # Frame 9: Settle down & rack pump forend + bolt backward!
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, -0.008, 0.022), (3.0, 2.0, -4.0))
    set_weapon_bone_pose_pc(arm, "Bone_Pump", (0.0, 0.0, 0.105))
    set_weapon_bone_pose_pc(arm, "Bone_Bolt", (0.0, 0.0, 0.068))
    keyframe_weapon_bones(arm, 10)
    # Frame 16: Slam pump forend forward into battery
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, 0.004, -0.010), (-1.2, 0.0, 0.0))
    set_weapon_bone_pose_pc(arm, "Bone_Pump", (0.0, 0.0, 0.0))
    set_weapon_bone_pose_pc(arm, "Bone_Bolt", (0.0, 0.0, 0.0))
    keyframe_weapon_bones(arm, 16)
    # Frame 21: Clean return to ready
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 21)
    push_weapon_nla(arm, act, "FirePump")

    act = bpy.data.actions.new("ReloadShell")
    arm.animation_data.action = act
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 1)
    # Frame 7: Cant shotgun to expose bottom loading gate; shell approaches from below
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (-0.025, 0.025, 0.02), (12.0, 8.0, 26.0))
    set_weapon_bone_pose_pc(arm, "Bone_Shell", (0.01, -0.095, 0.04), (-22.0, 0.0, 0.0))
    keyframe_weapon_bones(arm, 7)
    # Frame 14: Thumb pushes 12G shell up & forward into magazine tube!
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (-0.022, 0.032, 0.012), (13.5, 8.0, 28.0))
    set_weapon_bone_pose_pc(arm, "Bone_Shell", (0.0, 0.012, -0.065), (0.0, 0.0, 0.0))
    keyframe_weapon_bones(arm, 14)
    # Frame 22: Return to ready
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 22)
    push_weapon_nla(arm, act, "ReloadShell")

    reset_weapon_pose(arm)
    export_collection_glb(col, os.path.join(OUT_DIR, "m590_shotgun.glb"))
    return col


# ---------------------------------------------------------------------------
# 2. Silver Talon .50 AE (`silver_talon_50ae.glb`)
# ---------------------------------------------------------------------------

def build_silver_talon_50ae(mats: Dict[str, bpy.types.Material], scene_col: bpy.types.Collection) -> bpy.types.Collection:
    col = bpy.data.collections.new("Weapon_SilverTalon_50AE")
    scene_col.children.link(col)

    arm = create_weapon_armature(
        "SilverTalonArmature",
        [
            ("Bone_Root", None, (0.0, 0.0, 0.0), (0.0, 0.0, -0.18)),
            ("Bone_Slide", "Bone_Root", (0.0, 0.026, 0.03), (0.0, 0.026, -0.12)),
            ("Bone_Mag", "Bone_Root", (0.0, -0.015, 0.008), (0.0, -0.115, 0.035)),
            ("Bone_Hammer", "Bone_Root", (0.0, 0.020, 0.048), (0.0, 0.042, 0.062)),
            ("Bone_Muzzle", "Bone_Root", (0.0, 0.032, -0.292), (0.0, 0.032, -0.332)),
        ],
        col,
    )

    # Brushed Chrome Frame + Triangular 6" Fluted Barrel + Wrap-Around Grip + Trigger Guard
    bm = bmesh.new()
    # Frame dustcover & rails
    add_box_pc(bm, (0.0, 0.002, -0.075), (0.017, 0.012, 0.125), bevel=0.002, mat_idx=0)
    # Iconic Desert Eagle Fixed Triangular Barrel + Flutes + Integral Weaver Slots
    add_box_pc(bm, (0.0, 0.030, -0.195), (0.016, 0.020, 0.088), bevel=0.004, mat_idx=0)
    add_box_pc(bm, (0.0, 0.048, -0.195), (0.011, 0.006, 0.084), bevel=0.002, mat_idx=0)
    add_cylinder_z_pc(bm, 0.0, 0.032, -0.10, -0.286, 0.0072, 0.0072, sides=14, mat_idx=1)  # .50 AE bore!
    # Front tritium sight blade
    add_box_pc(bm, (0.0, 0.058, -0.268), (0.003, 0.006, 0.008), bevel=0.001, mat_idx=1)
    add_box_pc(bm, (0.0, 0.061, -0.264), (0.0018, 0.002, 0.002), bevel=0.0004, mat_idx=3)
    # Ergonomic wrap-around rubberized grip + trigger guard + trigger
    add_box_pc(bm, (0.0, -0.058, 0.022), (0.0185, 0.058, 0.028), bevel=0.005, mat_idx=2, pitch_deg=16.0)
    add_box_pc(bm, (0.0, -0.022, -0.042), (0.007, 0.016, 0.032), bevel=0.002, mat_idx=0)
    add_box_pc(bm, (0.0, -0.016, -0.032), (0.0035, 0.012, 0.006), bevel=0.001, mat_idx=1, pitch_deg=18.0)
    finalize_weapon_part(
        "SilverTalon_FrameBarrelGrip", bm,
        [mats["brushed_chrome"], mats["anodized_black"], mats["polymer_grip"], mats["tritium_sight"]],
        arm, "Bone_Root", col,
    )

    # Reciprocating Chrome Slide (`Bone_Slide`) with rear serrations & combat rear sight
    bm = bmesh.new()
    add_box_pc(bm, (0.0, 0.028, -0.022), (0.0185, 0.020, 0.082), bevel=0.003, mat_idx=0)
    for s_i in range(6):
        sz = 0.015 + s_i * 0.0075
        add_box_pc(bm, (0.0, 0.026, sz), (0.0195, 0.014, 0.002), bevel=0.0005, mat_idx=1)
    add_box_pc(bm, (0.0, 0.054, 0.042), (0.012, 0.007, 0.010), bevel=0.0015, mat_idx=1)
    add_box_pc(bm, (0.0, 0.057, 0.048), (0.007, 0.0025, 0.002), bevel=0.0004, mat_idx=2)
    finalize_weapon_part(
        "SilverTalon_Slide", bm,
        [mats["brushed_chrome"], mats["anodized_black"], mats["tritium_sight"]],
        arm, "Bone_Slide", col,
    )

    # Heavy .50 AE Magazine (`Bone_Mag`) + Top Brass Cartridge
    bm = bmesh.new()
    add_box_pc(bm, (0.0, -0.062, 0.022), (0.014, 0.056, 0.022), bevel=0.002, mat_idx=0, pitch_deg=16.0)
    add_box_pc(bm, (0.0, -0.120, 0.039), (0.0175, 0.006, 0.027), bevel=0.002, mat_idx=1, pitch_deg=16.0)
    add_cylinder_z_pc(bm, 0.0, -0.004, 0.024, -0.016, 0.0068, 0.0064, sides=12, mat_idx=2)
    finalize_weapon_part(
        "SilverTalon_Magazine", bm,
        [mats["parkerized_steel"], mats["polymer_grip"], mats["brass_gold"]],
        arm, "Bone_Mag", col,
    )

    # Skeletonized Hammer (`Bone_Hammer`)
    bm = bmesh.new()
    add_box_pc(bm, (0.0, 0.030, 0.056), (0.0045, 0.014, 0.010), bevel=0.0015, mat_idx=0, pitch_deg=-25.0)
    finalize_weapon_part("SilverTalon_Hammer", bm, [mats["anodized_black"]], arm, "Bone_Hammer", col)

    add_muzzle_socket("MuzzleSocket", (0.0, 0.032, -0.292), arm, col)

    arm.animation_data_create()
    bpy.context.scene.render.fps = 24

    act = bpy.data.actions.new("Idle")
    arm.animation_data.action = act
    for f, dy, roll in [(1, 0.0, 0.0), (25, 0.0025, 0.6), (49, 0.0, 0.0)]:
        reset_weapon_pose(arm)
        set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, dy, 0.0), (0.0, 0.0, roll))
        keyframe_weapon_bones(arm, f)
    push_weapon_nla(arm, act, "Idle")

    act = bpy.data.actions.new("FireBlowback")
    arm.animation_data.action = act
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 1)
    # Frame 3: Massive .50 AE wrist snap + full slide blowback + hammer cocked back!
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, 0.024, 0.052), (16.5, -1.5, 2.5))
    set_weapon_bone_pose_pc(arm, "Bone_Slide", (0.0, 0.0, 0.058))
    set_weapon_bone_pose_pc(arm, "Bone_Hammer", (0.0, 0.0, 0.0), (-42.0, 0.0, 0.0))
    keyframe_weapon_bones(arm, 3)
    # Frame 7: Slide slams forward into battery while muzzle begins settling
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, 0.010, 0.018), (6.5, 0.0, 0.0))
    set_weapon_bone_pose_pc(arm, "Bone_Slide", (0.0, 0.0, 0.0))
    keyframe_weapon_bones(arm, 7)
    # Frame 14: Clean return
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 14)
    push_weapon_nla(arm, act, "FireBlowback")

    act = bpy.data.actions.new("ReloadMag")
    arm.animation_data.action = act
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 1)
    # Frame 7: Cant pistol & eject heavy .50 AE magazine downward
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (-0.02, 0.02, 0.01), (8.0, 12.0, 24.0))
    set_weapon_bone_pose_pc(arm, "Bone_Slide", (0.0, 0.0, 0.048))
    set_weapon_bone_pose_pc(arm, "Bone_Mag", (0.0, -0.22, 0.06))
    keyframe_weapon_bones(arm, 7)
    # Frame 15: Slam fresh magazine into magwell
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (-0.015, 0.032, 0.005), (10.0, 8.0, 18.0))
    set_weapon_bone_pose_pc(arm, "Bone_Slide", (0.0, 0.0, 0.048))
    set_weapon_bone_pose_pc(arm, "Bone_Mag", (0.0, 0.0, 0.0))
    keyframe_weapon_bones(arm, 15)
    # Frame 19: Drop slide release — slide slams forward!
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, 0.004, -0.012), (-2.0, 0.0, 0.0))
    keyframe_weapon_bones(arm, 19)
    # Frame 25: Ready
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 25)
    push_weapon_nla(arm, act, "ReloadMag")

    reset_weapon_pose(arm)
    export_collection_glb(col, os.path.join(OUT_DIR, "silver_talon_50ae.glb"))
    return col


# ---------------------------------------------------------------------------
# 3. H&K MSG90A1 7.62mm Marksman Rifle (`msg90_sniper.glb`)
# ---------------------------------------------------------------------------

def build_msg90_sniper(mats: Dict[str, bpy.types.Material], scene_col: bpy.types.Collection) -> bpy.types.Collection:
    col = bpy.data.collections.new("Weapon_MSG90_Sniper")
    scene_col.children.link(col)

    arm = create_weapon_armature(
        "MSG90Armature",
        [
            ("Bone_Root", None, (0.0, 0.0, 0.0), (0.0, 0.0, -0.35)),
            ("Bone_Mag", "Bone_Root", (0.0, -0.025, -0.10), (0.0, -0.145, -0.10)),
            ("Bone_ChargingHandle", "Bone_Root", (-0.018, 0.034, -0.34), (-0.042, 0.034, -0.34)),
            ("Bone_Bolt", "Bone_Root", (0.012, 0.016, -0.08), (0.012, 0.016, -0.17)),
            ("Bone_Muzzle", "Bone_Root", (0.0, 0.012, -0.82), (0.0, 0.012, -0.86)),
        ],
        col,
    )

    # Receiver + Free-Float Handguard + Long Heavy Barrel + Flash Hider + Scope + Folded Bipod + Cheek-Riser Stock
    bm = bmesh.new()
    # Reinforced HK stamped receiver + lower trigger pack
    add_box_pc(bm, (0.0, 0.014, -0.08), (0.021, 0.030, 0.145), bevel=0.003, mat_idx=1)
    add_box_pc(bm, (0.0, -0.020, -0.03), (0.018, 0.018, 0.085), bevel=0.002, mat_idx=2)
    # PSG/MSG ergonomic pistol grip with adjustable palm shelf
    add_box_pc(bm, (0.0, -0.068, 0.022), (0.017, 0.052, 0.024), bevel=0.004, mat_idx=2, pitch_deg=18.0)
    add_box_pc(bm, (0.0, -0.118, 0.038), (0.024, 0.007, 0.030), bevel=0.002, mat_idx=2)
    # Adjustable cheek-riser buttstock
    add_box_pc(bm, (0.0, 0.002, 0.195), (0.019, 0.040, 0.135), bevel=0.004, mat_idx=2)
    add_box_pc(bm, (0.0, 0.046, 0.175), (0.021, 0.014, 0.068), bevel=0.004, mat_idx=3)  # Raised cheek piece
    add_box_pc(bm, (0.0, -0.006, 0.335), (0.021, 0.056, 0.014), bevel=0.003, mat_idx=1)
    # Polygonal free-float handguard + cocking tube + long heavy barrel + flash hider
    add_box_pc(bm, (0.0, 0.008, -0.355), (0.022, 0.024, 0.135), bevel=0.005, mat_idx=2)
    add_cylinder_z_pc(bm, 0.0, 0.034, -0.22, -0.48, 0.010, 0.010, sides=14, mat_idx=0)  # HK cocking tube
    add_cylinder_z_pc(bm, 0.0, 0.012, -0.49, -0.76, 0.0115, 0.0105, sides=18, mat_idx=0)  # Heavy barrel
    add_cylinder_z_pc(bm, 0.0, 0.012, -0.76, -0.815, 0.0135, 0.0130, sides=16, mat_idx=1)  # Birdcage flash hider
    # Folded front precision bipod legs
    for sx in (-1.0, 1.0):
        add_cylinder_z_pc(bm, sx * 0.026, -0.022, -0.47, -0.29, 0.0065, 0.0065, sides=10, mat_idx=0)
        add_box_pc(bm, sx * 0.026 if False else (sx * 0.026, -0.022, -0.285), (0.009, 0.010, 0.010), bevel=0.002, mat_idx=2)
    # Claw Mount + Hensoldt 10x42 Telescopic Scope + Turrets + Coated Lenses
    for rz in (-0.03, -0.14):
        add_box_pc(bm, (0.0, 0.058, rz), (0.016, 0.018, 0.012), bevel=0.002, mat_idx=1)
    add_cylinder_z_pc(bm, 0.0, 0.078, 0.045, -0.195, 0.016, 0.016, sides=18, mat_idx=1)  # Main scope tube
    add_cylinder_z_pc(bm, 0.0, 0.078, 0.085, 0.045, 0.022, 0.017, sides=18, mat_idx=1)   # Ocular bell
    add_cylinder_z_pc(bm, 0.0, 0.078, -0.195, -0.265, 0.017, 0.026, sides=20, mat_idx=1)  # Objective bell
    add_cylinder_z_pc(bm, 0.0, 0.078, 0.086, 0.083, 0.019, 0.019, sides=18, mat_idx=4)   # Rear lens
    add_cylinder_z_pc(bm, 0.0, 0.078, -0.263, -0.266, 0.023, 0.023, sides=18, mat_idx=4) # Front lens
    add_box_pc(bm, (0.0, 0.100, -0.085), (0.010, 0.009, 0.010), bevel=0.002, mat_idx=0)  # Elevation turret
    add_box_pc(bm, (0.022, 0.078, -0.085), (0.009, 0.010, 0.010), bevel=0.002, mat_idx=0)  # Windage turret
    finalize_weapon_part(
        "MSG90_RifleOpticBipod", bm,
        [mats["parkerized_steel"], mats["anodized_black"], mats["polymer_grip"], mats["polymer_fde"], mats["optic_glass"]],
        arm, "Bone_Root", col,
    )

    # 20-Round 7.62x51mm Stamped Steel Box Magazine (`Bone_Mag`)
    bm = bmesh.new()
    add_box_pc(bm, (0.0, -0.082, -0.105), (0.0135, 0.062, 0.036), bevel=0.002, mat_idx=0)
    for rib_y in (-0.055, -0.082, -0.108):
        add_box_pc(bm, (0.0, rib_y, -0.105), (0.0148, 0.003, 0.032), bevel=0.0008, mat_idx=0)
    finalize_weapon_part("MSG90_Magazine20Rd", bm, [mats["parkerized_steel"]], arm, "Bone_Mag", col)

    # Forward HK Roller-Delayed Charging Handle (`Bone_ChargingHandle`) & Bolt (`Bone_Bolt`)
    bm = bmesh.new()
    add_box_pc(bm, (-0.024, 0.034, -0.34), (0.014, 0.006, 0.010), bevel=0.0015, mat_idx=0)
    finalize_weapon_part("MSG90_ChargingHandle", bm, [mats["polymer_grip"]], arm, "Bone_ChargingHandle", col)

    bm = bmesh.new()
    add_box_pc(bm, (0.012, 0.016, -0.115), (0.010, 0.011, 0.042), bevel=0.0015, mat_idx=0)
    finalize_weapon_part("MSG90_BoltCarrier", bm, [mats["bolt_steel"]], arm, "Bone_Bolt", col)

    add_muzzle_socket("MuzzleSocket", (0.0, 0.012, -0.82), arm, col)

    arm.animation_data_create()
    bpy.context.scene.render.fps = 24

    act = bpy.data.actions.new("Idle")
    arm.animation_data.action = act
    for f, dy in [(1, 0.0), (30, 0.002), (60, 0.0)]:
        reset_weapon_pose(arm)
        set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, dy, 0.0))
        keyframe_weapon_bones(arm, f)
    push_weapon_nla(arm, act, "Idle")

    act = bpy.data.actions.new("FireRecoil")
    arm.animation_data.action = act
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 1)
    # Frame 3: Crisp 7.62 NATO linear recoil + bolt reciprocation
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, 0.012, 0.055), (5.5, 0.0, -0.8))
    set_weapon_bone_pose_pc(arm, "Bone_Bolt", (0.0, 0.0, 0.065))
    keyframe_weapon_bones(arm, 3)
    # Frame 7: Bolt returns forward
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, 0.004, 0.016), (2.0, 0.0, 0.0))
    keyframe_weapon_bones(arm, 7)
    # Frame 15: Settle on target
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 15)
    push_weapon_nla(arm, act, "FireRecoil")

    act = bpy.data.actions.new("ReloadMag")
    arm.animation_data.action = act
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 1)
    # Frame 6: Lock charging handle back in HK notch
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (-0.015, 0.015, 0.02), (6.0, 6.0, 16.0))
    set_weapon_bone_pose_pc(arm, "Bone_ChargingHandle", (0.0, 0.012, 0.085), (0.0, 0.0, -35.0))
    keyframe_weapon_bones(arm, 6)
    # Frame 13: Drop empty 20-rd box mag
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (-0.02, 0.02, 0.02), (8.0, 8.0, 20.0))
    set_weapon_bone_pose_pc(arm, "Bone_ChargingHandle", (0.0, 0.012, 0.085), (0.0, 0.0, -35.0))
    set_weapon_bone_pose_pc(arm, "Bone_Mag", (0.0, -0.24, 0.02))
    keyframe_weapon_bones(arm, 13)
    # Frame 21: Seat fresh 20-rd box mag
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (-0.015, 0.028, 0.015), (9.0, 6.0, 16.0))
    set_weapon_bone_pose_pc(arm, "Bone_ChargingHandle", (0.0, 0.012, 0.085), (0.0, 0.0, -35.0))
    set_weapon_bone_pose_pc(arm, "Bone_Mag", (0.0, 0.0, 0.0))
    keyframe_weapon_bones(arm, 21)
    # Frame 26: Classic HK-slap charging handle release!
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (0.005, -0.006, -0.010), (-1.5, 0.0, -3.0))
    keyframe_weapon_bones(arm, 26)
    # Frame 32: Ready
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 32)
    push_weapon_nla(arm, act, "ReloadMag")

    reset_weapon_pose(arm)
    export_collection_glb(col, os.path.join(OUT_DIR, "msg90_sniper.glb"))
    return col


# ---------------------------------------------------------------------------
# 4. Colt M4A1 5.56mm SOPMOD Carbine (`m4a1_carbine.glb`)
# ---------------------------------------------------------------------------

def build_m4a1_carbine(mats: Dict[str, bpy.types.Material], scene_col: bpy.types.Collection) -> bpy.types.Collection:
    col = bpy.data.collections.new("Weapon_M4A1_Carbine")
    scene_col.children.link(col)

    arm = create_weapon_armature(
        "M4A1Armature",
        [
            ("Bone_Root", None, (0.0, 0.0, 0.0), (0.0, 0.0, -0.30)),
            ("Bone_Mag", "Bone_Root", (0.0, -0.025, -0.095), (0.0, -0.165, -0.125)),
            ("Bone_Bolt", "Bone_Root", (0.014, 0.018, -0.06), (0.014, 0.018, -0.14)),
            ("Bone_ChargingHandle", "Bone_Root", (0.0, 0.036, 0.035), (0.0, 0.036, -0.04)),
            ("Bone_Muzzle", "Bone_Root", (0.0, 0.016, -0.61), (0.0, 0.016, -0.65)),
        ],
        col,
    )

    # Forged Upper/Lower + RIS Quad-Rail + Step-Cut Barrel + A-Frame Sight + Holo/ACOG Optic + SOPMOD Stock
    bm = bmesh.new()
    # Upper & Lower Receiver + Magwell + Brass Deflector
    add_box_pc(bm, (0.0, 0.016, -0.055), (0.020, 0.026, 0.115), bevel=0.003, mat_idx=1)
    add_box_pc(bm, (0.0, -0.016, -0.092), (0.018, 0.024, 0.036), bevel=0.002, mat_idx=1)
    add_box_pc(bm, (0.022, 0.020, -0.015), (0.007, 0.010, 0.014), bevel=0.002, mat_idx=1)  # Brass deflector
    # A2 Pistol Grip + Trigger Guard
    add_box_pc(bm, (0.0, -0.062, 0.018), (0.016, 0.048, 0.022), bevel=0.004, mat_idx=2, pitch_deg=22.0)
    add_box_pc(bm, (0.0, -0.032, -0.035), (0.006, 0.008, 0.026), bevel=0.0015, mat_idx=1)
    # Buffer tube + Collapsible 6-position SOPMOD Crane Stock (FDE/Black)
    add_cylinder_z_pc(bm, 0.0, 0.016, 0.06, 0.25, 0.015, 0.015, sides=14, mat_idx=1)
    add_box_pc(bm, (0.0, 0.002, 0.195), (0.022, 0.042, 0.088), bevel=0.005, mat_idx=3)
    add_box_pc(bm, (0.0, -0.016, 0.284), (0.020, 0.054, 0.010), bevel=0.003, mat_idx=2)
    # RIS Quad-Rail Handguard + Picatinny Slots + FDE Rail Covers + Vertical Foregrip
    add_box_pc(bm, (0.0, 0.016, -0.275), (0.024, 0.026, 0.105), bevel=0.003, mat_idx=1)
    for sx in (-1.0, 1.0):
        add_box_pc(bm, (sx * 0.025, 0.016, -0.275), (0.004, 0.014, 0.078), bevel=0.002, mat_idx=3)
    add_cylinder_z_pc(bm, 0.0, -0.042, -0.275, -0.275 - 0.001, 0.014, 0.014, sides=12, mat_idx=2)
    add_box_pc(bm, (0.0, -0.048, -0.275), (0.014, 0.038, 0.014), bevel=0.004, mat_idx=2)  # Vertical foregrip
    # 14.5" M4 Step-Cut Barrel + A-Frame Front Sight Post + A2 Birdcage Flash Suppressor
    add_cylinder_z_pc(bm, 0.0, 0.016, -0.38, -0.56, 0.0095, 0.0090, sides=16, mat_idx=0)
    add_cylinder_z_pc(bm, 0.0, 0.016, -0.56, -0.605, 0.0115, 0.0115, sides=16, mat_idx=0)
    add_box_pc(bm, (0.0, 0.046, -0.415), (0.007, 0.028, 0.022), bevel=0.002, mat_idx=0, pitch_deg=-14.0)
    # Tactical Holographic / ACOG Combat Optic on Upper Receiver Rail
    add_box_pc(bm, (0.0, 0.058, -0.055), (0.019, 0.020, 0.052), bevel=0.003, mat_idx=1)
    add_box_pc(bm, (0.0, 0.062, -0.055), (0.014, 0.013, 0.004), bevel=0.0005, mat_idx=4)  # Illuminated reticle glass
    finalize_weapon_part(
        "M4A1_ReceiverRailBarrelOptic", bm,
        [mats["parkerized_steel"], mats["anodized_black"], mats["polymer_grip"], mats["polymer_fde"], mats["optic_glass"]],
        arm, "Bone_Root", col,
    )

    # Curved 30-Round STANAG Magazine (`Bone_Mag`)
    bm = bmesh.new()
    add_box_pc(bm, (0.0, -0.065, -0.098), (0.012, 0.042, 0.031), bevel=0.002, mat_idx=0, pitch_deg=-6.0)
    add_box_pc(bm, (0.0, -0.138, -0.114), (0.012, 0.042, 0.031), bevel=0.002, mat_idx=0, pitch_deg=-16.0)
    finalize_weapon_part("M4A1_STANAG_Mag30", bm, [mats["parkerized_steel"]], arm, "Bone_Mag", col)

    # Bolt Carrier Group (`Bone_Bolt`) + T-Charging Handle (`Bone_ChargingHandle`)
    bm = bmesh.new()
    add_box_pc(bm, (0.013, 0.018, -0.075), (0.009, 0.010, 0.038), bevel=0.001, mat_idx=0)
    finalize_weapon_part("M4A1_BoltCarrier", bm, [mats["bolt_steel"]], arm, "Bone_Bolt", col)

    bm = bmesh.new()
    add_box_pc(bm, (0.0, 0.036, 0.048), (0.022, 0.005, 0.008), bevel=0.0015, mat_idx=0)
    add_box_pc(bm, (0.0, 0.036, 0.008), (0.005, 0.004, 0.040), bevel=0.001, mat_idx=0)
    finalize_weapon_part("M4A1_ChargingHandle", bm, [mats["anodized_black"]], arm, "Bone_ChargingHandle", col)

    add_muzzle_socket("MuzzleSocket", (0.0, 0.016, -0.61), arm, col)

    arm.animation_data_create()
    bpy.context.scene.render.fps = 24

    act = bpy.data.actions.new("Idle")
    arm.animation_data.action = act
    for f, dy, pitch in [(1, 0.0, 0.0), (24, 0.0025, 0.3), (48, 0.0, 0.0)]:
        reset_weapon_pose(arm)
        set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, dy, 0.0), (pitch, 0.0, 0.0))
        keyframe_weapon_bones(arm, f)
    push_weapon_nla(arm, act, "Idle")

    act = bpy.data.actions.new("FireCycle")
    arm.animation_data.action = act
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 1)
    # Frame 2: Fast 750-RPM 5.56mm impulse + BCG reciprocation
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, 0.007, 0.034), (3.2, -0.4, 0.8))
    set_weapon_bone_pose_pc(arm, "Bone_Bolt", (0.0, 0.0, 0.056))
    keyframe_weapon_bones(arm, 2)
    # Frame 5: BCG slams forward
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, 0.002, 0.008), (0.9, 0.0, 0.0))
    keyframe_weapon_bones(arm, 5)
    # Frame 9: Ready
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 9)
    push_weapon_nla(arm, act, "FireCycle")

    act = bpy.data.actions.new("ReloadMag")
    arm.animation_data.action = act
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 1)
    # Frame 7: Cant carbine & drop STANAG mag
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (-0.018, 0.018, 0.015), (7.0, 10.0, 22.0))
    set_weapon_bone_pose_pc(arm, "Bone_Bolt", (0.0, 0.0, 0.048))
    set_weapon_bone_pose_pc(arm, "Bone_Mag", (0.0, -0.24, -0.02))
    keyframe_weapon_bones(arm, 7)
    # Frame 15: Insert fresh STANAG mag
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (-0.014, 0.026, 0.010), (8.5, 8.0, 18.0))
    set_weapon_bone_pose_pc(arm, "Bone_Bolt", (0.0, 0.0, 0.048))
    set_weapon_bone_pose_pc(arm, "Bone_Mag", (0.0, 0.0, 0.0))
    keyframe_weapon_bones(arm, 15)
    # Frame 20: Pull T-charging handle / bolt catch release!
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, 0.008, 0.024), (3.0, 0.0, 4.0))
    set_weapon_bone_pose_pc(arm, "Bone_ChargingHandle", (0.0, 0.0, 0.058))
    keyframe_weapon_bones(arm, 20)
    # Frame 26: Ready
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 26)
    push_weapon_nla(arm, act, "ReloadMag")

    reset_weapon_pose(arm)
    export_collection_glb(col, os.path.join(OUT_DIR, "m4a1_carbine.glb"))
    return col


# ---------------------------------------------------------------------------
# 5. M67 Fragmentation Grenade (`frag_grenade.glb`)
# ---------------------------------------------------------------------------

def build_frag_grenade(mats: Dict[str, bpy.types.Material], scene_col: bpy.types.Collection) -> bpy.types.Collection:
    col = bpy.data.collections.new("Weapon_M67_FragGrenade")
    scene_col.children.link(col)

    arm = create_weapon_armature(
        "FragGrenadeArmature",
        [
            ("Bone_Body", None, (0.0, -0.032, 0.0), (0.0, 0.048, 0.0)),
            ("Bone_Spoon", "Bone_Body", (0.0, 0.046, 0.008), (0.0, -0.018, 0.038)),
            ("Bone_PinRing", "Bone_Body", (-0.016, 0.044, 0.0), (-0.042, 0.036, 0.0)),
        ],
        col,
    )

    # Segmented Olive-Drab Cast-Steel Body + Equatorial Crimp Seam + M213 Fuze Neck
    bm = bmesh.new()
    add_uv_sphere_pc(bm, (0.0, 0.0, 0.0), (0.033, 0.034, 0.033), segments=20, rings=14, mat_idx=0)
    # Equatorial crimp band
    add_uv_sphere_pc(bm, (0.0, 0.0, 0.0), (0.0348, 0.005, 0.0348), segments=20, rings=6, mat_idx=0)
    # M213 Zinc/Steel Fuze Collar & Striker Head (along +Y vertical!)
    add_box_pc(bm, (0.0, 0.038, 0.0), (0.012, 0.010, 0.012), bevel=0.003, mat_idx=1)
    add_box_pc(bm, (0.0, 0.050, 0.0), (0.015, 0.007, 0.016), bevel=0.002, mat_idx=1)
    finalize_weapon_part(
        "M67_GrenadeBody", bm, [mats["olive_drab"], mats["fuze_zinc"]], arm, "Bone_Body", col
    )

    # Curved Sheet-Metal Safety Spoon Lever (`Bone_Spoon`)
    bm = bmesh.new()
    add_box_pc(bm, (0.0, 0.052, 0.010), (0.009, 0.004, 0.016), bevel=0.0015, mat_idx=0)
    add_box_pc(bm, (0.0, 0.016, 0.033), (0.008, 0.034, 0.003), bevel=0.001, mat_idx=0, pitch_deg=18.0)
    finalize_weapon_part("M67_SpoonLever", bm, [mats["olive_drab"]], arm, "Bone_Spoon", col)

    # Split Cotter Pin + Circular Pull Ring (`Bone_PinRing`)
    bm = bmesh.new()
    add_box_pc(bm, (0.0, 0.046, 0.0), (0.018, 0.002, 0.002), bevel=0.0005, mat_idx=0)
    # Octagonal steel pull ring on left side (-X)
    ring_c = (-0.028, 0.036, 0.0)
    for seg_i in range(8):
        a0 = (2.0 * math.pi * seg_i) / 8.0
        ry = ring_c[1] + math.sin(a0) * 0.013
        rz = ring_c[2] + math.cos(a0) * 0.013
        add_box_pc(bm, (ring_c[0], ry, rz), (0.002, 0.0035, 0.0035), bevel=0.0008, mat_idx=1)
    finalize_weapon_part(
        "M67_PullPinRing", bm, [mats["fuze_zinc"], mats["brass_gold"]], arm, "Bone_PinRing", col
    )

    arm.animation_data_create()
    bpy.context.scene.render.fps = 24

    act = bpy.data.actions.new("Idle")
    arm.animation_data.action = act
    for f, dy in [(1, 0.0), (24, 0.002), (48, 0.0)]:
        reset_weapon_pose(arm)
        set_weapon_bone_pose_pc(arm, "Bone_Body", (0.0, dy, 0.0))
        keyframe_weapon_bones(arm, f)
    push_weapon_nla(arm, act, "Idle")

    act = bpy.data.actions.new("FirePinPull")
    arm.animation_data.action = act
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 1)
    # Frame 6: Yank pull-pin out to the left
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_PinRing", (-0.065, -0.015, 0.02), (0.0, 0.0, 35.0))
    keyframe_weapon_bones(arm, 6)
    # Frame 14: Throw release — safety spoon flips off!
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_PinRing", (-0.12, -0.06, 0.04), (0.0, 0.0, 65.0))
    set_weapon_bone_pose_pc(arm, "Bone_Spoon", (0.02, 0.08, 0.06), (-115.0, 20.0, 0.0))
    keyframe_weapon_bones(arm, 14)
    push_weapon_nla(arm, act, "FirePinPull")

    act = bpy.data.actions.new("ReloadReady")
    arm.animation_data.action = act
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Body", (0.0, -0.08, 0.04), (-25.0, 0.0, 0.0))
    keyframe_weapon_bones(arm, 1)
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 12)
    push_weapon_nla(arm, act, "ReloadReady")

    reset_weapon_pose(arm)
    export_collection_glb(col, os.path.join(OUT_DIR, "frag_grenade.glb"))
    return col


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(OUT_BLEND), exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0

    mats = build_weapon_materials()
    cols = [
        build_m590_shotgun(mats, scene.collection),
        build_silver_talon_50ae(mats, scene.collection),
        build_msg90_sniper(mats, scene.collection),
        build_m4a1_carbine(mats, scene.collection),
        build_frag_grenade(mats, scene.collection),
    ]

    # Space the 5 weapons neatly side-by-side along X in `weapons_arsenal.blend` for Blender 5.2 GUI inspection!
    showcase_x = [-0.90, -0.45, 0.0, 0.45, 0.85]
    for col, x_off in zip(cols, showcase_x):
        for obj in col.objects:
            if obj.parent is None:
                obj.location.x += x_off

    bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND)

    for fname in ["m590_shotgun.glb", "silver_talon_50ae.glb", "msg90_sniper.glb", "m4a1_carbine.glb", "frag_grenade.glb"]:
        fpath = os.path.join(OUT_DIR, fname)
        print(f"[Weapon Pipeline] {fname}: {os.path.getsize(fpath) / 1024.0:.1f} KB")


if __name__ == "__main__":
    main()
