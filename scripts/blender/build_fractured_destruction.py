#!/usr/bin/env python3
"""
Procedural Blender 5.2.1 LTS Pipeline — AAA PBR 3D Voronoi Cell-Fractured Concrete Barrier & Debris Pack.

Generates:
  - public/models/concrete_wall_fractured.glb   (`IntactConcreteWall` + `Chunk_00` .. `Chunk_35`)
  - public/models/concrete_wall_connectivity.json (`ChunkConnectivityGraphJson`, version: 1)
  - public/models/debris_pack.glb               (`Brick_0..2` + `Splinter_0..2`)
  - public/models/blend_sources/concrete_wall_fractured.blend

Coordinate & Instancing Convention:
  - PlayCanvas / glTF 2.0 (+Y Up):
      Concrete wall spans X in [-1.80, +1.80] (3.60m), Y in [0.00, +2.40] (2.40m), Z in [-0.14, +0.14] (0.28m).
  - Every `Chunk_00..35`, `Brick_0..2`, and `Splinter_0..2` exports as a SINGLE watertight manifold
    glTF primitive (`Primitives created: 1`) with baked `COLOR_0` vertex colors multiplied with procedural
    PBR Albedo + Tangent-Space Normal + Metallic/Roughness maps so `HardwareInstancedPool` renders 100% of
    each chunk/debris mesh in a single instanced draw call and Rapier3D receives the complete convex hull!
"""

import json
import math
import os
import random
from typing import Dict, List, Sequence, Tuple

import bmesh
import bpy
import numpy as np
from mathutils import Vector


REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_DIR = os.path.join(REPO_ROOT, "public", "models")
OUT_WALL_GLB = os.path.join(OUT_DIR, "concrete_wall_fractured.glb")
OUT_CONN_JSON = os.path.join(OUT_DIR, "concrete_wall_connectivity.json")
OUT_DEBRIS_GLB = os.path.join(OUT_DIR, "debris_pack.glb")
OUT_BLEND = os.path.join(OUT_DIR, "blend_sources", "concrete_wall_fractured.blend")

WALL_WIDTH_X = 3.60
WALL_HEIGHT_Y = 2.40
WALL_THICK_Z = 0.28
CONCRETE_DENSITY_KG_M3 = 2400.0
FRACTURE_BOND_J_PER_M2 = 8500.0


def pc_to_bl(x: float, y: float, z: float) -> Vector:
    return Vector((x, -z, y))


def bl_to_pc(v: Vector) -> Tuple[float, float, float]:
    return (v.x, v.z, -v.y)


# ---------------------------------------------------------------------------
# Vectorized Procedural PBR Texture Synthesis (Albedo + Normal + ORM)
# ---------------------------------------------------------------------------

def _hash_grid(ix: np.ndarray, iy: np.ndarray, seed: int) -> np.ndarray:
    n = (ix.astype(np.int64) * 374761393 + iy.astype(np.int64) * 668265263 + seed * 1442695041) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((n ^ (n >> 16)) & 0xFFFF).astype(np.float32) / 65535.0


def tileable_value_noise(size: int, freq_x: int, freq_y: int, seed: int) -> np.ndarray:
    """Seamless periodic 2D value noise over [0, 1)^2 with smoothstep interpolation."""
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
        acc += amp * tileable_value_noise(size, fx, fy, seed + o * 97)
        norm += amp
        amp *= gain
        fx = min(size // 2, fx * 2)
        fy = min(size // 2, fy * 2)
    return acc / max(norm, 1e-6)


def height_to_normal_rgb(height: np.ndarray, strength: float) -> np.ndarray:
    """Convert scalar heightfield [H, W] (row 0 = v=0 bottom) into OpenGL (+X, +Y, +Z) tangent normal RGB."""
    dh_du = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 0.5 * strength
    dh_dv = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * 0.5 * strength
    nx = -dh_du
    ny = -dh_dv
    nz = np.ones_like(height)
    inv_len = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz)
    rgb = np.stack(
        [
            (nx * inv_len) * 0.5 + 0.5,
            (ny * inv_len) * 0.5 + 0.5,
            (nz * inv_len) * 0.5 + 0.5,
        ],
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


def build_concrete_pbr_maps(size: int = 512) -> Tuple[bpy.types.Image, bpy.types.Image, bpy.types.Image]:
    """
    2-zone vertical atlas in a single PBR texture set (`primitives.length === 1`!):
      - Bottom half `v in [0.0, 0.5)`: Architectural bunker formwork concrete (horizontal board seams,
        recessed circular form-tie cone holes, subtle vertical rain streaks, fine sand pores).
      - Top half `v in [0.5, 1.0]`: Coarse fractured interior concrete aggregate (crushed gravel chunks,
        sharp cleavage facets, exposed dark/light stone speckles, high roughness).
    """
    us = (np.arange(size, dtype=np.float32) + 0.5) / size
    vs = (np.arange(size, dtype=np.float32) + 0.5) / size
    uu, vv = np.meshgrid(us, vs)

    coarse = fbm_periodic(size, 6, 6, 4, seed=401)
    fine = fbm_periodic(size, 24, 24, 3, seed=419)
    micro = tileable_value_noise(size, 96, 96, seed=433)
    pebbles = tileable_value_noise(size, 32, 32, seed=457)

    # --- Exterior Formwork Region (v < 0.5) ---
    v_ext = np.clip(vv * 2.0, 0.0, 1.0)
    # 4 horizontal plywood/plank formwork seams across wall height + 1 vertical panel joint
    plank_phase = (v_ext * 4.0) % 1.0
    h_seam = np.exp(-((plank_phase - 0.5) ** 2) / (2.0 * 0.012 ** 2))
    # Shift seam to panel boundaries (0.25, 0.50, 0.75)
    seam_y = np.zeros_like(vv)
    for sv in (0.25, 0.50, 0.75):
        seam_y = np.maximum(seam_y, np.exp(-((v_ext - sv) ** 2) / (2.0 * 0.0055 ** 2)))
    seam_x = np.exp(-((np.minimum(uu, 1.0 - uu)) ** 2) / (2.0 * 0.0045 ** 2))
    form_seams = np.maximum(seam_y, seam_x * 0.85)

    # Recessed circular form-tie cone holes (2 columns x 3 rows per 1.2m panel)
    tie_holes = np.zeros_like(vv)
    tie_rims = np.zeros_like(vv)
    for tu in (0.25, 0.75):
        for tv in (0.14, 0.50, 0.86):
            du = (uu - tu) * 1.20
            dv = (v_ext - tv) * 2.40
            r = np.sqrt(du * du + dv * dv)
            cone = np.clip(1.0 - r / 0.028, 0.0, 1.0)
            tie_holes = np.maximum(tie_holes, cone ** 1.5)
            rim = np.exp(-((r - 0.031) ** 2) / (2.0 * 0.005 ** 2))
            tie_rims = np.maximum(tie_rims, rim)

    # Subtle vertical rain-drip staining from top edge & tie-holes + hairline crack
    rain_streak = tileable_value_noise(size, 32, 4, seed=479)
    top_stain = np.clip((v_ext - 0.72) / 0.28, 0.0, 1.0) * (0.5 + 0.5 * rain_streak)
    bot_grime = np.clip((0.22 - v_ext) / 0.22, 0.0, 1.0) * (0.55 + 0.45 * coarse)

    # Wood-grain faint imprint from formwork boards
    board_grain = (tileable_value_noise(size, 8, 64, seed=491) - 0.5) * 0.06

    ext_height = (
        0.52
        + (coarse - 0.5) * 0.16
        + (fine - 0.5) * 0.12
        + (micro - 0.5) * 0.08
        + board_grain
        - form_seams * 0.30
        - tie_holes * 0.58
        + tie_rims * 0.07
    )
    # Pitted air-void bug holes on concrete surface
    pits = np.clip((micro - 0.83) / 0.17, 0.0, 1.0)
    ext_height -= pits * 0.16

    ext_base = (
        0.67
        + (coarse - 0.5) * 0.08
        + (fine - 0.5) * 0.06
        + (micro - 0.5) * 0.04
        - form_seams * 0.10
        - tie_holes * 0.24
        - pits * 0.07
        - top_stain * 0.06
        - bot_grime * 0.10
    )
    ext_albedo = np.stack(
        [
            ext_base * 1.01,
            ext_base * 1.015,
            ext_base * 0.98 - bot_grime * 0.02,
        ],
        axis=-1,
    )
    ext_ao = np.clip(1.0 - form_seams * 0.28 - tie_holes * 0.55 - pits * 0.22, 0.35, 1.0)
    ext_rough = np.clip(0.84 + (fine - 0.5) * 0.12 + tie_holes * 0.10 + bot_grime * 0.06, 0.68, 0.98)

    # --- Interior Fractured Aggregate Region (v >= 0.5) ---
    # Cellular/crystalline sharp gravel relief via ridged FBM + pebble cells
    ridge1 = 1.0 - np.abs(tileable_value_noise(size, 14, 14, seed=509) * 2.0 - 1.0)
    ridge2 = 1.0 - np.abs(tileable_value_noise(size, 28, 28, seed=523) * 2.0 - 1.0)
    gravel_cells = np.clip((pebbles - 0.52) * 2.4, -0.4, 0.6)
    int_height = (
        0.50
        + (ridge1 - 0.5) * 0.45
        + (ridge2 - 0.5) * 0.28
        + gravel_cells * 0.26
        + (micro - 0.5) * 0.18
    )
    # Exposed dark basalt & light quartz aggregate flecks
    quartz_fleck = np.clip((micro - 0.78) * 4.0, 0.0, 1.0)
    basalt_fleck = np.clip((0.24 - pebbles) * 3.5, 0.0, 1.0)
    int_base = (
        0.64
        + (ridge1 - 0.5) * 0.14
        + (fine - 0.5) * 0.12
        + quartz_fleck * 0.16
        - basalt_fleck * 0.18
    )
    int_albedo = np.stack(
        [
            int_base * 0.99,
            int_base * 1.00,
            int_base * 0.97 + basalt_fleck * 0.02,
        ],
        axis=-1,
    )
    int_ao = np.clip(0.86 + (ridge1 - 0.5) * 0.24 - basalt_fleck * 0.12, 0.48, 1.0)
    int_rough = np.clip(0.90 + (ridge2 - 0.5) * 0.10 - quartz_fleck * 0.12, 0.72, 0.99)

    is_int = (vv >= 0.5)
    height = np.where(is_int, int_height, ext_height)
    albedo = np.where(is_int[:, :, None], int_albedo, ext_albedo)
    ao = np.where(is_int, int_ao, ext_ao)
    rough = np.where(is_int, int_rough, ext_rough)
    metal = np.where(is_int, quartz_fleck * 0.06, np.zeros_like(ao))

    nrm_ext = height_to_normal_rgb(ext_height, strength=4.8)
    nrm_int = height_to_normal_rgb(int_height, strength=8.0)
    normal_rgb = np.where(is_int[:, :, None], nrm_int, nrm_ext)
    orm_rgb = np.stack([ao, rough, metal], axis=-1)

    return (
        create_packed_image("Tex_Concrete_Albedo", albedo, non_color=False),
        create_packed_image("Tex_Concrete_Normal", normal_rgb, non_color=True),
        create_packed_image("Tex_Concrete_ORM", orm_rgb, non_color=True),
    )


def build_brick_pbr_maps(size: int = 256) -> Tuple[bpy.types.Image, bpy.types.Image, bpy.types.Image]:
    """Kiln-fired porous terracotta clay masonry brick with wire-cut striations & mortar dust."""
    coarse = fbm_periodic(size, 6, 6, 3, seed=601)
    fine = fbm_periodic(size, 20, 20, 3, seed=617)
    micro = tileable_value_noise(size, 64, 64, seed=631)
    wire_drag = tileable_value_noise(size, 48, 6, seed=647)

    pits = np.clip((micro - 0.74) / 0.26, 0.0, 1.0)
    mortar_speck = np.clip((coarse * fine - 0.42) * 3.2, 0.0, 1.0)
    char_flash = np.clip((0.28 - coarse) * 2.8, 0.0, 1.0)

    height = (
        0.55
        + (coarse - 0.5) * 0.24
        + (fine - 0.5) * 0.20
        + (wire_drag - 0.5) * 0.14
        - pits * 0.36
        + mortar_speck * 0.08
    )

    r = 0.66 + (coarse - 0.5) * 0.14 + (fine - 0.5) * 0.08 - char_flash * 0.20
    g = 0.27 + (coarse - 0.5) * 0.08 + (fine - 0.5) * 0.05 - char_flash * 0.09
    b = 0.18 + (coarse - 0.5) * 0.06 + (fine - 0.5) * 0.04 - char_flash * 0.05
    # Blend dusty lime mortar flecks
    r = r * (1.0 - mortar_speck * 0.55) + 0.78 * (mortar_speck * 0.55)
    g = g * (1.0 - mortar_speck * 0.55) + 0.76 * (mortar_speck * 0.55)
    b = b * (1.0 - mortar_speck * 0.55) + 0.72 * (mortar_speck * 0.55)

    albedo = np.stack([r, g, b], axis=-1) * (1.0 - pits[:, :, None] * 0.18)
    normal_rgb = height_to_normal_rgb(height, strength=10.5)
    ao = np.clip(1.0 - pits * 0.38, 0.45, 1.0)
    rough = np.clip(0.84 + (fine - 0.5) * 0.12 + pits * 0.08 + mortar_speck * 0.06, 0.70, 0.98)
    orm_rgb = np.stack([ao, rough, np.zeros_like(ao)], axis=-1)

    return (
        create_packed_image("Tex_Brick_Albedo", albedo, non_color=False),
        create_packed_image("Tex_Brick_Normal", normal_rgb, non_color=True),
        create_packed_image("Tex_Brick_ORM", orm_rgb, non_color=True),
    )


def build_wood_pbr_maps(size: int = 256) -> Tuple[bpy.types.Image, bpy.types.Image, bpy.types.Image]:
    """Anisotropic fibrous structural pine/fir timber grain aligned along U (splinter length X)."""
    us = (np.arange(size, dtype=np.float32) + 0.5) / size
    vs = (np.arange(size, dtype=np.float32) + 0.5) / size
    uu, vv = np.meshgrid(us, vs)

    # Long fibrous streaks stretched along U (low freq in U, high freq in V)
    fibers_fine = tileable_value_noise(size, 6, 72, seed=701)
    fibers_med = tileable_value_noise(size, 4, 28, seed=719)
    wobble = fbm_periodic(size, 4, 8, 3, seed=733)

    # Cathedral / annual growth rings along V modulated by wobble
    ring_phase = (vv * 7.0 + wobble * 1.8) % 1.0
    latewood = np.clip(1.0 - np.abs(ring_phase - 0.72) * 5.5, 0.0, 1.0) ** 1.4
    splinter_grooves = 1.0 - np.abs(fibers_fine * 2.0 - 1.0)

    height = (
        0.52
        + (fibers_med - 0.5) * 0.25
        + (splinter_grooves - 0.5) * 0.28
        - latewood * 0.12
    )

    # Warm sapwood/heartwood amber tones darkened along dense latewood rings
    r = 0.78 - latewood * 0.22 + (fibers_fine - 0.5) * 0.08 + (wobble - 0.5) * 0.06
    g = 0.60 - latewood * 0.21 + (fibers_fine - 0.5) * 0.07 + (wobble - 0.5) * 0.05
    b = 0.37 - latewood * 0.15 + (fibers_fine - 0.5) * 0.05 + (wobble - 0.5) * 0.04
    albedo = np.stack([r, g, b], axis=-1)

    normal_rgb = height_to_normal_rgb(height, strength=9.0)
    ao = np.clip(0.92 - (1.0 - splinter_grooves) * 0.18, 0.60, 1.0)
    rough = np.clip(0.76 - latewood * 0.10 + (fibers_fine - 0.5) * 0.12, 0.58, 0.92)
    orm_rgb = np.stack([ao, rough, np.zeros_like(ao)], axis=-1)

    return (
        create_packed_image("Tex_Wood_Albedo", albedo, non_color=False),
        create_packed_image("Tex_Wood_Normal", normal_rgb, non_color=True),
        create_packed_image("Tex_Wood_ORM", orm_rgb, non_color=True),
    )


# ---------------------------------------------------------------------------
# PBR Materials with Vertex-Color Multiplication (1 Primitive per Instanced Mesh!)
# ---------------------------------------------------------------------------

def make_vcol_pbr_material(
    name: str,
    albedo_img: bpy.types.Image,
    normal_img: bpy.types.Image,
    orm_img: bpy.types.Image,
    normal_strength: float = 1.0,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name=name)
    if mat.node_tree is None:
        mat.use_nodes = True
    nt = mat.node_tree
    nodes = nt.nodes
    links = nt.links

    bsdf = nodes.get("Principled BSDF") or nodes.new(type="ShaderNodeBsdfPrincipled")

    tex_alb = nodes.new(type="ShaderNodeTexImage")
    tex_alb.image = albedo_img
    tex_alb.interpolation = "Linear"

    vcol_node = nodes.new(type="ShaderNodeVertexColor")
    vcol_node.layer_name = "Col"

    mix_node = nodes.new(type="ShaderNodeMixRGB")
    mix_node.blend_type = "MULTIPLY"
    mix_node.inputs["Fac"].default_value = 1.0
    links.new(tex_alb.outputs["Color"], mix_node.inputs["Color1"])
    links.new(vcol_node.outputs["Color"], mix_node.inputs["Color2"])
    links.new(mix_node.outputs["Color"], bsdf.inputs["Base Color"])

    tex_orm = nodes.new(type="ShaderNodeTexImage")
    tex_orm.image = orm_img
    tex_orm.interpolation = "Linear"
    sep_orm = nodes.new(type="ShaderNodeSeparateColor")
    links.new(tex_orm.outputs["Color"], sep_orm.inputs["Color"])
    links.new(sep_orm.outputs["Green"], bsdf.inputs["Roughness"])
    links.new(sep_orm.outputs["Blue"], bsdf.inputs["Metallic"])

    tex_nrm = nodes.new(type="ShaderNodeTexImage")
    tex_nrm.image = normal_img
    tex_nrm.interpolation = "Linear"
    nrm_node = nodes.new(type="ShaderNodeNormalMap")
    nrm_node.inputs["Strength"].default_value = normal_strength
    links.new(tex_nrm.outputs["Color"], nrm_node.inputs["Color"])
    links.new(nrm_node.outputs["Normal"], bsdf.inputs["Normal"])

    return mat


def build_materials() -> Dict[str, bpy.types.Material]:
    c_alb, c_nrm, c_orm = build_concrete_pbr_maps(size=512)
    b_alb, b_nrm, b_orm = build_brick_pbr_maps(size=256)
    w_alb, w_nrm, w_orm = build_wood_pbr_maps(size=256)
    return {
        "concrete": make_vcol_pbr_material("Mat_ReinforcedConcrete", c_alb, c_nrm, c_orm, normal_strength=0.85),
        "brick": make_vcol_pbr_material("Mat_MasonryBrick", b_alb, b_nrm, b_orm, normal_strength=0.82),
        "wood": make_vcol_pbr_material("Mat_WoodSplinter", w_alb, w_nrm, w_orm, normal_strength=0.78),
    }


def _fold_band(val: float, lo: float, hi: float) -> float:
    """Triangle-wave fold into [lo, hi] so UVs remain continuous and never cross atlas boundaries."""
    span = hi - lo
    t = ((val % (2.0 * span)) + 2.0 * span) % (2.0 * span)
    if t > span:
        t = 2.0 * span - t
    return lo + t


def assign_concrete_atlas_uvs(bm: bmesh.types.BMesh, nbr_layer=None) -> None:
    """
    Map exterior faces into `v in [0.03, 0.47]` (seamless wall-aligned formwork & tie-holes)
    and interior Voronoi fracture faces into `v in [0.55, 0.95]` using each face's true
    orthonormal tangent plane `(t_u, t_v)` so angled Voronoi cleavage planes never stretch!
    """
    uv_layer = bm.loops.layers.uv.verify()
    panel_w = 1.20  # 3 panels across 3.60m wall width
    for face in bm.faces:
        is_interior = nbr_layer is not None and face[nbr_layer] >= 0
        n = face.normal
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        ref = Vector((0.0, 0.0, 1.0)) if az < 0.88 else Vector((1.0, 0.0, 0.0))
        t_u = ref.cross(n).normalized()
        t_v = n.cross(t_u).normalized()
        for loop in face.loops:
            pc_x, pc_y, pc_z = bl_to_pc(loop.vert.co)
            if not is_interior:
                # Exterior wall faces: align across full 3.60m x 2.40m barrier!
                if ay >= ax and ay >= az:
                    # Front/back main wall face (Blender Y = PlayCanvas -Z)
                    u = (pc_x + WALL_WIDTH_X * 0.5) / panel_w
                    v = 0.03 + max(0.0, min(1.0, pc_y / WALL_HEIGHT_Y)) * 0.44
                elif ax >= ay and ax >= az:
                    # Left/right end caps
                    u = (pc_z + WALL_THICK_Z * 0.5) / panel_w
                    v = 0.03 + max(0.0, min(1.0, pc_y / WALL_HEIGHT_Y)) * 0.44
                else:
                    # Top/bottom horizontal slab faces
                    u = (pc_x + WALL_WIDTH_X * 0.5) / panel_w
                    v = 0.16 + ((pc_z + WALL_THICK_Z * 0.5) / WALL_THICK_Z) * 0.18
            else:
                # Interior Voronoi cleavage planes: distortion-free face-plane tangent projection!
                s = loop.vert.co.dot(t_u) * 1.35
                t = loop.vert.co.dot(t_v) * 1.35
                u = s
                v = _fold_band(t, 0.55, 0.95)
            loop[uv_layer].uv = (u, v)


def assign_triplanar_uvs(bm: bmesh.types.BMesh, scale: float = 4.0) -> None:
    uv_layer = bm.loops.layers.uv.verify()
    for face in bm.faces:
        n = face.normal
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        for loop in face.loops:
            px, py, pz = bl_to_pc(loop.vert.co)
            if az >= ax and az >= ay:
                u, v = px * scale + 0.5, py * scale + 0.5
            elif ax >= ay and ax >= az:
                u, v = pz * scale + 0.5, py * scale + 0.5
            else:
                u, v = px * scale + 0.5, pz * scale + 0.5
            loop[uv_layer].uv = (u, v)


def assign_splinter_uvs(bm: bmesh.types.BMesh, length_scale: float = 3.2, radial_scale: float = 7.0) -> None:
    """Align wood grain U along splinter X axis so fibrous grain grooves follow splinter length."""
    uv_layer = bm.loops.layers.uv.verify()
    for face in bm.faces:
        for loop in face.loops:
            px, py, pz = bl_to_pc(loop.vert.co)
            u = px * length_scale + 0.5
            v = (py + pz) * radial_scale + 0.5
            loop[uv_layer].uv = (u, v)


def set_face_loop_colors(
    bm: bmesh.types.BMesh,
    face_color_fn,
) -> None:
    col_layer = bm.loops.layers.color.get("Col") or bm.loops.layers.color.new("Col")
    for face in bm.faces:
        rgba = face_color_fn(face)
        for loop in face.loops:
            loop[col_layer] = rgba


def finalize_sharp_mesh(bm: bmesh.types.BMesh, name: str, mat: bpy.types.Material, angle_deg: float = 36.0) -> bpy.types.Mesh:
    for f in bm.faces:
        f.smooth = True
    mesh = bpy.data.meshes.new(name=name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.shade_smooth()
    mesh.set_sharp_from_angle(angle=math.radians(angle_deg))
    mesh.materials.append(mat)
    return mesh


# ---------------------------------------------------------------------------
# 1. Intact Concrete Wall + 36-Cell 3D Voronoi Fracture + Connectivity Graph
# ---------------------------------------------------------------------------

def build_intact_wall_object(
    mats: Dict[str, bpy.types.Material],
    collection: bpy.types.Collection,
) -> bpy.types.Object:
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=2.0)
    hx = WALL_WIDTH_X * 0.5
    hy = WALL_HEIGHT_Y * 0.5
    hz = WALL_THICK_Z * 0.5
    for v in bm.verts:
        pc_x = v.co.x * hx
        pc_y = (v.co.z + 1.0) * hy
        pc_z = v.co.y * hz
        v.co = pc_to_bl(pc_x, pc_y, pc_z)

    bmesh.ops.bevel(
        bm, geom=bm.edges[:], offset=0.012, offset_type="OFFSET", segments=2, profile=0.5, affect="EDGES"
    )
    for f in bm.faces:
        f.material_index = 0

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    assign_concrete_atlas_uvs(bm, nbr_layer=None)
    set_face_loop_colors(bm, lambda _f: (0.96, 0.96, 0.95, 1.0))
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])

    mesh = finalize_sharp_mesh(bm, "IntactConcreteWall", mats["concrete"], angle_deg=38.0)
    obj = bpy.data.objects.new(name="IntactConcreteWall", object_data=mesh)
    collection.objects.link(obj)
    return obj


def generate_voronoi_sites_pc(seed: int = 42, cols: int = 6, rows: int = 6) -> List[Tuple[float, float, float]]:
    rng = random.Random(seed)
    sites: List[Tuple[float, float, float]] = []
    dx = WALL_WIDTH_X / cols
    dy = WALL_HEIGHT_Y / rows
    for r in range(rows):
        for c in range(cols):
            jitter_x = rng.uniform(-0.27, 0.27) * dx
            jitter_y = rng.uniform(-0.18, 0.22) * dy if r == 0 else rng.uniform(-0.27, 0.27) * dy
            sx = -WALL_WIDTH_X * 0.5 + (c + 0.5) * dx + jitter_x
            sy = (r + 0.5) * dy + jitter_y
            sz = rng.uniform(-WALL_THICK_Z * 0.24, WALL_THICK_Z * 0.24)
            sites.append((sx, sy, sz))
    return sites


def build_voronoi_fractured_wall(
    mats: Dict[str, bpy.types.Material],
    collection: bpy.types.Collection,
) -> Tuple[List[bpy.types.Object], Dict[str, object]]:
    sites_pc = generate_voronoi_sites_pc(seed=42, cols=6, rows=6)
    sites_bl = [pc_to_bl(*s) for s in sites_pc]
    num_cells = len(sites_bl)

    hx = WALL_WIDTH_X * 0.5
    hy = WALL_HEIGHT_Y * 0.5
    hz = WALL_THICK_Z * 0.5

    raw_contact_area: Dict[Tuple[int, int], float] = {}
    chunk_objs: List[bpy.types.Object] = []
    node_records: List[Dict[str, object]] = []

    for i in range(num_cells):
        si = sites_bl[i]
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=2.0)
        for v in bm.verts:
            pc_x = v.co.x * hx
            pc_y = (v.co.z + 1.0) * hy
            pc_z = v.co.y * hz
            v.co = pc_to_bl(pc_x, pc_y, pc_z)

        nbr_layer = bm.faces.layers.int.new("neighbor_idx")
        for f in bm.faces:
            f[nbr_layer] = -1
            f.material_index = 0

        for j in range(num_cells):
            if i == j:
                continue
            sj = sites_bl[j]
            mid = 0.5 * (si + sj)
            plane_no = (sj - si).normalized()
            ret = bmesh.ops.bisect_plane(
                bm,
                geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
                dist=1e-5,
                plane_co=mid,
                plane_no=plane_no,
                clear_outer=True,
                clear_inner=False,
            )
            cut_edges = [e for e in ret["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
            if cut_edges:
                fill_ret = bmesh.ops.holes_fill(bm, edges=cut_edges, sides=0)
                for nf in fill_ret.get("faces", []):
                    nf[nbr_layer] = j
                    nf.material_index = 0

        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        # Assign UVs while chunks are still in world wall coordinates so exterior formwork aligns!
        assign_concrete_atlas_uvs(bm, nbr_layer=nbr_layer)

        for f in bm.faces:
            nbr = f[nbr_layer]
            if nbr >= 0:
                area = f.calc_area()
                if area > 1e-4:
                    key = (min(i, nbr), max(i, nbr))
                    raw_contact_area[key] = raw_contact_area.get(key, 0.0) + 0.5 * area

        # Bake exterior vs darker aggregate interior fracture face colors before triangulating
        shade_jit = ((i * 37) % 11 - 5) * 0.006
        set_face_loop_colors(
            bm,
            lambda f, sj=shade_jit: (
                (0.56 + sj, 0.57 + sj, 0.55 + sj, 1.0)
                if f[nbr_layer] >= 0
                else (0.96 + sj * 0.5, 0.96 + sj * 0.5, 0.95 + sj * 0.5, 1.0)
            ),
        )

        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])

        volume_m3 = max(1e-4, float(bm.calc_volume()))
        mass_kg = round(volume_m3 * CONCRETE_DENSITY_KG_M3, 2)

        pc_coords = [bl_to_pc(v.co) for v in bm.verts]
        min_x = min(p[0] for p in pc_coords)
        max_x = max(p[0] for p in pc_coords)
        min_y = min(p[1] for p in pc_coords)
        max_y = max(p[1] for p in pc_coords)
        min_z = min(p[2] for p in pc_coords)
        max_z = max(p[2] for p in pc_coords)

        cx = 0.5 * (min_x + max_x)
        cy = 0.5 * (min_y + max_y)
        cz = 0.5 * (min_z + max_z)
        center_bl = pc_to_bl(cx, cy, cz)

        for v in bm.verts:
            v.co -= center_bl

        chunk_name = f"Chunk_{i:02d}"
        mesh = finalize_sharp_mesh(bm, chunk_name, mats["concrete"], angle_deg=24.0)

        obj = bpy.data.objects.new(name=chunk_name, object_data=mesh)
        obj.location = center_bl
        collection.objects.link(obj)
        chunk_objs.append(obj)

        is_anchored = min_y <= 0.05
        node_records.append(
            {
                "index": i,
                "name": chunk_name,
                "isAnchored": bool(is_anchored),
                "localCenter": {"x": round(cx, 5), "y": round(cy, 5), "z": round(cz, 5)},
                "halfExtents": {
                    "x": round(0.5 * (max_x - min_x), 5),
                    "y": round(0.5 * (max_y - min_y), 5),
                    "z": round(0.5 * (max_z - min_z), 5),
                },
                "massKg": mass_kg,
                "meshVariant": i,
                "edges": [],
            }
        )

    adjacency: Dict[int, List[Dict[str, object]]] = {i: [] for i in range(num_cells)}
    for (a, b), shared_area in sorted(raw_contact_area.items()):
        if shared_area < 2e-4:
            continue
        threshold_j = round(max(180.0, shared_area * FRACTURE_BOND_J_PER_M2), 1)
        adjacency[a].append({"neighborIndex": b, "breakThresholdJ": threshold_j, "severed": False})
        adjacency[b].append({"neighborIndex": a, "breakThresholdJ": threshold_j, "severed": False})

    for i in range(num_cells):
        edges_sorted = sorted(adjacency[i], key=lambda e: int(e["neighborIndex"]))  # type: ignore[arg-type]
        node_records[i]["edges"] = edges_sorted

    connectivity_json: Dict[str, object] = {
        "version": 1,
        "wallId": "concrete_barrier_v1",
        "nodes": node_records,
    }
    return chunk_objs, connectivity_json


# ---------------------------------------------------------------------------
# 2. Instanced Debris Pack (`Brick_0..2` + `Splinter_0..2`)
# ---------------------------------------------------------------------------

def build_brick_variant(
    index: int,
    mats: Dict[str, bpy.types.Material],
    collection: bpy.types.Collection,
) -> bpy.types.Object:
    rng = random.Random(100 + index)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=2.0)

    hx = 0.1075 * rng.uniform(0.96, 1.03)
    hy = 0.0325 * rng.uniform(0.96, 1.04)
    hz = 0.0510 * rng.uniform(0.96, 1.03)
    for v in bm.verts:
        v.co = pc_to_bl(v.co.x * hx, v.co.z * hy, v.co.y * hz)

    # Chipped corners on battle-damaged masonry variants
    if index >= 1:
        chips = [(hx * 0.72, hy * 0.55, hz * (0.65 if index == 1 else -0.65), (0.68, 0.52, 0.51 if index == 1 else -0.51))]
        if index == 2:
            chips.append((-hx * 0.68, -hy * 0.50, hz * 0.62, (-0.64, -0.48, 0.55)))
        for cx_p, cy_p, cz_p, n_tup in chips:
            ret = bmesh.ops.bisect_plane(
                bm,
                geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
                dist=1e-5,
                plane_co=pc_to_bl(cx_p, cy_p, cz_p),
                plane_no=pc_to_bl(*n_tup).normalized(),
                clear_outer=True,
                clear_inner=False,
            )
            cut_edges = [e for e in ret["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
            if cut_edges:
                bmesh.ops.holes_fill(bm, edges=cut_edges, sides=0)

    bmesh.ops.bevel(
        bm, geom=bm.edges[:], offset=0.0042, offset_type="OFFSET", segments=2, profile=0.5, affect="EDGES"
    )
    for f in bm.faces:
        f.material_index = 0

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    shade = 0.98 - index * 0.08
    set_face_loop_colors(
        bm,
        lambda f: (
            (0.90, 0.89, 0.86, 1.0)
            if (index == 2 and f.normal.z > 0.85)
            else (shade, shade * 0.96, shade * 0.93, 1.0)
        ),
    )
    assign_triplanar_uvs(bm, scale=4.2)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])

    name = f"Brick_{index}"
    mesh = finalize_sharp_mesh(bm, name, mats["brick"], angle_deg=38.0)
    obj = bpy.data.objects.new(name=name, object_data=mesh)
    collection.objects.link(obj)
    return obj


def build_splinter_variant(
    index: int,
    mats: Dict[str, bpy.types.Material],
    collection: bpy.types.Collection,
) -> bpy.types.Object:
    rng = random.Random(200 + index)
    bm = bmesh.new()

    length_x = 0.21 + index * 0.042
    half_w = 0.017 + rng.uniform(-0.002, 0.004)
    half_t = 0.0095 + rng.uniform(-0.0015, 0.0025)

    stations = [
        (-0.50 * length_x, 0.10, 0.14, rng.uniform(-0.005, 0.005), rng.uniform(-0.002, 0.002)),
        (-0.32 * length_x, 0.62, 0.72, rng.uniform(-0.004, 0.004), rng.uniform(-0.002, 0.002)),
        (-0.12 * length_x, 0.96, 0.98, rng.uniform(-0.002, 0.002), 0.0),
        (0.10 * length_x, 1.00, 1.00, 0.0, rng.uniform(-0.002, 0.002)),
        (0.31 * length_x, 0.70, 0.78, rng.uniform(-0.004, 0.004), rng.uniform(-0.002, 0.002)),
        (0.50 * length_x, 0.08, 0.12, rng.uniform(-0.006, 0.006), rng.uniform(-0.002, 0.002)),
    ]

    rings: List[List[bmesh.types.BMVert]] = []
    sides = 8
    for sx, sy_scale, sz_scale, y_jag, z_jag in stations:
        r_verts: List[bmesh.types.BMVert] = []
        for s in range(sides):
            ang = (2.0 * math.pi * s) / sides + (0.16 if s % 2 == 1 else 0.0)
            ridge = 1.12 if s % 2 == 0 else 0.86
            py = math.sin(ang) * half_w * sy_scale * ridge + y_jag
            pz = math.cos(ang) * half_t * sz_scale * ridge + z_jag
            r_verts.append(bm.verts.new(pc_to_bl(sx, py, pz)))
        rings.append(r_verts)

    for r_i in range(len(rings) - 1):
        r0 = rings[r_i]
        r1 = rings[r_i + 1]
        for s in range(sides):
            sn = (s + 1) % sides
            f = bm.faces.new((r0[s], r0[sn], r1[sn], r1[s]))
            f.material_index = 0

    tip_left = bm.verts.new(pc_to_bl(-0.57 * length_x, rng.uniform(-0.005, 0.005), 0.0))
    tip_right = bm.verts.new(pc_to_bl(0.57 * length_x, rng.uniform(-0.005, 0.005), 0.0))
    for s in range(sides):
        sn = (s + 1) % sides
        f0 = bm.faces.new((tip_left, rings[0][sn], rings[0][s]))
        f1 = bm.faces.new((tip_right, rings[-1][s], rings[-1][sn]))
        f0.material_index = 0
        f1.material_index = 0

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    set_face_loop_colors(
        bm,
        lambda f: (0.74, 0.64, 0.52, 1.0) if abs(f.normal.x) > 0.72 else (0.98, 0.94, 0.86, 1.0),
    )
    assign_splinter_uvs(bm, length_scale=3.4, radial_scale=6.5)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])

    name = f"Splinter_{index}"
    mesh = finalize_sharp_mesh(bm, name, mats["wood"], angle_deg=34.0)
    obj = bpy.data.objects.new(name=name, object_data=mesh)
    collection.objects.link(obj)
    return obj


def export_objects_glb(objs: Sequence[bpy.types.Object], filepath: str) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=filepath,
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=False,
        export_texcoords=True,
        export_normals=True,
        export_tangents=True,
        export_all_vertex_colors=True,
        export_materials="EXPORT",
        export_animations=False,
        export_lights=False,
    )


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(OUT_BLEND), exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.save_version = 0
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0

    mats = build_materials()

    wall_col = bpy.data.collections.new("ConcreteWallFractured")
    debris_col = bpy.data.collections.new("DebrisPack")
    scene.collection.children.link(wall_col)
    scene.collection.children.link(debris_col)

    intact_obj = build_intact_wall_object(mats, wall_col)
    chunk_objs, connectivity_json = build_voronoi_fractured_wall(mats, wall_col)

    export_objects_glb([intact_obj] + chunk_objs, OUT_WALL_GLB)

    with open(OUT_CONN_JSON, "w", encoding="utf-8") as f:
        json.dump(connectivity_json, f, indent=2)
        f.write("\n")

    debris_objs: List[bpy.types.Object] = []
    for idx in range(3):
        debris_objs.append(build_brick_variant(idx, mats, debris_col))
    for idx in range(3):
        debris_objs.append(build_splinter_variant(idx, mats, debris_col))
    export_objects_glb(debris_objs, OUT_DEBRIS_GLB)

    # Offset intact reference wall & debris variants cleanly for non-overlapping inspection in Blender 5.2 GUI
    intact_obj.location.x = -4.2
    for idx, dobj in enumerate(debris_objs):
        dobj.location = pc_to_bl(2.5 + (idx % 3) * 0.45, 0.25 + (idx // 3) * 0.35, 0.0)
    bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND)

    nodes = connectivity_json["nodes"]  # type: ignore[index]
    anchored_count = sum(1 for n in nodes if n["isAnchored"])  # type: ignore[index]
    edge_count = sum(len(n["edges"]) for n in nodes) // 2  # type: ignore[index,arg-type]
    print(
        f"[Fracture Pipeline] {len(chunk_objs)} Voronoi chunks ({anchored_count} anchored, {edge_count} undirected bonds) | "
        f"concrete_wall_fractured.glb: {os.path.getsize(OUT_WALL_GLB) / 1024.0:.1f} KB | "
        f"debris_pack.glb: {os.path.getsize(OUT_DEBRIS_GLB) / 1024.0:.1f} KB"
    )


if __name__ == "__main__":
    main()
