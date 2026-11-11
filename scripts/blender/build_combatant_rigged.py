#!/usr/bin/env python3
"""
Procedural Blender 5.2.1 LTS Pipeline — GHOUL-X Rigged & Animated Tactical Combatant.

Generates:
  - public/models/ghoul_combatant.glb
  - public/models/blend_sources/ghoul_combatant.blend

Coordinate Convention:
  - PlayCanvas / glTF 2.0 (+Y Up):
      Feet grounded at y = 0.00m, Crown at y = 1.80m, Character facing +Z
      (-X = Anatomical Left, +X = Anatomical Right per GHOUL_ZONE_HIERARCHY).
  - Blender 5.2 (+Z Up, -Y Forward):
      pc_to_bl(x, y, z) = Vector((x, -z, y))
      When exported with `export_yup=True`, Blender (x, -z, y) maps 1:1 to glTF (x, y, z).

Submeshes (35 total, all manifold, seam-free cylindrical UVs, PBR-textured, and skinned to `GhoulArmature`):
  - 22 GHOUL Gore Zone Submeshes (`Zone_PELVIS_GROIN` .. `Zone_FOOT_RIGHT`)
  - 6 Modular Tactical Armor, Archetype Headgear & Gore Submeshes:
      `Gear_ESAPI_PlateCarrier`, `Gear_PASGT_Helmet`, `Gear_TacticalVisor`,
      `Gear_SpetsnazBeret`, `Gear_PunkMohawk`, `Gear_EvisceratedGut`
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
from typing import Callable, Dict, List, Optional, Sequence, Tuple

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


def clamp01(v: float) -> float:
    return 0.0 if v < 0.0 else (1.0 if v > 1.0 else v)


def hash2f(ix: int, iy: int, seed: int) -> float:
    n = ((ix * 374761393) + (iy * 668265263) + (seed * 1442695041)) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((n ^ (n >> 16)) & 0xFFFF) / 65535.0


# ---------------------------------------------------------------------------
# Procedural Baked PBR Albedo Textures & Materials (Blender 5.2 Principled BSDF)
# ---------------------------------------------------------------------------

def make_procedural_image(
    name: str,
    size: int,
    painter: Callable[[int, int, float, float], Tuple[float, float, float]],
) -> bpy.types.Image:
    img = bpy.data.images.new(name=name, width=size, height=size, alpha=False)
    img.colorspace_settings.name = "sRGB"
    pixels = [1.0] * (size * size * 4)
    for y in range(size):
        v = (y + 0.5) / size
        row_base = y * size * 4
        for x in range(size):
            u = (x + 0.5) / size
            r, g, b = painter(x, y, u, v)
            idx = row_base + x * 4
            pixels[idx] = clamp01(r)
            pixels[idx + 1] = clamp01(g)
            pixels[idx + 2] = clamp01(b)
            pixels[idx + 3] = 1.0
    img.pixels.foreach_set(pixels)
    img.pack()
    return img


def make_pbr_material(
    name: str,
    base_color: Tuple[float, float, float, float],
    roughness: float = 0.65,
    metallic: float = 0.0,
    emission_color: Optional[Tuple[float, float, float, float]] = None,
    emission_strength: float = 0.0,
    albedo_image: Optional[bpy.types.Image] = None,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name=name)
    if mat.node_tree is None:
        mat.use_nodes = True
    nt = mat.node_tree
    nodes = nt.nodes
    links = nt.links
    bsdf = nodes.get("Principled BSDF")
    if bsdf is None:
        bsdf = nodes.new(type="ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = base_color
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic

    if albedo_image is not None:
        tex_node = nodes.new(type="ShaderNodeTexImage")
        tex_node.image = albedo_image
        tex_node.interpolation = "Linear"
        links.new(tex_node.outputs["Color"], bsdf.inputs["Base Color"])

    if emission_color is not None and "Emission Color" in bsdf.inputs:
        bsdf.inputs["Emission Color"].default_value = emission_color
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


def build_palette() -> Dict[str, bpy.types.Material]:
    S = 128

    def paint_head(x: int, y: int, u: float, v: float) -> Tuple[float, float, float]:
        n = (hash2f(x, y, 17) - 0.5) * 0.04
        du = abs(u - 0.5)
        # Warm tactical skin tone
        r, g, b = 0.76 + n, 0.56 + n * 0.9, 0.44 + n * 0.8
        # Shaved military buzzcut on crown & back of head
        if v > 0.72 or (du > 0.27 and v > 0.28):
            stubble = (hash2f(x, y, 31) - 0.5) * 0.05
            fade = clamp01((max(v - 0.68, du - 0.25)) * 7.0)
            hr, hg, hb = 0.22 + stubble, 0.18 + stubble, 0.15 + stubble
            r = r * (1.0 - fade) + hr * fade
            g = g * (1.0 - fade) + hg * fade
            b = b * (1.0 - fade) + hb * fade
        # Furrowed eyebrows (anatomically positioned at orbital brow ridge v ~ 0.46)
        if 0.45 <= v <= 0.495 and 0.026 <= du <= 0.118:
            return (0.16 + n * 0.5, 0.12 + n * 0.5, 0.09 + n * 0.5)
        # Orbital socket shadow + forward-set eyes (u = 0.5 +/- 0.068, v = 0.405)
        eye_dx = (du - 0.068) / 0.034
        eye_dy = (v - 0.405) / 0.032
        eye_r2 = eye_dx * eye_dx + eye_dy * eye_dy
        if eye_r2 < 1.0:
            iris_r2 = ((du - 0.066) / 0.016) ** 2 + ((v - 0.406) / 0.022) ** 2
            pupil_r2 = ((du - 0.066) / 0.008) ** 2 + ((v - 0.406) / 0.012) ** 2
            if pupil_r2 < 1.0:
                return (0.05, 0.05, 0.06)
            if iris_r2 < 1.0:
                return (0.22, 0.27, 0.21)
            return (0.88, 0.86, 0.84)
        elif eye_r2 < 1.65:
            r, g, b = r - 0.08, g - 0.07, b - 0.06
        # Nose bridge & nostril shadow
        if du < 0.028 and 0.20 < v < 0.44:
            r, g, b = r + 0.04, g + 0.03, b + 0.02
        if 0.010 < du < 0.032 and 0.15 < v < 0.21:
            r, g, b = r - 0.15, g - 0.12, b - 0.10
        return (r, g, b)

    def paint_jaw(x: int, y: int, u: float, v: float) -> Tuple[float, float, float]:
        n = (hash2f(x, y, 43) - 0.5) * 0.035
        du = abs(u - 0.5)
        # Fade stubble cleanly toward upper maxilla seam (v -> 1.0) so jaw blends seamlessly into cranium skin!
        stubble_mask = clamp01(1.0 - max(0.0, v - 0.58) * 2.5)
        stubble = (-0.045 if ((x + y) & 1) == 0 else -0.012) * stubble_mask
        r, g, b = 0.76 + stubble + n, 0.56 + stubble + n * 0.9, 0.44 + stubble + n * 0.8
        # Mouth & lips around v = 0.58
        if du < 0.072 and 0.52 <= v <= 0.65:
            if 0.575 <= v <= 0.60:
                return (0.22, 0.09, 0.09)
            return (0.58 + n * 0.5, 0.35 + n * 0.4, 0.31 + n * 0.4)
        # Under-chin shadow
        if v < 0.20:
            r, g, b = r - 0.07, g - 0.06, b - 0.05
        return (r, g, b)

    def paint_arm_skin(x: int, y: int, u: float, v: float) -> Tuple[float, float, float]:
        n = (hash2f(x, y, 59) - 0.5) * 0.035
        muscle_shade = math.sin(u * math.pi * 4.0) * 0.035
        return (0.72 + n + muscle_shade, 0.53 + n + muscle_shade * 0.8, 0.41 + n + muscle_shade * 0.7)

    def paint_shirt_charcoal(x: int, y: int, u: float, v: float) -> Tuple[float, float, float]:
        n = (hash2f(x, y, 71) - 0.5) * 0.03
        rib = 0.014 if (x % 3 == 0) else -0.008
        du = abs(u - 0.5)
        fold = math.sin(v * 22.0 + du * 8.0) * 0.022
        # Pectoral / side-panel tactical stitching
        seam = -0.045 if (abs(du - 0.19) < 0.012 or abs(v - 0.56) < 0.010) else 0.0
        base_r, base_g, base_b = 0.17, 0.19, 0.21
        if du > 0.22 and du < 0.34:
            # Breathable darker side-mesh gusset
            base_r, base_g, base_b = 0.12, 0.13, 0.15
        return (base_r + n + rib + fold + seam, base_g + n + rib + fold + seam, base_b + n + rib + fold + seam)

    def paint_bdu_olive(x: int, y: int, u: float, v: float) -> Tuple[float, float, float]:
        n = (hash2f(x, y, 89) - 0.5) * 0.035
        ripstop = -0.016 if (x % 4 == 0 or y % 4 == 0) else 0.006
        crease = math.sin(v * 20.0 + math.sin(u * 12.0) * 1.5) * 0.028
        seam = -0.04 if abs(abs(u - 0.5) - 0.25) < 0.010 else 0.0
        return (0.22 + n + ripstop + crease + seam, 0.26 + n + ripstop + crease + seam, 0.17 + n + ripstop + crease + seam)

    def paint_webbing(x: int, y: int, u: float, v: float) -> Tuple[float, float, float]:
        n = (hash2f(x, y, 103) - 0.5) * 0.03
        molle = -0.05 if (y % 16 in (0, 1) or (x % 16 == 0 and (y // 16) % 2 == 0)) else 0.01
        return (0.38 + n + molle, 0.32 + n + molle * 0.9, 0.21 + n + molle * 0.8)

    def paint_boot(x: int, y: int, u: float, v: float) -> Tuple[float, float, float]:
        n = (hash2f(x, y, 113) - 0.5) * 0.025
        du = abs(u - 0.5)
        if v < 0.20:
            lug = -0.03 if (x % 8 < 4) else 0.02
            return (0.07 + lug, 0.07 + lug, 0.08 + lug)
        if du < 0.075 and 0.26 < v < 0.86:
            lace = 0.16 if (y % 7 in (0, 1)) else 0.04
            return (lace, lace, lace + 0.01)
        crease = math.sin(v * 24.0) * 0.018
        return (0.11 + n + crease, 0.11 + n + crease, 0.12 + n + crease)

    def paint_kevlar(x: int, y: int, _u: float, _v: float) -> Tuple[float, float, float]:
        n = (hash2f(x, y, 131) - 0.5) * 0.025
        weave = 0.018 if ((x + y) % 4 < 2) else -0.014
        return (0.21 + n + weave, 0.24 + n + weave, 0.18 + n + weave)

    img_head = make_procedural_image("Tex_Combatant_Head", S, paint_head)
    img_jaw = make_procedural_image("Tex_Combatant_Jaw", S, paint_jaw)
    img_arm_skin = make_procedural_image("Tex_Combatant_ArmSkin", 64, paint_arm_skin)
    img_shirt = make_procedural_image("Tex_Combatant_Shirt", S, paint_shirt_charcoal)
    img_bdu = make_procedural_image("Tex_Combatant_BDU", S, paint_bdu_olive)
    img_web = make_procedural_image("Tex_Combatant_Webbing", 64, paint_webbing)
    img_boot = make_procedural_image("Tex_Combatant_Boot", S, paint_boot)
    img_kevlar = make_procedural_image("Tex_Combatant_Kevlar", 64, paint_kevlar)

    return {
        "head_skin": make_pbr_material("Mat_Head_Sculpted", (1.0, 1.0, 1.0, 1.0), roughness=0.58, albedo_image=img_head),
        "jaw_skin": make_pbr_material("Mat_Jaw_Sculpted", (1.0, 1.0, 1.0, 1.0), roughness=0.60, albedo_image=img_jaw),
        "skin_tone": make_pbr_material("Mat_Skin_Tactical", (1.0, 1.0, 1.0, 1.0), roughness=0.58, albedo_image=img_arm_skin),
        "bdu_olive": make_pbr_material("Mat_BDU_OliveDrab", (1.0, 1.0, 1.0, 1.0), roughness=0.82, albedo_image=img_bdu),
        "shirt_charcoal": make_pbr_material("Mat_CombatShirt_Charcoal", (1.0, 1.0, 1.0, 1.0), roughness=0.76, albedo_image=img_shirt),
        "webbing_tan": make_pbr_material("Mat_TacticalWebbing_Coyote", (1.0, 1.0, 1.0, 1.0), roughness=0.78, albedo_image=img_web),
        "boot_leather": make_pbr_material("Mat_CombatBoot_Leather", (1.0, 1.0, 1.0, 1.0), roughness=0.52, albedo_image=img_boot),
        "polymer_dark": make_pbr_material("Mat_Polymer_ArmorPad", (0.10, 0.11, 0.12, 1.0), roughness=0.40, metallic=0.14),
        "visor_glass": make_pbr_material("Mat_EyePro_Visor", (0.03, 0.05, 0.08, 1.0), roughness=0.12, metallic=0.78),
        "glove_leather": make_pbr_material("Mat_Glove_NomexLeather", (0.055, 0.06, 0.065, 1.0), roughness=0.62),
        "esapi_plate": make_pbr_material("Mat_ESAPI_PlateCarrier", (1.0, 1.0, 1.0, 1.0), roughness=0.68, metallic=0.06, albedo_image=img_kevlar),
        "helmet_kevlar": make_pbr_material("Mat_PASGT_Kevlar", (1.0, 1.0, 1.0, 1.0), roughness=0.62, metallic=0.05, albedo_image=img_kevlar),
        "beret_crimson": make_pbr_material("Mat_Spetsnaz_Beret", (0.32, 0.025, 0.045, 1.0), roughness=0.82),
        "mohawk_punk": make_pbr_material("Mat_Punk_Mohawk", (0.68, 0.04, 0.04, 1.0), roughness=0.72),
        "gore_viscera": make_pbr_material(
            "Mat_Gore_Viscera", (0.48, 0.03, 0.04, 1.0), roughness=0.22,
            emission_color=(0.18, 0.01, 0.01, 1.0), emission_strength=0.12
        ),
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
# Anatomical BMesh Lofting & Sculpting Primitives (Seam-Free Cylindrical UVs)
# ---------------------------------------------------------------------------

SculptModifier = Callable[[float, float, float, float], Tuple[float, float, float]]


def compute_segment_basis_bl(
    p0: Vector,
    p1: Vector,
) -> Tuple[Vector, float, Vector, Vector, Vector]:
    axis = p1 - p0
    seg_len = max(1e-4, axis.length)
    tangent = axis / seg_len

    # Forward reference in Blender is -Y (glTF +Z)
    fwd_ref = Vector((0.0, -1.0, 0.0))
    if abs(tangent.dot(fwd_ref)) > 0.94:
        fwd_ref = Vector((0.0, 0.0, 1.0))

    basis_right = fwd_ref.cross(tangent).normalized()
    if basis_right.length < 1e-4:
        basis_right = Vector((1.0, 0.0, 0.0))
    if basis_right.x < 0 and abs(tangent.x) < 0.75:
        basis_right = -basis_right

    basis_fwd = tangent.cross(basis_right).normalized()
    if basis_fwd.y > 0 and abs(tangent.y) < 0.75:
        basis_fwd = -basis_fwd
        basis_right = basis_fwd.cross(tangent).normalized()
        if basis_right.x < 0 and abs(tangent.x) < 0.75:
            basis_right = -basis_right

    return axis, seg_len, tangent, basis_right, basis_fwd


def add_sculpted_loft(
    bm: bmesh.types.BMesh,
    p_start_pc: Tuple[float, float, float],
    p_end_pc: Tuple[float, float, float],
    stations: Sequence[Tuple[float, float, float, float, float]],
    sides: int = 16,
    mat_index: int = 0,
    cap_ends: bool = True,
    start_dome_scale: float = 0.30,
    end_dome_scale: float = 0.30,
    v_Ascending: bool = True,
    sculpt_fn: Optional[SculptModifier] = None,
) -> List[bmesh.types.BMVert]:
    """
    Lofts a closed manifold anatomical segment from `p_start_pc` to `p_end_pc`.
    UV convention matches PlayCanvas `retroTextures.ts`:
      - `s = sides/2` (`theta = 0`) is `+Z` (front) -> `u = 0.5`
      - `s = 0` and `s = sides` are `-Z` (rear) -> `u = 0.0` and `u = 1.0` cleanly without seam wrap!
      - `v` runs `0.0 -> 1.0` from bottom to top (or reversed when `v_Ascending=False`, e.g. downward limb bones).
    """
    uv_layer = bm.loops.layers.uv.verify()
    p0 = pc_vec_to_bl(p_start_pc)
    p1 = pc_vec_to_bl(p_end_pc)
    axis, _seg_len, tangent, basis_right, basis_fwd = compute_segment_basis_bl(p0, p1)

    rings: List[List[bmesh.types.BMVert]] = []
    ring_vs: List[float] = []
    created_verts: List[bmesh.types.BMVert] = []

    t_min = stations[0][0]
    t_span = max(1e-4, stations[-1][0] - t_min)

    for t, rr, rf, off_r, off_f in stations:
        norm_t = clamp01((t - t_min) / t_span)
        v_coord = norm_t if v_Ascending else (1.0 - norm_t)
        ring_vs.append(v_coord)

        center = p0 + axis * t + basis_right * off_r + basis_fwd * off_f
        ring_verts: List[bmesh.types.BMVert] = []
        for s in range(sides):
            # s = 0 -> theta = -pi (-Z back); s = sides/2 -> theta = 0 (+Z front); s -> sides -> +pi (-Z back)
            theta = ((s / sides) - 0.5) * 2.0 * math.pi
            local_r = math.sin(theta) * rr
            local_f = math.cos(theta) * rf
            dt_shift = 0.0
            if sculpt_fn is not None:
                local_r, local_f, dt_shift = sculpt_fn(norm_t, theta, local_r, local_f)
            pt = center + basis_right * local_r + basis_fwd * local_f + tangent * dt_shift
            v = bm.verts.new(pt)
            ring_verts.append(v)
            created_verts.append(v)
        rings.append(ring_verts)

    for r_idx in range(len(rings) - 1):
        r0 = rings[r_idx]
        r1 = rings[r_idx + 1]
        v0 = ring_vs[r_idx]
        v1 = ring_vs[r_idx + 1]
        for s in range(sides):
            sn = (s + 1) % sides
            u0 = s / sides
            u1 = (s + 1) / sides
            f = bm.faces.new((r0[s], r0[sn], r1[sn], r1[s]))
            f.material_index = mat_index
            f.smooth = True
            f.loops[0][uv_layer].uv = (u0, v0)
            f.loops[1][uv_layer].uv = (u1, v0)
            f.loops[2][uv_layer].uv = (u1, v1)
            f.loops[3][uv_layer].uv = (u0, v1)

    if cap_ends and len(rings) >= 2:
        t0, rr0, rf0, or0, of0 = stations[0]
        c_start = (
            p0
            + axis * t0
            + basis_right * or0
            + basis_fwd * of0
            - tangent * (0.5 * (rr0 + rf0) * start_dome_scale)
        )
        v_cap0 = bm.verts.new(c_start)
        created_verts.append(v_cap0)
        vc0 = ring_vs[0]
        for s in range(sides):
            sn = (s + 1) % sides
            f = bm.faces.new((v_cap0, rings[0][sn], rings[0][s]))
            f.material_index = mat_index
            f.smooth = True
            f.loops[0][uv_layer].uv = (0.5, vc0)
            f.loops[1][uv_layer].uv = ((s + 1) / sides, vc0)
            f.loops[2][uv_layer].uv = (s / sides, vc0)

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
        vc1 = ring_vs[-1]
        for s in range(sides):
            sn = (s + 1) % sides
            f = bm.faces.new((v_cap1, rings[-1][s], rings[-1][sn]))
            f.material_index = mat_index
            f.smooth = True
            f.loops[0][uv_layer].uv = (0.5, vc1)
            f.loops[1][uv_layer].uv = (s / sides, vc1)
            f.loops[2][uv_layer].uv = ((s + 1) / sides, vc1)

    return created_verts


def add_curved_shell_patch_pc(
    bm: bmesh.types.BMesh,
    y_bottom: float,
    y_top: float,
    theta_min: float,
    theta_max: float,
    rx_inner: float,
    rz_inner: float,
    thickness: float,
    center_xz: Tuple[float, float] = (0.0, 0.0),
    cols: int = 8,
    rows: int = 4,
    mat_index: int = 0,
    top_narrow: float = 1.0,
) -> List[bmesh.types.BMVert]:
    """
    Builds a manifold curved armor/pad/pocket shell hugging an elliptical body contour around +Y!
    Eliminates flat floating bricks sticking out from curved limbs/chests.
    """
    uv_layer = bm.loops.layers.uv.verify()
    cx, cz = center_xz
    front_grid: List[List[bmesh.types.BMVert]] = []
    back_grid: List[List[bmesh.types.BMVert]] = []
    out_verts: List[bmesh.types.BMVert] = []

    for r in range(rows + 1):
        vf = r / rows
        y = y_bottom + (y_top - y_bottom) * vf
        span_scale = 1.0 - (1.0 - top_narrow) * vf
        t_mid = 0.5 * (theta_min + theta_max)
        t_half = 0.5 * (theta_max - theta_min) * span_scale
        f_row: List[bmesh.types.BMVert] = []
        b_row: List[bmesh.types.BMVert] = []
        for c in range(cols + 1):
            uf = c / cols
            th = (t_mid - t_half) + (2.0 * t_half) * uf
            st = math.sin(th)
            ct = math.cos(th)
            # Chamfer outer thickness slightly at borders so edges look beveled & tailored
            edge_taper = 0.55 if (r in (0, rows) or c in (0, cols)) else 1.0
            thk = thickness * edge_taper
            xi = cx + st * rx_inner
            zi = cz + ct * rz_inner
            xo = cx + st * (rx_inner + thk)
            zo = cz + ct * (rz_inner + thk)
            vf_bl = bm.verts.new(pc_to_bl(xo, y, zo))
            vb_bl = bm.verts.new(pc_to_bl(xi, y, zi))
            f_row.append(vf_bl)
            b_row.append(vb_bl)
            out_verts.extend((vf_bl, vb_bl))
        front_grid.append(f_row)
        back_grid.append(b_row)

    def make_quad(v0, v1, v2, v3, u0, kv0, u1, kv1):
        f = bm.faces.new((v0, v1, v2, v3))
        f.material_index = mat_index
        f.smooth = True
        f.loops[0][uv_layer].uv = (u0, kv0)
        f.loops[1][uv_layer].uv = (u1, kv0)
        f.loops[2][uv_layer].uv = (u1, kv1)
        f.loops[3][uv_layer].uv = (u0, kv1)

    for r in range(rows):
        v0, v1 = r / rows, (r + 1) / rows
        for c in range(cols):
            u0, u1 = c / cols, (c + 1) / cols
            make_quad(
                front_grid[r][c], front_grid[r][c + 1], front_grid[r + 1][c + 1], front_grid[r + 1][c],
                u0, v0, u1, v1,
            )
            make_quad(
                back_grid[r][c + 1], back_grid[r][c], back_grid[r + 1][c], back_grid[r + 1][c + 1],
                u1, v0, u0, v1,
            )

    # Stitch 4 perimeter rim strips so shell is 100% closed manifold
    for c in range(cols):
        u0, u1 = c / cols, (c + 1) / cols
        make_quad(back_grid[0][c], front_grid[0][c], front_grid[0][c + 1], back_grid[0][c + 1], u0, 0.0, u1, 0.1)
        make_quad(front_grid[rows][c], back_grid[rows][c], back_grid[rows][c + 1], front_grid[rows][c + 1], u0, 0.9, u1, 1.0)
    for r in range(rows):
        v0, v1 = r / rows, (r + 1) / rows
        make_quad(back_grid[r][0], back_grid[r + 1][0], front_grid[r + 1][0], front_grid[r][0], 0.0, v0, 0.1, v1)
        make_quad(front_grid[r][cols], front_grid[r + 1][cols], back_grid[r + 1][cols], back_grid[r][cols], 0.9, v0, 1.0, v1)

    return out_verts


def add_beveled_box_pc(
    bm: bmesh.types.BMesh,
    center_pc: Tuple[float, float, float],
    half_extents_pc: Tuple[float, float, float],
    bevel_width: float = 0.006,
    mat_index: int = 0,
    euler_deg_pc: Tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> List[bmesh.types.BMVert]:
    uv_layer = bm.loops.layers.uv.verify()
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
        local = Vector((v.co.x * hx, v.co.y * hz, v.co.z * hy))
        v.co = c_bl + (rot @ local)

    vert_set = set(verts)
    box_edges = [e for e in bm.edges if e.verts[0] in vert_set and e.verts[1] in vert_set]
    box_faces = [f for f in bm.faces if all(v in vert_set for v in f.verts)]
    for f in box_faces:
        f.material_index = mat_index
        f.smooth = True

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

    final_set = set(verts)
    for f in bm.faces:
        if all(v in final_set for v in f.verts):
            n = f.normal
            ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
            for loop in f.loops:
                co = loop.vert.co - c_bl
                if az >= ax and az >= ay:
                    u, v = co.x * 3.0 + 0.5, co.y * 3.0 + 0.5
                elif ax >= ay and ax >= az:
                    u, v = co.y * 3.0 + 0.5, co.z * 3.0 + 0.5
                else:
                    u, v = co.x * 3.0 + 0.5, co.z * 3.0 + 0.5
                loop[uv_layer].uv = (u, v)

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
# 22-Bone GHOUL Armature Definition (Aligned with GHOUL_ZONE_HIERARCHY, 1.80m Tall)
# ---------------------------------------------------------------------------

GHOUL_BONE_SPECS: List[Tuple[str, Optional[str], Tuple[float, float, float], Tuple[float, float, float]]] = [
    ("Bone_PELVIS_GROIN", None, (0.0, 0.93, 0.0), (0.0, 1.03, 0.0)),
    ("Bone_TORSO_LOWER_ABDOMEN", "Bone_PELVIS_GROIN", (0.0, 1.03, 0.0), (0.0, 1.23, 0.0)),
    ("Bone_TORSO_UPPER_THORAX", "Bone_TORSO_LOWER_ABDOMEN", (0.0, 1.23, 0.0), (0.0, 1.50, 0.0)),
    ("Bone_NECK_CERVICAL", "Bone_TORSO_UPPER_THORAX", (0.0, 1.50, 0.0), (0.0, 1.60, 0.0)),
    ("Bone_HEAD_CRANIUM", "Bone_NECK_CERVICAL", (0.0, 1.60, 0.0), (0.0, 1.80, 0.0)),
    ("Bone_HEAD_FACE_JAW", "Bone_HEAD_CRANIUM", (0.0, 1.63, 0.02), (0.0, 1.575, 0.10)),

    # Left Arm (-X) — natural athletic A-pose
    ("Bone_SHOULDER_LEFT", "Bone_TORSO_UPPER_THORAX", (-0.13, 1.45, 0.0), (-0.215, 1.43, 0.0)),
    ("Bone_UPPER_ARM_LEFT", "Bone_SHOULDER_LEFT", (-0.215, 1.43, 0.0), (-0.325, 1.18, 0.01)),
    ("Bone_FOREARM_LEFT", "Bone_UPPER_ARM_LEFT", (-0.325, 1.18, 0.01), (-0.405, 0.95, 0.08)),
    ("Bone_HAND_LEFT", "Bone_FOREARM_LEFT", (-0.405, 0.95, 0.08), (-0.44, 0.85, 0.125)),

    # Right Arm (+X)
    ("Bone_SHOULDER_RIGHT", "Bone_TORSO_UPPER_THORAX", (0.13, 1.45, 0.0), (0.215, 1.43, 0.0)),
    ("Bone_UPPER_ARM_RIGHT", "Bone_SHOULDER_RIGHT", (0.215, 1.43, 0.0), (0.325, 1.18, 0.01)),
    ("Bone_FOREARM_RIGHT", "Bone_UPPER_ARM_RIGHT", (0.325, 1.18, 0.01), (0.405, 0.95, 0.08)),
    ("Bone_HAND_RIGHT", "Bone_FOREARM_RIGHT", (0.405, 0.95, 0.08), (0.44, 0.85, 0.125)),

    # Left Leg (-X)
    ("Bone_THIGH_LEFT", "Bone_PELVIS_GROIN", (-0.108, 0.89, 0.0), (-0.115, 0.50, 0.01)),
    ("Bone_KNEE_LEFT", "Bone_THIGH_LEFT", (-0.115, 0.50, 0.01), (-0.115, 0.41, 0.012)),
    ("Bone_SHIN_LEFT", "Bone_KNEE_LEFT", (-0.115, 0.41, 0.012), (-0.115, 0.085, 0.0)),
    ("Bone_FOOT_LEFT", "Bone_SHIN_LEFT", (-0.115, 0.085, 0.0), (-0.115, 0.03, 0.17)),

    # Right Leg (+X)
    ("Bone_THIGH_RIGHT", "Bone_PELVIS_GROIN", (0.108, 0.89, 0.0), (0.115, 0.50, 0.01)),
    ("Bone_KNEE_RIGHT", "Bone_THIGH_RIGHT", (0.115, 0.50, 0.01), (0.115, 0.41, 0.012)),
    ("Bone_SHIN_RIGHT", "Bone_KNEE_RIGHT", (0.115, 0.41, 0.012), (0.115, 0.085, 0.0)),
    ("Bone_FOOT_RIGHT", "Bone_SHIN_RIGHT", (0.115, 0.085, 0.0), (0.115, 0.03, 0.17)),
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
# Build All 22 Sculpted GHOUL Zone Submeshes + 13 Gear/Gore/Internal Submeshes
# ---------------------------------------------------------------------------

def build_all_combatant_submeshes(
    arm_obj: bpy.types.Object,
    pal: Dict[str, bpy.types.Material],
    collection: bpy.types.Collection,
) -> List[bpy.types.Object]:
    objs: List[bpy.types.Object] = []

    # 1. Zone_PELVIS_GROIN — Anatomically sculpted hip girdle, glutes, groin taper & tactical rigger belt
    def sculpt_pelvis(t: float, theta: float, lr: float, lf: float) -> Tuple[float, float, float]:
        # Gluteal fullness in rear (|theta| > 1.8) + groin crotch dip at bottom center
        glute = max(0.0, -math.cos(theta)) * math.sin(t * math.pi) * 0.016
        crotch_lift = -0.022 * (1.0 - t) * max(0.0, 1.0 - abs(math.sin(theta)) * 2.2)
        hip_cup = 0.010 * math.sin(t * math.pi) * (abs(math.sin(theta)) ** 2)
        return lr + math.copysign(hip_cup, lr) if abs(lr) > 1e-5 else lr, lf - glute, crotch_lift

    bm = bmesh.new()
    add_sculpted_loft(
        bm, (0.0, 0.835, 0.0), (0.0, 1.015, 0.0),
        [
            (0.00, 0.148, 0.102, 0.0, -0.006),
            (0.28, 0.178, 0.118, 0.0, -0.004),
            (0.62, 0.174, 0.118, 0.0, 0.000),
            (0.86, 0.164, 0.114, 0.0, 0.002),
            (1.00, 0.148, 0.104, 0.0, 0.002),
        ],
        sides=20, mat_index=0, start_dome_scale=0.18, end_dome_scale=0.10, sculpt_fn=sculpt_pelvis,
    )
    # Contoured tactical belt wrap + polymer Cobra buckle + contoured rear IFAK pouch
    add_curved_shell_patch_pc(bm, 0.968, 1.012, -math.pi * 0.99, math.pi * 0.99, 0.160, 0.111, 0.009, cols=18, rows=2, mat_index=1)
    add_curved_shell_patch_pc(bm, 0.966, 1.014, -0.18, 0.18, 0.168, 0.118, 0.010, cols=4, rows=2, mat_index=2)
    add_curved_shell_patch_pc(bm, 0.905, 0.985, math.pi - 0.36, math.pi + 0.36, 0.162, 0.114, 0.032, cols=6, rows=3, mat_index=1)
    objs.append(finalize_skinned_mesh_object(
        "Zone_PELVIS_GROIN", bm,
        [pal["bdu_olive"], pal["webbing_tan"], pal["polymer_dark"]],
        arm_obj, [("Bone_PELVIS_GROIN", 0.90), ("Bone_TORSO_LOWER_ABDOMEN", 0.10)], collection,
    ))

    # 2. Zone_TORSO_LOWER_ABDOMEN — Athletic tapered waist, obliques, rectus contour, flush side pouches
    def sculpt_abdomen(t: float, theta: float, lr: float, lf: float) -> Tuple[float, float, float]:
        # Subtle rectus abdominis & lumbar curve (zero flat box edges)
        lumbar_arch = -0.008 * math.sin(t * math.pi) * max(0.0, -math.cos(theta))
        ab_groove = -0.004 * max(0.0, math.cos(theta)) * math.exp(-((theta / 0.16) ** 2))
        return lr, lf + lumbar_arch + ab_groove, 0.0

    bm = bmesh.new()
    add_sculpted_loft(
        bm, (0.0, 0.995, 0.0), (0.0, 1.235, 0.0),
        [
            (0.00, 0.156, 0.108, 0.0, 0.002),
            (0.25, 0.152, 0.108, 0.0, 0.004),
            (0.60, 0.156, 0.112, 0.0, 0.006),
            (0.88, 0.165, 0.118, 0.0, 0.006),
            (1.00, 0.152, 0.108, 0.0, 0.005),
        ],
        sides=20, mat_index=0, start_dome_scale=0.10, end_dome_scale=0.10, sculpt_fn=sculpt_abdomen,
    )
    for sx in (-1.0, 1.0):
        th_c = sx * (math.pi * 0.5)
        add_curved_shell_patch_pc(bm, 1.02, 1.115, th_c - 0.28, th_c + 0.28, 0.152, 0.108, 0.026, cols=5, rows=3, mat_index=1)
    objs.append(finalize_skinned_mesh_object(
        "Zone_TORSO_LOWER_ABDOMEN", bm,
        [pal["shirt_charcoal"], pal["webbing_tan"]],
        arm_obj,
        [("Bone_TORSO_LOWER_ABDOMEN", 0.76), ("Bone_PELVIS_GROIN", 0.12), ("Bone_TORSO_UPPER_THORAX", 0.12)],
        collection,
    ))

    # 3. Zone_TORSO_UPPER_THORAX — Sculpted V-taper chest, organic pectoral shelves, sternum cleft, lats & trapezius
    def sculpt_thorax(t: float, theta: float, lr: float, lf: float) -> Tuple[float, float, float]:
        # Sculpted pectorals between t=0.25..0.78 on front (+Z, |theta| < 0.85), dipping at sternum (theta=0)
        pec_band = math.sin(clamp01((t - 0.18) / 0.62) * math.pi)
        front_mask = max(0.0, math.cos(theta))
        sternum_cleft = math.exp(-((theta / 0.14) ** 2))
        pec_swell = 0.018 * pec_band * (front_mask ** 1.6) * (1.0 - 0.55 * sternum_cleft)
        # Scapula / upper back muscle definition
        back_muscle = 0.010 * pec_band * (max(0.0, -math.cos(theta)) ** 1.5) * (1.0 - 0.4 * math.exp(-(((abs(theta) - math.pi) / 0.18) ** 2)))
        return lr, lf + pec_swell - back_muscle, 0.0

    bm = bmesh.new()
    add_sculpted_loft(
        bm, (0.0, 1.215, 0.0), (0.0, 1.505, 0.0),
        [
            (0.00, 0.164, 0.118, 0.0, 0.006),
            (0.22, 0.176, 0.126, 0.0, 0.008),
            (0.52, 0.194, 0.134, 0.0, 0.010),
            (0.76, 0.200, 0.132, 0.0, 0.006),
            (0.91, 0.158, 0.104, 0.0, -0.002),
            (1.00, 0.088, 0.078, 0.0, -0.004),
        ],
        sides=22, mat_index=0, start_dome_scale=0.08, end_dome_scale=0.14, sculpt_fn=sculpt_thorax,
    )
    objs.append(finalize_skinned_mesh_object(
        "Zone_TORSO_UPPER_THORAX", bm,
        [pal["shirt_charcoal"], pal["bdu_olive"]],
        arm_obj,
        [("Bone_TORSO_UPPER_THORAX", 0.84), ("Bone_TORSO_LOWER_ABDOMEN", 0.12), ("Bone_SHOULDER_LEFT", 0.02), ("Bone_SHOULDER_RIGHT", 0.02)],
        collection,
    ))

    # 4. Zone_NECK_CERVICAL — Sternocleidomastoid V-contour + rolled tactical collar
    def sculpt_neck(t: float, theta: float, lr: float, lf: float) -> Tuple[float, float, float]:
        trachea = 0.005 * math.sin(t * math.pi) * math.exp(-((theta / 0.28) ** 2))
        return lr, lf + trachea, 0.0

    bm = bmesh.new()
    add_sculpted_loft(
        bm, (0.0, 1.485, -0.004), (0.0, 1.615, 0.004),
        [
            (0.00, 0.076, 0.072, 0.0, 0.0),
            (0.32, 0.068, 0.066, 0.0, 0.002),
            (0.70, 0.062, 0.062, 0.0, 0.004),
            (1.00, 0.058, 0.060, 0.0, 0.004),
        ],
        sides=16, mat_index=0, start_dome_scale=0.18, end_dome_scale=0.22, sculpt_fn=sculpt_neck,
    )
    # Rolled combat shirt collar at base of neck
    add_curved_shell_patch_pc(bm, 1.482, 1.522, -math.pi * 0.99, math.pi * 0.99, 0.074, 0.070, 0.012, center_xz=(0.0, -0.003), cols=16, rows=2, mat_index=1)
    objs.append(finalize_skinned_mesh_object(
        "Zone_NECK_CERVICAL", bm,
        [pal["skin_tone"], pal["shirt_charcoal"]],
        arm_obj, [("Bone_NECK_CERVICAL", 1.0)], collection,
    ))

    # 5. Zone_HEAD_CRANIUM — Anatomically sculpted skull vault, supraorbital brow, eye sockets, nose & ears
    def sculpt_cranium(t: float, theta: float, lr: float, lf: float) -> Tuple[float, float, float]:
        abs_th = abs(theta)
        # Pronounced brow ridge at t ~ 0.40
        brow = 0.011 * math.exp(-(((t - 0.40) / 0.09) ** 2)) * math.exp(-((abs_th / 0.50) ** 2))
        # Recessed orbital sockets below brow (t ~ 0.29, |theta| ~ 0.26)
        eye_socket = -0.006 * math.exp(-(((t - 0.29) / 0.08) ** 2)) * math.exp(-(((abs_th - 0.26) / 0.13) ** 2))
        # Sculpted nose bridge & tip emerging along theta=0 (t ~ 0.14..0.38)
        nose_len = math.exp(-(((t - 0.21) / 0.12) ** 2))
        nose = 0.017 * nose_len * math.exp(-((abs_th / 0.12) ** 2))
        # Zygomatic cheekbone flare (t ~ 0.22, |theta| ~ 0.58)
        cheek = 0.005 * math.exp(-(((t - 0.22) / 0.11) ** 2)) * math.exp(-(((abs_th - 0.58) / 0.22) ** 2))
        r_out = lr + (math.copysign(cheek, lr) if abs(lr) > 1e-5 else 0.0)
        return r_out, lf + brow + eye_socket + nose, 0.0

    bm = bmesh.new()
    add_sculpted_loft(
        bm, (0.0, 1.626, -0.004), (0.0, 1.796, -0.006),
        [
            (0.00, 0.064, 0.072, 0.0, 0.004),
            (0.10, 0.075, 0.088, 0.0, 0.007),
            (0.24, 0.081, 0.095, 0.0, 0.007),
            (0.42, 0.086, 0.102, 0.0, 0.005),
            (0.64, 0.088, 0.104, 0.0, 0.000),
            (0.85, 0.076, 0.090, 0.0, -0.004),
            (1.00, 0.044, 0.052, 0.0, -0.006),
        ],
        sides=22, mat_index=0, start_dome_scale=0.08, end_dome_scale=0.38, sculpt_fn=sculpt_cranium,
    )
    # Sculpted anatomical ears (curved pinna shells, not boxes!)
    for sx in (-1.0, 1.0):
        th_ear = sx * (math.pi * 0.52)
        add_curved_shell_patch_pc(
            bm, 1.642, 1.686, th_ear - 0.14, th_ear + 0.14,
            0.083, 0.096, 0.011, center_xz=(0.0, -0.004), cols=4, rows=3, mat_index=0
        )
    objs.append(finalize_skinned_mesh_object(
        "Zone_HEAD_CRANIUM", bm,
        [pal["head_skin"]],
        arm_obj, [("Bone_HEAD_CRANIUM", 1.0)], collection,
    ))

    # 6. Zone_HEAD_FACE_JAW — Sculpted strong jawline, gonial angle, chin & lips (tucks seamlessly into cranium!)
    def sculpt_jaw(t: float, theta: float, lr: float, lf: float) -> Tuple[float, float, float]:
        abs_th = abs(theta)
        chin = 0.009 * math.exp(-(((t - 0.18) / 0.18) ** 2)) * math.exp(-((abs_th / 0.38) ** 2))
        lips = 0.005 * math.exp(-(((t - 0.58) / 0.14) ** 2)) * math.exp(-((abs_th / 0.34) ** 2))
        jaw_angle = 0.005 * math.exp(-(((t - 0.40) / 0.22) ** 2)) * math.exp(-(((abs_th - 0.85) / 0.30) ** 2))
        r_out = lr + (math.copysign(jaw_angle, lr) if abs(lr) > 1e-5 else 0.0)
        return r_out, lf + chin + lips, 0.0

    bm = bmesh.new()
    add_sculpted_loft(
        bm, (0.0, 1.568, 0.012), (0.0, 1.648, 0.002),
        [
            (0.00, 0.044, 0.052, 0.0, 0.014),
            (0.32, 0.066, 0.074, 0.0, 0.010),
            (0.68, 0.074, 0.085, 0.0, 0.005),
            (0.85, 0.074, 0.084, 0.0, 0.002),
            (1.00, 0.058, 0.066, 0.0, 0.000),
        ],
        sides=22, mat_index=0, start_dome_scale=0.22, end_dome_scale=0.06, sculpt_fn=sculpt_jaw,
    )
    objs.append(finalize_skinned_mesh_object(
        "Zone_HEAD_FACE_JAW", bm,
        [pal["jaw_skin"]],
        arm_obj, [("Bone_HEAD_FACE_JAW", 1.0)], collection,
    ))

    # 7..14. Left & Right Arms (Deltoid Shoulders, Sleeved Upper Arms, Muscular Forearms, Articulated Tactical Hands)
    for side_label, sx in (("LEFT", -1.0), ("RIGHT", 1.0)):
        # Shoulder Deltoid Cap — cups smoothly over upper chest & humeral head
        bm = bmesh.new()
        add_sculpted_loft(
            bm, (sx * 0.135, 1.445, 0.0), (sx * 0.228, 1.418, 0.004),
            [
                (0.00, 0.066, 0.072, 0.0, 0.0),
                (0.50, 0.076, 0.080, 0.0, 0.002),
                (1.00, 0.064, 0.068, 0.0, 0.0),
            ],
            sides=16, mat_index=0, start_dome_scale=0.35, end_dome_scale=0.38, v_Ascending=False,
        )
        objs.append(finalize_skinned_mesh_object(
            f"Zone_SHOULDER_{side_label}", bm,
            [pal["bdu_olive"]],
            arm_obj, [(f"Bone_SHOULDER_{side_label}", 0.82), ("Bone_TORSO_UPPER_THORAX", 0.18)], collection,
        ))

        # Upper Arm — Spherical humeral ball + sculpted bicep/tricep + rolled BDU sleeve cuff at elbow
        def sculpt_bicep(t: float, theta: float, lr: float, lf: float) -> Tuple[float, float, float]:
            bicep = 0.009 * math.sin(t * math.pi) * max(0.0, math.cos(theta))
            tricep = 0.007 * math.sin(t * math.pi * 0.9) * max(0.0, -math.cos(theta))
            return lr, lf + bicep - tricep, 0.0

        bm = bmesh.new()
        add_sculpted_loft(
            bm, (sx * 0.215, 1.43, 0.0), (sx * 0.325, 1.18, 0.01),
            [
                (0.00, 0.056, 0.058, 0.0, 0.0),
                (0.35, 0.062, 0.066, 0.0, 0.004),
                (0.72, 0.056, 0.058, 0.0, 0.002),
                (0.88, 0.058, 0.060, 0.0, 0.0),  # Rolled BDU sleeve cuff fold
                (1.00, 0.052, 0.054, 0.0, 0.0),
            ],
            sides=16, mat_index=0, start_dome_scale=0.48, end_dome_scale=0.22, v_Ascending=False, sculpt_fn=sculpt_bicep,
        )
        objs.append(finalize_skinned_mesh_object(
            f"Zone_UPPER_ARM_{side_label}", bm,
            [pal["bdu_olive"]],
            arm_obj, [(f"Bone_UPPER_ARM_{side_label}", 1.0)], collection,
        ))

        # Forearm — Proximal elbow ball tucked cleanly inside bicep cuff + flush olecranon contour (ZERO floating pad!)
        def sculpt_forearm(t: float, theta: float, lr: float, lf: float) -> Tuple[float, float, float]:
            brachioradialis = 0.007 * math.sin(min(1.0, t * 1.4) * math.pi) * (0.4 + 0.6 * abs(math.sin(theta)))
            return lr * (1.0 + brachioradialis * 4.0), lf, 0.0

        bm = bmesh.new()
        add_sculpted_loft(
            bm, (sx * 0.325, 1.18, 0.01), (sx * 0.405, 0.95, 0.08),
            [
                (0.00, 0.044, 0.046, 0.0, 0.0),  # Tucked inside sleeve cuff (0.044 < 0.052 -> zero zig-zag!)
                (0.24, 0.051, 0.053, 0.0, 0.0),
                (0.62, 0.042, 0.044, 0.0, 0.0),
                (0.88, 0.035, 0.037, 0.0, 0.0),
                (1.00, 0.032, 0.034, 0.0, 0.0),
            ],
            sides=14, mat_index=0, start_dome_scale=0.45, end_dome_scale=0.35, v_Ascending=False, sculpt_fn=sculpt_forearm,
        )
        # Snug wrist glove gauntlet band at distal forearm
        add_sculpted_loft(
            bm, (sx * 0.392, 0.988, 0.068), (sx * 0.406, 0.948, 0.081),
            [(0.0, 0.037, 0.039, 0.0, 0.0), (1.0, 0.035, 0.037, 0.0, 0.0)],
            sides=14, mat_index=1, start_dome_scale=0.08, end_dome_scale=0.08, v_Ascending=False,
        )
        objs.append(finalize_skinned_mesh_object(
            f"Zone_FOREARM_{side_label}", bm,
            [pal["skin_tone"], pal["polymer_dark"]],
            arm_obj, [(f"Bone_FOREARM_{side_label}", 1.0)], collection,
        ))

        # Hand — Sculpted tactical shooting glove: wrist cuff, palm arch, molded knuckles, curled grip fingers & thumb
        def sculpt_hand(t: float, theta: float, lr: float, lf: float) -> Tuple[float, float, float]:
            # Molded knuckle ridge on dorsal (+lf/back) side around t=0.52 + curled finger arch toward palm
            knuckle = 0.004 * math.exp(-(((t - 0.50) / 0.14) ** 2)) * max(0.0, -math.cos(theta))
            finger_curl = 0.010 * (max(0.0, t - 0.45) ** 1.4)
            return lr, lf - knuckle + finger_curl, 0.0

        bm = bmesh.new()
        add_sculpted_loft(
            bm, (sx * 0.405, 0.95, 0.08), (sx * 0.44, 0.85, 0.125),
            [
                (0.00, 0.032, 0.026, 0.0, 0.0),
                (0.45, 0.041, 0.022, 0.0, 0.0),
                (0.78, 0.038, 0.018, 0.0, 0.004),
                (1.00, 0.030, 0.014, 0.0, 0.008),
            ],
            sides=14, mat_index=0, start_dome_scale=0.35, end_dome_scale=0.22, v_Ascending=False, sculpt_fn=sculpt_hand,
        )
        # Opposable thumb lofted organically from radial wrist/thenar eminence
        add_sculpted_loft(
            bm, (sx * 0.398, 0.935, 0.092), (sx * 0.392, 0.892, 0.132),
            [
                (0.00, 0.016, 0.016, 0.0, 0.0),
                (0.55, 0.013, 0.013, 0.0, 0.0),
                (1.00, 0.010, 0.010, 0.0, 0.0),
            ],
            sides=10, mat_index=0, start_dome_scale=0.25, end_dome_scale=0.35, v_Ascending=False,
        )
        objs.append(finalize_skinned_mesh_object(
            f"Zone_HAND_{side_label}", bm,
            [pal["glove_leather"], pal["polymer_dark"]],
            arm_obj, [(f"Bone_HAND_{side_label}", 1.0)], collection,
        ))

    # 15..22. Left & Right Legs (Sculpted Thighs, Contoured Kneepads, Calves, Laced Combat Boots)
    for side_label, sx in (("LEFT", -1.0), ("RIGHT", 1.0)):
        # Thigh — Rounded hip ball tucked cleanly inside pelvic flare (0.108 + 0.072 = 0.180 <= pelvic hip cup!)
        def sculpt_thigh(t: float, theta: float, lr: float, lf: float) -> Tuple[float, float, float]:
            quad = 0.012 * math.sin(t * math.pi * 0.92) * max(0.0, math.cos(theta))
            hamstring = 0.008 * math.sin(t * math.pi * 0.85) * max(0.0, -math.cos(theta))
            crease = 0.003 * math.sin(t * 22.0)
            return lr + (sx * crease * 0.5), lf + quad - hamstring, 0.0

        bm = bmesh.new()
        add_sculpted_loft(
            bm, (sx * 0.108, 0.895, 0.0), (sx * 0.115, 0.50, 0.01),
            [
                (0.00, 0.072, 0.082, 0.0, -0.004),  # Rounded femoral hip ball tucked inside pelvis!
                (0.18, 0.088, 0.096, 0.0, 0.002),
                (0.45, 0.086, 0.094, 0.0, 0.006),
                (0.78, 0.072, 0.078, 0.0, 0.003),
                (1.00, 0.062, 0.066, 0.0, 0.0),
            ],
            sides=18, mat_index=0, start_dome_scale=0.52, end_dome_scale=0.36, v_Ascending=False, sculpt_fn=sculpt_thigh,
        )
        # Flush curved BDU cargo pocket hugging outer thigh (not a brick!)
        th_out = sx * (math.pi * 0.5)
        add_curved_shell_patch_pc(
            bm, 0.60, 0.77, th_out - 0.42, th_out + 0.42,
            0.078, 0.084, 0.018, center_xz=(sx * 0.112, 0.005), cols=6, rows=4, mat_index=1
        )
        objs.append(finalize_skinned_mesh_object(
            f"Zone_THIGH_{side_label}", bm,
            [pal["bdu_olive"], pal["webbing_tan"]],
            arm_obj, [(f"Bone_THIGH_{side_label}", 1.0)], collection,
        ))

        # Knee — Articulated joint cylinder + curved hard-shell tactical knee cap hugging +Z front!
        bm = bmesh.new()
        add_sculpted_loft(
            bm, (sx * 0.115, 0.51, 0.01), (sx * 0.115, 0.405, 0.012),
            [
                (0.00, 0.060, 0.064, 0.0, 0.0),
                (0.50, 0.061, 0.065, 0.0, 0.003),
                (1.00, 0.056, 0.060, 0.0, 0.0),
            ],
            sides=16, mat_index=0, start_dome_scale=0.38, end_dome_scale=0.35, v_Ascending=False,
        )
        add_curved_shell_patch_pc(
            bm, 0.422, 0.498, -0.68, 0.68,
            0.059, 0.063, 0.016, center_xz=(sx * 0.115, 0.013), cols=8, rows=4, mat_index=1
        )
        objs.append(finalize_skinned_mesh_object(
            f"Zone_KNEE_{side_label}", bm,
            [pal["bdu_olive"], pal["polymer_dark"]],
            arm_obj, [(f"Bone_KNEE_{side_label}", 1.0)], collection,
        ))

        # Shin — Sculpted gastrocnemius calf belly + bloused BDU trouser cuff over boot collar
        def sculpt_shin(t: float, theta: float, lr: float, lf: float) -> Tuple[float, float, float]:
            calf = 0.014 * math.exp(-(((t - 0.28) / 0.22) ** 2)) * max(0.0, -math.cos(theta))
            blouse = 0.006 * math.exp(-(((t - 0.88) / 0.08) ** 2))
            return lr * (1.0 + blouse * 6.0), lf - calf + blouse, 0.0

        bm = bmesh.new()
        add_sculpted_loft(
            bm, (sx * 0.115, 0.41, 0.012), (sx * 0.115, 0.105, 0.0),
            [
                (0.00, 0.055, 0.059, 0.0, 0.0),
                (0.28, 0.062, 0.068, 0.0, -0.006),
                (0.68, 0.050, 0.054, 0.0, -0.002),
                (0.90, 0.055, 0.058, 0.0, 0.0),
                (1.00, 0.044, 0.048, 0.0, 0.0),
            ],
            sides=16, mat_index=0, start_dome_scale=0.35, end_dome_scale=0.25, v_Ascending=False, sculpt_fn=sculpt_shin,
        )
        objs.append(finalize_skinned_mesh_object(
            f"Zone_SHIN_{side_label}", bm,
            [pal["bdu_olive"]],
            arm_obj, [(f"Bone_SHIN_{side_label}", 1.0)], collection,
        ))

        # Foot — True sculpted 8-inch tactical combat boot (grounded cleanly at y = 0.000m!)
        def sculpt_boot(t: float, theta: float, lr: float, lf: float) -> Tuple[float, float, float]:
            # Flatten bottom sole cleanly at y = 0.000m while keeping upper instep & rounded toe box organic!
            return lr, lf, 0.0

        bm = bmesh.new()
        # Vertical laced boot shaft + heel counter + sloped instep + rounded toe cap (strictly horizontal sole at y = 0.002m!)
        add_sculpted_loft(
            bm, (sx * 0.115, 0.002, 0.000), (sx * 0.115, 0.125, 0.000),
            [
                (0.00, 0.052, 0.128, 0.0, 0.056),   # Grounded lugged Vibram outsole base (flat at y = 0.002m!)
                (0.14, 0.052, 0.128, 0.0, 0.051),   # Outsole welt rim (y = 0.019)
                (0.28, 0.048, 0.118, 0.0, 0.042),   # Toe cap & heel counter (y = 0.036)
                (0.46, 0.045, 0.088, 0.0, 0.014),   # Sloped laced instep vamp (y = 0.058)
                (0.70, 0.044, 0.056, 0.0, -0.010),  # Ankle collar throat (y = 0.088)
                (1.00, 0.046, 0.054, 0.0, -0.015),  # Padded top boot cuff (y = 0.125)
            ],
            sides=18, mat_index=0, start_dome_scale=0.005, end_dome_scale=0.12, sculpt_fn=sculpt_boot,
        )
        objs.append(finalize_skinned_mesh_object(
            f"Zone_FOOT_{side_label}", bm,
            [pal["boot_leather"], pal["polymer_dark"]],
            arm_obj, [(f"Bone_FOOT_{side_label}", 1.0)], collection,
        ))

    # -----------------------------------------------------------------------
    # Modular Ballistic Armor, Archetype Headgear & Gore Submeshes
    # -----------------------------------------------------------------------

    # 23. Gear_ESAPI_PlateCarrier — Curved swimmer-cut plates (x in [-0.125, 0.125], y in [1.18, 1.46])
    bm = bmesh.new()
    # Front curved ESAPI plate (tapered swimmer-cut top leaving armpits & collarbone open!)
    add_curved_shell_patch_pc(
        bm, 1.185, 1.455, -0.64, 0.64,
        0.190, 0.136, 0.020, cols=10, rows=5, mat_index=0, top_narrow=0.72
    )
    # Rear curved ESAPI plate
    add_curved_shell_patch_pc(
        bm, 1.195, 1.455, math.pi - 0.62, math.pi + 0.62,
        0.188, 0.130, 0.018, cols=10, rows=5, mat_index=0, top_narrow=0.76
    )
    # Side cummerbund wraps + 3 contoured front STANAG mag pouches + shoulder straps
    for sx in (-1.0, 1.0):
        th_side = sx * (math.pi * 0.5)
        add_curved_shell_patch_pc(
            bm, 1.195, 1.305, th_side - 0.55, th_side + 0.55,
            0.182, 0.126, 0.012, cols=6, rows=3, mat_index=1
        )
        add_beveled_box_pc(
            bm, (sx * 0.092, 1.482, 0.002), (0.024, 0.014, 0.115),
            bevel_width=0.005, mat_index=1, euler_deg_pc=(4.0, 0.0, sx * -8.0)
        )
    for pouch_th in (-0.36, 0.0, 0.36):
        add_curved_shell_patch_pc(
            bm, 1.195, 1.318, pouch_th - 0.14, pouch_th + 0.14,
            0.208, 0.154, 0.024, cols=4, rows=3, mat_index=1
        )
    objs.append(finalize_skinned_mesh_object(
        "Gear_ESAPI_PlateCarrier", bm,
        [pal["esapi_plate"], pal["webbing_tan"]],
        arm_obj, [("Bone_TORSO_UPPER_THORAX", 0.88), ("Bone_TORSO_LOWER_ABDOMEN", 0.12)], collection,
    ))

    # 24. Gear_PASGT_Helmet — Sculpted Kevlar ballistic shell with PASGT brim & ear flares
    def sculpt_helmet(t: float, theta: float, lr: float, lf: float) -> Tuple[float, float, float]:
        abs_th = abs(theta)
        # PASGT front brow visor lip + lowered ear/nape coverage (cut higher in front at t=0..0.22!)
        front_cut_lift = 0.026 * (1.0 - t) * max(0.0, math.cos(theta))
        brim_flare = 0.010 * math.exp(-(((t - 0.18) / 0.12) ** 2)) * max(0.0, math.cos(theta))
        ear_flare = 0.010 * math.exp(-(((t - 0.16) / 0.16) ** 2)) * math.exp(-(((abs_th - 1.55) / 0.45) ** 2))
        r_out = lr + (math.copysign(ear_flare, lr) if abs(lr) > 1e-5 else 0.0)
        return r_out, lf + brim_flare, front_cut_lift

    bm = bmesh.new()
    add_sculpted_loft(
        bm, (0.0, 1.652, -0.008), (0.0, 1.822, -0.008),
        [
            (0.00, 0.102, 0.114, 0.0, -0.006),
            (0.28, 0.108, 0.120, 0.0, 0.002),
            (0.64, 0.100, 0.112, 0.0, 0.000),
            (0.88, 0.078, 0.088, 0.0, -0.003),
            (1.00, 0.044, 0.050, 0.0, -0.005),
        ],
        sides=22, mat_index=0, start_dome_scale=0.05, end_dome_scale=0.38, sculpt_fn=sculpt_helmet,
    )
    # Contoured NVG front shroud
    add_curved_shell_patch_pc(
        bm, 1.712, 1.758, -0.18, 0.18,
        0.104, 0.116, 0.010, center_xz=(0.0, -0.006), cols=4, rows=2, mat_index=1
    )
    objs.append(finalize_skinned_mesh_object(
        "Gear_PASGT_Helmet", bm,
        [pal["helmet_kevlar"], pal["polymer_dark"]],
        arm_obj, [("Bone_HEAD_CRANIUM", 1.0)], collection,
    ))

    # 25. Gear_TacticalVisor — Sleek curved wrap-around ballistic eye-pro / shades (covers orbital line cleanly!)
    bm = bmesh.new()
    add_curved_shell_patch_pc(
        bm, 1.672, 1.704, -0.82, 0.82,
        0.091, 0.108, 0.008, center_xz=(0.0, -0.001), cols=12, rows=3, mat_index=0
    )
    objs.append(finalize_skinned_mesh_object(
        "Gear_TacticalVisor", bm,
        [pal["visor_glass"]],
        arm_obj, [("Bone_HEAD_CRANIUM", 1.0)], collection,
    ))

    # 26. Gear_SpetsnazBeret — Tilted maroon military beret + leather headband rim for SNIPER_OPERATIVE
    def sculpt_beret(t: float, theta: float, lr: float, lf: float) -> Tuple[float, float, float]:
        right_fold = max(0.0, math.sin(theta))
        drape_x = 0.032 * right_fold * math.sin(t * math.pi * 0.82)
        drape_y = -0.022 * right_fold * t
        return lr + drape_x, lf, drape_y

    bm = bmesh.new()
    add_sculpted_loft(
        bm, (0.0, 1.706, -0.006), (0.0, 1.812, -0.006),
        [
            (0.00, 0.093, 0.108, 0.0, 0.0),
            (0.35, 0.104, 0.116, 0.004, 0.002),
            (0.72, 0.098, 0.110, 0.006, 0.0),
            (1.00, 0.056, 0.064, 0.004, -0.004),
        ],
        sides=20, mat_index=0, start_dome_scale=0.05, end_dome_scale=0.34, sculpt_fn=sculpt_beret,
    )
    # Black leather beret band around forehead
    add_curved_shell_patch_pc(
        bm, 1.698, 1.716, -math.pi * 0.99, math.pi * 0.99,
        0.091, 0.106, 0.006, center_xz=(0.0, -0.005), cols=20, rows=2, mat_index=1
    )
    objs.append(finalize_skinned_mesh_object(
        "Gear_SpetsnazBeret", bm,
        [pal["beret_crimson"], pal["polymer_dark"]],
        arm_obj, [("Bone_HEAD_CRANIUM", 1.0)], collection,
    ))

    # 27. Gear_PunkMohawk — Row of sculpted punk mohawk spikes along cranial crest for SKINHEAD_PUNK
    bm = bmesh.new()
    for sp_i in range(6):
        frac = sp_i / 5.0
        ang = -0.35 + frac * 1.35
        base_y = 1.735 + math.cos(ang) * 0.052
        base_z = -0.008 + math.sin(ang) * 0.078
        tip_y = base_y + math.cos(ang) * 0.072 + 0.018
        tip_z = base_z + math.sin(ang) * 0.055
        add_sculpted_loft(
            bm, (0.0, base_y, base_z), (0.0, tip_y, tip_z),
            [
                (0.00, 0.016, 0.024, 0.0, 0.0),
                (0.55, 0.010, 0.016, 0.0, 0.0),
                (1.00, 0.003, 0.005, 0.0, 0.0),
            ],
            sides=8, mat_index=0, start_dome_scale=0.15, end_dome_scale=0.40,
        )
    objs.append(finalize_skinned_mesh_object(
        "Gear_PunkMohawk", bm,
        [pal["mohawk_punk"]],
        arm_obj, [("Bone_HEAD_CRANIUM", 1.0)], collection,
    ))

    # 28. Gear_EvisceratedGut — Sculpted SoF open-stomach visceral crater + broken ribs + entrail coils
    def sculpt_eviscerated_shell(t: float, theta: float, lr: float, lf: float) -> Tuple[float, float, float]:
        # Hollow out front (+Z, |theta| < 0.95) into a deep crimson visceral gut cavity!
        if abs(theta) < 0.95 and 0.15 < t < 0.88:
            crater = math.sin(((t - 0.15) / 0.73) * math.pi) * math.cos((theta / 0.95) * (math.pi * 0.5))
            return lr, lf - crater * 0.135, 0.0
        return lr, lf, 0.0

    bm = bmesh.new()
    add_sculpted_loft(
        bm, (0.0, 0.995, 0.0), (0.0, 1.235, 0.0),
        [
            (0.00, 0.156, 0.108, 0.0, 0.002),
            (0.30, 0.154, 0.110, 0.0, 0.004),
            (0.65, 0.158, 0.114, 0.0, 0.006),
            (1.00, 0.152, 0.108, 0.0, 0.005),
        ],
        sides=20, mat_index=0, start_dome_scale=0.10, end_dome_scale=0.10, sculpt_fn=sculpt_eviscerated_shell,
    )
    # Glistening entrail coils + jagged broken lower rib tips inside cavity
    for c_idx, (cx, cy, cz) in enumerate([(-0.042, 1.075, 0.088), (0.005, 1.052, 0.102), (0.046, 1.082, 0.086)]):
        add_sculpted_loft(
            bm, (cx - 0.028, cy + 0.022, cz - 0.012), (cx + 0.028, cy - 0.024, cz + 0.014),
            [(0.0, 0.018, 0.018, 0.0, 0.0), (0.5, 0.024, 0.022, 0.0, 0.008), (1.0, 0.017, 0.017, 0.0, 0.0)],
            sides=10, mat_index=1, start_dome_scale=0.35, end_dome_scale=0.35,
        )
    for sx in (-1.0, 1.0):
        add_sculpted_loft(
            bm, (sx * 0.082, 1.195, 0.072), (sx * 0.052, 1.168, 0.104),
            [(0.0, 0.010, 0.008, 0.0, 0.0), (1.0, 0.004, 0.004, 0.0, 0.0)],
            sides=6, mat_index=2,
        )
    objs.append(finalize_skinned_mesh_object(
        "Gear_EvisceratedGut", bm,
        [pal["gore_viscera"], pal["organ_liver"], pal["bone_cortical"]],
        arm_obj,
        [("Bone_TORSO_LOWER_ABDOMEN", 0.76), ("Bone_PELVIS_GROIN", 0.12), ("Bone_TORSO_UPPER_THORAX", 0.12)],
        collection,
    ))

    # -----------------------------------------------------------------------
    # Internal X-Ray Anatomical Submeshes (7 Organs & Cortical Skeletons)
    # Strictly tucked inside outer flesh envelope so ZERO bones poke out!
    # -----------------------------------------------------------------------

    # 29. Organ_Brain — Gyri-contoured bi-hemispheric cerebrum + cerebellum inside skull
    bm = bmesh.new()
    for sx in (-1.0, 1.0):
        add_sculpted_loft(
            bm, (sx * 0.028, 1.668, -0.008), (sx * 0.026, 1.758, -0.006),
            [
                (0.00, 0.028, 0.056, 0.0, 0.0),
                (0.50, 0.034, 0.068, 0.0, 0.004),
                (1.00, 0.022, 0.048, 0.0, 0.0),
            ],
            sides=12, mat_index=0, end_dome_scale=0.35,
        )
    objs.append(finalize_skinned_mesh_object(
        "Organ_Brain", bm, [pal["organ_brain"]],
        arm_obj, [("Bone_HEAD_CRANIUM", 1.0)], collection,
    ))

    # 30. Organ_Heart — Conical myocardium + aortic arch tucked inside ribcage
    bm = bmesh.new()
    add_sculpted_loft(
        bm, (-0.028, 1.295, 0.022), (-0.008, 1.385, 0.006),
        [
            (0.00, 0.020, 0.020, 0.0, 0.0),
            (0.45, 0.040, 0.038, 0.0, 0.0),
            (0.85, 0.034, 0.032, 0.0, 0.0),
            (1.00, 0.016, 0.016, 0.0, 0.0),
        ],
        sides=12, mat_index=0, end_dome_scale=0.40,
    )
    add_sculpted_loft(
        bm, (-0.008, 1.375, 0.006), (0.004, 1.432, -0.010),
        [(0.0, 0.013, 0.013, 0.0, 0.0), (1.0, 0.011, 0.011, 0.0, 0.0)],
        sides=10, mat_index=0,
    )
    objs.append(finalize_skinned_mesh_object(
        "Organ_Heart", bm, [pal["organ_heart"]],
        arm_obj, [("Bone_TORSO_UPPER_THORAX", 1.0)], collection,
    ))

    # 31. Organ_Lungs — Paired Left & Right Pulmonary Lobes fitted cleanly inside ribcage
    bm = bmesh.new()
    for sx in (-1.0, 1.0):
        add_sculpted_loft(
            bm, (sx * 0.072, 1.265, 0.004), (sx * 0.062, 1.438, 0.002),
            [
                (0.00, 0.046, 0.056, 0.0, 0.0),
                (0.42, 0.052, 0.062, 0.0, 0.004),
                (0.80, 0.040, 0.048, 0.0, 0.0),
                (1.00, 0.022, 0.028, 0.0, 0.0),
            ],
            sides=12, mat_index=0, end_dome_scale=0.35,
        )
    objs.append(finalize_skinned_mesh_object(
        "Organ_Lungs", bm, [pal["organ_lungs"]],
        arm_obj, [("Bone_TORSO_UPPER_THORAX", 1.0)], collection,
    ))

    # 32. Organ_Liver — Wedge-shaped Right-Hypochondrium Parenchyma
    bm = bmesh.new()
    add_sculpted_loft(
        bm, (-0.020, 1.195, 0.020), (0.092, 1.165, 0.012),
        [
            (0.00, 0.024, 0.032, 0.0, 0.0),
            (0.45, 0.046, 0.054, 0.0, 0.0),
            (0.85, 0.052, 0.058, 0.0, 0.0),
            (1.00, 0.032, 0.038, 0.0, 0.0),
        ],
        sides=12, mat_index=0, end_dome_scale=0.35,
    )
    objs.append(finalize_skinned_mesh_object(
        "Organ_Liver", bm, [pal["organ_liver"]],
        arm_obj, [("Bone_TORSO_LOWER_ABDOMEN", 0.85), ("Bone_TORSO_UPPER_THORAX", 0.15)], collection,
    ))

    # 33. Skelet_Skull — Sculpted calvarium, orbital sockets & anatomical U-shaped mandible (ZERO cheek poke!)
    bm = bmesh.new()
    add_sculpted_loft(
        bm, (0.0, 1.638, -0.006), (0.0, 1.772, -0.006),
        [
            (0.00, 0.054, 0.064, 0.0, 0.0),
            (0.45, 0.068, 0.080, 0.0, 0.004),
            (0.85, 0.062, 0.074, 0.0, 0.0),
            (1.00, 0.038, 0.046, 0.0, 0.0),
        ],
        sides=14, mat_index=0, end_dome_scale=0.38,
    )
    # Anatomical tapered mandible tucked strictly inside Zone_HEAD_FACE_JAW (max |x| <= 0.036!)
    add_sculpted_loft(
        bm, (0.0, 1.582, 0.032), (0.0, 1.632, 0.022),
        [
            (0.00, 0.028, 0.032, 0.0, 0.012),
            (0.50, 0.036, 0.038, 0.0, 0.008),
            (1.00, 0.042, 0.040, 0.0, 0.004),
        ],
        sides=12, mat_index=0, end_dome_scale=0.20,
    )
    objs.append(finalize_skinned_mesh_object(
        "Skelet_Skull", bm, [pal["bone_cortical"]],
        arm_obj, [("Bone_HEAD_CRANIUM", 0.85), ("Bone_HEAD_FACE_JAW", 0.15)], collection,
    ))

    # 34. Skelet_RibcageSpine — Vertebral Column + Clavicles + Sternum + 8 Curved Rib Pairs enclosing Lungs/Heart!
    bm = bmesh.new()
    add_sculpted_loft(
        bm, (0.0, 0.97, -0.042), (0.0, 1.58, -0.016),
        [
            (0.00, 0.024, 0.026, 0.0, 0.0),
            (0.35, 0.022, 0.024, 0.0, -0.005),
            (0.75, 0.020, 0.022, 0.0, 0.003),
            (1.00, 0.016, 0.018, 0.0, 0.0),
        ],
        sides=10, mat_index=0,
    )
    # Sternum + Clavicles
    add_beveled_box_pc(bm, (0.0, 1.355, 0.094), (0.018, 0.082, 0.008), bevel_width=0.003, mat_index=0)
    for sx in (-1.0, 1.0):
        add_sculpted_loft(
            bm, (sx * 0.018, 1.448, 0.082), (sx * 0.155, 1.452, 0.005),
            [(0.0, 0.009, 0.009, 0.0, 0.0), (1.0, 0.008, 0.008, 0.0, 0.0)],
            sides=6, mat_index=0,
        )
    # 8 Curved Rib Pairs wrapping OUTSIDE the lungs (`rx_span` up to 0.142, `rz_front` to 0.092)
    for rib_i in range(8):
        frac = rib_i / 7.0
        ry = 1.235 + frac * 0.205
        rx_span = 0.142 - abs(frac - 0.45) * 0.042
        rz_front = 0.092 - abs(frac - 0.45) * 0.020
        for sx in (-1.0, 1.0):
            add_sculpted_loft(
                bm, (sx * 0.020, ry + 0.010, -0.040), (sx * rx_span, ry + 0.002, 0.012),
                [(0.0, 0.007, 0.006, 0.0, 0.0), (1.0, 0.007, 0.006, 0.0, 0.0)],
                sides=6, mat_index=0,
            )
            if rib_i >= 1:
                add_sculpted_loft(
                    bm, (sx * rx_span, ry + 0.002, 0.012), (sx * 0.020, ry - 0.010, rz_front),
                    [(0.0, 0.007, 0.006, 0.0, 0.0), (1.0, 0.006, 0.005, 0.0, 0.0)],
                    sides=6, mat_index=0,
                )
    objs.append(finalize_skinned_mesh_object(
        "Skelet_RibcageSpine", bm, [pal["bone_cortical"]],
        arm_obj,
        [("Bone_TORSO_UPPER_THORAX", 0.68), ("Bone_TORSO_LOWER_ABDOMEN", 0.22), ("Bone_NECK_CERVICAL", 0.10)],
        collection,
    ))

    # 35. Skelet_Pelvis — Sculpted curved iliac wings, sacrum & pubic ring tucked strictly inside pelvis!
    bm = bmesh.new()
    # Sacrum
    add_sculpted_loft(
        bm, (0.0, 0.905, -0.040), (0.0, 0.985, -0.042),
        [(0.0, 0.022, 0.016, 0.0, 0.0), (0.6, 0.044, 0.022, 0.0, 0.0), (1.0, 0.036, 0.020, 0.0, 0.0)],
        sides=10, mat_index=0,
    )
    # Curved left & right iliac crests (max radius 0.125 < outer 0.164 -> ZERO hip poke!)
    for sx in (-1.0, 1.0):
        th_hip = sx * (math.pi * 0.52)
        add_curved_shell_patch_pc(
            bm, 0.885, 0.985, th_hip - 0.68, th_hip + 0.68,
            0.106, 0.072, 0.016, cols=6, rows=3, mat_index=0
        )
    # Pubic symphysis arch
    add_curved_shell_patch_pc(
        bm, 0.875, 0.908, -0.58, 0.58,
        0.102, 0.068, 0.014, cols=6, rows=2, mat_index=0
    )
    objs.append(finalize_skinned_mesh_object(
        "Skelet_Pelvis", bm, [pal["bone_cortical"]],
        arm_obj, [("Bone_PELVIS_GROIN", 1.0)], collection,
    ))

    return objs


# ---------------------------------------------------------------------------
# Armature-Space Pose Helper (with Full Roll/Palm Orientation!) & 5 Baked NLA Clips
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
    z_hint_pc: Optional[Tuple[float, float, float]] = None,
) -> None:
    """
    Rotate `bone_name` in armature space so its longitudinal +Y axis points along `target_dir_pc`.
    If `z_hint_pc` is provided, aligns the bone's local +Z axis cleanly toward `z_hint_pc`
    (eliminating waiter-tray palm-down hand twisting when gripping rifles!).
    """
    bpy.context.view_layer.update()
    pb = arm_obj.pose.bones[bone_name]
    cur_mat = pb.matrix.copy()
    cur_head = cur_mat.translation.copy()
    cur_y = cur_mat.col[1].to_3d().normalized()

    desired_y = pc_vec_to_bl(target_dir_pc).normalized()
    if desired_y.length < 1e-6:
        return

    if z_hint_pc is not None:
        hint_bl = pc_vec_to_bl(z_hint_pc).normalized()
        basis_x = desired_y.cross(hint_bl)
        if basis_x.length > 1e-5:
            basis_x.normalize()
            basis_z = basis_x.cross(desired_y).normalized()
            rot3 = Matrix((basis_x, desired_y, basis_z)).transposed()
            if abs(twist_deg) > 1e-4:
                rot3 = Quaternion(desired_y, math.radians(twist_deg)).to_matrix() @ rot3
            new_mat = rot3.to_4x4()
            new_mat.translation = cur_head
            pb.matrix = new_mat
            bpy.context.view_layer.update()
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


def mirror_vec_pc(v: Tuple[float, float, float], southpaw: bool) -> Tuple[float, float, float]:
    return (-v[0], v[1], v[2]) if southpaw else v


def side_bone(prefix: str, anatomical_side: str, southpaw: bool) -> str:
    """
    Maps anatomical side ('TRIGGER' vs 'SUPPORT') to GHOUL bone names.
    Note on coordinate frame: the combatant stands at (0,0,0) facing +Z (towards viewer).
    Therefore -X (`Bone_*_LEFT`) is the character's own ANATOMICAL RIGHT side, and
    +X (`Bone_*_RIGHT`) is the character's own ANATOMICAL LEFT side!
    - Right-handed (`southpaw=False`, default ~88%): TRIGGER = `Bone_*_LEFT` (-X, anatomical right),
      SUPPORT = `Bone_*_RIGHT` (+X, anatomical left).
    - Left-handed (`southpaw=True`, ~12%): TRIGGER = `Bone_*_RIGHT` (+X, anatomical left),
      SUPPORT = `Bone_*_LEFT` (-X, anatomical right).
    """
    is_neg_x = (anatomical_side == "TRIGGER" and not southpaw) or (
        anatomical_side == "SUPPORT" and southpaw
    )
    suffix = "LEFT" if is_neg_x else "RIGHT"
    return f"Bone_{prefix}_{suffix}"


def apply_combat_ready_pose(arm_obj: bpy.types.Object, breath: float = 0.0, southpaw: bool = False) -> None:
    reset_armature_pose(arm_obj)
    sgn = -1.0 if southpaw else 1.0
    set_pelvis_offset_pc(arm_obj, 0.0, -0.032 + breath * 0.008, 0.0)
    # Bladed tactical shooter stance: lead shoulder forward, buttstock (trigger) shoulder back
    aim_pose_bone_pc(arm_obj, "Bone_PELVIS_GROIN", (0.0, 1.0, 0.05), twist_deg=10.0 * sgn)
    aim_pose_bone_pc(arm_obj, "Bone_TORSO_LOWER_ABDOMEN", (0.0, 1.0, 0.09 + breath * 0.02), twist_deg=8.0 * sgn)
    aim_pose_bone_pc(arm_obj, "Bone_TORSO_UPPER_THORAX", (0.0, 1.0, 0.13 + breath * 0.025), twist_deg=6.0 * sgn)
    aim_pose_bone_pc(arm_obj, "Bone_NECK_CERVICAL", (0.0, 1.0, 0.05), twist_deg=-12.0 * sgn)
    aim_pose_bone_pc(arm_obj, "Bone_HEAD_CRANIUM", (0.0, 1.0, 0.02), twist_deg=-12.0 * sgn)

    # Trigger arm: elbow tucked down/back, right hand back at pistol-grip in front of right shoulder pocket (-0.13, 1.27, +0.21)
    aim_pose_bone_pc(
        arm_obj,
        side_bone("UPPER_ARM", "TRIGGER", southpaw),
        mirror_vec_pc((-0.14, -0.96, -0.06), southpaw),
    )
    aim_pose_bone_pc(
        arm_obj,
        side_bone("FOREARM", "TRIGGER", southpaw),
        mirror_vec_pc((0.48, 0.36, 0.80), southpaw),
        z_hint_pc=mirror_vec_pc((-0.86, 0.18, 0.48), southpaw),
    )
    aim_pose_bone_pc(
        arm_obj,
        side_bone("HAND", "TRIGGER", southpaw),
        mirror_vec_pc((0.28, 0.04, 0.96), southpaw),
        z_hint_pc=mirror_vec_pc((-0.95, 0.14, 0.28), southpaw),
    )

    # Support arm: reaches across chest & 20cm forward (-0.05, 1.27, +0.40) to cradle rifle handguard!
    aim_pose_bone_pc(
        arm_obj,
        side_bone("UPPER_ARM", "SUPPORT", southpaw),
        mirror_vec_pc((-0.34, -0.54, 0.77), southpaw),
    )
    aim_pose_bone_pc(
        arm_obj,
        side_bone("FOREARM", "SUPPORT", southpaw),
        mirror_vec_pc((-0.68, -0.04, 0.73), southpaw),
        z_hint_pc=mirror_vec_pc((0.68, -0.42, 0.60), southpaw),
    )
    aim_pose_bone_pc(
        arm_obj,
        side_bone("HAND", "SUPPORT", southpaw),
        mirror_vec_pc((0.22, 0.06, 0.97), southpaw),
        z_hint_pc=mirror_vec_pc((0.84, -0.50, -0.18), southpaw),
    )

    # Athletic flexed knees: support-side lead leg forward, trigger-side rear leg stepped back
    aim_pose_bone_pc(arm_obj, side_bone("THIGH", "SUPPORT", southpaw), mirror_vec_pc((0.05, -0.96, 0.24), southpaw))
    aim_pose_bone_pc(arm_obj, side_bone("KNEE", "SUPPORT", southpaw), mirror_vec_pc((0.02, -0.98, -0.14), southpaw))
    aim_pose_bone_pc(arm_obj, side_bone("SHIN", "SUPPORT", southpaw), mirror_vec_pc((0.02, -0.98, -0.18), southpaw))
    aim_pose_bone_pc(
        arm_obj,
        side_bone("FOOT", "SUPPORT", southpaw),
        mirror_vec_pc((0.04, -0.25, 0.97), southpaw),
        z_hint_pc=(0.0, 1.0, 0.25),
    )

    aim_pose_bone_pc(arm_obj, side_bone("THIGH", "TRIGGER", southpaw), mirror_vec_pc((-0.07, -0.97, -0.16), southpaw))
    aim_pose_bone_pc(arm_obj, side_bone("KNEE", "TRIGGER", southpaw), mirror_vec_pc((-0.04, -0.98, -0.18), southpaw))
    aim_pose_bone_pc(arm_obj, side_bone("SHIN", "TRIGGER", southpaw), mirror_vec_pc((-0.04, -0.97, -0.22), southpaw))
    aim_pose_bone_pc(
        arm_obj,
        side_bone("FOOT", "TRIGGER", southpaw),
        mirror_vec_pc((-0.06, -0.25, 0.96), southpaw),
        z_hint_pc=(0.0, 1.0, 0.25),
    )


def bake_handed_clip_set(arm_obj: bpy.types.Object, southpaw: bool) -> None:
    suffix = "_Southpaw" if southpaw else ""
    sgn = -1.0 if southpaw else 1.0

    # 1. CombatReadyIdle (frames 1..49 seamless loop)
    name = f"CombatReadyIdle{suffix}"
    act = bpy.data.actions.new(name=name)
    arm_obj.animation_data.action = act
    for frame, b in [(1, 0.0), (13, 0.6), (25, 1.0), (37, 0.4), (49, 0.0)]:
        apply_combat_ready_pose(arm_obj, breath=b, southpaw=southpaw)
        keyframe_all_pose_bones(arm_obj, frame)
    push_action_to_nla(arm_obj, act, name)

    # 2. UnsuspectingIdle (frames 1..61 relaxed patrol guard stance + head scan)
    name = f"UnsuspectingIdle{suffix}"
    act = bpy.data.actions.new(name=name)
    arm_obj.animation_data.action = act
    for frame, scan_yaw, breath in [(1, 0.0, 0.0), (16, 14.0, 0.5), (31, 0.0, 1.0), (46, -14.0, 0.5), (61, 0.0, 0.0)]:
        reset_armature_pose(arm_obj)
        set_pelvis_offset_pc(arm_obj, 0.0, breath * 0.005, 0.0)
        aim_pose_bone_pc(arm_obj, "Bone_TORSO_UPPER_THORAX", (0.0, 1.0, 0.02 + breath * 0.015), twist_deg=4.0 * sgn)
        aim_pose_bone_pc(arm_obj, "Bone_HEAD_CRANIUM", (0.0, 1.0, 0.02), twist_deg=scan_yaw * sgn)
        # Low-ready slung rifle across chest (trigger hand near grip, support hand cradling barrel)
        aim_pose_bone_pc(arm_obj, side_bone("UPPER_ARM", "TRIGGER", southpaw), mirror_vec_pc((-0.22, -0.94, 0.20), southpaw))
        aim_pose_bone_pc(
            arm_obj,
            side_bone("FOREARM", "TRIGGER", southpaw),
            mirror_vec_pc((0.48, -0.28, 0.83), southpaw),
            z_hint_pc=mirror_vec_pc((-0.85, 0.15, 0.45), southpaw),
        )
        aim_pose_bone_pc(
            arm_obj,
            side_bone("HAND", "TRIGGER", southpaw),
            mirror_vec_pc((0.22, -0.18, 0.96), southpaw),
            z_hint_pc=mirror_vec_pc((-0.94, 0.15, 0.22), southpaw),
        )
        aim_pose_bone_pc(arm_obj, side_bone("UPPER_ARM", "SUPPORT", southpaw), mirror_vec_pc((0.20, -0.92, 0.32), southpaw))
        aim_pose_bone_pc(
            arm_obj,
            side_bone("FOREARM", "SUPPORT", southpaw),
            mirror_vec_pc((-0.52, -0.22, 0.82), southpaw),
            z_hint_pc=mirror_vec_pc((0.80, -0.45, 0.35), southpaw),
        )
        aim_pose_bone_pc(
            arm_obj,
            side_bone("HAND", "SUPPORT", southpaw),
            mirror_vec_pc((-0.28, -0.15, 0.95), southpaw),
            z_hint_pc=mirror_vec_pc((0.85, -0.45, 0.25), southpaw),
        )
        keyframe_all_pose_bones(arm_obj, frame)
    push_action_to_nla(arm_obj, act, name)

    # 3. HitStaggerChest (frames 1..28 thoracic kinetic impact recoil stagger)
    name = f"HitStaggerChest{suffix}"
    act = bpy.data.actions.new(name=name)
    arm_obj.animation_data.action = act
    apply_combat_ready_pose(arm_obj, breath=0.0, southpaw=southpaw)
    keyframe_all_pose_bones(arm_obj, 1)

    reset_armature_pose(arm_obj)
    set_pelvis_offset_pc(arm_obj, 0.0, -0.06, -0.08)
    aim_pose_bone_pc(arm_obj, "Bone_TORSO_LOWER_ABDOMEN", (0.0, 0.96, -0.26), twist_deg=-10.0 * sgn)
    aim_pose_bone_pc(arm_obj, "Bone_TORSO_UPPER_THORAX", (-0.05 * sgn, 0.88, -0.46), twist_deg=-18.0 * sgn)
    aim_pose_bone_pc(arm_obj, "Bone_NECK_CERVICAL", (-0.06 * sgn, 0.82, -0.56))
    aim_pose_bone_pc(arm_obj, "Bone_HEAD_CRANIUM", (-0.08 * sgn, 0.76, -0.64))
    aim_pose_bone_pc(arm_obj, side_bone("UPPER_ARM", "TRIGGER", southpaw), mirror_vec_pc((-0.64, -0.52, 0.56), southpaw))
    aim_pose_bone_pc(
        arm_obj,
        side_bone("FOREARM", "TRIGGER", southpaw),
        mirror_vec_pc((-0.20, 0.35, 0.91), southpaw),
        z_hint_pc=mirror_vec_pc((-0.94, 0.15, -0.22), southpaw),
    )
    aim_pose_bone_pc(
        arm_obj,
        side_bone("HAND", "TRIGGER", southpaw),
        mirror_vec_pc((-0.10, 0.25, 0.96), southpaw),
        z_hint_pc=mirror_vec_pc((-0.96, 0.15, -0.12), southpaw),
    )
    aim_pose_bone_pc(arm_obj, side_bone("UPPER_ARM", "SUPPORT", southpaw), mirror_vec_pc((0.62, -0.56, 0.54), southpaw))
    aim_pose_bone_pc(
        arm_obj,
        side_bone("FOREARM", "SUPPORT", southpaw),
        mirror_vec_pc((0.25, 0.42, 0.87), southpaw),
        z_hint_pc=mirror_vec_pc((0.92, -0.20, -0.28), southpaw),
    )
    aim_pose_bone_pc(
        arm_obj,
        side_bone("HAND", "SUPPORT", southpaw),
        mirror_vec_pc((0.15, 0.35, 0.92), southpaw),
        z_hint_pc=mirror_vec_pc((0.95, -0.15, -0.15), southpaw),
    )
    aim_pose_bone_pc(arm_obj, side_bone("THIGH", "SUPPORT", southpaw), mirror_vec_pc((0.08, -0.94, 0.32), southpaw))
    aim_pose_bone_pc(arm_obj, side_bone("SHIN", "SUPPORT", southpaw), mirror_vec_pc((0.04, -0.95, -0.30), southpaw))
    aim_pose_bone_pc(arm_obj, side_bone("THIGH", "TRIGGER", southpaw), mirror_vec_pc((-0.10, -0.92, -0.36), southpaw))
    keyframe_all_pose_bones(arm_obj, 6)

    reset_armature_pose(arm_obj)
    set_pelvis_offset_pc(arm_obj, 0.0, -0.09, -0.14)
    aim_pose_bone_pc(arm_obj, "Bone_TORSO_LOWER_ABDOMEN", (0.0, 0.94, 0.32))
    aim_pose_bone_pc(arm_obj, "Bone_TORSO_UPPER_THORAX", (0.0, 0.88, 0.46))
    aim_pose_bone_pc(arm_obj, "Bone_HEAD_CRANIUM", (0.0, 0.95, 0.30))
    aim_pose_bone_pc(arm_obj, side_bone("UPPER_ARM", "TRIGGER", southpaw), mirror_vec_pc((-0.28, -0.80, 0.52), southpaw))
    aim_pose_bone_pc(
        arm_obj,
        side_bone("FOREARM", "TRIGGER", southpaw),
        mirror_vec_pc((0.45, 0.22, 0.86), southpaw),
        z_hint_pc=mirror_vec_pc((-0.86, 0.18, 0.44), southpaw),
    )
    aim_pose_bone_pc(
        arm_obj,
        side_bone("HAND", "TRIGGER", southpaw),
        mirror_vec_pc((0.14, 0.06, 0.98), southpaw),
        z_hint_pc=mirror_vec_pc((-0.95, 0.15, 0.14), southpaw),
    )
    aim_pose_bone_pc(arm_obj, side_bone("UPPER_ARM", "SUPPORT", southpaw), mirror_vec_pc((0.28, -0.78, 0.55), southpaw))
    aim_pose_bone_pc(
        arm_obj,
        side_bone("FOREARM", "SUPPORT", southpaw),
        mirror_vec_pc((-0.48, 0.25, 0.84), southpaw),
        z_hint_pc=mirror_vec_pc((0.80, -0.45, 0.38), southpaw),
    )
    aim_pose_bone_pc(
        arm_obj,
        side_bone("HAND", "SUPPORT", southpaw),
        mirror_vec_pc((-0.14, 0.10, 0.98), southpaw),
        z_hint_pc=mirror_vec_pc((0.85, -0.50, 0.12), southpaw),
    )
    keyframe_all_pose_bones(arm_obj, 15)

    apply_combat_ready_pose(arm_obj, breath=0.2, southpaw=southpaw)
    keyframe_all_pose_bones(arm_obj, 28)
    push_action_to_nla(arm_obj, act, name)

    # 4. DiaphragmDropKneel (frames 1..42: support hand clutches solar plexus, trigger hand keeps weapon ready, drops to trigger-side knee)
    name = f"DiaphragmDropKneel{suffix}"
    act = bpy.data.actions.new(name=name)
    arm_obj.animation_data.action = act
    apply_combat_ready_pose(arm_obj, breath=0.0, southpaw=southpaw)
    keyframe_all_pose_bones(arm_obj, 1)

    reset_armature_pose(arm_obj)
    set_pelvis_offset_pc(arm_obj, 0.0, -0.14, -0.04)
    aim_pose_bone_pc(arm_obj, "Bone_TORSO_LOWER_ABDOMEN", (0.0, 0.84, 0.54))
    aim_pose_bone_pc(arm_obj, "Bone_TORSO_UPPER_THORAX", (0.0, 0.72, 0.69))
    aim_pose_bone_pc(arm_obj, "Bone_HEAD_CRANIUM", (0.0, 0.65, 0.76))
    aim_pose_bone_pc(arm_obj, side_bone("UPPER_ARM", "SUPPORT", southpaw), mirror_vec_pc((0.15, -0.82, 0.55), southpaw))
    aim_pose_bone_pc(
        arm_obj,
        side_bone("FOREARM", "SUPPORT", southpaw),
        mirror_vec_pc((-0.85, 0.20, 0.48), southpaw),
        z_hint_pc=mirror_vec_pc((0.40, 0.15, 0.90), southpaw),
    )
    aim_pose_bone_pc(
        arm_obj,
        side_bone("HAND", "SUPPORT", southpaw),
        mirror_vec_pc((-0.78, 0.15, 0.60), southpaw),
        z_hint_pc=mirror_vec_pc((0.50, 0.15, 0.85), southpaw),
    )
    aim_pose_bone_pc(arm_obj, side_bone("UPPER_ARM", "TRIGGER", southpaw), mirror_vec_pc((-0.30, -0.88, 0.36), southpaw))
    aim_pose_bone_pc(
        arm_obj,
        side_bone("FOREARM", "TRIGGER", southpaw),
        mirror_vec_pc((0.25, -0.10, 0.96), southpaw),
        z_hint_pc=mirror_vec_pc((-0.94, 0.15, 0.25), southpaw),
    )
    aim_pose_bone_pc(
        arm_obj,
        side_bone("HAND", "TRIGGER", southpaw),
        mirror_vec_pc((0.10, -0.05, 0.99), southpaw),
        z_hint_pc=mirror_vec_pc((-0.96, 0.15, 0.10), southpaw),
    )
    aim_pose_bone_pc(arm_obj, side_bone("THIGH", "SUPPORT", southpaw), mirror_vec_pc((0.06, -0.82, 0.56), southpaw))
    aim_pose_bone_pc(arm_obj, side_bone("SHIN", "SUPPORT", southpaw), mirror_vec_pc((0.02, -0.96, -0.28), southpaw))
    aim_pose_bone_pc(arm_obj, side_bone("THIGH", "TRIGGER", southpaw), mirror_vec_pc((-0.08, -0.95, -0.30), southpaw))
    aim_pose_bone_pc(arm_obj, side_bone("SHIN", "TRIGGER", southpaw), mirror_vec_pc((-0.04, -0.55, -0.83), southpaw))
    keyframe_all_pose_bones(arm_obj, 9)

    for frame, gasp in [(24, 0.0), (33, 0.14), (42, 0.04)]:
        reset_armature_pose(arm_obj)
        set_pelvis_offset_pc(arm_obj, 0.0, -0.38, 0.02)
        aim_pose_bone_pc(arm_obj, "Bone_TORSO_LOWER_ABDOMEN", (0.0, 0.86, 0.50 - gasp))
        aim_pose_bone_pc(arm_obj, "Bone_TORSO_UPPER_THORAX", (0.0, 0.78 + gasp * 0.5, 0.62 - gasp))
        aim_pose_bone_pc(arm_obj, "Bone_NECK_CERVICAL", (0.0, 0.88, 0.46))
        aim_pose_bone_pc(arm_obj, "Bone_HEAD_CRANIUM", (0.0, 0.94, 0.34 - gasp))
        aim_pose_bone_pc(arm_obj, side_bone("UPPER_ARM", "SUPPORT", southpaw), mirror_vec_pc((0.12, -0.85, 0.51), southpaw))
        aim_pose_bone_pc(
            arm_obj,
            side_bone("FOREARM", "SUPPORT", southpaw),
            mirror_vec_pc((-0.88, 0.28, 0.38), southpaw),
            z_hint_pc=mirror_vec_pc((0.35, 0.15, 0.92), southpaw),
        )
        aim_pose_bone_pc(
            arm_obj,
            side_bone("HAND", "SUPPORT", southpaw),
            mirror_vec_pc((-0.80, 0.20, 0.56), southpaw),
            z_hint_pc=mirror_vec_pc((0.48, 0.15, 0.86), southpaw),
        )
        aim_pose_bone_pc(arm_obj, side_bone("UPPER_ARM", "TRIGGER", southpaw), mirror_vec_pc((-0.26, -0.85, 0.45), southpaw))
        aim_pose_bone_pc(
            arm_obj,
            side_bone("FOREARM", "TRIGGER", southpaw),
            mirror_vec_pc((0.22, 0.08, 0.97), southpaw),
            z_hint_pc=mirror_vec_pc((-0.95, 0.15, 0.22), southpaw),
        )
        aim_pose_bone_pc(
            arm_obj,
            side_bone("HAND", "TRIGGER", southpaw),
            mirror_vec_pc((0.08, 0.04, 0.99), southpaw),
            z_hint_pc=mirror_vec_pc((-0.97, 0.15, 0.08), southpaw),
        )
        aim_pose_bone_pc(arm_obj, side_bone("THIGH", "SUPPORT", southpaw), mirror_vec_pc((0.08, -0.18, 0.98), southpaw))
        aim_pose_bone_pc(arm_obj, side_bone("KNEE", "SUPPORT", southpaw), mirror_vec_pc((0.02, -0.98, -0.12), southpaw))
        aim_pose_bone_pc(arm_obj, side_bone("SHIN", "SUPPORT", southpaw), mirror_vec_pc((0.02, -0.99, -0.08), southpaw))
        aim_pose_bone_pc(
            arm_obj,
            side_bone("FOOT", "SUPPORT", southpaw),
            mirror_vec_pc((0.04, -0.15, 0.98), southpaw),
            z_hint_pc=(0.0, 1.0, 0.15),
        )
        aim_pose_bone_pc(arm_obj, side_bone("THIGH", "TRIGGER", southpaw), mirror_vec_pc((-0.08, -0.98, 0.14), southpaw))
        aim_pose_bone_pc(arm_obj, side_bone("KNEE", "TRIGGER", southpaw), mirror_vec_pc((-0.04, -0.25, -0.96), southpaw))
        aim_pose_bone_pc(arm_obj, side_bone("SHIN", "TRIGGER", southpaw), mirror_vec_pc((-0.04, -0.06, -0.99), southpaw))
        aim_pose_bone_pc(
            arm_obj,
            side_bone("FOOT", "TRIGGER", southpaw),
            mirror_vec_pc((-0.04, -0.95, -0.30), southpaw),
            z_hint_pc=(0.0, -0.30, 0.95),
        )
        keyframe_all_pose_bones(arm_obj, frame)
    push_action_to_nla(arm_obj, act, name)

    # 5. LegCollapseCrawl (frames 1..48: prone collapse propped on elbows aiming weapon forward)
    name = f"LegCollapseCrawl{suffix}"
    act = bpy.data.actions.new(name=name)
    arm_obj.animation_data.action = act
    apply_combat_ready_pose(arm_obj, breath=0.0, southpaw=southpaw)
    keyframe_all_pose_bones(arm_obj, 1)

    reset_armature_pose(arm_obj)
    set_pelvis_offset_pc(arm_obj, -0.03 * sgn, -0.46, -0.08)
    aim_pose_bone_pc(arm_obj, "Bone_TORSO_LOWER_ABDOMEN", (-0.04 * sgn, 0.78, 0.62))
    aim_pose_bone_pc(arm_obj, "Bone_TORSO_UPPER_THORAX", (-0.02 * sgn, 0.68, 0.73))
    aim_pose_bone_pc(arm_obj, "Bone_HEAD_CRANIUM", (0.0, 0.85, 0.52))
    aim_pose_bone_pc(arm_obj, side_bone("UPPER_ARM", "TRIGGER", southpaw), mirror_vec_pc((-0.35, -0.70, 0.62), southpaw))
    aim_pose_bone_pc(arm_obj, side_bone("UPPER_ARM", "SUPPORT", southpaw), mirror_vec_pc((0.35, -0.70, 0.62), southpaw))
    aim_pose_bone_pc(arm_obj, side_bone("THIGH", "TRIGGER", southpaw), mirror_vec_pc((-0.32, -0.65, -0.68), southpaw))
    aim_pose_bone_pc(arm_obj, side_bone("SHIN", "TRIGGER", southpaw), mirror_vec_pc((-0.18, -0.25, -0.95), southpaw))
    aim_pose_bone_pc(arm_obj, side_bone("THIGH", "SUPPORT", southpaw), mirror_vec_pc((0.28, -0.60, -0.75), southpaw))
    aim_pose_bone_pc(arm_obj, side_bone("SHIN", "SUPPORT", southpaw), mirror_vec_pc((0.12, -0.20, -0.97), southpaw))
    keyframe_all_pose_bones(arm_obj, 12)

    for frame, crawl_shift in [(28, 0.0), (38, 0.04), (48, 0.0)]:
        reset_armature_pose(arm_obj)
        set_pelvis_offset_pc(arm_obj, 0.0, -0.78, -0.10 + crawl_shift)
        aim_pose_bone_pc(arm_obj, "Bone_PELVIS_GROIN", (0.0, 0.22, 0.97), z_hint_pc=(0.0, -0.97, 0.22))
        aim_pose_bone_pc(arm_obj, "Bone_TORSO_LOWER_ABDOMEN", (0.0, 0.26, 0.96), z_hint_pc=(0.0, -0.96, 0.26))
        aim_pose_bone_pc(arm_obj, "Bone_TORSO_UPPER_THORAX", (0.0, 0.42, 0.91), z_hint_pc=(0.0, -0.91, 0.42))
        aim_pose_bone_pc(arm_obj, "Bone_NECK_CERVICAL", (0.0, 0.78, 0.62))
        aim_pose_bone_pc(arm_obj, "Bone_HEAD_CRANIUM", (0.0, 0.96, 0.28))
        aim_pose_bone_pc(arm_obj, side_bone("UPPER_ARM", "TRIGGER", southpaw), mirror_vec_pc((-0.42, -0.65, 0.63), southpaw))
        aim_pose_bone_pc(
            arm_obj,
            side_bone("FOREARM", "TRIGGER", southpaw),
            mirror_vec_pc((0.42, 0.18, 0.89), southpaw),
            z_hint_pc=mirror_vec_pc((-0.88, 0.18, 0.42), southpaw),
        )
        aim_pose_bone_pc(
            arm_obj,
            side_bone("HAND", "TRIGGER", southpaw),
            mirror_vec_pc((0.10, 0.08, 0.99), southpaw),
            z_hint_pc=mirror_vec_pc((-0.96, 0.15, 0.10), southpaw),
        )
        aim_pose_bone_pc(arm_obj, side_bone("UPPER_ARM", "SUPPORT", southpaw), mirror_vec_pc((0.42, -0.65, 0.63), southpaw))
        aim_pose_bone_pc(
            arm_obj,
            side_bone("FOREARM", "SUPPORT", southpaw),
            mirror_vec_pc((-0.42, 0.18, 0.89), southpaw),
            z_hint_pc=mirror_vec_pc((0.82, -0.42, 0.38), southpaw),
        )
        aim_pose_bone_pc(
            arm_obj,
            side_bone("HAND", "SUPPORT", southpaw),
            mirror_vec_pc((-0.10, 0.08, 0.99), southpaw),
            z_hint_pc=mirror_vec_pc((0.85, -0.50, 0.10), southpaw),
        )
        aim_pose_bone_pc(
            arm_obj,
            side_bone("THIGH", "TRIGGER", southpaw),
            mirror_vec_pc((-0.22, -0.06, -0.97), southpaw),
            z_hint_pc=(0.0, -1.0, 0.06),
        )
        aim_pose_bone_pc(
            arm_obj,
            side_bone("KNEE", "TRIGGER", southpaw),
            mirror_vec_pc((-0.14, -0.04, -0.99), southpaw),
            z_hint_pc=(0.0, -1.0, 0.04),
        )
        aim_pose_bone_pc(
            arm_obj,
            side_bone("SHIN", "TRIGGER", southpaw),
            mirror_vec_pc((-0.12, 0.02, -0.99), southpaw),
            z_hint_pc=(0.0, -1.0, -0.02),
        )
        aim_pose_bone_pc(
            arm_obj,
            side_bone("FOOT", "TRIGGER", southpaw),
            mirror_vec_pc((-0.12, -0.85, -0.52), southpaw),
            z_hint_pc=(0.0, -0.52, 0.85),
        )
        aim_pose_bone_pc(
            arm_obj,
            side_bone("THIGH", "SUPPORT", southpaw),
            mirror_vec_pc((0.18, -0.06, -0.98), southpaw),
            z_hint_pc=(0.0, -1.0, 0.06),
        )
        aim_pose_bone_pc(
            arm_obj,
            side_bone("KNEE", "SUPPORT", southpaw),
            mirror_vec_pc((0.10, -0.04, -0.99), southpaw),
            z_hint_pc=(0.0, -1.0, 0.04),
        )
        aim_pose_bone_pc(
            arm_obj,
            side_bone("SHIN", "SUPPORT", southpaw),
            mirror_vec_pc((0.08, 0.02, -0.99), southpaw),
            z_hint_pc=(0.0, -1.0, -0.02),
        )
        aim_pose_bone_pc(
            arm_obj,
            side_bone("FOOT", "SUPPORT", southpaw),
            mirror_vec_pc((0.10, -0.85, -0.52), southpaw),
            z_hint_pc=(0.0, -0.52, 0.85),
        )
        keyframe_all_pose_bones(arm_obj, frame)
    push_action_to_nla(arm_obj, act, name)


def bake_all_combatant_animations(arm_obj: bpy.types.Object) -> None:
    bpy.context.scene.render.fps = 24
    arm_obj.animation_data_create()
    bake_handed_clip_set(arm_obj, southpaw=False)
    bake_handed_clip_set(arm_obj, southpaw=True)
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

    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND)

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
