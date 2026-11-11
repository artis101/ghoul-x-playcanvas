#!/usr/bin/env python3
"""
Procedural Blender 5.2.1 LTS Pipeline — GHOUL-X AAA Hard-Surface & PBR Animated 3D Weapon Arsenal.

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
  - -Z = Barrel / Muzzle Forward (matches PlayCanvas `cameraEntity` forward axis `-Z`)
  - Blender 5.2 internal mapping: `pc_to_bl(x, y, z) = Vector((x, -z, y))` so exporting with
    `export_yup=True` produces exact PlayCanvas `(x, y, z)` coordinates with CCW outward normals.
"""

import math
import os
from typing import Dict, List, Optional, Sequence, Tuple

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector


REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_DIR = os.path.join(REPO_ROOT, "public", "models")
OUT_BLEND = os.path.join(OUT_DIR, "blend_sources", "weapons_arsenal.blend")


def pc_to_bl(x: float, y: float, z: float) -> Vector:
    return Vector((x, -z, y))


def pc_vec_to_bl(v: Tuple[float, float, float]) -> Vector:
    return Vector((v[0], -v[2], v[1]))


def bl_to_pc(v: Vector) -> Tuple[float, float, float]:
    return (v.x, v.z, -v.y)


# ---------------------------------------------------------------------------
# Vectorized Procedural PBR Texture Suite (Albedo + Tangent Normal + ORM)
# ---------------------------------------------------------------------------

def _hash_grid(ix: np.ndarray, iy: np.ndarray, seed: int) -> np.ndarray:
    n = (ix.astype(np.int64) * 374761393 + iy.astype(np.int64) * 668265263 + seed * 1442695041) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((n ^ (n >> 16)) & 0xFFFF).astype(np.float32) / 65535.0


def tileable_value_noise(size: int, freq_x: int, freq_y: int, seed: int) -> np.ndarray:
    xs = (np.arange(size, dtype=np.float32) + 0.5) / size * freq_x
    ys = (np.arange(size, dtype=np.float32) + 0.5) / size * freq_y
    gx, gy = np.meshgrid(xs, ys)

    ix0 = np.floor(gx).astype(np.int64) % freq_x
    iy0 = np.floor(gy).astype(np.int64) % freq_y
    ix1 = (ix0 + 1) % freq_x
    iy1 = (iy0 + 1) % freq_y

    fx = gx - np.floor(gx)
    fy = gy - np.floor(gy)
    ux = fx * fx * (3.0 - 2.0 * fx)
    uy = fy * fy * (3.0 - 2.0 * fy)

    v00 = _hash_grid(ix0, iy0, seed)
    v10 = _hash_grid(ix1, iy0, seed)
    v01 = _hash_grid(ix0, iy1, seed)
    v11 = _hash_grid(ix1, iy1, seed)

    nx0 = v00 * (1.0 - ux) + v10 * ux
    nx1 = v01 * (1.0 - ux) + v11 * ux
    return nx0 * (1.0 - uy) + nx1 * uy


def fbm_periodic(size: int, base_fx: int, base_fy: int, octaves: int, seed: int, gain: float = 0.5) -> np.ndarray:
    acc = np.zeros((size, size), dtype=np.float32)
    amp = 1.0
    norm = 0.0
    fx, fy = base_fx, base_fy
    for o in range(octaves):
        acc += amp * tileable_value_noise(size, fx, fy, seed + o * 89)
        norm += amp
        amp *= gain
        fx = min(size // 2, fx * 2)
        fy = min(size // 2, fy * 2)
    return acc / max(norm, 1e-6)


def height_to_normal_rgb(height: np.ndarray, strength: float) -> np.ndarray:
    dh_du = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 0.5 * strength
    dh_dv = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * 0.5 * strength
    nx = -dh_du
    ny = -dh_dv
    nz = np.ones_like(height)
    inv_len = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz)
    rgb = np.stack(
        [(nx * inv_len) * 0.5 + 0.5, (ny * inv_len) * 0.5 + 0.5, (nz * inv_len) * 0.5 + 0.5],
        axis=-1,
    )
    return np.clip(rgb, 0.0, 1.0)


def create_packed_image(name: str, rgb: np.ndarray, non_color: bool = False) -> bpy.types.Image:
    h, w, _ = rgb.shape
    img = bpy.data.images.new(name=name, width=w, height=h, alpha=False)
    img.colorspace_settings.name = "Non-Color" if non_color else "sRGB"
    rgba = np.empty((h, w, 4), dtype=np.float32)
    rgba[:, :, :3] = np.clip(rgb, 0.0, 1.0)
    rgba[:, :, 3] = 1.0
    img.pixels.foreach_set(rgba.ravel())
    img.pack()
    return img


def make_textured_pbr_material(
    name: str,
    albedo_img: Optional[bpy.types.Image] = None,
    base_color: Tuple[float, float, float, float] = (1.0, 1.0, 1.0, 1.0),
    normal_img: Optional[bpy.types.Image] = None,
    normal_strength: float = 1.0,
    orm_img: Optional[bpy.types.Image] = None,
    roughness: float = 0.45,
    metallic: float = 0.0,
    emission_color: Optional[Tuple[float, float, float, float]] = None,
    emission_strength: float = 0.0,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name=name)
    if mat.node_tree is None:
        mat.use_nodes = True
    nt = mat.node_tree
    nodes = nt.nodes
    links = nt.links
    bsdf = nodes.get("Principled BSDF") or nodes.new(type="ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = base_color
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic

    if albedo_img is not None:
        t_alb = nodes.new(type="ShaderNodeTexImage")
        t_alb.image = albedo_img
        t_alb.interpolation = "Linear"
        links.new(t_alb.outputs["Color"], bsdf.inputs["Base Color"])

    if orm_img is not None:
        t_orm = nodes.new(type="ShaderNodeTexImage")
        t_orm.image = orm_img
        t_orm.interpolation = "Linear"
        sep = nodes.new(type="ShaderNodeSeparateColor")
        links.new(t_orm.outputs["Color"], sep.inputs["Color"])
        links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])

    if normal_img is not None:
        t_nrm = nodes.new(type="ShaderNodeTexImage")
        t_nrm.image = normal_img
        t_nrm.interpolation = "Linear"
        nmap = nodes.new(type="ShaderNodeNormalMap")
        nmap.inputs["Strength"].default_value = normal_strength
        links.new(t_nrm.outputs["Color"], nmap.inputs["Color"])
        links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])

    if emission_color is not None and "Emission Color" in bsdf.inputs:
        bsdf.inputs["Emission Color"].default_value = emission_color
        bsdf.inputs["Emission Strength"].default_value = emission_strength

    return mat


def build_weapon_materials() -> Dict[str, bpy.types.Material]:
    S = 192
    us = (np.arange(S, dtype=np.float32) + 0.5) / S
    vs = (np.arange(S, dtype=np.float32) + 0.5) / S
    uu, vv = np.meshgrid(us, vs)

    # 1. Parkerized / Manganese-Phosphate Nitride Steel (anisotropic grain + micro-pitting + oil mottling)
    brush_u = tileable_value_noise(S, 6, 96, seed=101)
    brush_fine = tileable_value_noise(S, 12, 128, seed=107)
    pits = tileable_value_noise(S, 84, 84, seed=113)
    oil_mottle = fbm_periodic(S, 6, 6, 3, seed=127)
    scratches = np.clip((tileable_value_noise(S, 16, 64, seed=131) - 0.86) * 5.0, 0.0, 1.0)

    pk_h = 0.50 + (brush_u - 0.5) * 0.22 + (brush_fine - 0.5) * 0.14 - np.clip((pits - 0.78) * 2.2, 0.0, 1.0) * 0.18 + scratches * 0.10
    pk_val = 0.185 + (oil_mottle - 0.5) * 0.026 + (brush_u - 0.5) * 0.016 + scratches * 0.05
    pk_alb = create_packed_image("Tex_Parkerized_Albedo", np.stack([pk_val * 0.96, pk_val * 1.00, pk_val * 1.05], axis=-1))
    pk_nrm = create_packed_image("Tex_Parkerized_Normal", height_to_normal_rgb(pk_h, strength=2.0), non_color=True)
    pk_rough = np.clip(0.39 - (oil_mottle - 0.5) * 0.10 + (pits - 0.5) * 0.06 - scratches * 0.08, 0.26, 0.50)
    pk_metal = np.clip(0.88 + scratches * 0.06, 0.84, 0.96)
    pk_orm = create_packed_image("Tex_Parkerized_ORM", np.stack([np.clip(0.95 - np.clip(pits - 0.76, 0.0, 1.0) * 0.3, 0.80, 1.0), pk_rough, pk_metal], axis=-1), non_color=True)

    # 2. Type-III Hardcoat Anodized Forged 7075-T6 Receiver Aluminum (bead-blasted micro-dimples + CNC sheen)
    bead1 = tileable_value_noise(S, 96, 96, seed=201)
    bead2 = tileable_value_noise(S, 48, 48, seed=211)
    an_mottle = fbm_periodic(S, 8, 8, 3, seed=223)
    edge_speck = np.clip((bead1 * bead2 - 0.68) * 3.0, 0.0, 1.0)

    an_h = 0.50 + (bead1 - 0.5) * 0.22 + (bead2 - 0.5) * 0.14
    an_val = 0.130 + (an_mottle - 0.5) * 0.018 + (bead2 - 0.5) * 0.010 + edge_speck * 0.04
    an_alb = create_packed_image("Tex_Anodized_Albedo", np.stack([an_val * 0.96, an_val * 1.00, an_val * 1.07], axis=-1))
    an_nrm = create_packed_image("Tex_Anodized_Normal", height_to_normal_rgb(an_h, strength=1.6), non_color=True)
    an_rough = np.clip(0.36 + (bead1 - 0.5) * 0.08 - (an_mottle - 0.5) * 0.05, 0.26, 0.45)
    an_metal = np.clip(0.82 + edge_speck * 0.10, 0.76, 0.92)
    an_orm = create_packed_image("Tex_Anodized_ORM", np.stack([np.full_like(an_rough, 0.97), an_rough, an_metal], axis=-1), non_color=True)

    # 3. Directional Brushed Hard Chrome & Polished Bolt Steel (Silver Talon .50 AE + BCGs)
    ch_grain1 = tileable_value_noise(S, 6, 128, seed=301)
    ch_grain2 = tileable_value_noise(S, 12, 84, seed=313)
    ch_cross = tileable_value_noise(S, 48, 12, seed=317)
    ch_h = 0.50 + (ch_grain1 - 0.5) * 0.24 + (ch_grain2 - 0.5) * 0.14 + (ch_cross - 0.5) * 0.04
    ch_val = 0.86 + (ch_grain1 - 0.5) * 0.022 + (ch_grain2 - 0.5) * 0.012
    ch_alb = create_packed_image("Tex_Chrome_Albedo", np.stack([ch_val * 0.98, ch_val * 1.00, ch_val * 1.03], axis=-1))
    bs_val = 0.58 + (ch_grain1 - 0.5) * 0.032 + (oil_mottle - 0.5) * 0.024
    bs_alb = create_packed_image("Tex_BoltSteel_Albedo", np.stack([bs_val * 0.98, bs_val * 1.00, bs_val * 1.04], axis=-1))
    ch_nrm = create_packed_image("Tex_BrushedMetal_Normal", height_to_normal_rgb(ch_h, strength=1.5), non_color=True)
    ch_rough = np.clip(0.21 + (ch_grain1 - 0.5) * 0.06 + np.abs(ch_grain2 - 0.5) * 0.04, 0.14, 0.28)
    ch_orm = create_packed_image("Tex_BrushedMetal_ORM", np.stack([np.full_like(ch_rough, 0.98), ch_rough, np.full_like(ch_rough, 0.97)], axis=-1), non_color=True)

    # 4. High-Frequency Diamond-Checkered / Laser-Stippled Tactical Polymer (Black & FDE)
    # Periodic diamond knurling pyramids + organic stipple micro-cells
    freq_d = 42.0
    d1 = np.abs(((uu + vv) * freq_d) % 1.0 - 0.5) * 2.0
    d2 = np.abs(((uu - vv) * freq_d) % 1.0 - 0.5) * 2.0
    diamond_pyr = (1.0 - np.maximum(d1, d2))  # Sharp pyramid peaks in [0, 1]
    stipple_jit = tileable_value_noise(S, 72, 72, seed=401)
    nylon_mottle = fbm_periodic(S, 10, 10, 3, seed=409)

    poly_h = 0.40 + diamond_pyr * 0.36 + (stipple_jit - 0.5) * 0.20
    poly_nrm = create_packed_image("Tex_PolymerStipple_Normal", height_to_normal_rgb(poly_h, strength=3.5), non_color=True)
    poly_ao = np.clip(0.82 + diamond_pyr * 0.18, 0.76, 1.0)
    poly_rough = np.clip(0.74 - diamond_pyr * 0.10 + (stipple_jit - 0.5) * 0.08, 0.58, 0.86)
    poly_orm = create_packed_image("Tex_PolymerStipple_ORM", np.stack([poly_ao, poly_rough, np.full_like(poly_rough, 0.03)], axis=-1), non_color=True)

    pb_val = 0.084 + diamond_pyr * 0.014 + (nylon_mottle - 0.5) * 0.010
    pb_alb = create_packed_image("Tex_PolymerBlack_Albedo", np.stack([pb_val * 0.98, pb_val * 0.99, pb_val * 1.05], axis=-1))

    fde_mod = 0.96 + diamond_pyr * 0.04 + (nylon_mottle - 0.5) * 0.05
    fde_alb = create_packed_image("Tex_PolymerFDE_Albedo", np.stack([0.42 * fde_mod, 0.34 * fde_mod, 0.23 * fde_mod], axis=-1))

    # 5. M67 Cast-Iron Olive Drab + Yellow Comp-B High-Explosive Stencil Band (v in [0.68, 0.74])
    cast_coarse = fbm_periodic(S, 14, 14, 3, seed=503)
    cast_fine = tileable_value_noise(S, 72, 72, seed=509)
    paint_chip = np.clip((tileable_value_noise(S, 36, 36, seed=521) - 0.80) * 4.0, 0.0, 1.0)

    m67_h = 0.50 + (cast_coarse - 0.5) * 0.24 + (cast_fine - 0.5) * 0.20 - paint_chip * 0.10
    # Crisp horizontal yellow stencil marking band around upper shoulder of sphere (v ~ 0.69..0.745)
    band_mask = np.clip(1.0 - np.abs(vv - 0.718) / 0.026, 0.0, 1.0)
    band_mask = np.clip(band_mask * 3.0, 0.0, 1.0) * (1.0 - paint_chip * 0.55)
    # Dashed stencil breaks along U for authentic military lot-marking look
    dash_cut = ((uu * 16.0) % 1.0 > 0.88).astype(np.float32) * ((vv > 0.708).astype(np.float32))
    band_mask = band_mask * (1.0 - dash_cut * 0.75)

    od_mod = 0.95 + (cast_coarse - 0.5) * 0.10 + (cast_fine - 0.5) * 0.06
    od_r = 0.21 * od_mod * (1.0 - band_mask) + (0.86 * od_mod) * band_mask
    od_g = 0.27 * od_mod * (1.0 - band_mask) + (0.69 * od_mod) * band_mask
    od_b = 0.14 * od_mod * (1.0 - band_mask) + (0.15 * od_mod) * band_mask
    # Subtle bare steel glint on chipped paint specks
    od_r = od_r * (1.0 - paint_chip * 0.30) + 0.44 * (paint_chip * 0.30)
    od_g = od_g * (1.0 - paint_chip * 0.30) + 0.45 * (paint_chip * 0.30)
    od_b = od_b * (1.0 - paint_chip * 0.30) + 0.46 * (paint_chip * 0.30)

    m67_alb = create_packed_image("Tex_M67_Albedo", np.stack([od_r, od_g, od_b], axis=-1))
    m67_nrm = create_packed_image("Tex_M67_Normal", height_to_normal_rgb(m67_h, strength=2.6), non_color=True)
    m67_rough = np.clip(0.54 + (cast_fine - 0.5) * 0.12 - paint_chip * 0.14, 0.36, 0.70)
    m67_metal = np.clip(0.16 + paint_chip * 0.50, 0.14, 0.76)
    m67_orm = create_packed_image("Tex_M67_ORM", np.stack([np.full_like(m67_rough, 0.96), m67_rough, m67_metal], axis=-1), non_color=True)

    return {
        "parkerized_steel": make_textured_pbr_material(
            "Mat_ParkerizedSteel", albedo_img=pk_alb, normal_img=pk_nrm, normal_strength=0.35, orm_img=pk_orm
        ),
        "anodized_black": make_textured_pbr_material(
            "Mat_AnodizedReceiver", albedo_img=an_alb, normal_img=an_nrm, normal_strength=0.28, orm_img=an_orm
        ),
        "brushed_chrome": make_textured_pbr_material(
            "Mat_BrushedSilverChrome", albedo_img=ch_alb, normal_img=ch_nrm, normal_strength=0.22, orm_img=ch_orm
        ),
        "bolt_steel": make_textured_pbr_material(
            "Mat_BoltSteel_Polished", albedo_img=bs_alb, normal_img=ch_nrm, normal_strength=0.22, orm_img=ch_orm
        ),
        "polymer_grip": make_textured_pbr_material(
            "Mat_PolymerFurniture", albedo_img=pb_alb, normal_img=poly_nrm, normal_strength=0.55, orm_img=poly_orm
        ),
        "polymer_fde": make_textured_pbr_material(
            "Mat_TacticalPolymer_FDE", albedo_img=fde_alb, normal_img=poly_nrm, normal_strength=0.28, orm_img=poly_orm
        ),
        "olive_drab": make_textured_pbr_material(
            "Mat_M67_OliveDrab", albedo_img=m67_alb, normal_img=m67_nrm, normal_strength=0.50, orm_img=m67_orm
        ),
        "fuze_zinc": make_textured_pbr_material(
            "Mat_FuzeZincSteel", base_color=(0.60, 0.58, 0.50, 1.0), normal_img=an_nrm, normal_strength=0.18, roughness=0.31, metallic=0.88
        ),
        "shell_red": make_textured_pbr_material(
            "Mat_Shotshell_Crimson", base_color=(0.70, 0.08, 0.09, 1.0), normal_img=ch_nrm, normal_strength=0.20, roughness=0.38, metallic=0.04
        ),
        "brass_gold": make_textured_pbr_material(
            "Mat_BrassCasing", base_color=(0.86, 0.68, 0.25, 1.0), normal_img=ch_nrm, normal_strength=0.18, roughness=0.20, metallic=0.94
        ),
        "copper_jacket": make_textured_pbr_material(
            "Mat_CopperJacket", base_color=(0.78, 0.43, 0.25, 1.0), normal_img=ch_nrm, normal_strength=0.16, roughness=0.22, metallic=0.93
        ),
        "rubber_pad": make_textured_pbr_material(
            "Mat_RecoilRubber", base_color=(0.050, 0.052, 0.056, 1.0), normal_img=poly_nrm, normal_strength=0.28, roughness=0.86, metallic=0.02
        ),
        "dark_bore": make_textured_pbr_material(
            "Mat_BarrelBoreDark", base_color=(0.012, 0.012, 0.015, 1.0), roughness=0.94, metallic=0.15
        ),
        "optic_glass": make_textured_pbr_material(
            "Mat_OpticLens_Coated", base_color=(0.05, 0.26, 0.30, 1.0), roughness=0.06, metallic=0.88,
            emission_color=(0.07, 0.52, 0.42, 1.0), emission_strength=0.42,
        ),
        "holo_reticle": make_textured_pbr_material(
            "Mat_HoloReticle_Glow", base_color=(0.98, 0.16, 0.08, 1.0), roughness=0.10, metallic=0.05,
            emission_color=(1.0, 0.18, 0.08, 1.0), emission_strength=2.50,
        ),
        "tritium_sight": make_textured_pbr_material(
            "Mat_TritiumNightSight", base_color=(0.18, 0.96, 0.34, 1.0), roughness=0.18, metallic=0.10,
            emission_color=(0.20, 0.98, 0.36, 1.0), emission_strength=1.65,
        ),
    }


# ---------------------------------------------------------------------------
# AAA Hard-Surface BMesh Primitives (in PlayCanvas Viewmodel Coordinates)
# ---------------------------------------------------------------------------

def assign_weapon_uvs(bm: bmesh.types.BMesh, scale: float = 5.5, uv_mode: str = "weapon") -> None:
    """
    Assign clean directional UVs:
      - `weapon`: U runs along barrel axis (`pc_z`) on side/top/bottom surfaces so anisotropic brushed
        steel & machining grain follows the barrel/slide axis; stippled grips get crisp uniform cells.
      - `m67_body`: Spherical UVs on grenade body (`y_pc <= 0.035`) so the yellow Comp-B stencil band wraps
        horizontally around the upper hemisphere, while fuze collar maps to olive/zinc region.
      - `m67_olive_only`: Clamps V into `[0.15, 0.52]` so M67 spoon stays pure cast olive-drab without yellow band.
    """
    uv_layer = bm.loops.layers.uv.verify()
    for face in bm.faces:
        n = face.normal
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        for loop in face.loops:
            px, py, pz = bl_to_pc(loop.vert.co)
            if uv_mode == "m67_body":
                if py <= 0.0355:
                    u = math.atan2(px, pz) / (2.0 * math.pi) + 0.5
                    v = max(0.02, min(0.96, (py + 0.0345) / 0.069))
                else:
                    u = (px + pz) * 8.0 + 0.5
                    v = 0.32 + (py - 0.035) * 4.0
            elif uv_mode == "m67_olive_only":
                u = (px + pz) * 6.0 + 0.5
                v = 0.20 + max(0.0, min(0.32, (py + 0.04) * 3.0))
            else:
                # Blender X=pc_x, Y=-pc_z, Z=pc_y
                if ay >= ax and ay >= az:
                    # Front/rear cap face (normal along pc_z)
                    u, v = px * scale + 0.5, py * scale + 0.5
                elif ax >= ay and ax >= az:
                    # Left/right flank (normal along pc_x): U = pc_z (barrel axis!), V = pc_y
                    u, v = -pz * scale + 0.5, py * scale + 0.5
                else:
                    # Top/bottom face (normal along pc_y): U = pc_z (barrel axis!), V = pc_x
                    u, v = -pz * scale + 0.5, px * scale + 0.5
            loop[uv_layer].uv = (u, v)


def _rot_pc_to_bl_matrix(pitch_deg: float = 0.0, yaw_deg: float = 0.0, roll_deg: float = 0.0) -> Matrix:
    return Euler(
        (math.radians(pitch_deg), math.radians(-roll_deg), math.radians(yaw_deg)),
        "XYZ",
    ).to_matrix()


def add_box_pc(
    bm: bmesh.types.BMesh,
    center_pc: Tuple[float, float, float],
    half_extents_pc: Tuple[float, float, float],
    bevel: float = 0.0020,
    bevel_segs: int = 1,
    mat_idx: int = 0,
    pitch_deg: float = 0.0,
    yaw_deg: float = 0.0,
    roll_deg: float = 0.0,
) -> List[bmesh.types.BMVert]:
    hx, hy, hz = half_extents_pc
    ret = bmesh.ops.create_cube(bm, size=2.0)
    verts: List[bmesh.types.BMVert] = ret["verts"]
    rot = _rot_pc_to_bl_matrix(pitch_deg, yaw_deg, roll_deg)
    c_bl = pc_vec_to_bl(center_pc)
    for v in verts:
        local = Vector((v.co.x * hx, -v.co.y * hz, v.co.z * hy))
        v.co = c_bl + (rot @ local)

    vset = set(verts)
    edges = [e for e in bm.edges if e.verts[0] in vset and e.verts[1] in vset]
    for f in bm.faces:
        if all(v in vset for v in f.verts):
            f.material_index = mat_idx
            f.smooth = True

    if bevel > 1e-5 and edges:
        max_bev = min(hx, hy, hz) * 0.44
        actual_bev = min(bevel, max_bev)
        if actual_bev > 1e-5:
            bev = bmesh.ops.bevel(
                bm, geom=edges, offset=actual_bev, offset_type="OFFSET",
                segments=max(1, bevel_segs), profile=0.5, affect="EDGES",
            )
            for f in bev.get("faces", []):
                f.material_index = mat_idx
                f.smooth = True
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
    sides: int = 24,
    mat_idx: int = 0,
    smooth: bool = True,
) -> List[bmesh.types.BMVert]:
    if radius_end is None:
        radius_end = radius_start
    return add_lathe_z_pc(
        bm, x_pc, y_pc, [(z_start_pc, radius_start), (z_end_pc, radius_end)],
        sides=sides, mat_idx=mat_idx, smooth=smooth,
    )


def add_cylinder_axis_pc(
    bm: bmesh.types.BMesh,
    p0_pc: Tuple[float, float, float],
    p1_pc: Tuple[float, float, float],
    radius_start: float,
    radius_end: Optional[float] = None,
    sides: int = 20,
    mat_idx: int = 0,
) -> List[bmesh.types.BMVert]:
    """Closed manifold cylinder along an arbitrary 3D segment `p0_pc -> p1_pc`."""
    if radius_end is None:
        radius_end = radius_start
    p0 = pc_vec_to_bl(p0_pc)
    p1 = pc_vec_to_bl(p1_pc)
    axis = p1 - p0
    if axis.length < 1e-6:
        return []
    t_dir = axis.normalized()
    ref = Vector((1.0, 0.0, 0.0)) if abs(t_dir.x) < 0.85 else Vector((0.0, 0.0, 1.0))
    u_dir = t_dir.cross(ref).normalized()
    v_dir = t_dir.cross(u_dir).normalized()

    r0_verts: List[bmesh.types.BMVert] = []
    r1_verts: List[bmesh.types.BMVert] = []
    for s in range(sides):
        ang = (2.0 * math.pi * s) / sides
        radial = u_dir * math.cos(ang) + v_dir * math.sin(ang)
        r0_verts.append(bm.verts.new(p0 + radial * radius_start))
        r1_verts.append(bm.verts.new(p1 + radial * radius_end))

    for s in range(sides):
        sn = (s + 1) % sides
        f = bm.faces.new((r0_verts[s], r0_verts[sn], r1_verts[sn], r1_verts[s]))
        f.material_index = mat_idx
        f.smooth = True

    c0 = bm.verts.new(p0)
    c1 = bm.verts.new(p1)
    for s in range(sides):
        sn = (s + 1) % sides
        f0 = bm.faces.new((c0, r0_verts[sn], r0_verts[s]))
        f1 = bm.faces.new((c1, r1_verts[s], r1_verts[sn]))
        f0.material_index = mat_idx
        f1.material_index = mat_idx
        f0.smooth = True
        f1.smooth = True
    return r0_verts + r1_verts + [c0, c1]


def add_lathe_z_pc(
    bm: bmesh.types.BMesh,
    x_pc: float,
    y_pc: float,
    stations_zr: Sequence[Tuple[float, float]],
    sides: int = 28,
    mat_idx: int = 0,
    smooth: bool = True,
    cap_start: bool = True,
    cap_end: bool = True,
) -> List[bmesh.types.BMVert]:
    """Multi-station lathe solid along PlayCanvas Z axis for stepped barrels, bells, caps, and cartridges."""
    rings: List[List[bmesh.types.BMVert]] = []
    all_verts: List[bmesh.types.BMVert] = []
    for z_pc, rad in stations_zr:
        c = pc_to_bl(x_pc, y_pc, z_pc)
        ring: List[bmesh.types.BMVert] = []
        for s in range(sides):
            ang = (2.0 * math.pi * s) / sides
            v = bm.verts.new(Vector((c.x + math.cos(ang) * rad, c.y, c.z + math.sin(ang) * rad)))
            ring.append(v)
        rings.append(ring)
        all_verts.extend(ring)

    # Determine winding along overall progression
    p_first = pc_to_bl(x_pc, y_pc, stations_zr[0][0])
    p_last = pc_to_bl(x_pc, y_pc, stations_zr[-1][0])
    flip = p_last.y < p_first.y

    for i in range(len(rings) - 1):
        r0, r1 = rings[i], rings[i + 1]
        for s in range(sides):
            sn = (s + 1) % sides
            quad = (r0[s], r1[s], r1[sn], r0[sn]) if flip else (r0[s], r0[sn], r1[sn], r1[s])
            f = bm.faces.new(quad)
            f.material_index = mat_idx
            f.smooth = smooth

    if cap_start:
        c0 = bm.verts.new(p_first)
        all_verts.append(c0)
        for s in range(sides):
            sn = (s + 1) % sides
            tri = (c0, rings[0][s], rings[0][sn]) if flip else (c0, rings[0][sn], rings[0][s])
            f0 = bm.faces.new(tri)
            f0.material_index = mat_idx
            f0.smooth = True

    if cap_end:
        c1 = bm.verts.new(p_last)
        all_verts.append(c1)
        for s in range(sides):
            sn = (s + 1) % sides
            tri = (c1, rings[-1][sn], rings[-1][s]) if flip else (c1, rings[-1][s], rings[-1][sn])
            f1 = bm.faces.new(tri)
            f1.material_index = mat_idx
            f1.smooth = True

    return all_verts


def add_hollow_barrel_z_pc(
    bm: bmesh.types.BMesh,
    x_pc: float,
    y_pc: float,
    outer_stations_zr: Sequence[Tuple[float, float]],
    bore_radius: float,
    bore_depth: float = 0.055,
    sides: int = 28,
    outer_mat_idx: int = 0,
    bore_mat_idx: int = 1,
    rifling_lands: int = 6,
) -> List[bmesh.types.BMVert]:
    """
    Watertight high-segment barrel along `-Z` (`outer_stations_zr` ordered from chamber toward muzzle tip `-Z`)
    that rolls over a machined 11-deg target muzzle crown into a recessed dark rifled bore!
    """
    z_muzzle, r_muzzle = outer_stations_zr[-1]
    crown_lip_r = max(bore_radius + 0.0012, r_muzzle - 0.0016)
    z_crown_in = z_muzzle + 0.0022  # recessed slightly inside crown
    z_bore_back = z_muzzle + bore_depth

    rings: List[Tuple[List[bmesh.types.BMVert], int]] = []
    # Outer profile rings
    for idx, (zp, rp) in enumerate(outer_stations_zr):
        c = pc_to_bl(x_pc, y_pc, zp)
        ring = [
            bm.verts.new(Vector((c.x + math.cos(2.0 * math.pi * s / sides) * rp, c.y, c.z + math.sin(2.0 * math.pi * s / sides) * rp)))
            for s in range(sides)
        ]
        rings.append((ring, outer_mat_idx))

    # Crown bevel rim -> Bore mouth (with subtle rifling land modulation) -> Bore back
    c_crown = pc_to_bl(x_pc, y_pc, z_muzzle + 0.0006)
    ring_crown = [
        bm.verts.new(Vector((c_crown.x + math.cos(2.0 * math.pi * s / sides) * crown_lip_r, c_crown.y, c_crown.z + math.sin(2.0 * math.pi * s / sides) * crown_lip_r)))
        for s in range(sides)
    ]
    rings.append((ring_crown, outer_mat_idx))

    for zp, twist in [(z_crown_in, 0.0), (z_muzzle + bore_depth * 0.45, 0.22), (z_bore_back, 0.48)]:
        c = pc_to_bl(x_pc, y_pc, zp)
        b_ring: List[bmesh.types.BMVert] = []
        for s in range(sides):
            ang = (2.0 * math.pi * s) / sides
            land = 0.94 if int(((ang + twist) * rifling_lands / math.pi)) % 2 == 0 else 1.02
            rr = bore_radius * land
            b_ring.append(bm.verts.new(Vector((c.x + math.cos(ang) * rr, c.y, c.z + math.sin(ang) * rr))))
        rings.append((b_ring, bore_mat_idx))

    # Chamber rear cap (`outer_stations_zr[0]`) and deep bore back cap
    p_rear = pc_to_bl(x_pc, y_pc, outer_stations_zr[0][0])
    p_bore_end = pc_to_bl(x_pc, y_pc, z_bore_back)

    for i in range(len(rings) - 1):
        r0, _m0 = rings[i]
        r1, m1 = rings[i + 1]
        use_mat = bore_mat_idx if (i >= len(outer_stations_zr)) else outer_mat_idx
        for s in range(sides):
            sn = (s + 1) % sides
            # Since outer goes toward -Z (Blender +Y), normal points outward with (r0[s], r0[sn], r1[sn], r1[s]);
            # When folding back into bore (+Z / Blender -Y), same topological strip continuity keeps normals outward!
            f = bm.faces.new((r0[s], r0[sn], r1[sn], r1[s]))
            f.material_index = use_mat
            f.smooth = True

    c0 = bm.verts.new(p_rear)
    c1 = bm.verts.new(p_bore_end)
    first_ring = rings[0][0]
    last_ring = rings[-1][0]
    for s in range(sides):
        sn = (s + 1) % sides
        f0 = bm.faces.new((c0, first_ring[sn], first_ring[s]))
        f0.material_index = outer_mat_idx
        f0.smooth = True
        f1 = bm.faces.new((c1, last_ring[s], last_ring[sn]))
        f1.material_index = bore_mat_idx
        f1.smooth = True

    return [v for r, _ in rings for v in r] + [c0, c1]


def add_slotted_flash_hider_z_pc(
    bm: bmesh.types.BMesh,
    x_pc: float,
    y_pc: float,
    z_base: float,
    z_tip: float,
    outer_r: float,
    bore_r: float,
    num_prongs: int = 5,
    outer_mat_idx: int = 0,
    bore_mat_idx: int = 1,
) -> None:
    """
    AAA Birdcage / Slotted Flash Suppressor (`z_base -> z_tip`, where `z_tip < z_base`):
      - Rear wrench-flat collar + recessed expansion groove
      - Dark inner recessed core (`bore_mat_idx`) visible through open longitudinal compensator slots
      - Raised steel longitudinal prongs bridging to front muzzle ring with recessed hollow bore!
    """
    length = abs(z_base - z_tip)
    z_collar_end = z_base - length * 0.26
    z_slot_end = z_tip + length * 0.16

    # 1. Rear collar + recessed dark slot core + front crown ring with hollow bore
    add_hollow_barrel_z_pc(
        bm, x_pc, y_pc,
        [
            (z_base, outer_r * 0.90),
            (z_base - 0.003, outer_r),
            (z_collar_end, outer_r),
            (z_collar_end - 0.002, bore_r + 0.0018),
            (z_slot_end + 0.002, bore_r + 0.0018),
            (z_slot_end, outer_r * 0.98),
            (z_tip, outer_r * 0.95),
        ],
        bore_radius=bore_r,
        bore_depth=length * 0.88,
        sides=24,
        outer_mat_idx=outer_mat_idx,
        bore_mat_idx=bore_mat_idx,
    )

    # 2. Individual raised birdcage prongs around upper/side arc (A2 closed bottom + 5 upper slots!)
    prong_thick = outer_r * 0.30
    prong_z_mid = 0.5 * (z_collar_end + z_slot_end)
    prong_hz = 0.5 * abs(z_slot_end - z_collar_end) + 0.002
    for p_i in range(num_prongs):
        # Distribute prongs around full 360 deg
        ang_deg = (360.0 * p_i) / num_prongs + 18.0
        ang_rad = math.radians(ang_deg)
        r_mid = 0.5 * (outer_r + bore_r + 0.0015)
        px = x_pc + math.cos(ang_rad) * r_mid
        py = y_pc + math.sin(ang_rad) * r_mid
        add_box_pc(
            bm, (px, py, prong_z_mid),
            (0.5 * (outer_r - bore_r), prong_thick * 0.5, prong_hz),
            bevel=0.0007, bevel_segs=1, mat_idx=outer_mat_idx,
            roll_deg=ang_deg,
        )


def _rounded_trapezoid_pts_2d(
    hx_pos: float,
    hx_neg: float,
    hy: float,
    cf: float,
    corner_segs: int = 1,
    neg_first: bool = False,
) -> List[Tuple[float, float]]:
    """
    CCW 2D cross-section loop with `corner_segs`-segment elliptical corner fillets.
    - `corner_segs = 1`: crisp 8-point machined hard-surface prism
    - `corner_segs = 3`: smooth 16-point rounded ergonomic stock / contoured pistol grip profile
      (adjacent face angle < 30 deg so smooth-by-angle never creases rounded furniture!)
    When `neg_first=False` (XY loft): `hx_pos` is at `+hy` (top), `hx_neg` is at `-hy` (bottom).
    When `neg_first=True` (YZ swept loft): `hx_pos` is at `-hy` (frontstrap `-N`), `hx_neg` is at `+hy` (backstrap `+N`).
    """
    cf = max(0.08, min(0.48, cf))
    cs = max(1, corner_segs)
    ry = hy * min(0.88, cf * 1.35)

    if not neg_first:
        rx_t = hx_pos * cf
        rx_b = hx_neg * cf
        pts: List[Tuple[float, float]] = []
        # Top-right corner: angle 0 -> pi/2
        for k in range(cs + 1):
            a = (0.5 * math.pi * k) / cs
            pts.append(((hx_pos - rx_t) + math.cos(a) * rx_t, (hy - ry) + math.sin(a) * ry))
        # Top-left corner: angle pi/2 -> pi
        for k in range(cs + 1):
            a = 0.5 * math.pi + (0.5 * math.pi * k) / cs
            pts.append(((-hx_pos + rx_t) + math.cos(a) * rx_t, (hy - ry) + math.sin(a) * ry))
        # Bottom-left corner: angle pi -> 3*pi/2
        for k in range(cs + 1):
            a = math.pi + (0.5 * math.pi * k) / cs
            pts.append(((-hx_neg + rx_b) + math.cos(a) * rx_b, (-hy + ry) + math.sin(a) * ry))
        # Bottom-right corner: angle 3*pi/2 -> 2*pi
        for k in range(cs + 1):
            a = 1.5 * math.pi + (0.5 * math.pi * k) / cs
            pts.append(((hx_neg - rx_b) + math.cos(a) * rx_b, (-hy + ry) + math.sin(a) * ry))
        return pts
    else:
        # Front (-hy) uses hx_pos (`hx_f`), Rear (+hy) uses hx_neg (`hx_r`), same CCW winding as original!
        rx_f = hx_pos * cf
        rx_r = hx_neg * cf
        pts = []
        # Front-right -> Front-left along -hy, then Rear-left -> Rear-right along +hy (clockwise in (x,n) = outward w/ flip)
        # Keep exact same winding direction as original 8-pt pts_2d:
        # 1) Front-left corner (-hx_f+rx_f, -hy) -> (-hx_f, -hy+ry)
        for k in range(cs + 1):
            a = 1.5 * math.pi - (0.5 * math.pi * k) / cs  # 3pi/2 -> pi
            pts.append(((-hx_pos + rx_f) + math.cos(a) * rx_f, (-hy + ry) + math.sin(a) * ry))
        # 2) Rear-left corner (-hx_r, +hy-ry) -> (-hx_r+rx_r, +hy)
        for k in range(cs + 1):
            a = math.pi - (0.5 * math.pi * k) / cs  # pi -> pi/2
            pts.append(((-hx_neg + rx_r) + math.cos(a) * rx_r, (hy - ry) + math.sin(a) * ry))
        # 3) Rear-right corner (+hx_r-rx_r, +hy) -> (+hx_r, +hy-ry)
        for k in range(cs + 1):
            a = 0.5 * math.pi - (0.5 * math.pi * k) / cs  # pi/2 -> 0
            pts.append(((hx_neg - rx_r) + math.cos(a) * rx_r, (hy - ry) + math.sin(a) * ry))
        # 4) Front-right corner (+hx_f, -hy+ry) -> (+hx_f-rx_f, -hy)
        for k in range(cs + 1):
            a = 2.0 * math.pi - (0.5 * math.pi * k) / cs  # 2pi -> 3pi/2
            pts.append(((hx_pos - rx_f) + math.cos(a) * rx_f, (-hy + ry) + math.sin(a) * ry))
        return pts


def add_profile_loft_pc(
    bm: bmesh.types.BMesh,
    stations: Sequence[Tuple[float, float, float, float, float, float, float, float]],
    mat_idx: int = 0,
    corner_segs: int = 1,
    cap_bevel_start: float = 0.0,
    cap_bevel_end: float = 0.0,
) -> List[bmesh.types.BMVert]:
    """
    Lofts a filleted-trapezoid cross-section across arbitrary 3D stations:
      station = `(cx, cy, cz, hx_top, hx_bot, hy, chamfer_frac, pitch_deg)`
    Set `corner_segs=3` and `cap_bevel_* > 0` for pillowy-smooth rounded stocks & cheek risers!
    """
    st_list = list(stations)
    if cap_bevel_start > 1e-5 and len(st_list) >= 2:
        s0, s1 = st_list[0], st_list[1]
        dx, dy, dz = s1[0] - s0[0], s1[1] - s0[1], s1[2] - s0[2]
        seg_len = max(1e-5, math.sqrt(dx * dx + dy * dy + dz * dz))
        b = min(cap_bevel_start, seg_len * 0.35)
        ux, uy, uz = dx / seg_len, dy / seg_len, dz / seg_len
        st_list = [
            (s0[0], s0[1], s0[2], s0[3] * 0.80, s0[4] * 0.80, s0[5] * 0.82, min(0.46, s0[6] + 0.08), s0[7]),
            (s0[0] + ux * b * 0.45, s0[1] + uy * b * 0.45, s0[2] + uz * b * 0.45, s0[3] * 0.93, s0[4] * 0.93, s0[5] * 0.94, s0[6], s0[7]),
            (s0[0] + ux * b, s0[1] + uy * b, s0[2] + uz * b, s0[3], s0[4], s0[5], s0[6], s0[7]),
        ] + st_list[1:]
    if cap_bevel_end > 1e-5 and len(st_list) >= 2:
        s_prev, s_end = st_list[-2], st_list[-1]
        dx, dy, dz = s_end[0] - s_prev[0], s_end[1] - s_prev[1], s_end[2] - s_prev[2]
        seg_len = max(1e-5, math.sqrt(dx * dx + dy * dy + dz * dz))
        b = min(cap_bevel_end, seg_len * 0.35)
        ux, uy, uz = dx / seg_len, dy / seg_len, dz / seg_len
        st_list = st_list[:-1] + [
            (s_end[0] - ux * b, s_end[1] - uy * b, s_end[2] - uz * b, s_end[3], s_end[4], s_end[5], s_end[6], s_end[7]),
            (s_end[0] - ux * b * 0.45, s_end[1] - uy * b * 0.45, s_end[2] - uz * b * 0.45, s_end[3] * 0.93, s_end[4] * 0.93, s_end[5] * 0.94, s_end[6], s_end[7]),
            (s_end[0], s_end[1], s_end[2], s_end[3] * 0.80, s_end[4] * 0.80, s_end[5] * 0.82, min(0.46, s_end[6] + 0.08), s_end[7]),
        ]

    rings: List[List[bmesh.types.BMVert]] = []
    centers: List[Vector] = []

    for cx, cy, cz, hx_t, hx_b, hy, cf, pitch_deg in st_list:
        pts_2d = _rounded_trapezoid_pts_2d(hx_t, hx_b, hy, cf, corner_segs=corner_segs, neg_first=False)
        rot = _rot_pc_to_bl_matrix(pitch_deg=pitch_deg)
        c_bl = pc_to_bl(cx, cy, cz)
        centers.append(c_bl)
        ring: List[bmesh.types.BMVert] = []
        for lx, ly in pts_2d:
            v_bl = c_bl + (rot @ Vector((lx, 0.0, ly)))
            ring.append(bm.verts.new(v_bl))
        rings.append(ring)

    n_pts = len(rings[0])
    d_prog = centers[-1] - centers[0]
    mid_idx = max(1, n_pts // 4)
    e01 = rings[0][mid_idx].co - rings[0][0].co
    out_guess = e01.cross(d_prog)
    radial_0 = ((rings[0][0].co + rings[0][mid_idx].co) * 0.5) - centers[0]
    flip = out_guess.dot(radial_0) < 0.0

    for i in range(len(rings) - 1):
        r0, r1 = rings[i], rings[i + 1]
        for s in range(n_pts):
            sn = (s + 1) % n_pts
            quad = (r0[s], r1[s], r1[sn], r0[sn]) if flip else (r0[s], r0[sn], r1[sn], r1[s])
            f = bm.faces.new(quad)
            f.material_index = mat_idx
            f.smooth = True

    c_start = bm.verts.new(centers[0])
    c_end = bm.verts.new(centers[-1])
    for s in range(n_pts):
        sn = (s + 1) % n_pts
        t0 = (c_start, rings[0][s], rings[0][sn]) if flip else (c_start, rings[0][sn], rings[0][s])
        t1 = (c_end, rings[-1][sn], rings[-1][s]) if flip else (c_end, rings[-1][s], rings[-1][sn])
        f0 = bm.faces.new(t0)
        f1 = bm.faces.new(t1)
        f0.material_index = mat_idx
        f1.material_index = mat_idx
        f0.smooth = True
        f1.smooth = True

    return [v for r in rings for v in r] + [c_start, c_end]


def add_swept_loft_yz_pc(
    bm: bmesh.types.BMesh,
    stations: Sequence[Tuple[float, float, float, float, float, float, float]],
    mat_idx: int = 0,
    corner_segs: int = 1,
    cap_bevel_start: float = 0.0,
    cap_bevel_end: float = 0.0,
) -> List[bmesh.types.BMVert]:
    """
    Sweeps a filleted cross-section along any curved or angled spine in the PlayCanvas YZ plane
    (pistol grips, curved STANAG magazines, flared magwells, open U-bow trigger guards, curved triggers, grenade spoons):
      station = `(cx, cy, cz, hx_neg_n, hx_pos_n, h_depth, chamfer_frac)`
    Set `corner_segs=3` for contoured ergonomic grips & curved STANAG magazines!
    """
    st_list = list(stations)
    if cap_bevel_start > 1e-5 and len(st_list) >= 2:
        s0, s1 = st_list[0], st_list[1]
        dx, dy, dz = s1[0] - s0[0], s1[1] - s0[1], s1[2] - s0[2]
        seg_len = max(1e-5, math.sqrt(dx * dx + dy * dy + dz * dz))
        b = min(cap_bevel_start, seg_len * 0.35)
        ux, uy, uz = dx / seg_len, dy / seg_len, dz / seg_len
        st_list = [
            (s0[0], s0[1], s0[2], s0[3] * 0.80, s0[4] * 0.80, s0[5] * 0.82, min(0.46, s0[6] + 0.08)),
            (s0[0] + ux * b * 0.45, s0[1] + uy * b * 0.45, s0[2] + uz * b * 0.45, s0[3] * 0.93, s0[4] * 0.93, s0[5] * 0.94, s0[6]),
            (s0[0] + ux * b, s0[1] + uy * b, s0[2] + uz * b, s0[3], s0[4], s0[5], s0[6]),
        ] + st_list[1:]
    if cap_bevel_end > 1e-5 and len(st_list) >= 2:
        s_prev, s_end = st_list[-2], st_list[-1]
        dx, dy, dz = s_end[0] - s_prev[0], s_end[1] - s_prev[1], s_end[2] - s_prev[2]
        seg_len = max(1e-5, math.sqrt(dx * dx + dy * dy + dz * dz))
        b = min(cap_bevel_end, seg_len * 0.35)
        ux, uy, uz = dx / seg_len, dy / seg_len, dz / seg_len
        st_list = st_list[:-1] + [
            (s_end[0] - ux * b, s_end[1] - uy * b, s_end[2] - uz * b, s_end[3], s_end[4], s_end[5], s_end[6]),
            (s_end[0] - ux * b * 0.45, s_end[1] - uy * b * 0.45, s_end[2] - uz * b * 0.45, s_end[3] * 0.93, s_end[4] * 0.93, s_end[5] * 0.94, s_end[6]),
            (s_end[0], s_end[1], s_end[2], s_end[3] * 0.80, s_end[4] * 0.80, s_end[5] * 0.82, min(0.46, s_end[6] + 0.08)),
        ]

    centers = [pc_to_bl(s[0], s[1], s[2]) for s in st_list]
    n_st = len(st_list)
    x_axis = Vector((1.0, 0.0, 0.0))
    rings: List[List[bmesh.types.BMVert]] = []

    for i, (_, _, _, hx_f, hx_r, hd, cf) in enumerate(st_list):
        if i == 0:
            tang = centers[1] - centers[0]
        elif i == n_st - 1:
            tang = centers[-1] - centers[-2]
        else:
            t0 = (centers[i] - centers[i - 1]).normalized()
            t1 = (centers[i + 1] - centers[i]).normalized()
            tang = t0 + t1
        tang_yz = Vector((0.0, tang.y, tang.z))
        if tang_yz.length < 1e-7:
            tang_yz = Vector((0.0, 0.0, -1.0))
        else:
            tang_yz.normalize()
        n_dir = tang_yz.cross(x_axis).normalized()

        pts_2d = _rounded_trapezoid_pts_2d(hx_f, hx_r, hd, cf, corner_segs=corner_segs, neg_first=True)
        c_bl = centers[i]
        ring: List[bmesh.types.BMVert] = []
        for lx, ln in pts_2d:
            v_bl = c_bl + x_axis * lx + n_dir * ln
            ring.append(bm.verts.new(v_bl))
        rings.append(ring)

    n_pts = len(rings[0])
    d_prog = centers[1] - centers[0]
    mid_idx = max(1, n_pts // 4)
    e01 = rings[0][mid_idx].co - rings[0][0].co
    out_guess = e01.cross(d_prog)
    radial_0 = ((rings[0][0].co + rings[0][mid_idx].co) * 0.5) - centers[0]
    flip = out_guess.dot(radial_0) < 0.0

    for i in range(len(rings) - 1):
        r0, r1 = rings[i], rings[i + 1]
        for s in range(n_pts):
            sn = (s + 1) % n_pts
            quad = (r0[s], r1[s], r1[sn], r0[sn]) if flip else (r0[s], r0[sn], r1[sn], r1[s])
            f = bm.faces.new(quad)
            f.material_index = mat_idx
            f.smooth = True

    c_start = bm.verts.new(centers[0])
    c_end = bm.verts.new(centers[-1])
    for s in range(n_pts):
        sn = (s + 1) % n_pts
        t0 = (c_start, rings[0][s], rings[0][sn]) if flip else (c_start, rings[0][sn], rings[0][s])
        t1 = (c_end, rings[-1][sn], rings[-1][s]) if flip else (c_end, rings[-1][s], rings[-1][sn])
        f0 = bm.faces.new(t0)
        f1 = bm.faces.new(t1)
        f0.material_index = mat_idx
        f1.material_index = mat_idx
        f0.smooth = True
        f1.smooth = True

    return [v for r in rings for v in r] + [c_start, c_end]


def add_open_trigger_guard_pc(
    bm: bmesh.types.BMesh,
    x_pc: float,
    y_top: float,
    z_front: float,
    z_rear: float,
    bow_drop: float,
    half_width_x: float = 0.0055,
    band_thick: float = 0.0032,
    guard_mat_idx: int = 0,
    trigger_mat_idx: int = 1,
    trigger_z: Optional[float] = None,
) -> None:
    """
    Genuine open contoured trigger guard loop (100% open window in profile & 3/4 views!)
    plus a sculpted crescent-curved trigger shoe & cross-pin inside the guard bow.
    """
    z_mid = 0.5 * (z_front + z_rear)
    z_span = z_rear - z_front  # positive (z_rear > z_front since -Z is forward)
    ht = band_thick * 0.55
    bow_pts = [
        (y_top + 0.003, z_front),
        (y_top - bow_drop * 0.45, z_front + z_span * 0.06),
        (y_top - bow_drop * 0.88, z_front + z_span * 0.22),
        (y_top - bow_drop, z_mid),
        (y_top - bow_drop * 0.88, z_front + z_span * 0.78),
        (y_top - bow_drop * 0.45, z_front + z_span * 0.94),
        (y_top + 0.003, z_rear),
    ]
    guard_stations = [
        (x_pc, py, pz, half_width_x, half_width_x, ht, 0.28)
        for (py, pz) in bow_pts
    ]
    add_swept_loft_yz_pc(bm, guard_stations, mat_idx=guard_mat_idx)

    # Sculpted crescent-curved trigger shoe hanging inside the open guard window
    tz = trigger_z if trigger_z is not None else (z_front + z_span * 0.55)
    trig_hw = half_width_x * 0.58
    trig_stations = [
        (x_pc, y_top + 0.003, tz + 0.002, trig_hw, trig_hw, 0.0034, 0.30),
        (x_pc, y_top - bow_drop * 0.25, tz - 0.002, trig_hw, trig_hw * 0.92, 0.0030, 0.32),
        (x_pc, y_top - bow_drop * 0.52, tz - 0.002, trig_hw * 0.90, trig_hw * 0.85, 0.0025, 0.35),
        (x_pc, y_top - bow_drop * 0.74, tz + 0.004, trig_hw * 0.80, trig_hw * 0.75, 0.0018, 0.38),
    ]
    add_swept_loft_yz_pc(bm, trig_stations, mat_idx=trigger_mat_idx)

    # Trigger pivot pin across receiver ears
    add_cylinder_axis_pc(
        bm,
        (x_pc - half_width_x * 2.4, y_top + 0.005, tz + 0.002),
        (x_pc + half_width_x * 2.4, y_top + 0.005, tz + 0.002),
        radius_start=0.0018, sides=12, mat_idx=trigger_mat_idx,
    )


def _add_prism_tooth_pc(
    bm: bmesh.types.BMesh,
    cx: float,
    cy: float,
    cz: float,
    direction: str,
    half_w: float,
    height: float,
    half_z: float,
    mat_idx: int,
) -> None:
    """Clean 8-vertex MIL-STD-1913 chamfered trapezoidal recoil lug (zero bevel corner bloat)."""
    top_w = half_w * 0.72
    if direction in ("+Y", "-Y"):
        sgn = 1.0 if direction == "+Y" else -1.0
        y0, y1 = cy, cy + sgn * height
        pts = [
            (cx - half_w, y0, cz + half_z), (cx + half_w, y0, cz + half_z),
            (cx + top_w, y1, cz + half_z * 0.88), (cx - top_w, y1, cz + half_z * 0.88),
            (cx - half_w, y0, cz - half_z), (cx + half_w, y0, cz - half_z),
            (cx + top_w, y1, cz - half_z * 0.88), (cx - top_w, y1, cz - half_z * 0.88),
        ]
    else:
        sgn = 1.0 if direction == "+X" else -1.0
        x0, x1 = cx, cx + sgn * height
        pts = [
            (x0, cy - half_w, cz + half_z), (x0, cy + half_w, cz + half_z),
            (x1, cy + top_w, cz + half_z * 0.88), (x1, cy - top_w, cz + half_z * 0.88),
            (x0, cy - half_w, cz - half_z), (x0, cy + half_w, cz - half_z),
            (x1, cy + top_w, cz - half_z * 0.88), (x1, cy - top_w, cz - half_z * 0.88),
        ]
    vs = [bm.verts.new(pc_to_bl(*p)) for p in pts]
    quads = [
        (0, 1, 2, 3), (7, 6, 5, 4),
        (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0),
    ]
    for q in quads:
        f = bm.faces.new((vs[q[0]], vs[q[1]], vs[q[2]], vs[q[3]]))
        f.material_index = mat_idx
        f.smooth = True


def add_custom_poly_z_pc(
    bm: bmesh.types.BMesh,
    pts_xy_ccw: Sequence[Tuple[float, float]],
    z_stations: Sequence[Tuple[float, float, float]],
    mat_idx: int = 0,
) -> List[bmesh.types.BMVert]:
    """
    Lofts an arbitrary CCW 2D polygon `pts_xy_ccw` (in PlayCanvas XY coordinates) across
    `z_stations = [(z_pc, scale_x, scale_y), ...]` for crisp polygonal/triangular barrels & slides!
    """
    cx = sum(p[0] for p in pts_xy_ccw) / len(pts_xy_ccw)
    cy = sum(p[1] for p in pts_xy_ccw) / len(pts_xy_ccw)
    rings: List[List[bmesh.types.BMVert]] = []
    centers: List[Vector] = []
    for z_pc, sx, sy in z_stations:
        c_bl = pc_to_bl(cx, cy, z_pc)
        centers.append(c_bl)
        ring: List[bmesh.types.BMVert] = []
        for px, py in pts_xy_ccw:
            lx = cx + (px - cx) * sx
            ly = cy + (py - cy) * sy
            ring.append(bm.verts.new(pc_to_bl(lx, ly, z_pc)))
        rings.append(ring)

    n_pts = len(pts_xy_ccw)
    d_prog = centers[-1] - centers[0]
    e01 = rings[0][1].co - rings[0][0].co
    out_guess = e01.cross(d_prog)
    radial_0 = ((rings[0][0].co + rings[0][1].co) * 0.5) - centers[0]
    flip = out_guess.dot(radial_0) < 0.0

    for i in range(len(rings) - 1):
        r0, r1 = rings[i], rings[i + 1]
        for s in range(n_pts):
            sn = (s + 1) % n_pts
            quad = (r0[s], r1[s], r1[sn], r0[sn]) if flip else (r0[s], r0[sn], r1[sn], r1[s])
            f = bm.faces.new(quad)
            f.material_index = mat_idx
            f.smooth = True

    c_start = bm.verts.new(centers[0])
    c_end = bm.verts.new(centers[-1])
    for s in range(n_pts):
        sn = (s + 1) % n_pts
        t0 = (c_start, rings[0][s], rings[0][sn]) if flip else (c_start, rings[0][sn], rings[0][s])
        t1 = (c_end, rings[-1][sn], rings[-1][s]) if flip else (c_end, rings[-1][s], rings[-1][sn])
        f0 = bm.faces.new(t0)
        f1 = bm.faces.new(t1)
        f0.material_index = mat_idx
        f1.material_index = mat_idx
        f0.smooth = True
        f1.smooth = True

    return [v for r in rings for v in r] + [c_start, c_end]


def add_contoured_grip_pc(
    bm: bmesh.types.BMesh,
    y_top: float,
    z_top: float,
    length_y: float,
    rake_deg: float,
    half_w: float,
    half_depth: float,
    mat_idx: int,
    groove_amp: float = 0.0028,
    palm_swell: float = 0.0052,
    heel_flare: float = 1.10,
) -> List[bmesh.types.BMVert]:
    """
    Sculpted ergonomic tactical pistol grip (16-point oval cross-section, `corner_segs=3`) with:
      - `rake_deg` (~18-21 deg) natural combat grip angle
      - Swept upper beavertail tang transition
      - 3 sculpted finger-groove scallops & ridges along the frontstrap
      - Rounded mid-palm backstrap & lateral swell
      - Flared, multi-step rounded bevel heel cap (`cap_bevel_end=0.0042`)
    """
    rake_rad = math.radians(rake_deg)
    tan_r = math.tan(rake_rad)
    stations: List[Tuple[float, float, float, float, float, float, float]] = []
    n_steps = 11
    for i in range(n_steps):
        t = i / (n_steps - 1)
        py = y_top - length_y * t
        z_spine = z_top + (length_y * tan_r) * t

        # Backstrap contour: swept beavertail at top (t=0) + mid-palm arch swell (t=0.45) + heel flare (t=1)
        back_ext = (
            half_depth
            + palm_swell * math.sin(math.pi * min(1.0, t * 1.08)) ** 1.15
            + (0.0045 * ((1.0 - t / 0.22) ** 2) if t < 0.22 else 0.0)
            + (0.0032 * (((t - 0.84) / 0.16) ** 1.5) if t > 0.84 else 0.0)
        )

        # Frontstrap contour: trigger-guard undercut at top + 3 finger grooves & ridges + heel lip!
        if t < 0.16:
            front_ext = half_depth * (0.86 + 0.14 * (t / 0.16))
        elif t <= 0.86:
            u = (t - 0.16) / 0.70  # 0..1 across 3 finger grooves (cos(6*pi*u): ridges at 0, 1/3, 2/3, 1; valleys between!)
            front_ext = half_depth + groove_amp * math.cos(6.0 * math.pi * u)
        else:
            u_h = (t - 0.86) / 0.14
            front_ext = half_depth + groove_amp + 0.0030 * u_h

        # Lateral palm-swell width (`hx`)
        swell_w = 1.0 + 0.10 * math.sin(math.pi * t)
        if t > 0.86:
            swell_w = max(swell_w, 1.0 + (heel_flare - 1.0) * ((t - 0.86) / 0.14))
        hx_f = half_w * 0.92 * swell_w
        hx_r = half_w * 1.04 * swell_w

        hd = 0.5 * (front_ext + back_ext)
        cz = z_spine + 0.5 * (back_ext - front_ext)
        stations.append((0.0, py, cz, hx_f, hx_r, hd, 0.45))

    return add_swept_loft_yz_pc(
        bm, stations, mat_idx=mat_idx, corner_segs=3, cap_bevel_start=0.0025, cap_bevel_end=0.0042
    )


def add_picatinny_rail_pc(
    bm: bmesh.types.BMesh,
    cx: float,
    cy: float,
    z_start: float,
    z_end: float,
    direction: str = "+Y",
    mat_idx: int = 0,
    tooth_pitch: float = 0.010,
    rail_half_w: float = 0.0106,
    base_h: float = 0.0022,
    tooth_h: float = 0.0026,
) -> None:
    """
    True MIL-STD-1913 Toothed Picatinny Rail along Z (`z_start -> z_end`):
      - Chamfered dovetail base spine
      - Individual spaced Picatinny recoil lugs/teeth with 45-deg side bevels!
    """
    z_hi = max(z_start, z_end)
    z_lo = min(z_start, z_end)
    span = z_hi - z_lo
    z_mid = 0.5 * (z_hi + z_lo)

    tooth_hz = tooth_pitch * 0.28

    num_teeth = max(2, int(span / tooth_pitch))
    step = span / num_teeth

    if direction in ("+Y", "-Y"):
        sgn = 1.0 if direction == "+Y" else -1.0
        add_box_pc(
            bm, (cx, cy + sgn * base_h * 0.5, z_mid),
            (rail_half_w * 0.82, base_h * 0.5, span * 0.5),
            bevel=0.0004, bevel_segs=1, mat_idx=mat_idx,
        )
        for i in range(num_teeth):
            tz = z_hi - (i + 0.5) * step
            _add_prism_tooth_pc(bm, cx, cy + sgn * base_h, tz, direction, rail_half_w, tooth_h, tooth_hz, mat_idx)
    else:
        sgn = 1.0 if direction == "+X" else -1.0
        add_box_pc(
            bm, (cx + sgn * base_h * 0.5, cy, z_mid),
            (base_h * 0.5, rail_half_w * 0.82, span * 0.5),
            bevel=0.0004, bevel_segs=1, mat_idx=mat_idx,
        )
        for i in range(num_teeth):
            tz = z_hi - (i + 0.5) * step
            _add_prism_tooth_pc(bm, cx + sgn * base_h, cy, tz, direction, rail_half_w, tooth_h, tooth_hz, mat_idx)


def add_torus_pc(
    bm: bmesh.types.BMesh,
    center_pc: Tuple[float, float, float],
    axis: str,
    major_r: float,
    minor_r: float,
    major_segs: int = 20,
    minor_segs: int = 10,
    mat_idx: int = 0,
    tilt_deg: float = 0.0,
) -> List[bmesh.types.BMVert]:
    """Smooth closed manifold torus ring (`axis` in `'X'`, `'Y'`, `'Z'` in PlayCanvas coordinates)."""
    c_bl = pc_vec_to_bl(center_pc)
    if axis == "X":
        # Ring lies in PlayCanvas YZ plane (normal = +X)
        base_rot = Euler((0.0, math.radians(90.0), 0.0), "XYZ").to_matrix()
    elif axis == "Z":
        # Ring lies in PlayCanvas XY plane (normal = -Z / Blender +Y): ghost-ring aperture!
        base_rot = Euler((math.radians(90.0), 0.0, 0.0), "XYZ").to_matrix()
    else:
        base_rot = Matrix.Identity(3)

    tilt_rot = Euler((0.0, math.radians(tilt_deg), 0.0), "XYZ").to_matrix()
    xform = tilt_rot @ base_rot

    rings: List[List[bmesh.types.BMVert]] = []
    for i in range(major_segs):
        theta = (2.0 * math.pi * i) / major_segs
        ct, st = math.cos(theta), math.sin(theta)
        ring: List[bmesh.types.BMVert] = []
        for j in range(minor_segs):
            phi = (2.0 * math.pi * j) / minor_segs
            r_xy = major_r + minor_r * math.cos(phi)
            local_pt = Vector((r_xy * ct, r_xy * st, minor_r * math.sin(phi)))
            ring.append(bm.verts.new(c_bl + (xform @ local_pt)))
        rings.append(ring)

    for i in range(major_segs):
        inext = (i + 1) % major_segs
        for j in range(minor_segs):
            jnext = (j + 1) % minor_segs
            f = bm.faces.new((rings[i][j], rings[inext][j], rings[inext][jnext], rings[i][jnext]))
            f.material_index = mat_idx
            f.smooth = True

    return [v for r in rings for v in r]


def add_uv_sphere_pc(
    bm: bmesh.types.BMesh,
    center_pc: Tuple[float, float, float],
    radii_pc: Tuple[float, float, float],
    segments: int = 28,
    rings: int = 20,
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


# ---------------------------------------------------------------------------
# Armature, Finalization, NLA Animation & GLB Export Helpers
# ---------------------------------------------------------------------------

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
    angle_deg: float = 38.0,
    uv_mode: str = "weapon",
    uv_scale: float = 5.5,
) -> bpy.types.Object:
    for f in bm.faces:
        f.smooth = True
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    assign_weapon_uvs(bm, scale=uv_scale, uv_mode=uv_mode)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])

    mesh = bpy.data.meshes.new(name=name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.shade_smooth()
    mesh.set_sharp_from_angle(angle=math.radians(angle_deg))

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
    pb = arm_obj.pose.bones[bone_name]
    # Convert the requested model-space delta into the bone's rest axes.
    # Writing the local pose lets animated children inherit the parent's recoil.
    rest_rotation = pb.bone.matrix_local.to_3x3()
    model_to_blender = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))
    model_to_bone = rest_rotation.transposed() @ model_to_blender
    delta_rotation = Euler(tuple(math.radians(a) for a in euler_deg_pc), "XYZ").to_matrix()
    pb.location = model_to_bone @ Vector(offset_pc)
    pb.rotation_quaternion = (model_to_bone @ delta_rotation @ model_to_bone.transposed()).to_quaternion()


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
        pb.keyframe_insert(data_path="scale", frame=frame)


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
        export_tangents=True,
        export_materials="EXPORT",
        export_skins=True,
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_rest_position_armature=True,
        export_lights=False,
    )
    return poly_count


# ---------------------------------------------------------------------------
# 1. Mossberg 590A1 Tactical 12-Gauge (`m590_shotgun.glb`)
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

    # Material palette indices on main body:
    # 0=parkerized_steel, 1=anodized_black, 2=polymer_grip, 3=rubber_pad, 4=tritium_sight, 5=dark_bore
    bm = bmesh.new()

    # Milled 7075-T6 aluminum receiver with chamfered upper roof & recessed right-side ejection port!
    # Left receiver wall + bottom shell-lifter floor + rear breech block + front barrel-extension collar
    add_profile_loft_pc(
        bm,
        [
            (0.0, 0.008, 0.048, 0.0155, 0.0195, 0.029, 0.25, -10.0),
            (0.0, 0.010, 0.028, 0.0175, 0.0210, 0.033, 0.24, 0.0),
            (0.0, 0.010, -0.035, 0.0175, 0.0210, 0.033, 0.24, 0.0),
        ],
        mat_idx=1,
    )
    # Left wall & top bridge spanning past the open right-side ejection port (`z = -0.035..-0.125`)
    add_box_pc(bm, (-0.0145, 0.010, -0.082), (0.0065, 0.032, 0.052), bevel=0.002, mat_idx=1)
    add_box_pc(bm, (0.0, 0.036, -0.082), (0.0185, 0.007, 0.052), bevel=0.002, mat_idx=1)
    for sx in (-1.0, 1.0):
        add_box_pc(bm, (sx * 0.016, -0.016, -0.082), (0.004, 0.008, 0.052), bevel=0.001, mat_idx=1)
    # Dark interior receiver chamber recess behind bolt carrier
    add_box_pc(bm, (0.003, 0.013, -0.082), (0.011, 0.017, 0.044), bevel=0.001, mat_idx=5)
    # Front receiver face & barrel boss (`z = -0.125..-0.185`)
    add_profile_loft_pc(
        bm,
        [
            (0.0, 0.010, -0.125, 0.0175, 0.0210, 0.033, 0.24, 0.0),
            (0.0, 0.009, -0.182, 0.0165, 0.0195, 0.031, 0.26, 0.0),
        ],
        mat_idx=1,
    )
    # Ambidextrous top-tang safety slider (signature Mossberg 590 detail!) + receiver trigger pins
    add_box_pc(bm, (0.0, 0.039, 0.034), (0.0075, 0.0045, 0.013), bevel=0.001, mat_idx=0, pitch_deg=-12.0)
    for pin_z in (-0.005, 0.018):
        add_cylinder_axis_pc(bm, (-0.0218, -0.006, pin_z), (0.0218, -0.006, pin_z), 0.0022, sides=12, mat_idx=0)

    # Top MIL-STD-1913 toothed Picatinny rail + Winged Ghost-Ring Rear Aperture Sight!
    add_box_pc(bm, (0.0, 0.040, -0.0725), (0.0105, 0.0035, 0.0925), bevel=0.0006, mat_idx=1)
    add_picatinny_rail_pc(bm, 0.0, 0.043, 0.020, -0.165, direction="+Y", mat_idx=1, tooth_pitch=0.010)
    # Ghost-ring base clamp, protective steel side ears, windage drum & toroidal aperture ring
    add_box_pc(bm, (0.0, 0.050, 0.005), (0.0125, 0.0045, 0.015), bevel=0.0012, mat_idx=0)
    for sx in (-1.0, 1.0):
        add_box_pc(bm, (sx * 0.0105, 0.058, 0.005), (0.0022, 0.0085, 0.010), bevel=0.0008, mat_idx=0, roll_deg=sx * -8.0)
        add_box_pc(bm, (sx * 0.0055, 0.058, 0.012), (0.0012, 0.0012, 0.0012), bevel=0.0003, mat_idx=4)
    add_torus_pc(bm, (0.0, 0.058, 0.005), axis="Z", major_r=0.0052, minor_r=0.0014, major_segs=20, minor_segs=10, mat_idx=0)
    add_cylinder_axis_pc(bm, (-0.015, 0.052, 0.005), (0.015, 0.052, 0.005), 0.0028, sides=14, mat_idx=0)

    # 20" Heavy-Walled Parkerized 12-Gauge Barrel with recessed hollow 18.5mm bore!
    add_hollow_barrel_z_pc(
        bm, 0.0, 0.026,
        [
            (-0.180, 0.0152),
            (-0.220, 0.0144),
            (-0.540, 0.0135),
            (-0.642, 0.0133),
        ],
        bore_radius=0.0094,
        bore_depth=0.070,
        sides=28,
        outer_mat_idx=0,
        bore_mat_idx=5,
        rifling_lands=0,
    )

    # Perforated / Ventilated Steel Barrel Heatshield (`z = -0.195 .. -0.525`) with slotted cooling ports!
    add_cylinder_z_pc(bm, 0.0, 0.0275, -0.198, -0.522, 0.0155, 0.0149, sides=20, mat_idx=5)
    for spine_deg in (-68.0, 0.0, 68.0):
        sr = math.radians(spine_deg)
        sx = math.sin(sr) * 0.0168
        sy = 0.026 + math.cos(sr) * 0.0168
        add_box_pc(bm, (sx, sy, -0.360), (0.0030, 0.0018, 0.165), bevel=0.0, mat_idx=0, roll_deg=-spine_deg)
    for rib_i in range(12):
        rz = -0.204 - rib_i * 0.0285
        # Continuous stamped steel arch strap across barrel leaving dark slotted cooling ports between straps!
        add_lathe_z_pc(
            bm, 0.0, 0.028,
            [(rz + 0.006, 0.0169), (rz - 0.006, 0.0168)],
            sides=20, mat_idx=0,
        )

    # Under-barrel 8-Shot Magazine Tube + Knurled Takedown Cap + Sling Stud + Bayonet Lug Barrel Clamp
    add_lathe_z_pc(
        bm, 0.0, -0.008,
        [
            (-0.180, 0.0128),
            (-0.595, 0.0128),
            (-0.598, 0.0148),
            (-0.626, 0.0148),
            (-0.630, 0.0132),
            (-0.636, 0.0065),
        ],
        sides=26, mat_idx=0,
    )
    # Knurling ribs on magazine tube cap
    for k_i in range(12):
        ka = (2.0 * math.pi * k_i) / 12.0
        add_box_pc(
            bm, (math.cos(ka) * 0.0150, -0.008 + math.sin(ka) * 0.0150, -0.612),
            (0.0012, 0.0012, 0.012), bevel=0.0004, mat_idx=1, roll_deg=math.degrees(ka),
        )
    # Heavy-duty figure-8 barrel/mag clamp + M7 bayonet lug + front sling swivel ring
    add_box_pc(bm, (0.0, 0.009, -0.558), (0.0168, 0.026, 0.013), bevel=0.0025, mat_idx=1)
    add_box_pc(bm, (0.0, -0.025, -0.558), (0.0065, 0.006, 0.016), bevel=0.0012, mat_idx=0)  # Bayonet lug T-bar
    add_torus_pc(bm, (0.0, -0.014, -0.638), axis="X", major_r=0.0075, minor_r=0.0015, major_segs=16, minor_segs=8, mat_idx=0)

    # Winged Front Sight Base + Glowing Green Tritium Blade (`z = -0.612`)
    add_box_pc(bm, (0.0, 0.044, -0.612), (0.0085, 0.006, 0.015), bevel=0.0015, mat_idx=0)
    for sx in (-1.0, 1.0):
        add_box_pc(bm, (sx * 0.0078, 0.053, -0.612), (0.0018, 0.0075, 0.010), bevel=0.0006, mat_idx=0, roll_deg=sx * -10.0)
    add_box_pc(bm, (0.0, 0.053, -0.612), (0.0018, 0.0065, 0.0055), bevel=0.0005, mat_idx=0, pitch_deg=-12.0)
    add_box_pc(bm, (0.0, 0.057, -0.608), (0.0014, 0.0018, 0.0018), bevel=0.0003, mat_idx=4)

    # Open Contoured Trigger Guard + Curved Trigger + Action-Lock Lever
    add_open_trigger_guard_pc(
        bm, x_pc=0.0, y_top=-0.020, z_front=-0.046, z_rear=0.012, bow_drop=0.025,
        half_width_x=0.0062, band_thick=0.0036, guard_mat_idx=1, trigger_mat_idx=0,
    )

    # Sculpted Tactical SGA-Style Ergonomic Stock (16-pt rounded oval cross-section + beveled ends!)
    add_profile_loft_pc(
        bm,
        [
            (0.0, 0.002, 0.034, 0.0165, 0.0182, 0.025, 0.44, -10.0),
            (0.0, -0.016, 0.068, 0.0148, 0.0162, 0.021, 0.46, -24.0),  # Smoothly rounded ergonomic grip wrist
            (0.0, -0.024, 0.108, 0.0158, 0.0175, 0.026, 0.44, -8.0),
            (0.0, -0.016, 0.165, 0.0168, 0.0185, 0.038, 0.42, 4.0),    # Rounded raised cheek comb
            (0.0, -0.020, 0.228, 0.0175, 0.0192, 0.047, 0.40, 2.0),
            (0.0, -0.024, 0.278, 0.0180, 0.0198, 0.053, 0.38, 2.0),
        ],
        mat_idx=2,
        corner_segs=3,
        cap_bevel_start=0.0045,
        cap_bevel_end=0.0040,
    )
    # Thick rounded black rubber recoil buttpad (`z = 0.276 .. 0.304`)
    add_profile_loft_pc(
        bm,
        [
            (0.0, -0.024, 0.276, 0.0184, 0.0202, 0.054, 0.38, 2.0),
            (0.0, -0.025, 0.304, 0.0174, 0.0192, 0.053, 0.42, 2.0),
        ],
        mat_idx=3,
        corner_segs=3,
        cap_bevel_start=0.0025,
        cap_bevel_end=0.0055,
    )

    finalize_weapon_part(
        "M590_ReceiverBarrelStock", bm,
        [
            mats["parkerized_steel"], mats["anodized_black"], mats["polymer_grip"],
            mats["rubber_pad"], mats["tritium_sight"], mats["dark_bore"],
        ],
        arm, "Bone_Root", col, angle_deg=38.0,
    )

    # Ribbed Corncob Tactical Pump Forend + Dual Steel Action Bars (`Bone_Pump`)
    bm = bmesh.new()
    add_lathe_z_pc(
        bm, 0.0, -0.009,
        [
            (-0.235, 0.0205),
            (-0.248, 0.0235),
            (-0.432, 0.0230),
            (-0.445, 0.0195),
        ],
        sides=24, mat_idx=0,
    )
    for g_i in range(9):
        gz = -0.254 - g_i * 0.0205
        add_lathe_z_pc(
            bm, 0.0, -0.009,
            [(gz + 0.002, 0.0238), (gz, 0.0268), (gz - 0.009, 0.0268), (gz - 0.011, 0.0238)],
            sides=24, mat_idx=0, cap_start=False, cap_end=False,
        )
    # FDE M-LOK / grip accent strap + dual steel twin action bars extending back into receiver!
    add_box_pc(bm, (0.0, -0.032, -0.340), (0.012, 0.005, 0.078), bevel=0.0015, mat_idx=1)
    for sx in (-1.0, 1.0):
        add_box_pc(bm, (sx * 0.0155, 0.002, -0.185), (0.0022, 0.0045, 0.068), bevel=0.0006, mat_idx=2)
    finalize_weapon_part(
        "M590_PumpForend", bm,
        [mats["polymer_grip"], mats["polymer_fde"], mats["parkerized_steel"]],
        arm, "Bone_Pump", col,
    )

    # Machined Steel Bolt Carrier + Extractor Claw (`Bone_Bolt`)
    bm = bmesh.new()
    add_box_pc(bm, (0.009, 0.015, -0.082), (0.0115, 0.0115, 0.042), bevel=0.002, mat_idx=0)
    add_box_pc(bm, (0.0195, 0.015, -0.095), (0.0022, 0.0038, 0.018), bevel=0.0006, mat_idx=1)  # Extractor claw
    finalize_weapon_part(
        "M590_BoltCarrier", bm, [mats["bolt_steel"], mats["parkerized_steel"]], arm, "Bone_Bolt", col
    )

    # Detailed 12-Gauge 2.75" Crimson Ribbed Shotshell + High-Brass Head & Rim (`Bone_Shell`)
    bm = bmesh.new()
    add_lathe_z_pc(
        bm, 0.0, -0.024,
        [
            (-0.046, 0.0112),  # Extractor rim flange
            (-0.049, 0.0112),
            (-0.0495, 0.0103),
            (-0.068, 0.0103),  # High-brass head
        ],
        sides=22, mat_idx=1,
    )
    add_lathe_z_pc(
        bm, 0.0, -0.024,
        [
            (-0.068, 0.0101),
            (-0.118, 0.0100),
            (-0.121, 0.0090),  # Rolled star-crimp mouth
        ],
        sides=22, mat_idx=0,
    )
    finalize_weapon_part(
        "M590_Shell12G", bm, [mats["shell_red"], mats["brass_gold"]], arm, "Bone_Shell", col
    )

    add_muzzle_socket("MuzzleSocket", (0.0, 0.026, -0.645), arm, col)

    arm.animation_data_create()
    bpy.context.scene.render.fps = 24

    def keyframe_pose(frame: int, shell_visible: bool = False) -> None:
        scale = 1.0 if shell_visible else 0.001
        arm.pose.bones["Bone_Shell"].scale = (scale,) * 3
        keyframe_weapon_bones(arm, frame)

    act = bpy.data.actions.new("Idle")
    arm.animation_data.action = act
    for f, dy, pitch in [(1, 0.0, 0.0), (25, 0.003, 0.35), (49, 0.0, 0.0)]:
        reset_weapon_pose(arm)
        set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, dy, 0.0), (pitch, 0.0, 0.0))
        keyframe_pose(f)
    push_weapon_nla(arm, act, "Idle")

    act = bpy.data.actions.new("FirePump")
    arm.animation_data.action = act
    reset_weapon_pose(arm)
    keyframe_pose(1)
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, 0.018, 0.065), (9.5, 0.0, -1.5))
    keyframe_pose(3)
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, -0.008, 0.022), (3.0, 2.0, -4.0))
    set_weapon_bone_pose_pc(arm, "Bone_Pump", (0.0, 0.0, 0.068))
    set_weapon_bone_pose_pc(arm, "Bone_Bolt", (0.0, 0.0, 0.068))
    keyframe_pose(10)
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, 0.004, -0.010), (-1.2, 0.0, 0.0))
    set_weapon_bone_pose_pc(arm, "Bone_Pump", (0.0, 0.0, 0.0))
    set_weapon_bone_pose_pc(arm, "Bone_Bolt", (0.0, 0.0, 0.0))
    keyframe_pose(16)
    reset_weapon_pose(arm)
    keyframe_pose(21)
    push_weapon_nla(arm, act, "FirePump")

    act = bpy.data.actions.new("ReloadShell")
    arm.animation_data.action = act
    reset_weapon_pose(arm)
    keyframe_pose(1)
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (-0.025, 0.025, 0.02), (12.0, 8.0, 26.0))
    set_weapon_bone_pose_pc(arm, "Bone_Shell", (0.01, -0.095, 0.04), (-22.0, 0.0, 0.0))
    keyframe_pose(7, shell_visible=True)
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (-0.022, 0.032, 0.012), (13.5, 8.0, 28.0))
    set_weapon_bone_pose_pc(arm, "Bone_Shell", (0.0, 0.0, -0.018))
    keyframe_pose(14, shell_visible=True)
    set_weapon_bone_pose_pc(arm, "Bone_Shell", (0.0, 0.016, -0.132))
    keyframe_pose(18)
    reset_weapon_pose(arm)
    keyframe_pose(22)
    push_weapon_nla(arm, act, "ReloadShell")

    reset_weapon_pose(arm)
    export_collection_glb(col, os.path.join(OUT_DIR, "m590_shotgun.glb"))
    return col


# ---------------------------------------------------------------------------
# 2. Silver Talon .50 AE (`silver_talon_50ae.glb`) — Desert Eagle Mark XIX
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

    # Material indices: 0=brushed_chrome, 1=anodized_black, 2=polymer_grip, 3=tritium_sight, 4=dark_bore
    bm = bmesh.new()

    # Machined Brushed Chrome Frame + Swept Beavertail Tang + Full-Length Railed Dustcover
    add_profile_loft_pc(
        bm,
        [
            (0.0, 0.012, 0.068, 0.0135, 0.0150, 0.0065, 0.34, -12.0),  # Swept beavertail tang
            (0.0, 0.006, 0.042, 0.0165, 0.0170, 0.0110, 0.24, 0.0),
            (0.0, 0.004, -0.065, 0.0168, 0.0168, 0.0115, 0.22, 0.0),
            (0.0, 0.005, -0.195, 0.0160, 0.0145, 0.0105, 0.24, 0.0),   # Forward dustcover under barrel
            (0.0, 0.007, -0.278, 0.0145, 0.0130, 0.0090, 0.28, 0.0),
        ],
        mat_idx=0,
    )
    # Under-dustcover accessory Picatinny slots (narrow pistol frame width)
    add_picatinny_rail_pc(
        bm, 0.0, -0.005, -0.145, -0.268, direction="-Y", mat_idx=0,
        tooth_pitch=0.011, rail_half_w=0.0082, base_h=0.0016, tooth_h=0.0020,
    )
    # Frame controls: takedown lever + slide catch lever + mag release button
    add_box_pc(bm, (-0.0185, 0.008, -0.072), (0.0022, 0.0048, 0.014), bevel=0.0008, mat_idx=1)
    add_box_pc(bm, (-0.0185, 0.012, -0.022), (0.0020, 0.0042, 0.018), bevel=0.0008, mat_idx=1)
    add_cylinder_axis_pc(bm, (-0.0195, -0.012, 0.002), (-0.0155, -0.012, 0.002), 0.0042, sides=14, mat_idx=1)

    # Iconic Desert Eagle Mark XIX Triangular / Polygonal 6" Fixed Barrel (`z = -0.088 .. -0.289`)!
    # Unmistakable steep 44-deg angled upper triangular slopes tapering to a narrow 12.0mm flat top rib!
    deagle_barrel_poly_ccw = [
        (0.0060, 0.0510),   # Narrow top-right rib edge (12mm total top flat!)
        (-0.0060, 0.0510),  # Narrow top-left rib edge
        (-0.0188, 0.0305),  # Steep 44-deg triangular upper-left facet shoulder!
        (-0.0188, 0.0170),  # Vertical lower-left slab flank
        (-0.0152, 0.0135),  # Lower-left dustcover chamfer
        (0.0152, 0.0135),   # Lower-right dustcover chamfer
        (0.0188, 0.0170),   # Vertical lower-right slab flank
        (0.0188, 0.0305),   # Steep 44-deg triangular upper-right facet shoulder!
    ]
    add_custom_poly_z_pc(
        bm,
        deagle_barrel_poly_ccw,
        [
            (-0.086, 0.96, 0.96),
            (-0.090, 1.00, 1.00),
            (-0.284, 1.00, 1.00),
            (-0.289, 0.91, 0.91),  # Crisp beveled triangular muzzle crown!
        ],
        mat_idx=0,
    )
    # Recessed dark `.50 AE` (12.7mm!) polygonal rifled muzzle crown & hollow bore
    add_hollow_barrel_z_pc(
        bm, 0.0, 0.031,
        [(-0.240, 0.0102), (-0.2892, 0.0098)],
        bore_radius=0.0066,
        bore_depth=0.065,
        sides=24,
        outer_mat_idx=0,
        bore_mat_idx=4,
        rifling_lands=6,
    )
    # Integral Weaver/Picatinny barrel scope slots strictly within the narrow 12mm top rib (leaving triangular slopes exposed!)
    add_picatinny_rail_pc(
        bm, 0.0, 0.0510, -0.105, -0.252, direction="+Y", mat_idx=0,
        tooth_pitch=0.014, rail_half_w=0.0058, base_h=0.0008, tooth_h=0.0018,
    )

    # Dovetailed Front Combat Blade Sight + Glowing Tritium Dot
    add_box_pc(bm, (0.0, 0.052, -0.272), (0.0058, 0.0020, 0.008), bevel=0.0006, mat_idx=1)
    add_box_pc(bm, (0.0, 0.058, -0.272), (0.0024, 0.0055, 0.0075), bevel=0.0007, mat_idx=1, pitch_deg=-14.0)
    add_box_pc(bm, (0.0, 0.060, -0.266), (0.0014, 0.0016, 0.0015), bevel=0.0003, mat_idx=3)

    # Open Contoured Combat Trigger Guard (with front finger-hook recurve!) + Curved Trigger
    add_open_trigger_guard_pc(
        bm, x_pc=0.0, y_top=-0.006, z_front=-0.074, z_rear=-0.010, bow_drop=0.028,
        half_width_x=0.0065, band_thick=0.0038, guard_mat_idx=0, trigger_mat_idx=1,
    )

    # Contoured Wrap-Around Stippled Hogue Rubber Grip (18.5-deg rake, 3 deep Hogue finger grooves, palm-swell backstrap!)
    add_contoured_grip_pc(
        bm,
        y_top=-0.004, z_top=0.006, length_y=0.112, rake_deg=18.5,
        half_w=0.0176, half_depth=0.0255, mat_idx=2,
        groove_amp=0.0034, palm_swell=0.0060, heel_flare=1.12,
    )

    finalize_weapon_part(
        "SilverTalon_FrameBarrelGrip", bm,
        [mats["brushed_chrome"], mats["anodized_black"], mats["polymer_grip"], mats["tritium_sight"], mats["dark_bore"]],
        arm, "Bone_Root", col, angle_deg=38.0,
    )

    # Reciprocating Brushed Chrome Slide (`Bone_Slide`) matching the Desert Eagle triangular/polygonal top profile!
    bm = bmesh.new()
    deagle_slide_poly_ccw = [
        (0.0068, 0.0505),
        (-0.0068, 0.0505),
        (-0.0192, 0.0305),
        (-0.0192, 0.0110),
        (0.0192, 0.0110),
        (0.0192, 0.0305),
    ]
    add_custom_poly_z_pc(
        bm,
        deagle_slide_poly_ccw,
        [
            (0.056, 0.92, 0.94),
            (0.051, 1.00, 1.00),
            (-0.022, 1.00, 1.00),
        ],
        mat_idx=0,
    )
    # Left slide prong & lower right rail continuing forward around open ejection port (`z = -0.022 .. -0.102`)
    left_prong_ccw = [
        (-0.0095, 0.0465),
        (-0.0192, 0.0305),
        (-0.0192, 0.0110),
        (-0.0125, 0.0110),
    ]
    add_custom_poly_z_pc(bm, left_prong_ccw, [(-0.020, 1.0, 1.0), (-0.102, 1.0, 1.0)], mat_idx=0)
    add_box_pc(bm, (0.0158, 0.015, -0.062), (0.0035, 0.0048, 0.042), bevel=0.0012, mat_idx=0)  # Lower right rail under open ejection port!
    # Visible dark rotary bolt head & extractor inside open ejection port
    add_cylinder_z_pc(bm, 0.0, 0.030, -0.020, -0.088, 0.0098, 0.0098, sides=18, mat_idx=1)
    # Crisp angled rear slide serrations (7 deep grooves on both sides)
    for s_i in range(7):
        sz = 0.040 - s_i * 0.0072
        for sx in (-1.0, 1.0):
            add_box_pc(bm, (sx * 0.0186, 0.026, sz), (0.0014, 0.0135, 0.0020), bevel=0.0005, mat_idx=1, pitch_deg=12.0)
    # Ambidextrous slide-mounted tear-drop safety levers
    for sx in (-1.0, 1.0):
        add_box_pc(bm, (sx * 0.0202, 0.032, 0.038), (0.0022, 0.0052, 0.012), bevel=0.0012, mat_idx=1, pitch_deg=-15.0)
    # Combat Novak-style rear U-notch sight + dual green tritium vials
    add_box_pc(bm, (0.0, 0.052, 0.042), (0.0115, 0.0048, 0.012), bevel=0.0012, mat_idx=1, pitch_deg=14.0)
    for sx in (-1.0, 1.0):
        add_box_pc(bm, (sx * 0.0062, 0.056, 0.046), (0.0032, 0.0032, 0.006), bevel=0.0006, mat_idx=1)
        add_box_pc(bm, (sx * 0.0058, 0.056, 0.0522), (0.0012, 0.0012, 0.0008), bevel=0.0002, mat_idx=2)
    finalize_weapon_part(
        "SilverTalon_Slide", bm,
        [mats["brushed_chrome"], mats["anodized_black"], mats["tritium_sight"]],
        arm, "Bone_Slide", col,
    )

    # Heavy 7-Round .50 AE Magazine + Visible Brass Cartridge with Copper Hollow-Point Bullet (`Bone_Mag`)
    bm = bmesh.new()
    add_swept_loft_yz_pc(
        bm,
        [
            (0.0, -0.008, 0.009, 0.0128, 0.0128, 0.0195, 0.24),
            (0.0, -0.115, 0.045, 0.0128, 0.0128, 0.0195, 0.24),
        ],
        mat_idx=0,
        corner_segs=2,
    )
    add_swept_loft_yz_pc(
        bm,
        [
            (0.0, -0.115, 0.046, 0.0182, 0.0192, 0.0275, 0.42),
            (0.0, -0.124, 0.049, 0.0172, 0.0182, 0.0265, 0.44),
        ],
        mat_idx=1,
        corner_segs=3,
        cap_bevel_start=0.0020,
        cap_bevel_end=0.0035,
    )
    # Visible .50 AE brass case + copper JHP hollow-point bullet seated at top of magazine!
    add_lathe_z_pc(bm, 0.0, -0.003, [(0.024, 0.0069), (-0.008, 0.0068)], sides=18, mat_idx=2)
    add_hollow_barrel_z_pc(
        bm, 0.0, -0.003,
        [(-0.008, 0.0064), (-0.016, 0.0060), (-0.022, 0.0042)],
        bore_radius=0.0022, bore_depth=0.006, sides=18, outer_mat_idx=3, bore_mat_idx=4,
    )
    finalize_weapon_part(
        "SilverTalon_Magazine", bm,
        [mats["parkerized_steel"], mats["polymer_grip"], mats["brass_gold"], mats["copper_jacket"], mats["dark_bore"]],
        arm, "Bone_Mag", col,
    )

    # True Skeletonized Combat Spur Hammer (`Bone_Hammer`) — two outer frame struts around open oval cutout!
    bm = bmesh.new()
    add_box_pc(bm, (0.0, 0.024, 0.052), (0.0042, 0.006, 0.005), bevel=0.001, mat_idx=0)
    add_box_pc(bm, (0.0, 0.034, 0.052), (0.0040, 0.007, 0.0028), bevel=0.0008, mat_idx=0, pitch_deg=-18.0)
    add_box_pc(bm, (0.0, 0.033, 0.061), (0.0040, 0.007, 0.0028), bevel=0.0008, mat_idx=0, pitch_deg=-32.0)
    add_box_pc(bm, (0.0, 0.041, 0.060), (0.0044, 0.0035, 0.0075), bevel=0.001, mat_idx=0, pitch_deg=-22.0)
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
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, 0.024, 0.052), (16.5, -1.5, 2.5))
    set_weapon_bone_pose_pc(arm, "Bone_Slide", (0.0, 0.0, 0.058))
    set_weapon_bone_pose_pc(arm, "Bone_Hammer", (0.0, 0.0, 0.0), (-42.0, 0.0, 0.0))
    keyframe_weapon_bones(arm, 3)
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, 0.010, 0.018), (6.5, 0.0, 0.0))
    keyframe_weapon_bones(arm, 7)
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 14)
    push_weapon_nla(arm, act, "FireBlowback")

    act = bpy.data.actions.new("ReloadMag")
    arm.animation_data.action = act
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 1)
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (-0.02, 0.02, 0.01), (8.0, 12.0, 24.0))
    set_weapon_bone_pose_pc(arm, "Bone_Slide", (0.0, 0.0, 0.048))
    set_weapon_bone_pose_pc(arm, "Bone_Mag", (0.0, -0.22, 0.074))
    keyframe_weapon_bones(arm, 7)
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (-0.015, 0.032, 0.005), (10.0, 8.0, 18.0))
    set_weapon_bone_pose_pc(arm, "Bone_Slide", (0.0, 0.0, 0.048))
    set_weapon_bone_pose_pc(arm, "Bone_Mag", (0.0, -0.075, 0.025))
    keyframe_weapon_bones(arm, 12)
    set_weapon_bone_pose_pc(arm, "Bone_Mag")
    keyframe_weapon_bones(arm, 15)
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, 0.004, -0.012), (-2.0, 0.0, 0.0))
    keyframe_weapon_bones(arm, 19)
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 25)
    push_weapon_nla(arm, act, "ReloadMag")

    reset_weapon_pose(arm)
    export_collection_glb(col, os.path.join(OUT_DIR, "silver_talon_50ae.glb"))
    return col


# ---------------------------------------------------------------------------
# 3. H&K MSG90A1 7.62x51mm Marksman Sniper Rifle (`msg90_sniper.glb`)
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

    # Material indices:
    # 0=parkerized_steel, 1=anodized_black, 2=polymer_grip, 3=polymer_fde, 4=optic_glass, 5=rubber_pad, 6=dark_bore
    bm = bmesh.new()

    # Stamped & Welded Fluted HK Steel Receiver (`z = 0.062 .. -0.222`) + Recessed Ejection Port!
    # Rear receiver section behind ejection port (`0.062 .. -0.062`)
    add_profile_loft_pc(
        bm,
        [
            (0.0, 0.014, 0.062, 0.0145, 0.0195, 0.026, 0.24, 0.0),
            (0.0, 0.014, -0.062, 0.0148, 0.0198, 0.026, 0.24, 0.0),
        ],
        mat_idx=1,
    )
    # Ejection port bridge (`-0.062 .. -0.155`): open right window exposing `Bone_Bolt` + dark chamber!
    add_box_pc(bm, (-0.0135, 0.014, -0.108), (0.0062, 0.025, 0.048), bevel=0.0018, mat_idx=1)
    add_box_pc(bm, (0.0, 0.035, -0.108), (0.0155, 0.0055, 0.048), bevel=0.0015, mat_idx=1)
    add_box_pc(bm, (0.002, 0.015, -0.108), (0.0095, 0.014, 0.042), bevel=0.001, mat_idx=6)
    # HK brass deflector lip behind ejection port
    add_box_pc(bm, (0.0195, 0.016, -0.060), (0.0042, 0.011, 0.006), bevel=0.0012, mat_idx=0, yaw_deg=18.0)
    # Front receiver trunnion + flared 7.62mm magwell (`-0.155 .. -0.222`)
    add_profile_loft_pc(
        bm,
        [
            (0.0, 0.013, -0.155, 0.0148, 0.0198, 0.026, 0.24, 0.0),
            (0.0, 0.012, -0.222, 0.0142, 0.0188, 0.024, 0.26, 0.0),
        ],
        mat_idx=1,
    )
    add_box_pc(bm, (0.0, -0.014, -0.105), (0.0172, 0.018, 0.044), bevel=0.002, mat_idx=1)  # Magwell skirt + paddle catch
    add_box_pc(bm, (0.0, -0.030, -0.058), (0.0055, 0.007, 0.008), bevel=0.001, mat_idx=0, pitch_deg=-20.0)
    # Signature HK stamped receiver longitudinal stiffening ribs & PSG reinforcing side rails!
    for sx in (-1.0, 1.0):
        add_box_pc(bm, (sx * 0.0198, 0.004, -0.025), (0.0024, 0.0055, 0.082), bevel=0.0008, mat_idx=0)
        add_box_pc(bm, (sx * 0.0165, 0.027, 0.002), (0.0018, 0.0032, 0.055), bevel=0.0006, mat_idx=0)

    # Lower Navy/PSG Polymer Trigger Pack + Ambi Selector Lever + Open Trigger Guard + Target Trigger Shoe
    add_box_pc(bm, (0.0, -0.015, 0.004), (0.0175, 0.014, 0.054), bevel=0.0025, mat_idx=2)
    for sx in (-1.0, 1.0):
        add_box_pc(bm, (sx * 0.0192, -0.012, 0.016), (0.0022, 0.0042, 0.014), bevel=0.0008, mat_idx=0, pitch_deg=-22.0)
    add_open_trigger_guard_pc(
        bm, x_pc=0.0, y_top=-0.026, z_front=-0.042, z_rear=0.010, bow_drop=0.024,
        half_width_x=0.0060, band_thick=0.0034, guard_mat_idx=2, trigger_mat_idx=0,
    )

    # Ergonomic PSG1/MSG90 Stippled Target Pistol Grip (19-deg rake, finger grooves, target palm swell) + Rounded Palm Shelf!
    add_contoured_grip_pc(
        bm,
        y_top=-0.022, z_top=0.014, length_y=0.095, rake_deg=19.0,
        half_w=0.0168, half_depth=0.0220, mat_idx=2,
        groove_amp=0.0028, palm_swell=0.0058, heel_flare=1.08,
    )
    # Precision Adjustable MSG90 Buttstock (16-pt rounded oval cross-section + beveled ends!)
    add_profile_loft_pc(
        bm,
        [
            (0.0, 0.008, 0.062, 0.0155, 0.0182, 0.026, 0.42, 0.0),
            (0.0, 0.003, 0.145, 0.0165, 0.0190, 0.036, 0.40, 0.0),
            (0.0, -0.002, 0.225, 0.0172, 0.0194, 0.041, 0.40, 0.0),
            (0.0, -0.006, 0.285, 0.0176, 0.0198, 0.045, 0.38, 0.0),
        ],
        mat_idx=2,
        corner_segs=3,
        cap_bevel_start=0.0040,
        cap_bevel_end=0.0045,
    )
    # Sculpted saddle-shaped FDE Cheek Riser (`y = 0.048`, `z = 0.122 .. 0.255`) with pillowy rounded bevels!
    for pz in (0.155, 0.225):
        add_cylinder_axis_pc(bm, (0.0, 0.024, pz), (0.0, 0.048, pz), 0.0045, sides=14, mat_idx=0)
    add_profile_loft_pc(
        bm,
        [
            (0.0, 0.047, 0.122, 0.0185, 0.0205, 0.0115, 0.45, -8.0),
            (0.0, 0.051, 0.188, 0.0195, 0.0218, 0.0130, 0.46, 0.0),
            (0.0, 0.047, 0.255, 0.0185, 0.0205, 0.0115, 0.45, 8.0),
        ],
        mat_idx=3,
        corner_segs=3,
        cap_bevel_start=0.0055,
        cap_bevel_end=0.0055,
    )
    # Thumbwheel adjustment dials on right side of stock + steel length-of-pull rods + rounded rubber buttpad
    for wy in (0.018, -0.016):
        add_cylinder_axis_pc(bm, (0.015, wy, 0.245), (0.022, wy, 0.245), 0.0095, sides=18, mat_idx=0)
        add_cylinder_z_pc(bm, 0.0, wy, 0.282, 0.326, 0.0055, 0.0055, sides=14, mat_idx=0)
    add_profile_loft_pc(
        bm,
        [
            (0.0, -0.008, 0.324, 0.0192, 0.0208, 0.056, 0.38, 0.0),
            (0.0, -0.008, 0.348, 0.0182, 0.0198, 0.055, 0.42, 0.0),
        ],
        mat_idx=5,
        corner_segs=3,
        cap_bevel_start=0.0030,
        cap_bevel_end=0.0050,
    )

    # Polygonal Ventilated Free-Float Handguard (`z = -0.220 .. -0.490`) + Upper HK Cocking Tube
    add_profile_loft_pc(
        bm,
        [
            (0.0, 0.006, -0.220, 0.0175, 0.0225, 0.022, 0.36, 0.0),
            (0.0, 0.006, -0.478, 0.0160, 0.0205, 0.020, 0.36, 0.0),
            (0.0, 0.007, -0.492, 0.0145, 0.0175, 0.018, 0.40, 0.0),
        ],
        mat_idx=2,
        corner_segs=2,
        cap_bevel_start=0.0035,
        cap_bevel_end=0.0035,
    )
    # Recessed dark cooling slots along both sides of handguard + bottom T-slot rail
    for slot_i in range(5):
        sz = -0.255 - slot_i * 0.044
        for sx in (-1.0, 1.0):
            add_box_pc(bm, (sx * 0.0202, 0.006, sz), (0.0018, 0.0042, 0.014), bevel=0.0005, mat_idx=6)
    add_cylinder_z_pc(bm, 0.0, 0.034, -0.218, -0.488, 0.0098, 0.0095, sides=24, mat_idx=0)  # HK cocking tube
    add_box_pc(bm, (0.0, 0.034, -0.492), (0.0095, 0.012, 0.006), bevel=0.0015, mat_idx=0)   # Front sight hood plug

    # Cold-Hammer-Forged Heavy Stepped 600mm Barrel + Barrel Weight Harmonic Collar + Slotted Birdcage Flash Hider!
    add_hollow_barrel_z_pc(
        bm, 0.0, 0.012,
        [
            (-0.485, 0.0128),
            (-0.620, 0.0122),
            (-0.715, 0.0118),
            (-0.718, 0.0142),  # Iconic MSG90A1 harmonic barrel-weight collar near muzzle!
            (-0.758, 0.0142),
            (-0.761, 0.0116),
        ],
        bore_radius=0.0044,
        bore_depth=0.045,
        sides=28,
        outer_mat_idx=0,
        bore_mat_idx=6,
    )
    add_slotted_flash_hider_z_pc(
        bm, x_pc=0.0, y_pc=0.012, z_base=-0.760, z_tip=-0.818,
        outer_r=0.0132, bore_r=0.0046, num_prongs=6, outer_mat_idx=0, bore_mat_idx=6,
    )

    # Articulated Folded Harris / HK Front Bipod (`z = -0.475 .. -0.275`) with Springs & Rubberized Feet!
    add_box_pc(bm, (0.0, -0.018, -0.468), (0.020, 0.008, 0.020), bevel=0.002, mat_idx=1)  # Swivel yoke block
    for sx in (-1.0, 1.0):
        bx = sx * 0.0265
        # Outer upper leg sleeve + inner notched telescoping leg + rubberized ski/pad foot
        add_cylinder_z_pc(bm, bx, -0.022, -0.465, -0.355, 0.0068, 0.0068, sides=18, mat_idx=1)
        add_cylinder_z_pc(bm, bx, -0.022, -0.355, -0.285, 0.0050, 0.0050, sides=16, mat_idx=0)
        add_box_pc(bm, (bx, -0.024, -0.278), (0.0085, 0.0105, 0.0105), bevel=0.0025, mat_idx=5)
        # External return spring coils alongside bipod leg!
        sy_spr = -0.011
        add_cylinder_z_pc(bm, bx * 0.88, sy_spr, -0.452, -0.368, 0.0032, 0.0032, sides=12, mat_idx=0)
        for c_i in range(8):
            cz = -0.448 + c_i * 0.0105
            add_torus_pc(bm, (bx * 0.88, sy_spr, cz), axis="Z", major_r=0.0038, minor_r=0.0010, major_segs=12, minor_segs=6, mat_idx=0)

    # Receiver-mounted scope rail + Hensoldt ZF 10x42 Telescopic Sniper Scope + Sunshade + Knurled Turrets + Coated Lenses!
    for rz in (0.002, -0.153):
        add_box_pc(bm, (0.0, 0.037, rz), (0.011, 0.005, 0.013), bevel=0.001, mat_idx=1)
    add_picatinny_rail_pc(bm, 0.0, 0.041, 0.025, -0.175, direction="+Y", mat_idx=1, tooth_pitch=0.011)
    for rz in (-0.018, -0.142):
        add_box_pc(bm, (0.0, 0.056, rz), (0.0155, 0.012, 0.012), bevel=0.002, mat_idx=1)
        add_torus_pc(bm, (0.0, 0.078, rz), axis="Z", major_r=0.0168, minor_r=0.0038, major_segs=24, minor_segs=10, mat_idx=1)
    # 30mm Scope Tube + Tapered Ocular Eyepiece + Flared 42mm Objective Bell + Extended Sunshade with recessed lenses!
    add_lathe_z_pc(
        bm, 0.0, 0.078,
        [
            (0.092, 0.0215),  # Rubberized ocular eyecup lip
            (0.085, 0.0225),
            (0.052, 0.0215),
            (0.036, 0.0162),  # 30mm main tube
            (-0.178, 0.0162),
            (-0.218, 0.0255), # 42mm objective bell
            (-0.292, 0.0262), # Anti-glare front sunshade!
            (-0.290, 0.0242), # Recessed inner sunshade step
            (-0.268, 0.0235),
        ],
        sides=28, mat_idx=1,
    )
    # Multi-coated emerald/cyan front objective lens & rear ocular lens
    add_cylinder_z_pc(bm, 0.0, 0.078, -0.266, -0.270, 0.0232, 0.0232, sides=26, mat_idx=4)
    add_cylinder_z_pc(bm, 0.0, 0.078, 0.088, 0.084, 0.0192, 0.0192, sides=24, mat_idx=4)
    # Saddle turret block + Knurled Elevation (+Y), Windage (+X), and Side-Parallax (-X) Turrets!
    add_box_pc(bm, (0.0, 0.078, -0.082), (0.019, 0.019, 0.018), bevel=0.003, mat_idx=1)
    add_cylinder_axis_pc(bm, (0.0, 0.094, -0.082), (0.0, 0.112, -0.082), 0.0115, 0.0110, sides=20, mat_idx=0)
    add_cylinder_axis_pc(bm, (0.016, 0.078, -0.082), (0.033, 0.078, -0.082), 0.0105, 0.0100, sides=20, mat_idx=0)
    add_cylinder_axis_pc(bm, (-0.016, 0.078, -0.082), (-0.030, 0.078, -0.082), 0.0098, 0.0094, sides=18, mat_idx=0)

    finalize_weapon_part(
        "MSG90_RifleOpticBipod", bm,
        [
            mats["parkerized_steel"], mats["anodized_black"], mats["polymer_grip"],
            mats["polymer_fde"], mats["optic_glass"], mats["rubber_pad"], mats["dark_bore"],
        ],
        arm, "Bone_Root", col, angle_deg=38.0,
    )

    # 20-Round 7.62x51mm NATO Stamped Waffle/Ribbed Steel Box Magazine + Top Brass Cartridge (`Bone_Mag`)
    bm = bmesh.new()
    add_box_pc(bm, (0.0, -0.082, -0.105), (0.0132, 0.062, 0.0365), bevel=0.0022, mat_idx=0)
    add_box_pc(bm, (0.0, -0.145, -0.105), (0.0150, 0.0045, 0.0395), bevel=0.0015, mat_idx=1)  # Flared steel floorplate
    for rib_y in (-0.048, -0.072, -0.096, -0.120):
        add_box_pc(bm, (0.0, rib_y, -0.105), (0.0146, 0.0028, 0.032), bevel=0.0008, mat_idx=0)
    for rib_z in (-0.084, -0.105, -0.126):
        add_box_pc(bm, (0.0, -0.084, rib_z), (0.0144, 0.050, 0.0025), bevel=0.0007, mat_idx=0)
    # Visible 7.62x51mm brass case + copper FMJ spitzer bullet in feed lips
    add_lathe_z_pc(
        bm, 0.0, -0.018,
        [(-0.074, 0.0058), (-0.114, 0.0056), (-0.121, 0.0040)],
        sides=16, mat_idx=2,
    )
    add_lathe_z_pc(
        bm, 0.0, -0.018,
        [(-0.121, 0.0039), (-0.132, 0.0034), (-0.141, 0.0010)],
        sides=16, mat_idx=3,
    )
    finalize_weapon_part(
        "MSG90_Magazine20Rd", bm,
        [mats["parkerized_steel"], mats["anodized_black"], mats["brass_gold"], mats["copper_jacket"]],
        arm, "Bone_Mag", col,
    )

    # Forward HK Roller-Delayed Folding Charging Handle (`Bone_ChargingHandle`) & Bolt (`Bone_Bolt`)
    bm = bmesh.new()
    add_cylinder_axis_pc(bm, (-0.008, 0.034, -0.340), (-0.024, 0.034, -0.340), 0.0045, sides=14, mat_idx=1)
    add_box_pc(bm, (-0.032, 0.034, -0.340), (0.012, 0.0055, 0.0095), bevel=0.002, mat_idx=0, yaw_deg=12.0)
    finalize_weapon_part(
        "MSG90_ChargingHandle", bm, [mats["polymer_grip"], mats["parkerized_steel"]], arm, "Bone_ChargingHandle", col
    )

    bm = bmesh.new()
    add_cylinder_z_pc(bm, 0.009, 0.016, -0.062, -0.156, 0.0108, 0.0108, sides=20, mat_idx=0)
    add_box_pc(bm, (0.0175, 0.016, -0.118), (0.0022, 0.0038, 0.018), bevel=0.0006, mat_idx=1)
    finalize_weapon_part(
        "MSG90_BoltCarrier", bm, [mats["bolt_steel"], mats["parkerized_steel"]], arm, "Bone_Bolt", col
    )

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
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, 0.012, 0.055), (5.5, 0.0, -0.8))
    set_weapon_bone_pose_pc(arm, "Bone_Bolt", (0.0, 0.0, 0.065))
    keyframe_weapon_bones(arm, 3)
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, 0.004, 0.016), (2.0, 0.0, 0.0))
    keyframe_weapon_bones(arm, 7)
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 15)
    push_weapon_nla(arm, act, "FireRecoil")

    act = bpy.data.actions.new("ReloadMag")
    arm.animation_data.action = act
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 1)

    set_weapon_bone_pose_pc(arm, "Bone_Root", (-0.015, 0.015, 0.02), (6.0, 6.0, 16.0))
    keyframe_weapon_bones(arm, 6)
    set_weapon_bone_pose_pc(arm, "Bone_Mag", (0.0, -0.24, 0.02))
    keyframe_weapon_bones(arm, 13)

    set_weapon_bone_pose_pc(arm, "Bone_Root", (-0.015, 0.028, 0.015), (9.0, 6.0, 16.0))
    set_weapon_bone_pose_pc(arm, "Bone_Mag")
    keyframe_weapon_bones(arm, 21)
    set_weapon_bone_pose_pc(arm, "Bone_ChargingHandle", (0.0, 0.0, 0.065))
    set_weapon_bone_pose_pc(arm, "Bone_Bolt", (0.0, 0.0, 0.065))
    keyframe_weapon_bones(arm, 25)
    set_weapon_bone_pose_pc(arm, "Bone_ChargingHandle")
    set_weapon_bone_pose_pc(arm, "Bone_Bolt")
    keyframe_weapon_bones(arm, 27)
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 32)
    push_weapon_nla(arm, act, "ReloadMag")

    reset_weapon_pose(arm)
    export_collection_glb(col, os.path.join(OUT_DIR, "msg90_sniper.glb"))
    return col


# ---------------------------------------------------------------------------
# 4. Colt M4A1 5.56mm SOPMOD Block I/II Carbine (`m4a1_carbine.glb`)
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

    # Material indices:
    # 0=parkerized_steel, 1=anodized_black, 2=polymer_grip, 3=polymer_fde,
    # 4=optic_glass, 5=holo_reticle, 6=rubber_pad, 7=dark_bore, 8=bolt_steel
    bm = bmesh.new()

    # Forged 7075-T6 Hexagonal Upper Receiver + Lower Receiver + Flared Magwell (`z = 0.058 .. -0.165`)!
    # Rear upper/lower forging (`0.058 .. -0.030`)
    add_profile_loft_pc(
        bm,
        [
            (0.0, 0.012, 0.058, 0.0145, 0.0182, 0.027, 0.25, 0.0),
            (0.0, 0.012, -0.030, 0.0152, 0.0188, 0.028, 0.24, 0.0),
        ],
        mat_idx=1,
    )
    # Recessed right-side ejection port window (`z = -0.030 .. -0.112`) + open hinged dust cover!
    add_box_pc(bm, (-0.0132, 0.018, -0.071), (0.0056, 0.021, 0.042), bevel=0.0015, mat_idx=1)
    add_box_pc(bm, (0.0, 0.035, -0.071), (0.0155, 0.0055, 0.042), bevel=0.0015, mat_idx=1)
    add_box_pc(bm, (0.002, 0.018, -0.071), (0.0085, 0.012, 0.038), bevel=0.001, mat_idx=7)
    # Hinged stamped steel ejection-port dust cover flipped open downward along right receiver flank!
    add_box_pc(bm, (0.0195, 0.005, -0.071), (0.0014, 0.0065, 0.036), bevel=0.0005, mat_idx=0, roll_deg=-12.0)
    add_cylinder_z_pc(bm, 0.0188, 0.011, -0.032, -0.110, 0.0018, 0.0018, sides=10, mat_idx=0)  # Dust cover hinge rod
    # Forward upper receiver + barrel nut boss (`-0.112 .. -0.168`)
    add_profile_loft_pc(
        bm,
        [
            (0.0, 0.018, -0.112, 0.0152, 0.0185, 0.022, 0.24, 0.0),
            (0.0, 0.018, -0.168, 0.0152, 0.0185, 0.022, 0.24, 0.0),
        ],
        mat_idx=1,
    )
    # Lower receiver trigger well + flared STANAG magwell with reinforcement fences!
    add_box_pc(bm, (0.0, -0.010, -0.018), (0.0168, 0.013, 0.052), bevel=0.002, mat_idx=1)
    add_swept_loft_yz_pc(
        bm,
        [
            (0.0, 0.004, -0.098, 0.0166, 0.0166, 0.0355, 0.20),
            (0.0, -0.024, -0.100, 0.0172, 0.0172, 0.0365, 0.20),
            (0.0, -0.036, -0.101, 0.0196, 0.0196, 0.0395, 0.18),  # Flared magwell lip!
        ],
        mat_idx=1,
    )
    # Iconic AR-15 / M4 Receiver Controls:
    # 1) Angled Forward Assist Plunger (+X rear), 2) Pyramidal Brass Deflector, 3) Left Bolt Catch Paddle, 4) Selector Switch!
    add_cylinder_axis_pc(bm, (0.014, 0.018, 0.012), (0.027, 0.018, 0.038), 0.0058, 0.0068, sides=16, mat_idx=0)
    add_box_pc(bm, (0.0205, 0.020, -0.018), (0.0065, 0.0095, 0.012), bevel=0.002, mat_idx=1, yaw_deg=22.0)
    add_box_pc(bm, (-0.0188, 0.008, -0.068), (0.0022, 0.0085, 0.0055), bevel=0.0008, mat_idx=0)  # Bolt catch paddle
    add_cylinder_axis_pc(bm, (-0.0192, -0.006, 0.018), (-0.0165, -0.006, 0.018), 0.0045, sides=14, mat_idx=0)
    add_box_pc(bm, (-0.0198, -0.006, 0.011), (0.0018, 0.0028, 0.009), bevel=0.0006, mat_idx=0)   # Fire selector lever
    add_box_pc(bm, (0.0185, -0.012, -0.072), (0.0020, 0.0042, 0.0075), bevel=0.0007, mat_idx=0)  # Mag catch button

    # Open Winter Combat Trigger Guard + Sculpted Curved M4 Trigger!
    add_open_trigger_guard_pc(
        bm, x_pc=0.0, y_top=-0.020, z_front=-0.056, z_rear=-0.004, bow_drop=0.022,
        half_width_x=0.0056, band_thick=0.0030, guard_mat_idx=1, trigger_mat_idx=0,
    )

    # Contoured Stippled A2 / Magpul-Style Pistol Grip (20-deg rake, finger-groove frontstrap, rounded palm swell!)
    add_contoured_grip_pc(
        bm,
        y_top=-0.014, z_top=0.010, length_y=0.094, rake_deg=20.0,
        half_w=0.0152, half_depth=0.0195, mat_idx=2,
        groove_amp=0.0028, palm_swell=0.0050, heel_flare=1.09,
    )

    # Castle Nut + 6-Position Mil-Spec Buffer Tube + Rounded FDE SOPMOD Crane Collapsible Stock + Rubber Buttpad!
    add_cylinder_z_pc(bm, 0.0, 0.016, 0.056, 0.072, 0.0182, 0.0182, sides=20, mat_idx=0)  # Castle nut
    add_cylinder_z_pc(bm, 0.0, 0.016, 0.072, 0.268, 0.0148, 0.0148, sides=24, mat_idx=1)  # Receiver extension tube
    # SOPMOD Crane sloped teardrop cheek-weld saddle (16-pt smooth rounded cross-section + 5mm rounded end bevels!)
    add_profile_loft_pc(
        bm,
        [
            (0.0, 0.010, 0.118, 0.0185, 0.0135, 0.026, 0.44, 0.0),
            (0.0, 0.005, 0.158, 0.0245, 0.0138, 0.035, 0.45, 0.0),
            (0.0, -0.001, 0.215, 0.0255, 0.0142, 0.046, 0.44, 0.0),
            (0.0, -0.009, 0.278, 0.0245, 0.0152, 0.056, 0.42, 0.0),
        ],
        mat_idx=3,
        corner_segs=3,
        cap_bevel_start=0.0055,
        cap_bevel_end=0.0045,
    )
    for sx in (-1.0, 1.0):
        add_lathe_z_pc(
            bm, sx * 0.0168, 0.017,
            [(0.122, 0.0085), (0.128, 0.0112), (0.272, 0.0112), (0.277, 0.0090)],
            sides=20, mat_idx=3,
        )
    add_box_pc(bm, (0.0, -0.032, 0.188), (0.0095, 0.012, 0.034), bevel=0.003, bevel_segs=2, mat_idx=2, pitch_deg=-8.0)  # Stock latch lever
    add_profile_loft_pc(
        bm,
        [
            (0.0, -0.010, 0.277, 0.0225, 0.0160, 0.056, 0.40, 0.0),
            (0.0, -0.010, 0.298, 0.0215, 0.0152, 0.055, 0.44, 0.0),
        ],
        mat_idx=6,
        corner_segs=3,
        cap_bevel_start=0.0025,
        cap_bevel_end=0.0055,
    )

    # The receiver and handguard have separate top rails at the same height.
    # Fill the shoulders under the rails so neither spine floats above its housing.
    add_box_pc(bm, (0.0, 0.036, -0.0605), (0.0105, 0.0035, 0.1085), bevel=0.0006, mat_idx=1)
    add_box_pc(bm, (0.0, 0.0375, -0.282), (0.0105, 0.002, 0.098), bevel=0.0006, mat_idx=1)
    add_picatinny_rail_pc(bm, 0.0, 0.039, 0.045, -0.168, direction="+Y", mat_idx=1, tooth_pitch=0.010)
    add_picatinny_rail_pc(bm, 0.0, 0.039, -0.184, -0.380, direction="+Y", mat_idx=1, tooth_pitch=0.010)
    # Delta ring / RIS II bolt-up barrel nut collar
    add_lathe_z_pc(bm, 0.0, 0.016, [(-0.165, 0.0235), (-0.184, 0.0225)], sides=24, mat_idx=1)
    # Ventilated octagonal RIS quad-rail chassis + dark inner barrel shroud + individual 3/6/9 o'clock Picatinny rails!
    add_profile_loft_pc(
        bm,
        [
            (0.0, 0.016, -0.184, 0.0205, 0.0205, 0.0225, 0.32, 0.0),
            (0.0, 0.016, -0.380, 0.0205, 0.0205, 0.0225, 0.32, 0.0),
        ],
        mat_idx=1,
    )
    for vent_i in range(5):
        vz = -0.205 - vent_i * 0.036
        for sx in (-1.0, 1.0):
            add_box_pc(bm, (sx * 0.0185, 0.030, vz), (0.0025, 0.0032, 0.011), bevel=0.0005, mat_idx=7, roll_deg=sx * -42.0)
            add_box_pc(bm, (sx * 0.0185, 0.002, vz), (0.0025, 0.0032, 0.011), bevel=0.0005, mat_idx=7, roll_deg=sx * 42.0)
    add_picatinny_rail_pc(bm, 0.0, -0.007, -0.190, -0.376, direction="-Y", mat_idx=1, tooth_pitch=0.010)
    add_picatinny_rail_pc(bm, 0.0205, 0.016, -0.190, -0.376, direction="+X", mat_idx=1, tooth_pitch=0.010)
    add_picatinny_rail_pc(bm, -0.0205, 0.016, -0.190, -0.376, direction="-X", mat_idx=1, tooth_pitch=0.010)

    # Ribbed FDE Tactical Polymer Rail Panels (left & right) + Stubby Tango/KAC Vertical Foregrip!
    for sx in (-1.0, 1.0):
        add_box_pc(bm, (sx * 0.0258, 0.016, -0.275), (0.0028, 0.0125, 0.064), bevel=0.0024, bevel_segs=2, mat_idx=3)
        for rib in range(10):
            z = -0.329 + rib * 0.012
            add_box_pc(bm, (sx * 0.0285, 0.016, z), (0.0011, 0.0095, 0.0025), bevel=0.0007, mat_idx=3)
    add_box_pc(bm, (0.0, -0.016, -0.272), (0.0145, 0.0065, 0.018), bevel=0.0022, bevel_segs=2, mat_idx=2)  # Foregrip rail clamp
    add_cylinder_axis_pc(bm, (0.0, -0.018, -0.272), (0.0, -0.088, -0.272), 0.0148, 0.0135, sides=24, mat_idx=2)
    add_cylinder_axis_pc(bm, (0.0, -0.088, -0.272), (0.0, -0.095, -0.272), 0.0155, 0.0142, sides=24, mat_idx=3)

    # AN/PEQ-15 FDE Tactical Laser/IR Aiming Module on Forward Top Rail (`z = -0.318`)!
    add_box_pc(bm, (0.0, 0.051, -0.318), (0.024, 0.0085, 0.038), bevel=0.0032, bevel_segs=2, mat_idx=3)
    add_cylinder_z_pc(bm, -0.012, 0.052, -0.354, -0.364, 0.0055, 0.0052, sides=16, mat_idx=1)  # IR illuminator bezel
    add_cylinder_z_pc(bm, 0.012, 0.052, -0.354, -0.362, 0.0042, 0.0040, sides=14, mat_idx=4)   # Coated laser emitter lens
    add_cylinder_axis_pc(bm, (0.0, 0.059, -0.312), (0.0, 0.064, -0.312), 0.0068, sides=14, mat_idx=2)  # Mode dial

    # 14.5" M4 Government Step-Cut Barrel + Gas Tube + Open A-Frame Front Sight Base + A2 Birdcage Flash Hider!
    # Stainless steel direct-impingement gas tube visible through upper handguard vents into FSB!
    add_cylinder_z_pc(bm, 0.0, 0.032, -0.168, -0.402, 0.0026, 0.0026, sides=12, mat_idx=8)
    add_hollow_barrel_z_pc(
        bm, 0.0, 0.016,
        [
            (-0.180, 0.0112),
            (-0.395, 0.0102),
            (-0.435, 0.0102),
            (-0.468, 0.0098),
            (-0.471, 0.0076),  # Iconic M4 M203 grenade-launcher barrel step-cut!
            (-0.502, 0.0076),
            (-0.505, 0.0096),
            (-0.562, 0.0094),
        ],
        bore_radius=0.0036,
        bore_depth=0.042,
        sides=28,
        outer_mat_idx=0,
        bore_mat_idx=7,
    )
    add_slotted_flash_hider_z_pc(
        bm, x_pc=0.0, y_pc=0.016, z_base=-0.560, z_tip=-0.608,
        outer_r=0.0112, bore_r=0.0038, num_prongs=5, outer_mat_idx=0, bore_mat_idx=7,
    )
    # Authentic Open A-Frame Front Sight Base (`z = -0.415`): rear angled strut + front vertical strut + sight post + bayonet lug!
    add_cylinder_z_pc(bm, 0.0, 0.016, -0.396, -0.436, 0.0124, 0.0122, sides=20, mat_idx=0)
    add_box_pc(bm, (0.0, 0.044, -0.405), (0.0045, 0.024, 0.0055), bevel=0.0012, mat_idx=0, pitch_deg=-24.0)  # Rear A-strut
    add_box_pc(bm, (0.0, 0.044, -0.428), (0.0045, 0.024, 0.0048), bevel=0.0012, mat_idx=0, pitch_deg=4.0)    # Front A-strut
    add_box_pc(bm, (0.0, 0.064, -0.418), (0.0072, 0.0045, 0.014), bevel=0.001, mat_idx=0)
    for sx in (-1.0, 1.0):
        add_box_pc(bm, (sx * 0.0058, 0.071, -0.422), (0.0014, 0.0065, 0.006), bevel=0.0005, mat_idx=0, roll_deg=sx * -8.0)
    add_cylinder_axis_pc(bm, (0.0, 0.065, -0.422), (0.0, 0.074, -0.422), 0.0012, sides=10, mat_idx=0)  # Front sight post!
    add_box_pc(bm, (0.0, -0.001, -0.426), (0.0055, 0.0055, 0.009), bevel=0.001, mat_idx=0)             # Bayonet lug

    # EOTech EXPS3 Holographic Weapon Sight (`z = -0.058`) with Rounded Protective Hood, Battery Tube & Glowing Reticle!
    add_box_pc(bm, (0.0, 0.048, -0.058), (0.0185, 0.0055, 0.046), bevel=0.0020, bevel_segs=2, mat_idx=1)  # QD rail base
    # EXPS-style side controls and quick-detach lever below the hood.
    add_box_pc(bm, (-0.018, 0.058, -0.033), (0.0034, 0.005, 0.016), bevel=0.0012, mat_idx=1)
    for z in (-0.023, -0.033, -0.043):
        add_box_pc(bm, (-0.0215, 0.058, z), (0.001, 0.0024, 0.003), bevel=0.0006, mat_idx=2)
    add_box_pc(bm, (0.019, 0.048, -0.069), (0.0038, 0.0025, 0.014), bevel=0.0012, mat_idx=1)
    add_cylinder_axis_pc(bm, (0.012, 0.054, -0.092), (0.023, 0.054, -0.092), 0.0082, sides=18, mat_idx=3)  # Transverse CR123 battery cap
    # Open protective aluminum hood: left wall, right wall, arched roof (hollow sight window!)
    for sx in (-1.0, 1.0):
        add_box_pc(bm, (sx * 0.0175, 0.068, -0.052), (0.0025, 0.016, 0.036), bevel=0.0018, bevel_segs=2, mat_idx=3)
    add_box_pc(bm, (0.0, 0.083, -0.052), (0.0195, 0.0032, 0.036), bevel=0.0022, bevel_segs=2, mat_idx=3)
    # Multi-coated holographic combiner glass + glowing crimson EOTech 68-MOA ring & 1-MOA center dot!
    add_box_pc(bm, (0.0, 0.067, -0.052), (0.0145, 0.0125, 0.0018), bevel=0.0004, mat_idx=4)
    add_torus_pc(bm, (0.0, 0.067, -0.0495), axis="Z", major_r=0.0052, minor_r=0.0006, major_segs=20, minor_segs=8, mat_idx=5)
    add_uv_sphere_pc(bm, (0.0, 0.067, -0.0495), (0.0011, 0.0011, 0.0006), segments=10, rings=8, mat_idx=5)

    finalize_weapon_part(
        "M4A1_ReceiverRailBarrelOptic", bm,
        [
            mats["parkerized_steel"], mats["anodized_black"], mats["polymer_grip"], mats["polymer_fde"],
            mats["optic_glass"], mats["holo_reticle"], mats["rubber_pad"], mats["dark_bore"], mats["bolt_steel"],
        ],
        arm, "Bone_Root", col, angle_deg=38.0,
    )

    # Authentic Curved 30-Round STANAG Aluminum/Steel Magazine + Curved Stamped Ribs + 5.56mm Brass Round (`Bone_Mag`)!
    # Circular STANAG arc (`R = 0.285m`, sweeping forward from 4 deg at magwell lip to 31 deg at floorplate!)
    bm = bmesh.new()
    mag_R = 0.285
    th_start = math.radians(5.0)
    th_end = math.radians(32.0)

    def _stanag_pt(frac: float) -> Tuple[float, float]:
        th = th_start + (th_end - th_start) * frac
        my = -0.032 - mag_R * (math.sin(th) - math.sin(th_start))
        mz = -0.099 - mag_R * (math.cos(th_start) - math.cos(th))
        return (my, mz)

    mag_curve = [(0.0, -0.016, -0.098, 0.0114, 0.0114, 0.0305, 0.26)]
    for m_i in range(8):
        my, mz = _stanag_pt(m_i / 7.0)
        mag_curve.append((0.0, my, mz, 0.0116, 0.0116, 0.0308, 0.28))
    add_swept_loft_yz_pc(bm, mag_curve, mat_idx=0, corner_segs=2)

    # Flared FDE Magpul ranger floorplate continuing along the 32-deg bottom STANAG tangent!
    fy0, fz0 = _stanag_pt(0.98)
    fy1, fz1 = _stanag_pt(1.06)
    add_swept_loft_yz_pc(
        bm,
        [
            (0.0, fy0, fz0, 0.0134, 0.0134, 0.0335, 0.30),
            (0.0, fy1, fz1, 0.0126, 0.0126, 0.0325, 0.34),
        ],
        mat_idx=1,
        corner_segs=2,
        cap_bevel_start=0.0018,
        cap_bevel_end=0.0028,
    )
    # 3 Curved longitudinal STANAG side stiffening ribs following the exact magazine arc!
    for rib_z_off in (-0.0145, 0.0, 0.0145):
        rib_pts = []
        for r_i in range(6):
            ry, rz = _stanag_pt(0.08 + 0.84 * (r_i / 5.0))
            rib_pts.append((0.0, ry, rz + rib_z_off, 0.0126, 0.0126, 0.0024, 0.32))
        add_swept_loft_yz_pc(bm, rib_pts, mat_idx=0, corner_segs=1)
    # Visible 5.56x45mm NATO brass cartridge + copper FMJ bullet in feed lips
    add_lathe_z_pc(bm, 0.0, -0.019, [(-0.072, 0.0048), (-0.104, 0.0046), (-0.110, 0.0031)], sides=14, mat_idx=2)
    add_lathe_z_pc(bm, 0.0, -0.019, [(-0.110, 0.0030), (-0.122, 0.0009)], sides=14, mat_idx=3)
    finalize_weapon_part(
        "M4A1_STANAG_Mag30", bm,
        [mats["parkerized_steel"], mats["polymer_fde"], mats["brass_gold"], mats["copper_jacket"]],
        arm, "Bone_Mag", col,
    )

    # AR-15 Bolt Carrier Group (`Bone_Bolt`) with Forward-Assist Serrations + T-Charging Handle (`Bone_ChargingHandle`)
    bm = bmesh.new()
    add_cylinder_z_pc(bm, 0.009, 0.018, -0.032, -0.114, 0.0098, 0.0098, sides=20, mat_idx=0)
    for ser_i in range(5):
        add_box_pc(bm, (0.018, 0.015, -0.042 - ser_i * 0.005), (0.0015, 0.0035, 0.0014), bevel=0.0004, mat_idx=1)
    finalize_weapon_part(
        "M4A1_BoltCarrier", bm, [mats["bolt_steel"], mats["parkerized_steel"]], arm, "Bone_Bolt", col
    )

    bm = bmesh.new()
    add_box_pc(bm, (0.0, 0.035, 0.050), (0.0235, 0.0048, 0.0075), bevel=0.0018, mat_idx=0)
    add_box_pc(bm, (-0.018, 0.035, 0.055), (0.0065, 0.0052, 0.0045), bevel=0.001, mat_idx=1)  # Extended tactical latch
    add_box_pc(bm, (0.0, 0.035, 0.006), (0.0048, 0.0036, 0.042), bevel=0.001, mat_idx=0)
    finalize_weapon_part(
        "M4A1_ChargingHandle", bm, [mats["anodized_black"], mats["parkerized_steel"]], arm, "Bone_ChargingHandle", col
    )

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
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, 0.007, 0.034), (3.2, -0.4, 0.8))
    set_weapon_bone_pose_pc(arm, "Bone_Bolt", (0.0, 0.0, 0.056))
    keyframe_weapon_bones(arm, 2)
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, 0.002, 0.008), (0.9, 0.0, 0.0))
    keyframe_weapon_bones(arm, 5)
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 9)
    push_weapon_nla(arm, act, "FireCycle")

    act = bpy.data.actions.new("ReloadMag")
    arm.animation_data.action = act
    reset_weapon_pose(arm)
    keyframe_weapon_bones(arm, 1)
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (-0.018, 0.018, 0.015), (7.0, 10.0, 22.0))
    set_weapon_bone_pose_pc(arm, "Bone_Bolt", (0.0, 0.0, 0.048))
    set_weapon_bone_pose_pc(arm, "Bone_Mag", (0.0, -0.24, -0.02))
    keyframe_weapon_bones(arm, 7)
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (-0.014, 0.026, 0.010), (8.5, 8.0, 18.0))
    set_weapon_bone_pose_pc(arm, "Bone_Bolt", (0.0, 0.0, 0.048))
    set_weapon_bone_pose_pc(arm, "Bone_Mag", (0.0, 0.0, 0.0))
    keyframe_weapon_bones(arm, 15)
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_Root", (0.0, 0.008, 0.024), (3.0, 0.0, 4.0))
    keyframe_weapon_bones(arm, 20)
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

    # Olive-drab spherical body with a subtle equatorial seam.
    bm = bmesh.new()
    add_uv_sphere_pc(bm, (0.0, 0.0, 0.0), (0.0332, 0.0338, 0.0332), segments=32, rings=24, mat_idx=0)
    add_torus_pc(bm, (0.0, 0.0, 0.0), axis="Y", major_r=0.0330, minor_r=0.00055, major_segs=32, minor_segs=8, mat_idx=0)
    # Threaded Hexagonal M213 Zinc Fuze Collar + Stamped Striker Housing & Pin Boss Ears (`+Y` top)
    add_cylinder_axis_pc(bm, (0.0, 0.030, 0.0), (0.0, 0.040, 0.0), 0.0115, 0.0115, sides=6, mat_idx=1)
    add_cylinder_axis_pc(bm, (0.0, 0.040, 0.0), (0.0, 0.049, 0.0), 0.0098, 0.0095, sides=20, mat_idx=1)
    add_box_pc(bm, (0.0, 0.051, -0.002), (0.0125, 0.0065, 0.0145), bevel=0.0020, mat_idx=1)
    for sx in (-1.0, 1.0):
        add_box_pc(bm, (sx * 0.0115, 0.046, -0.006), (0.0022, 0.0055, 0.0065), bevel=0.0008, mat_idx=1)
    add_cylinder_axis_pc(bm, (-0.0145, 0.049, -0.011), (0.0145, 0.049, -0.011), 0.0022, sides=12, mat_idx=2)  # Striker hinge pin

    finalize_weapon_part(
        "M67_GrenadeBody", bm,
        [mats["olive_drab"], mats["fuze_zinc"], mats["parkerized_steel"]],
        arm, "Bone_Body", col, angle_deg=42.0, uv_mode="m67_body",
    )

    # Contoured Stamped Sheet-Metal Safety Spoon Lever (`Bone_Spoon`) hugging sphere curvature!
    bm = bmesh.new()
    # Top striker cap hood + twin hinge hook ears
    add_box_pc(bm, (0.0, 0.056, 0.004), (0.0102, 0.0026, 0.0165), bevel=0.0012, mat_idx=0, pitch_deg=6.0)
    for sx in (-1.0, 1.0):
        add_box_pc(bm, (sx * 0.0095, 0.051, -0.009), (0.0018, 0.0052, 0.0055), bevel=0.0006, mat_idx=0)
    # Curved U-channel ergonomic spoon spine sweeping down the grenade shoulder with flared bottom finger flip!
    add_swept_loft_yz_pc(
        bm,
        [
            (0.0, 0.055, 0.016, 0.0094, 0.0082, 0.0022, 0.24),
            (0.0, 0.042, 0.029, 0.0090, 0.0078, 0.0022, 0.24),
            (0.0, 0.018, 0.037, 0.0085, 0.0074, 0.0022, 0.24),
            (0.0, -0.006, 0.036, 0.0080, 0.0070, 0.0021, 0.24),
            (0.0, -0.021, 0.039, 0.0084, 0.0074, 0.0020, 0.28),  # Characteristic outward bottom lip!
        ],
        mat_idx=0,
    )
    finalize_weapon_part(
        "M67_SpoonLever", bm, [mats["olive_drab"]], arm, "Bone_Spoon", col,
        angle_deg=40.0, uv_mode="m67_olive_only",
    )

    # Smooth 24-Segment Toroidal Steel Pull Ring + Twin-Prong Split Cotter Pin (`Bone_PinRing`)!
    bm = bmesh.new()
    # Twin split-pin wire prongs passing through fuze ears with flared retaining bend on +X!
    add_cylinder_axis_pc(bm, (-0.018, 0.0465, -0.005), (0.016, 0.0465, -0.005), 0.0013, sides=12, mat_idx=0)
    add_cylinder_axis_pc(bm, (-0.018, 0.0448, -0.005), (0.015, 0.0448, -0.005), 0.0013, sides=12, mat_idx=0)
    add_cylinder_axis_pc(bm, (0.015, 0.0465, -0.005), (0.019, 0.0495, -0.003), 0.0012, sides=10, mat_idx=0)
    add_cylinder_axis_pc(bm, (0.014, 0.0448, -0.005), (0.018, 0.0415, -0.007), 0.0012, sides=10, mat_idx=0)
    add_torus_pc(bm, (-0.018, 0.0456, -0.005), axis="Z", major_r=0.0026, minor_r=0.0012, major_segs=14, minor_segs=8, mat_idx=0)
    # Genuine smooth 24-segment round steel pull-ring hanging cleanly outside grenade shoulder!
    add_torus_pc(
        bm, (-0.0285, 0.0415, -0.005), axis="X", major_r=0.0138, minor_r=0.0018,
        major_segs=24, minor_segs=12, mat_idx=1, tilt_deg=24.0,
    )
    finalize_weapon_part(
        "M67_PullPinRing", bm, [mats["fuze_zinc"], mats["bolt_steel"]], arm, "Bone_PinRing", col, angle_deg=45.0
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
    reset_weapon_pose(arm)
    set_weapon_bone_pose_pc(arm, "Bone_PinRing", (-0.065, -0.015, 0.02), (0.0, 0.0, 35.0))
    keyframe_weapon_bones(arm, 6)
    set_weapon_bone_pose_pc(arm, "Bone_PinRing", (-0.12, -0.06, 0.04), (0.0, 0.0, 65.0))
    arm.pose.bones["Bone_PinRing"].scale = (0.001,) * 3
    keyframe_weapon_bones(arm, 9)
    set_weapon_bone_pose_pc(arm, "Bone_Spoon", (0.02, 0.08, 0.06), (-115.0, 20.0, 0.0))
    keyframe_weapon_bones(arm, 14)
    set_weapon_bone_pose_pc(arm, "Bone_Spoon", (0.04, 0.13, 0.11), (-150.0, 20.0, 0.0))
    arm.pose.bones["Bone_Spoon"].scale = (0.001,) * 3
    keyframe_weapon_bones(arm, 17)
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
    bpy.context.preferences.filepaths.save_version = 0
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
