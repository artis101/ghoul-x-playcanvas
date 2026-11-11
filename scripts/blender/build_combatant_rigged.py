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
import numpy as np
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
# Procedural NumPy PBR Texture Suite (Albedo + Tangent-Space Normal + ORM) & Materials
# ---------------------------------------------------------------------------
# All textures are generated procedurally with NumPy, packed into the .blend and exported
# as JPEG inside the GLB (keeps ghoul_combatant.glb well below the 2 MB runtime budget).
# glTF/OpenGL tangent-space convention: +G = +V (pixel rows grow with V).

SKIN_RGB = (0.735, 0.535, 0.425)


def _uvgrid(size: int):
    c = (np.arange(size, dtype=np.float32) + 0.5) / size
    u, v = np.meshgrid(c, c)  # v varies along rows (axis 0) == image V
    return u, v


def _smooth(e0: float, e1: float, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _gauss(v, s):
    return np.exp(-((v / s) ** 2))


def _rgb(r: float, g: float, b: float):
    return np.array((r, g, b), dtype=np.float32)


def _mix(a, b, t):
    t = np.asarray(t, dtype=np.float32)[..., None]
    return a * (1.0 - t) + b * t


def value_noise(size: int, cells: int, seed: int):
    """Tileable smooth value noise in [0, 1] (size x size)."""
    cells = max(1, min(size, cells))
    rng = np.random.default_rng(seed)
    grid = rng.random((cells, cells)).astype(np.float32)
    coords = np.arange(size, dtype=np.float32) * cells / size
    i0 = np.floor(coords).astype(np.int32)
    f = coords - i0
    f = f * f * (3.0 - 2.0 * f)
    i0 = i0 % cells
    i1 = (i0 + 1) % cells
    g00 = grid[np.ix_(i0, i0)]
    g01 = grid[np.ix_(i0, i1)]
    g10 = grid[np.ix_(i1, i0)]
    g11 = grid[np.ix_(i1, i1)]
    fx = f[None, :]
    fy = f[:, None]
    top = g00 * (1.0 - fx) + g01 * fx
    bot = g10 * (1.0 - fx) + g11 * fx
    return top * (1.0 - fy) + bot * fy


def fbm(size: int, base_cells: int, octaves: int, seed: int, gain: float = 0.5):
    out = np.zeros((size, size), dtype=np.float32)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        out += amp * value_noise(size, base_cells * (2 ** o), seed + o * 101)
        tot += amp
        amp *= gain
    return out / tot


def white_noise(size: int, seed: int):
    return np.random.default_rng(seed).random((size, size)).astype(np.float32)


def height_to_normal(h, strength: float):
    """Converts a tileable height field into an OpenGL/glTF tangent-space normal map (RGB 0..1)."""
    dx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * 0.5
    dy = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * 0.5
    nx = -dx * strength
    ny = -dy * strength
    nz = np.ones_like(h)
    inv = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack((nx * inv * 0.5 + 0.5, ny * inv * 0.5 + 0.5, nz * inv * 0.5 + 0.5), axis=-1)


def orm_from_roughness(rough, metal=None):
    r = np.clip(rough, 0.02, 1.0).astype(np.float32)
    m = np.zeros_like(r) if metal is None else np.clip(metal, 0.0, 1.0).astype(np.float32)
    return np.stack((np.ones_like(r), r, m), axis=-1)


def make_image_from_array(name: str, rgb, non_color: bool = False) -> bpy.types.Image:
    h, w = rgb.shape[:2]
    img = bpy.data.images.new(name=name, width=w, height=h, alpha=False)
    img.colorspace_settings.name = "Non-Color" if non_color else "sRGB"
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rgba[..., :3] = np.clip(rgb, 0.0, 1.0)
    img.pixels.foreach_set(rgba.ravel())
    img.pack()
    return img


def make_pbr_material(
    name: str,
    base_color: Tuple[float, float, float, float] = (1.0, 1.0, 1.0, 1.0),
    roughness: float = 0.65,
    metallic: float = 0.0,
    emission_color: Optional[Tuple[float, float, float, float]] = None,
    emission_strength: float = 0.0,
    albedo_image: Optional[bpy.types.Image] = None,
    normal_image: Optional[bpy.types.Image] = None,
    orm_image: Optional[bpy.types.Image] = None,
    normal_strength: float = 1.0,
    subsurface: float = 0.0,
    coat: float = 0.0,
) -> bpy.types.Material:
    """Principled BSDF with Albedo -> Base Color, NormalMap -> Normal, ORM(G=Roughness, B=Metallic)."""
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
        tex = nodes.new(type="ShaderNodeTexImage")
        tex.image = albedo_image
        tex.interpolation = "Linear"
        tex.location = (-620, 260)
        links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])

    if normal_image is not None:
        ntex = nodes.new(type="ShaderNodeTexImage")
        ntex.image = normal_image
        ntex.interpolation = "Linear"
        ntex.location = (-620, -320)
        nmap = nodes.new(type="ShaderNodeNormalMap")
        nmap.location = (-300, -320)
        nmap.inputs["Strength"].default_value = normal_strength
        links.new(ntex.outputs["Color"], nmap.inputs["Color"])
        links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])

    if orm_image is not None:
        otex = nodes.new(type="ShaderNodeTexImage")
        otex.image = orm_image
        otex.interpolation = "Linear"
        otex.location = (-620, -40)
        sep = nodes.new(type="ShaderNodeSeparateColor")
        sep.location = (-300, -40)
        links.new(otex.outputs["Color"], sep.inputs["Color"])
        links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])

    if subsurface > 0.0 and "Subsurface Weight" in bsdf.inputs:
        bsdf.inputs["Subsurface Weight"].default_value = subsurface
        bsdf.inputs["Subsurface Radius"].default_value = (1.0, 0.36, 0.18)
        bsdf.inputs["Subsurface Scale"].default_value = 0.006
    if coat > 0.0 and "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = coat
        bsdf.inputs["Coat Roughness"].default_value = 0.08

    if emission_color is not None and "Emission Color" in bsdf.inputs:
        bsdf.inputs["Emission Color"].default_value = emission_color
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


# ----- Individual procedural painters (return albedo, normal, roughness arrays) -----

def paint_skin_body(size: int, seed: int):
    mott = fbm(size, 4, 4, seed)
    pores = fbm(size, 64, 2, seed + 7)
    fine = white_noise(size, seed + 9)
    alb = _rgb(*SKIN_RGB)[None, None, :] * (0.93 + 0.14 * mott[..., None])
    alb = alb + _rgb(0.05, -0.012, -0.02) * (fbm(size, 6, 3, seed + 3)[..., None] - 0.5)
    h = 0.55 * pores + 0.12 * fine
    rough = 0.50 + 0.10 * pores
    return alb, height_to_normal(h, size * 0.010), rough


def paint_shirt_charcoal(size: int, seed: int):
    u, v = _uvgrid(size)
    du = np.abs(u - 0.5)
    n = fbm(size, 8, 4, seed)
    idx = np.arange(size)
    rip = (((idx % 12) == 0)[None, :] | ((idx % 12) == 0)[:, None]).astype(np.float32)
    weave = 0.5 + 0.5 * np.sin(idx[None, :] * np.pi * 0.5) * np.sin(idx[:, None] * np.pi * 0.5)
    warp = (fbm(size, 4, 3, seed + 1) - 0.5) * 7.0
    folds = (np.sin(v * 2.0 * np.pi * 7.0 + warp * 1.8 + du * 9.0) * 0.5 + 0.5) ** 3
    folds = folds * _smooth(0.35, 0.70, fbm(size, 5, 2, seed + 21))
    seams = _gauss(du - 0.25, 0.0045) + _gauss(u, 0.004) + _gauss(u - 1.0, 0.004) + _gauss(v - 0.55, 0.003) * _smooth(0.26, 0.24, du)
    stitch = seams * (((idx[:, None] + idx[None, :]) % 6) < 3)
    gusset = _smooth(0.205, 0.215, du) * (1.0 - _smooth(0.285, 0.295, du))
    mesh_holes = gusset * (((idx[:, None] % 4) < 2) & ((idx[None, :] % 4) < 2))
    base = _mix(_rgb(0.135, 0.145, 0.158), _rgb(0.092, 0.10, 0.112), gusset)
    alb = base * (0.88 + 0.22 * n[..., None]) * (1.0 - 0.10 * rip[..., None]) * (1.0 - 0.18 * folds[..., None] * 0.5)
    alb = alb * (1.0 - 0.25 * seams[..., None])
    h = 0.28 * folds + 0.18 * rip + 0.10 * weave - 0.55 * seams + 0.25 * stitch - 0.35 * mesh_holes
    rough = 0.78 + 0.08 * n - 0.04 * folds
    return alb, height_to_normal(h, size * 0.012), rough


def paint_bdu_olive(size: int, seed: int):
    u, v = _uvgrid(size)
    n = fbm(size, 8, 4, seed)
    idx = np.arange(size)
    rip = (((idx % 10) == 0)[None, :] | ((idx % 10) == 0)[:, None]).astype(np.float32)
    weave = 0.5 + 0.5 * np.sin(idx[None, :] * np.pi * 0.5 + idx[:, None] * np.pi * 0.5)
    warp = (fbm(size, 4, 3, seed + 2) - 0.5) * 8.0
    creases = (np.sin(v * 2.0 * np.pi * 9.0 + warp * 1.8) * 0.5 + 0.5) ** 4
    creases = creases * _smooth(0.35, 0.70, fbm(size, 5, 2, seed + 21))
    pleats = (np.sin(v * 2.0 * np.pi * 24.0) * 0.5 + 0.5) * _gauss(v - 0.5, 0.06) * _gauss(u - 0.5, 0.16)
    seams = _gauss(np.abs(u - 0.5) - 0.25, 0.0045) + _gauss(u, 0.004) + _gauss(u - 1.0, 0.004)
    stitch = seams * ((idx[:, None] % 6) < 3)
    blotch = fbm(size, 3, 3, seed + 11)
    base = _rgb(0.235, 0.265, 0.165) * (0.86 + 0.26 * n[..., None]) * (0.92 + 0.12 * blotch[..., None])
    alb = base * (1.0 - 0.09 * rip[..., None]) * (1.0 - 0.10 * creases[..., None]) * (1.0 - 0.22 * seams[..., None])
    h = 0.24 * creases + 0.30 * pleats + 0.16 * rip + 0.08 * weave - 0.5 * seams + 0.22 * stitch
    rough = 0.84 + 0.06 * n
    return alb, height_to_normal(h, size * 0.012), rough


def paint_cordura(size: int, seed: int, rgb: Tuple[float, float, float], molle: bool):
    u, v = _uvgrid(size)
    idx = np.arange(size)
    n = fbm(size, 8, 4, seed)
    weave = 0.5 + 0.5 * np.sin(idx[None, :] * np.pi * 0.66) * np.sin(idx[:, None] * np.pi * 0.66)
    h = 0.12 * weave + 0.25 * fbm(size, 32, 2, seed + 3)
    alb = _rgb(*rgb) * (0.86 + 0.24 * n[..., None]) * (0.96 + 0.06 * weave[..., None])
    if molle:
        period = size // 8
        band = ((idx % period) < (period * 0.5))[:, None]
        edge = (((idx % period) == 0) | ((idx % period) == int(period * 0.5) - 1))[:, None]
        tack = ((idx % (period // 2)) < 2)[None, :] & band
        h = h + 0.55 * band - 0.35 * edge + 0.25 * tack
        alb = alb * (1.0 - 0.10 * edge[..., None]) * (0.97 + 0.05 * band[..., None])
    stitch = (_gauss(v - 0.04, 0.004) + _gauss(v - 0.96, 0.004)) * ((idx[None, :] % 6) < 3)
    h = h + 0.3 * stitch
    rough = 0.80 + 0.08 * n
    return alb, height_to_normal(h, size * 0.012), rough


def paint_kevlar_coating(size: int, seed: int):
    n = fbm(size, 6, 4, seed)
    grit = fbm(size, 64, 2, seed + 4)
    alb = _rgb(0.20, 0.225, 0.165) * (0.88 + 0.22 * n[..., None]) * (0.95 + 0.08 * grit[..., None])
    scuff = _smooth(0.72, 0.80, fbm(size, 5, 3, seed + 9))
    alb = _mix(alb, _rgb(0.30, 0.31, 0.26), scuff * 0.5)
    h = 0.7 * grit + 0.2 * n
    rough = 0.72 + 0.10 * grit - 0.15 * scuff
    return alb, height_to_normal(h, size * 0.016), rough


def paint_glove(size: int, seed: int):
    u, v = _uvgrid(size)
    idx = np.arange(size)
    grain = fbm(size, 48, 2, seed)
    n = fbm(size, 6, 3, seed + 1)
    stitches = (_gauss(np.abs(u - 0.5) - 0.24, 0.004) + _gauss(u - 0.5, 0.004)) * ((idx[:, None] % 5) < 3)
    flex = (np.sin(v * 2.0 * np.pi * 14.0) * 0.5 + 0.5) ** 6
    alb = _rgb(0.058, 0.062, 0.066) * (0.85 + 0.30 * n[..., None]) + 0.03 * stitches[..., None]
    h = 0.45 * grain + 0.35 * flex + 0.3 * stitches
    rough = 0.62 + 0.12 * grain
    return alb, height_to_normal(h, size * 0.012), rough


def paint_boot_leather(size: int, seed: int):
    u, v = _uvgrid(size)
    idx = np.arange(size)
    suede = fbm(size, 64, 2, seed)
    n = fbm(size, 5, 4, seed + 2)
    crease = (np.sin(v * 2.0 * np.pi * 11.0 + (n - 0.5) * 5.0) * 0.5 + 0.5) ** 6
    stitch = (_gauss(v - 0.30, 0.004) + _gauss(v - 0.62, 0.004)) * ((idx[None, :] % 6) < 3)
    alb = _rgb(0.40, 0.31, 0.205) * (0.82 + 0.30 * n[..., None]) * (0.94 + 0.10 * suede[..., None])
    alb = alb * (1.0 - 0.12 * crease[..., None])
    h = 0.4 * suede + 0.45 * crease + 0.35 * stitch
    rough = 0.70 + 0.12 * suede
    return alb, height_to_normal(h, size * 0.012), rough


def paint_rubber(size: int, seed: int):
    idx = np.arange(size)
    n = fbm(size, 16, 3, seed)
    lug = ((((idx[:, None] // 8) + (idx[None, :] // 8)) % 2) == 0).astype(np.float32)
    alb = _rgb(0.045, 0.045, 0.048) * (0.85 + 0.3 * n[..., None])
    h = 0.6 * lug + 0.2 * n
    rough = 0.82 + 0.08 * n
    return alb, height_to_normal(h, size * 0.02), rough


def paint_carbon(size: int):
    idx = np.arange(size)
    tw = (((idx[:, None] // 4) + (idx[None, :] // 4)) % 2).astype(np.float32)
    ph = (idx[None, :] % 4) / 4.0
    h = np.where(tw > 0.5, np.sin(ph * np.pi), np.sin(((idx[:, None] % 4) / 4.0) * np.pi))
    alb = _rgb(0.05, 0.052, 0.058) * (0.8 + 0.4 * tw[..., None])
    rough = 0.48 + 0.10 * tw
    return alb, height_to_normal(h, size * 0.008), rough


def paint_polymer_normal(size: int, seed: int):
    h = fbm(size, 48, 2, seed)
    return height_to_normal(h, size * 0.010)


def paint_eye(size: int):
    """Eyeball texture: V = sqrt(polar / pi) from cornea apex (V=0) to the back (V=1); U = azimuth."""
    u, v = _uvgrid(size)
    polar = (v ** 2) * np.pi
    n = fbm(size, 16, 3, 41)
    striae = 0.5 + 0.5 * np.sin(u * 2.0 * np.pi * 38.0 + n * 6.0)
    sclera = _rgb(0.86, 0.82, 0.78) * (0.97 + 0.04 * n[..., None])
    veins = _smooth(0.55, 0.85, polar) * _smooth(0.62, 0.70, fbm(size, 24, 2, 77))
    sclera = _mix(sclera, _rgb(0.74, 0.38, 0.36), veins * 0.55)
    iris_t = np.clip(polar / 0.42, 0.0, 1.0)
    iris = _mix(_rgb(0.30, 0.20, 0.09), _rgb(0.21, 0.27, 0.17), _smooth(0.25, 0.85, iris_t))
    iris = iris * (0.70 + 0.45 * striae[..., None])
    limbal = _gauss(polar - 0.42, 0.035)
    iris = iris * (1.0 - 0.55 * limbal[..., None])
    col = _mix(sclera, iris, 1.0 - _smooth(0.40, 0.445, polar))
    col = _mix(col, _rgb(0.015, 0.015, 0.02), 1.0 - _smooth(0.135, 0.155, polar))
    return col


def paint_head_textures(size_a: int, size_r: int):
    """Albedo + normal + roughness for the unified head UV (u = head azimuth param, v = head ring param)."""
    K = HEAD_KEYS.shape[0] - 1

    def grid(size):
        u, v = _uvgrid(size)
        x, y, z, nx, nz, c, sn = head_base(v.astype(np.float64) * K, u.astype(np.float64))
        th = head_theta(u.astype(np.float64))
        return u, v, x, y, z, c, sn, th

    def masks(x, y, c, th):
        ax = np.abs(x)
        ath = np.abs(th)
        yhl = np.interp(ath, [0.0, 0.50, 0.80, 1.00, 1.14, 1.30, 1.80, 2.30, np.pi],
                        [1.751, 1.747, 1.738, 1.716, 1.700, 1.707, 1.709, 1.660, 1.624])
        hair = _smooth(yhl - 0.0025, yhl + 0.0055, y)
        brow_c = 1.7005 + 0.0042 * _gauss(ax - 0.035, 0.014) - 0.002 * _smooth(0.045, 0.055, ax)
        brow_t = 0.0040 * (1.0 - 0.45 * _smooth(0.030, 0.052, ax)) + 0.0010
        brow = np.clip(1.0 - np.abs(y - brow_c) / brow_t, 0.0, 1.0) ** 0.7
        brow = brow * _smooth(0.010, 0.016, ax) * (1.0 - _smooth(0.049, 0.056, ax)) * (c > 0.3)
        lw_up = 0.0210 * np.sqrt(np.clip(1.0 - ((y - 1.6115) / 0.0100) ** 2, 0.0, 1.0))
        bow = 0.0011 * _gauss(ax - 0.0055, 0.0035) - 0.0008 * _gauss(ax, 0.002)
        lips = _smooth(lw_up, lw_up - 0.0032, ax) * _smooth(1.6010, 1.6040, y) * (1.0 - _smooth(1.6195 + bow, 1.6218 + bow, y))
        lips = lips * (c > 0.5)
        btop_f = np.where(ax < 0.021, 1.6330, 1.6330 + (ax - 0.021) * 0.50)
        side_t = _smooth(0.60, 0.15, c)
        btop = btop_f * (1.0 - side_t) + 1.690 * side_t
        beard = (1.0 - _smooth(btop - 0.006, btop + 0.002, y)) * (1.0 - lips) * _smooth(-0.45, -0.05, c)
        return ax, hair, brow, lips, beard

    # ---- Albedo + normal at size_a ----
    u, v, x, y, z, c, sn, th = grid(size_a)
    ax, hair, brow, lips, beard = masks(x, y, c, th)
    S = size_a
    mott = fbm(S, 5, 4, 1201)
    pores = fbm(S, 128, 2, 1203)
    dots = white_noise(S, 1207)
    strands = 0.5 + 0.5 * np.sin(y * 5200.0 + x * 900.0 + fbm(S, 32, 2, 1209) * 9.0)

    skin = _rgb(*SKIN_RGB) * (0.93 + 0.14 * mott[..., None])
    redness = _gauss(ax - 0.042, 0.016) * _gauss(y - 1.660, 0.012) + 0.8 * _gauss(x, 0.010) * _gauss(y - 1.652, 0.010)
    skin = skin + _rgb(0.06, -0.015, -0.02) * redness[..., None]
    undereye = _gauss(ax - 0.032, 0.012) * _gauss(y - 1.6795, 0.0042) * (c > 0.3)
    skin = skin * (1.0 - _rgb(0.10, 0.13, 0.10) * undereye[..., None])
    socket = _gauss(ax - 0.032, 0.0115) * _gauss(y - 1.688, 0.0062) * (c > 0.3)
    skin = _mix(skin, _rgb(0.52, 0.30, 0.26), socket * 0.55)

    stubble_col = _rgb(0.43, 0.36, 0.33)
    stubble_amt = beard * (0.35 + 0.30 * (dots > 0.55)) * (0.75 + 0.5 * fbm(S, 12, 2, 1211))
    col = _mix(skin, stubble_col, np.clip(stubble_amt * 0.45, 0.0, 1.0))

    lip_col = _rgb(0.64, 0.40, 0.37) * (0.95 + 0.1 * mott[..., None])
    col = _mix(col, lip_col, lips * 0.70)
    mouth_line = _gauss(y - 1.6115, 0.00070) * (1.0 - _smooth(0.0185, 0.0215, ax)) * (c > 0.5)
    col = _mix(col, _rgb(0.20, 0.08, 0.08), mouth_line * 0.85)
    nostril = _gauss(ax - 0.0085, 0.0026) * _gauss(y - 1.6392, 0.0012) * (c > 0.5)
    col = _mix(col, _rgb(0.30, 0.15, 0.13), np.clip(nostril * 0.75, 0, 1))

    hair_col = _rgb(0.085, 0.070, 0.058) * (0.85 + 0.3 * strands[..., None])
    buzz = hair * (0.72 + 0.22 * (dots > 0.45))
    col = _mix(col, hair_col, buzz)
    brow_col = _rgb(0.075, 0.058, 0.045) * (0.8 + 0.4 * strands[..., None])
    col = _mix(col, brow_col, np.clip(brow * (0.75 + 0.35 * strands), 0, 1))

    wrinkles = (np.sin(y * 1900.0 + fbm(S, 6, 2, 1215) * 4.0) * 0.5 + 0.5) * _gauss(y - 1.734, 0.008) * (c > 0.4) * 0.10
    lip_lines = (np.sin(x * 3800.0 + fbm(S, 24, 2, 1217) * 5.0) * 0.5 + 0.5) * lips * 0.12
    h = 0.42 * pores + 0.30 * stubble_amt * dots + 0.45 * hair * strands * 0.6 + 0.55 * brow * strands + wrinkles + lip_lines
    nrm = height_to_normal(h, S * 0.0065)
    alb = col

    # ---- Roughness at size_r ----
    u2, v2, x2, y2, z2, c2, sn2, th2 = grid(size_r)
    ax2, hair2, brow2, lips2, beard2 = masks(x2, y2, c2, th2)
    tzone = (_gauss(x2, 0.012) * _gauss(y2 - 1.665, 0.035) + _gauss(x2, 0.04) * _gauss(y2 - 1.735, 0.015)) * (c2 > 0.4)
    rough = 0.54 - 0.12 * tzone - 0.16 * lips2 + 0.22 * hair2 + 0.08 * beard2 + 0.05 * fbm(size_r, 32, 2, 1301)
    return alb, nrm, rough


def build_palette() -> Dict[str, bpy.types.Material]:
    S = 256

    def tex_set(prefix: str, alb, nrm, rough=None, metal=None):
        a = make_image_from_array(f"Tex_Combatant_{prefix}_Albedo", alb)
        n = make_image_from_array(f"Tex_Combatant_{prefix}_Normal", nrm, non_color=True)
        o = make_image_from_array(f"Tex_Combatant_{prefix}_ORM", orm_from_roughness(rough, metal), non_color=True) if rough is not None else None
        return a, n, o

    h_alb, h_nrm, h_rough = paint_head_textures(512, 256)
    head_a, head_n, head_o = tex_set("Head", h_alb, h_nrm, h_rough)
    head_mat = make_pbr_material(
        "Mat_Head_Sculpted", roughness=0.52, albedo_image=head_a, normal_image=head_n, orm_image=head_o,
        normal_strength=0.9, subsurface=0.12,
    )

    sk = paint_skin_body(S, 501)
    skin_a, skin_n, skin_o = tex_set("Skin", sk[0], sk[1], sk[2])
    sh = paint_shirt_charcoal(S, 601)
    shirt_a, shirt_n, shirt_o = tex_set("Shirt", sh[0], sh[1], sh[2])
    bd = paint_bdu_olive(S, 701)
    bdu_a, bdu_n, bdu_o = tex_set("BDU", bd[0], bd[1], bd[2])
    wb = paint_cordura(S, 801, (0.44, 0.37, 0.25), molle=False)
    web_a, web_n, web_o = tex_set("Webbing", wb[0], wb[1], wb[2])
    pc_ = paint_cordura(S, 811, (0.42, 0.355, 0.24), molle=True)
    pcar_a, pcar_n, pcar_o = tex_set("PlateCarrier", pc_[0], pc_[1], pc_[2])
    kv = paint_kevlar_coating(S, 901)
    kev_a, kev_n, kev_o = tex_set("Helmet", kv[0], kv[1], kv[2])
    gl = paint_glove(S, 1001)
    glove_a, glove_n, glove_o = tex_set("Glove", gl[0], gl[1], gl[2])
    bt = paint_boot_leather(S, 1101)
    boot_a, boot_n, boot_o = tex_set("Boot", bt[0], bt[1], bt[2])
    rb = paint_rubber(128, 1151)
    rub_a, rub_n, rub_o = tex_set("Rubber", rb[0], rb[1], rb[2])
    cf = paint_carbon(128)
    carb_a, carb_n, carb_o = tex_set("Carbon", cf[0], cf[1], cf[2])
    poly_n = make_image_from_array("Tex_Combatant_Polymer_Normal", paint_polymer_normal(128, 1171), non_color=True)
    eye_a = make_image_from_array("Tex_Combatant_Eye_Albedo", paint_eye(128))

    return {
        "head_skin": head_mat,
        "jaw_skin": head_mat,  # identical material on cranium + jaw -> zero shading / colour seam
        "skin_tone": make_pbr_material("Mat_Skin_Tactical", roughness=0.52, albedo_image=skin_a, normal_image=skin_n, orm_image=skin_o, normal_strength=0.8, subsurface=0.12),
        "eye": make_pbr_material("Mat_Eye_Cornea", roughness=0.06, albedo_image=eye_a, coat=0.6),
        "bdu_olive": make_pbr_material("Mat_BDU_OliveDrab", roughness=0.84, albedo_image=bdu_a, normal_image=bdu_n, orm_image=bdu_o),
        "shirt_charcoal": make_pbr_material("Mat_CombatShirt_Charcoal", roughness=0.78, albedo_image=shirt_a, normal_image=shirt_n, orm_image=shirt_o),
        "webbing_tan": make_pbr_material("Mat_TacticalWebbing_Coyote", roughness=0.80, albedo_image=web_a, normal_image=web_n, orm_image=web_o),
        "boot_leather": make_pbr_material("Mat_CombatBoot_Leather", roughness=0.70, albedo_image=boot_a, normal_image=boot_n, orm_image=boot_o),
        "boot_rubber": make_pbr_material("Mat_CombatBoot_VibramRubber", roughness=0.84, albedo_image=rub_a, normal_image=rub_n, orm_image=rub_o),
        "polymer_dark": make_pbr_material("Mat_Polymer_ArmorPad", (0.042, 0.045, 0.048, 1.0), roughness=0.66, metallic=0.0, normal_image=poly_n, normal_strength=0.5),
        "carbon": make_pbr_material("Mat_CarbonFiber_KnuckleGuard", roughness=0.50, albedo_image=carb_a, normal_image=carb_n, orm_image=carb_o, normal_strength=0.35),
        "metal_hw": make_pbr_material("Mat_Gunmetal_Hardware", (0.075, 0.078, 0.082, 1.0), roughness=0.48, metallic=0.70),
        "visor_glass": make_pbr_material("Mat_EyePro_Visor", (0.025, 0.035, 0.05, 1.0), roughness=0.05, metallic=0.65),
        "glove_leather": make_pbr_material("Mat_Glove_NomexLeather", roughness=0.64, albedo_image=glove_a, normal_image=glove_n, orm_image=glove_o),
        "esapi_plate": make_pbr_material("Mat_ESAPI_PlateCarrier", roughness=0.80, albedo_image=pcar_a, normal_image=pcar_n, orm_image=pcar_o),
        "helmet_kevlar": make_pbr_material("Mat_PASGT_Kevlar", roughness=0.74, albedo_image=kev_a, normal_image=kev_n, orm_image=kev_o),
        "beret_crimson": make_pbr_material("Mat_Spetsnaz_Beret", (0.30, 0.03, 0.045, 1.0), roughness=0.88, normal_image=bdu_n, normal_strength=0.5),
        "mohawk_punk": make_pbr_material("Mat_Punk_Mohawk", (0.62, 0.035, 0.04, 1.0), roughness=0.62, normal_image=poly_n, normal_strength=1.0),
        "gore_viscera": make_pbr_material(
            "Mat_Gore_Viscera", (0.42, 0.025, 0.035, 1.0), roughness=0.18, normal_image=skin_n, normal_strength=1.4,
            emission_color=(0.18, 0.01, 0.01, 1.0), emission_strength=0.10, coat=0.5,
        ),
        "organ_brain": make_pbr_material(
            "Mat_Organ_Brain", (0.80, 0.50, 0.54, 1.0), roughness=0.32, normal_image=skin_n, normal_strength=1.2,
            emission_color=(0.35, 0.10, 0.14, 1.0), emission_strength=0.18,
        ),
        "organ_heart": make_pbr_material(
            "Mat_Organ_Heart", (0.66, 0.06, 0.08, 1.0), roughness=0.26, normal_image=skin_n, normal_strength=1.0,
            emission_color=(0.45, 0.03, 0.04, 1.0), emission_strength=0.25,
        ),
        "organ_lungs": make_pbr_material(
            "Mat_Organ_Lungs", (0.74, 0.32, 0.36, 1.0), roughness=0.42, normal_image=skin_n, normal_strength=1.0,
            emission_color=(0.25, 0.07, 0.09, 1.0), emission_strength=0.15,
        ),
        "organ_liver": make_pbr_material(
            "Mat_Organ_Liver", (0.40, 0.09, 0.07, 1.0), roughness=0.30, normal_image=skin_n, normal_strength=0.8,
            emission_color=(0.22, 0.04, 0.03, 1.0), emission_strength=0.15,
        ),
        "bone_cortical": make_pbr_material(
            "Mat_Bone_Cortical", (0.86, 0.83, 0.74, 1.0), roughness=0.46, normal_image=poly_n, normal_strength=0.8,
            emission_color=(0.20, 0.19, 0.16, 1.0), emission_strength=0.10,
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


def _v(p) -> Vector:
    return Vector((float(p[0]), float(p[1]), float(p[2])))


def add_frame_loft(
    bm: bmesh.types.BMesh,
    stations: Sequence[Tuple[Vector, Vector, Vector, float, float]],
    sides: int = 12,
    mat_index: int = 0,
    cap_start: bool = True,
    cap_end: bool = True,
    dome_start: float = 0.5,
    dome_end: float = 0.5,
    exponent: float = 1.0,
    closed: bool = False,
    sculpt_fn: Optional[Callable[[int, float, float, float], Tuple[float, float]]] = None,
) -> List[bmesh.types.BMVert]:
    """
    Lofts a closed manifold tube through explicit cross-section frames (all in PlayCanvas coords):
    station = (center, axis_a, axis_b, ra, rb); ring point = center + a*sin(th)*ra + b*cos(th)*rb.
    `exponent` < 1 gives rounded-rectangle (superellipse) cross-sections; `closed` joins last ring to first.
    """
    uv_layer = bm.loops.layers.uv.verify()
    rings: List[List[bmesh.types.BMVert]] = []
    created: List[bmesh.types.BMVert] = []
    n = len(stations)
    for i, (c, A, B, ra, rb) in enumerate(stations):
        ring = []
        for s in range(sides):
            th = ((s / sides) - 0.5) * 2.0 * math.pi
            sa, cb = math.sin(th), math.cos(th)
            if exponent != 1.0:
                sa = math.copysign(abs(sa) ** exponent, sa)
                cb = math.copysign(abs(cb) ** exponent, cb)
            la, lb = sa * ra, cb * rb
            if sculpt_fn is not None:
                la, lb = sculpt_fn(i, th, la, lb)
            p = _v(c) + _v(A) * la + _v(B) * lb
            v = bm.verts.new(pc_vec_to_bl(p))
            ring.append(v)
            created.append(v)
        rings.append(ring)

    seg_count = n if closed else n - 1
    for r in range(seg_count):
        r0, r1 = rings[r], rings[(r + 1) % n]
        v0, v1 = r / max(1, seg_count), (r + 1) / max(1, seg_count)
        for s in range(sides):
            sn = (s + 1) % sides
            f = bm.faces.new((r0[s], r0[sn], r1[sn], r1[s]))
            f.material_index = mat_index
            f.smooth = True
            f.loops[0][uv_layer].uv = (s / sides, v0)
            f.loops[1][uv_layer].uv = ((s + 1) / sides, v0)
            f.loops[2][uv_layer].uv = ((s + 1) / sides, v1)
            f.loops[3][uv_layer].uv = (s / sides, v1)

    if not closed and n >= 2:
        for is_start in (True, False):
            if (is_start and not cap_start) or ((not is_start) and not cap_end):
                continue
            idx, nxt = (0, 1) if is_start else (n - 1, n - 2)
            c, _a, _b, ra, rb = stations[idx]
            tdir = (_v(c) - _v(stations[nxt][0]))
            tdir = tdir.normalized() if tdir.length > 1e-7 else Vector((0.0, 1.0, 0.0))
            dome = dome_start if is_start else dome_end
            cv = bm.verts.new(pc_vec_to_bl(_v(c) + tdir * (0.5 * (ra + rb) * dome)))
            created.append(cv)
            ring = rings[idx]
            vc = 0.0 if is_start else 1.0
            for s in range(sides):
                sn = (s + 1) % sides
                f = bm.faces.new((cv, ring[sn], ring[s]) if is_start else (cv, ring[s], ring[sn]))
                f.material_index = mat_index
                f.smooth = True
                for lp in f.loops:
                    lp[uv_layer].uv = (0.5, vc)
    return created


def add_tube_path(
    bm: bmesh.types.BMesh,
    pts: Sequence[Vector],
    radius: Tuple[float, float],
    sides: int = 8,
    mat_index: int = 0,
    closed: bool = False,
    up_fn: Optional[Callable[[Vector], Vector]] = None,
    dome: float = 0.6,
) -> List[bmesh.types.BMVert]:
    """Sweeps an (optionally flattened) tube along a polyline (straps, laces, cords, rim trims)."""
    P = [_v(p) for p in pts]
    n = len(P)
    stations = []
    for i in range(n):
        if closed:
            t = P[(i + 1) % n] - P[(i - 1) % n]
        else:
            t = P[min(i + 1, n - 1)] - P[max(i - 1, 0)]
        t = t.normalized() if t.length > 1e-8 else Vector((0.0, 1.0, 0.0))
        up = up_fn(P[i]) if up_fn is not None else Vector((0.0, 1.0, 0.0))
        nrm = up - t * up.dot(t)
        if nrm.length < 1e-5:
            nrm = Vector((1.0, 0.0, 0.0)) - t * t.x
        nrm.normalize()
        bnm = t.cross(nrm).normalized()
        stations.append((P[i], bnm, nrm, radius[0], radius[1]))
    return add_frame_loft(bm, stations, sides=sides, mat_index=mat_index, closed=closed, dome_start=dome, dome_end=dome)


def add_grid_slab(
    bm: bmesh.types.BMesh,
    outer: Sequence[Sequence[Vector]],
    inner: Sequence[Sequence[Vector]],
    mat_index: int = 0,
    rim_mat_index: Optional[int] = None,
) -> List[bmesh.types.BMVert]:
    """Closed manifold slab from two matching open grids (outer skin + inner skin + 4 rim strips)."""
    uv_layer = bm.loops.layers.uv.verify()
    R = len(outer) - 1
    C = len(outer[0]) - 1
    rim_mat = mat_index if rim_mat_index is None else rim_mat_index
    vo = [[bm.verts.new(pc_vec_to_bl(_v(p))) for p in row] for row in outer]
    vi = [[bm.verts.new(pc_vec_to_bl(_v(p))) for p in row] for row in inner]

    def quad(a, b, c, d, uvs, mi):
        f = bm.faces.new((a, b, c, d))
        f.material_index = mi
        f.smooth = True
        for lp, uv in zip(f.loops, uvs):
            lp[uv_layer].uv = uv

    for r in range(R):
        for c in range(C):
            u0, u1, w0, w1 = c / C, (c + 1) / C, r / R, (r + 1) / R
            quad(vo[r][c], vo[r][c + 1], vo[r + 1][c + 1], vo[r + 1][c], ((u0, w0), (u1, w0), (u1, w1), (u0, w1)), mat_index)
            quad(vi[r][c + 1], vi[r][c], vi[r + 1][c], vi[r + 1][c + 1], ((u1, w0), (u0, w0), (u0, w1), (u1, w1)), mat_index)
    for c in range(C):
        u0, u1 = c / C, (c + 1) / C
        quad(vi[0][c], vo[0][c], vo[0][c + 1], vi[0][c + 1], ((u0, 0.0), (u0, 0.03), (u1, 0.03), (u1, 0.0)), rim_mat)
        quad(vo[R][c], vi[R][c], vi[R][c + 1], vo[R][c + 1], ((u0, 0.97), (u0, 1.0), (u1, 1.0), (u1, 0.97)), rim_mat)
    for r in range(R):
        w0, w1 = r / R, (r + 1) / R
        quad(vi[r][0], vi[r + 1][0], vo[r + 1][0], vo[r][0], ((0.0, w0), (0.0, w1), (0.03, w1), (0.03, w0)), rim_mat)
        quad(vo[r][C], vo[r + 1][C], vi[r + 1][C], vi[r][C], ((0.97, w0), (0.97, w1), (1.0, w1), (1.0, w0)), rim_mat)
    return [v for row in vo for v in row] + [v for row in vi for v in row]


def add_wrapped_dome_slab(
    bm: bmesh.types.BMesh,
    outer_rings: Sequence[Sequence[Vector]],
    inner_rings: Sequence[Sequence[Vector]],
    outer_top: Vector,
    inner_top: Vector,
    mat_index: int = 0,
    rim_mat_index: Optional[int] = None,
) -> Tuple[List[bmesh.types.BMVert], List[bmesh.types.BMVert]]:
    """Closed dome shell (helmet / beret): rings wrap 360 deg from the rim (ring 0) up to an apex vertex."""
    uv_layer = bm.loops.layers.uv.verify()
    R = len(outer_rings)
    C = len(outer_rings[0])
    rim_mat = mat_index if rim_mat_index is None else rim_mat_index
    vo = [[bm.verts.new(pc_vec_to_bl(_v(p))) for p in ring] for ring in outer_rings]
    vi = [[bm.verts.new(pc_vec_to_bl(_v(p))) for p in ring] for ring in inner_rings]
    to = bm.verts.new(pc_vec_to_bl(_v(outer_top)))
    ti = bm.verts.new(pc_vec_to_bl(_v(inner_top)))

    def face(vs, uvs, mi):
        f = bm.faces.new(vs)
        f.material_index = mi
        f.smooth = True
        for lp, uv in zip(f.loops, uvs):
            lp[uv_layer].uv = uv

    for r in range(R - 1):
        w0, w1 = r / R, (r + 1) / R
        for c in range(C):
            cn = (c + 1) % C
            u0, u1 = c / C, (c + 1) / C
            face((vo[r][c], vo[r][cn], vo[r + 1][cn], vo[r + 1][c]), ((u0, w0), (u1, w0), (u1, w1), (u0, w1)), mat_index)
            face((vi[r][cn], vi[r][c], vi[r + 1][c], vi[r + 1][cn]), ((u1, w0), (u0, w0), (u0, w1), (u1, w1)), mat_index)
    for c in range(C):
        cn = (c + 1) % C
        u0, u1 = c / C, (c + 1) / C
        face((to, vo[R - 1][c], vo[R - 1][cn]), ((0.5, 1.0), (u0, 1.0 - 1.0 / R), (u1, 1.0 - 1.0 / R)), mat_index)
        face((ti, vi[R - 1][cn], vi[R - 1][c]), ((0.5, 1.0), (u1, 1.0 - 1.0 / R), (u0, 1.0 - 1.0 / R)), mat_index)
        face((vi[0][c], vi[0][cn], vo[0][cn], vo[0][c]), ((u0, 0.0), (u1, 0.0), (u1, 0.03), (u0, 0.03)), rim_mat)
    return [v for ring in vo for v in ring] + [to], [v for ring in vi for v in ring] + [ti]


def add_oriented_box(
    bm: bmesh.types.BMesh,
    center: Vector,
    ax: Vector,
    ay: Vector,
    az: Vector,
    half: Tuple[float, float, float],
    bevel_width: float = 0.002,
    mat_index: int = 0,
) -> List[bmesh.types.BMVert]:
    """Beveled box with an arbitrary orthonormal frame (PlayCanvas coords)."""
    uv_layer = bm.loops.layers.uv.verify()
    ret = bmesh.ops.create_cube(bm, size=2.0)
    verts: List[bmesh.types.BMVert] = ret["verts"]
    C, X, Y, Z = _v(center), _v(ax), _v(ay), _v(az)
    for v in verts:
        lx, ly, lz = v.co.x, v.co.y, v.co.z
        v.co = pc_vec_to_bl(C + X * (lx * half[0]) + Y * (ly * half[1]) + Z * (lz * half[2]))
    vert_set = set(verts)
    edges = [e for e in bm.edges if e.verts[0] in vert_set and e.verts[1] in vert_set]
    for f in bm.faces:
        if all(v in vert_set for v in f.verts):
            f.material_index = mat_index
            f.smooth = False
    if bevel_width > 1e-5 and edges:
        bw = min(bevel_width, 0.45 * min(half))
        bev = bmesh.ops.bevel(bm, geom=edges, offset=bw, offset_type="OFFSET", segments=1, profile=0.5, affect="EDGES")
        for f in bev.get("faces", []):
            f.material_index = mat_index
            f.smooth = False
        verts = list(vert_set.union(bev.get("verts", [])))
    final_set = set(verts)
    c_bl = pc_vec_to_bl(C)
    for f in bm.faces:
        if all(v in final_set for v in f.verts):
            n = f.normal
            a_x, a_y, a_z = abs(n.x), abs(n.y), abs(n.z)
            for lp in f.loops:
                co = lp.vert.co - c_bl
                if a_z >= a_x and a_z >= a_y:
                    u, w = co.x * 4.0 + 0.5, co.y * 4.0 + 0.5
                elif a_x >= a_y:
                    u, w = co.y * 4.0 + 0.5, co.z * 4.0 + 0.5
                else:
                    u, w = co.x * 4.0 + 0.5, co.z * 4.0 + 0.5
                lp[uv_layer].uv = (u, w)
    return verts


def finalize_skinned_mesh_object(
    name: str,
    bm: bmesh.types.BMesh,
    materials: Sequence[bpy.types.Material],
    armature_obj: bpy.types.Object,
    bone_weights: Sequence[Tuple[str, float]],
    collection: bpy.types.Collection,
    custom_normals_pc: Optional[Dict[bmesh.types.BMVert, Vector]] = None,
) -> bpy.types.Object:
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.verts.index_update()
    cn_idx: Dict[int, Vector] = {}
    if custom_normals_pc:
        for bv, n_pc in custom_normals_pc.items():
            if bv.is_valid:
                cn_idx[bv.index] = pc_vec_to_bl(n_pc).normalized()

    mesh = bpy.data.meshes.new(name=name)
    bm.to_mesh(mesh)
    bm.free()

    for mat in materials:
        mesh.materials.append(mat)

    if cn_idx:
        # Shared analytic loop normals: seam rings shared by Zone_HEAD_CRANIUM + Zone_HEAD_FACE_JAW
        # receive IDENTICAL normals in both submeshes -> 100% seamless lighting across the cut.
        vnorms = [Vector(vn.vector) for vn in mesh.vertex_normals]
        for i, n_bl in cn_idx.items():
            vnorms[i] = n_bl
        mesh.normals_split_custom_set_from_vertices([tuple(n) for n in vnorms])

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
# Unified Analytic Anatomical Head Surface (shared by cranium, jaw, helmet, visor, beret)
# ---------------------------------------------------------------------------
# A single continuous parametric surface P(uk, s): `uk` = key-ring parameter (0 = under-chin,
# 16 = crown), `s` = azimuth parameter (0/1 = back, 0.5 = front). Zone_HEAD_FACE_JAW samples
# uk in [0, HEAD_SEAM_KEY] and Zone_HEAD_CRANIUM samples uk in [HEAD_SEAM_KEY, 16], so the seam
# ring at the maxilla/cheek line is bit-identical in position, UV and normal for both submeshes.

# Columns: y_front, y_back, z_front (+Z extent), z_back (|-Z| extent), half-width X
HEAD_KEYS = np.array([
    (1.5650, 1.5940, 0.044, 0.010, 0.034),  # 0  under-chin / submental (tucks onto throat)
    (1.5685, 1.5970, 0.068, 0.025, 0.041),  # 1  chin underside
    (1.5780, 1.5990, 0.080, 0.040, 0.047),  # 2  mental protuberance / chin
    (1.5910, 1.6010, 0.085, 0.054, 0.054),  # 3  lower lip / gonial angle
    (1.6040, 1.6040, 0.088, 0.064, 0.059),  # 4  mouth / jaw angle
    (1.6190, 1.6140, 0.090, 0.073, 0.065),  # 5  upper lip / philtrum
    (1.6340, 1.6260, 0.089, 0.082, 0.070),  # 6  SEAM: maxilla / cheek line under nose
    (1.6520, 1.6440, 0.088, 0.091, 0.074),  # 7  nose tip / alae
    (1.6700, 1.6640, 0.087, 0.099, 0.077),  # 8  zygomatic cheekbones
    (1.6880, 1.6840, 0.088, 0.104, 0.078),  # 9  eye line
    (1.7060, 1.7060, 0.093, 0.106, 0.079),  # 10 supraorbital brow ridge
    (1.7280, 1.7280, 0.089, 0.104, 0.078),  # 11 forehead
    (1.7500, 1.7500, 0.081, 0.097, 0.074),  # 12 hairline
    (1.7700, 1.7700, 0.068, 0.084, 0.066),  # 13 parietal
    (1.7860, 1.7860, 0.050, 0.064, 0.052),  # 14 vertex slope
    (1.7960, 1.7960, 0.030, 0.040, 0.034),  # 15 crown
    (1.8015, 1.8015, 0.012, 0.018, 0.014),  # 16 crown apex ring
], dtype=np.float64)
HEAD_SEAM_KEY = 6
HEAD_SUBDIV = [3, 3, 4, 6, 6, 4, 5, 5, 5, 5, 4, 3, 3, 3, 2, 2]
HEAD_SIDES = 64
HEAD_Z0 = -0.006
HEAD_APEX = (0.0, 1.8040, -0.0075)
EYE_CENTER_X = 0.0320
EYE_CENTER_Y = 1.6880
EYE_RADIUS = 0.0120


def head_theta(s):
    a = 2.0 * np.asarray(s, dtype=np.float64) - 1.0
    return math.pi * a - 0.55 * np.sin(math.pi * a)  # denser azimuth sampling across the face


def _catmull_keys(uk):
    K = HEAD_KEYS.shape[0]
    uk = np.clip(np.asarray(uk, dtype=np.float64), 0.0, K - 1.0)
    i = np.clip(np.floor(uk).astype(np.int64), 0, K - 2)
    t = (uk - i)[..., None]
    p0 = HEAD_KEYS[np.clip(i - 1, 0, K - 1)]
    p1 = HEAD_KEYS[i]
    p2 = HEAD_KEYS[i + 1]
    p3 = HEAD_KEYS[np.clip(i + 2, 0, K - 1)]
    return 0.5 * ((2.0 * p1) + (-p0 + p2) * t + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t * t + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t ** 3)


def head_base(uk, s):
    """Base (undisplaced) head surface. Returns x, y, z, nx, nz (XZ outward normal), cos(theta), sin(theta)."""
    uk, s = np.broadcast_arrays(np.asarray(uk, dtype=np.float64), np.asarray(s, dtype=np.float64))
    p = _catmull_keys(uk)
    yf, yb, zf, zb, rx = p[..., 0], p[..., 1], p[..., 2], p[..., 3], p[..., 4]
    th = head_theta(s)
    c, sn = np.cos(th), np.sin(th)
    w = 0.5 + 0.5 * np.tanh(2.4 * c)
    D = zb + (zf - zb) * w
    x = rx * sn
    y = yf + (yb - yf) * (1.0 - c) * 0.5
    z = HEAD_Z0 + D * c
    nx = sn / np.maximum(rx, 1e-4)
    nz = c / np.maximum(D, 1e-4)
    inv = 1.0 / np.sqrt(nx * nx + nz * nz)
    return x, y, z, nx * inv, nz * inv, c, sn


def head_displacement(x, y, c, sn, features: bool = True, nose: bool = True):
    """Anatomical sculpt displacement (metres along the outward XZ normal)."""
    G = _gauss
    ax = np.abs(x)
    d = np.zeros_like(x)
    front = _smooth(0.25, 0.70, c)
    # Supraorbital brow ridge + glabella
    d += 0.0055 * G(y - 1.7070, 0.0075) * G(x, 0.050) * front
    # Occipital bun & temporal hollows (also used for headgear fit)
    d += 0.0030 * G(y - 1.6750, 0.022) * G(c + 1.0, 0.35)
    d += -0.0025 * G(y - 1.7220, 0.014) * G(c - 0.35, 0.22) * np.abs(sn)
    if not features:
        return d
    # Recessed orbital sockets (eyeballs sit inside)
    d += -0.0115 * G(ax - EYE_CENTER_X, 0.0145) * G(y - EYE_CENTER_Y, 0.0095) * front
    if nose:
        yb_ = np.clip((1.700 - y) / 0.050, 0.0, 1.0)
        prof = np.where(y >= 1.650, 0.004 + 0.018 * yb_ ** 1.35, 0.022 * np.clip(1.0 - ((1.650 - y) / 0.0125) ** 2, 0.0, 1.0))
        prof = prof * np.where(y > 1.700, G(y - 1.700, 0.0060), 1.0)
        width = 0.0062 + 0.0050 * yb_
        d += prof * G(x, width) * front
        d += 0.0072 * G(ax - 0.0125, 0.0062) * G(y - 1.6435, 0.0052) * front  # alae / nostril wings
    # Nasolabial contour groove (ala -> mouth corner)
    Ax, Ay, Bx, By = 0.0165, 1.6445, 0.0275, 1.6150
    L2 = (Bx - Ax) ** 2 + (By - Ay) ** 2
    t = np.clip(((ax - Ax) * (Bx - Ax) + (y - Ay) * (By - Ay)) / L2, 0.0, 1.0)
    dist = np.sqrt((ax - (Ax + t * (Bx - Ax))) ** 2 + (y - (Ay + t * (By - Ay))) ** 2)
    d += -0.0016 * G(dist, 0.0028) * front
    # Zygomatic cheekbones
    d += 0.0045 * G(ax - 0.049, 0.016) * G(y - 1.668, 0.012) * _smooth(0.10, 0.50, c)
    # Philtrum, upper/lower lips, stomion line, mentolabial sulcus, chin
    d += -0.0012 * G(x, 0.0040) * G(y - 1.6285, 0.0055) * front
    d += 0.0042 * G(x, 0.0185) * G(y - 1.6185, 0.0040) * front
    d += 0.0048 * G(x, 0.0165) * G(y - 1.6045, 0.0042) * front
    d += -0.0026 * G(x, 0.0205) * G(y - 1.6115, 0.0019) * front
    d += -0.0020 * G(x, 0.0160) * G(y - 1.5960, 0.0036) * front
    d += 0.0060 * G(x, 0.0165) * G(y - 1.5825, 0.0080) * front
    # Gonial jaw angle
    d += 0.0040 * G(y - 1.6020, 0.010) * G(c + 0.15, 0.30) * np.abs(sn)
    return d


def head_surface(uk, s, offset: float = 0.0, features: bool = True, nose: bool = True):
    """Displaced head surface (+ optional outward offset along the true 3D normal) -> (..., 3) array."""
    x, y, z, nx, nz, c, sn = head_base(uk, s)
    d = head_displacement(x, y, c, sn, features=features, nose=nose)
    P = np.stack((x + d * nx, y, z + d * nz), axis=-1)
    if abs(offset) > 0.0:
        P = P + head_normal(uk, s, features=features, nose=nose) * offset
    return P


def head_normal(uk, s, features: bool = True, nose: bool = True):
    """True 3D outward normal from central finite differences of the analytic surface."""
    h_u, h_s = 1e-3, 1e-4
    uk = np.asarray(uk, dtype=np.float64)
    s = np.asarray(s, dtype=np.float64)
    K = HEAD_KEYS.shape[0] - 1
    up = np.clip(uk + h_u, 0.0, K)
    um = np.clip(uk - h_u, 0.0, K)
    Pu = head_surface(up, s, 0.0, features, nose) - head_surface(um, s, 0.0, features, nose)
    Ps = head_surface(uk, s + h_s, 0.0, features, nose) - head_surface(uk, s - h_s, 0.0, features, nose)
    n = np.cross(Ps, Pu)
    # The parametric cross product has ONE consistent handedness over the whole surface; fix the global
    # sign once with a known front-of-face sample (a per-vertex test would flip normals inside lip creases).
    pu_ref = head_surface(9.0 + h_u, 0.5, 0.0, features, nose) - head_surface(9.0 - h_u, 0.5, 0.0, features, nose)
    ps_ref = head_surface(9.0, 0.5 + h_s, 0.0, features, nose) - head_surface(9.0, 0.5 - h_s, 0.0, features, nose)
    if float(np.cross(ps_ref, pu_ref)[2]) < 0.0:
        n = -n
    return n / np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-9)


def head_ring_params() -> np.ndarray:
    uks: List[float] = []
    for k, n in enumerate(HEAD_SUBDIV):
        for j in range(n):
            uks.append(k + j / n)
    uks.append(float(len(HEAD_SUBDIV)))
    return np.array(uks, dtype=np.float64)


def head_uk_at_front_y(y_target: float) -> float:
    grid = np.linspace(0.0, HEAD_KEYS.shape[0] - 1.0, 4001)
    _x, y, _z, _nx, _nz, _c, _sn = head_base(grid, np.full_like(grid, 0.5))
    return float(grid[int(np.argmin(np.abs(y - y_target)))])



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


def add_ring_stack(
    bm: bmesh.types.BMesh,
    rings_pts: Sequence[Sequence[Vector]],
    start_pt: Optional[Vector],
    end_pt: Optional[Vector],
    mat_index: int = 0,
    v_values: Optional[Sequence[float]] = None,
) -> List[List[bmesh.types.BMVert]]:
    """Closed manifold surface through a stack of closed rings (+ optional fan caps)."""
    uv_layer = bm.loops.layers.uv.verify()
    n = len(rings_pts)
    C = len(rings_pts[0])
    vv = list(v_values) if v_values is not None else [i / max(1, n - 1) for i in range(n)]
    rings = [[bm.verts.new(pc_vec_to_bl(_v(p))) for p in ring] for ring in rings_pts]
    for r in range(n - 1):
        for c in range(C):
            cn = (c + 1) % C
            f = bm.faces.new((rings[r][c], rings[r][cn], rings[r + 1][cn], rings[r + 1][c]))
            f.material_index = mat_index
            f.smooth = True
            f.loops[0][uv_layer].uv = (c / C, vv[r])
            f.loops[1][uv_layer].uv = ((c + 1) / C, vv[r])
            f.loops[2][uv_layer].uv = ((c + 1) / C, vv[r + 1])
            f.loops[3][uv_layer].uv = (c / C, vv[r + 1])
    for pt, ring, vc, is_start in ((start_pt, rings[0], vv[0], True), (end_pt, rings[-1], vv[-1], False)):
        if pt is None:
            continue
        cv = bm.verts.new(pc_vec_to_bl(_v(pt)))
        for c in range(C):
            cn = (c + 1) % C
            f = bm.faces.new((cv, ring[cn], ring[c]) if is_start else (cv, ring[c], ring[cn]))
            f.material_index = mat_index
            f.smooth = True
            f.loops[0][uv_layer].uv = (0.5, vc)
            f.loops[1][uv_layer].uv = ((cn if is_start else c) / C, vc)
            f.loops[2][uv_layer].uv = ((c if is_start else cn) / C, vc)
    return rings


def _head_side_frame(theta_target: float, y_target: float):
    """Point + outward normal on the head surface at azimuth theta and (front-ish) height y."""
    s_grid = np.linspace(0.0, 1.0, 20001)
    s_val = float(s_grid[int(np.argmin(np.abs(head_theta(s_grid) - theta_target)))])
    uk_grid = np.linspace(0.0, HEAD_KEYS.shape[0] - 1.0, 3201)
    ys = head_surface(uk_grid, np.full_like(uk_grid, s_val))[:, 1]
    uk_val = float(uk_grid[int(np.argmin(np.abs(ys - y_target)))])
    P = head_surface(uk_val, s_val)
    Nn = head_normal(uk_val, s_val)
    return _v(P), _v(Nn), uk_val, s_val


def add_anatomical_ear(bm: bmesh.types.BMesh, sx: float, mat_index: int) -> None:
    """Curved pinna: helix rim, scapha, antihelix, concha bowl, tragus & lobe, angled back at the mastoid."""
    P_side, N_side, _uk, _s = _head_side_frame(sx * 1.70, 1.6725)
    n_ear = (N_side + Vector((0.0, 0.0, 0.58))).normalized()
    U = Vector((0.0, 1.0, -0.27)).normalized()
    F = U.cross(n_ear)
    if F.z < 0.0:
        F = -F
    F.normalize()
    U = n_ear.cross(F).normalized()
    if U.y < 0.0:
        U = -U
    C = P_side - N_side * 0.0030 + F * 0.001

    NR, NA = 7, 22
    rhos = [i / NR for i in range(1, NR + 1)]

    def outline(phi: float) -> Tuple[float, float]:
        a = 0.0172 * (1.0 - 0.30 * max(0.0, -math.sin(phi)))  # narrower lobe
        b = 0.0330 if math.sin(phi) > 0.0 else 0.0300
        return a, b

    def h_front(rho: float, phi: float) -> float:
        g = lambda v, s: math.exp(-((v / s) ** 2))
        helix = 0.0036 * g(rho - 0.90, 0.085) * (0.6 + 0.4 * max(0.0, math.sin(phi) + 0.3 * -math.cos(phi)))
        antihelix = 0.0026 * g(rho - 0.60, 0.085) * (0.55 + 0.45 * max(0.0, math.sin(phi + 0.6)))
        concha = -0.0048 * g(rho - 0.12, 0.34) * (1.0 - 0.6 * max(0.0, -math.sin(phi)))
        tragus = 0.0040 * g(rho - 0.62, 0.10) * g(phi + 0.25, 0.32)
        lobe = 0.0016 * g(rho - 0.55, 0.30) * max(0.0, -math.sin(phi)) ** 2
        return 0.0058 + helix + antihelix + concha + tragus + lobe

    def h_back(rho: float, phi: float) -> float:
        return -0.0030 + 0.0060 * rho ** 1.5

    def pt(rho: float, phi: float, h: float) -> Vector:
        a, b = outline(phi)
        return C + F * (rho * a * math.cos(phi)) + U * (rho * b * math.sin(phi)) + n_ear * h

    phis = [2.0 * math.pi * j / NA for j in range(NA)]
    rings: List[List[Vector]] = []
    vvals: List[float] = []
    for rho in rhos[:-1]:
        rings.append([pt(rho, ph, h_front(rho, ph)) for ph in phis])
        vvals.append(0.5 * rho)
    rim_h = [0.5 * (h_front(1.0, ph) + h_back(1.0, ph)) for ph in phis]
    rings.append([pt(1.03, ph, rim_h[j]) for j, ph in enumerate(phis)])
    vvals.append(0.5)
    for rho in reversed(rhos[:-1]):
        rings.append([pt(rho, ph, h_back(rho, ph)) for ph in phis])
        vvals.append(1.0 - 0.5 * rho)
    add_ring_stack(bm, rings, C + n_ear * h_front(0.0, 0.0), C + n_ear * h_back(0.0, 0.0), mat_index, vvals)


def add_eyeball(bm: bmesh.types.BMesh, center: Vector, radius: float, fwd: Vector, mat_index: int) -> None:
    """UV sphere with its pole on the visual axis: V = sqrt(polar / pi) so the iris gets texel density."""
    uv_layer = bm.loops.layers.uv.verify()
    fwd = fwd.normalized()
    side = Vector((0.0, 1.0, 0.0)).cross(fwd).normalized()
    up = fwd.cross(side).normalized()
    A, B = 12, 18
    apex_f = bm.verts.new(pc_vec_to_bl(center + fwd * radius))
    apex_b = bm.verts.new(pc_vec_to_bl(center - fwd * radius))
    rings = []
    alphas = []
    for i in range(1, A):
        al = math.pi * (i / A) ** 1.35  # denser near the cornea / iris
        alphas.append(al)
        ring = []
        for j in range(B):
            be = 2.0 * math.pi * j / B
            d = fwd * math.cos(al) + (side * math.cos(be) + up * math.sin(be)) * math.sin(al)
            ring.append(bm.verts.new(pc_vec_to_bl(center + d * radius)))
        rings.append(ring)

    def vco(al: float) -> float:
        return math.sqrt(al / math.pi)

    def face(vs, uvs):
        f = bm.faces.new(vs)
        f.material_index = mat_index
        f.smooth = True
        for lp, uv in zip(f.loops, uvs):
            lp[uv_layer].uv = uv

    for j in range(B):
        jn = (j + 1) % B
        u0, u1 = j / B, (j + 1) / B
        face((apex_f, rings[0][j], rings[0][jn]), ((0.5 * (u0 + u1), 0.0), (u0, vco(alphas[0])), (u1, vco(alphas[0]))))
        for i in range(len(rings) - 1):
            va, vb = vco(alphas[i]), vco(alphas[i + 1])
            face((rings[i][j], rings[i + 1][j], rings[i + 1][jn], rings[i][jn]), ((u0, va), (u0, vb), (u1, vb), (u1, va)))
        face((apex_b, rings[-1][jn], rings[-1][j]), ((0.5 * (u0 + u1), 1.0), (u1, vco(alphas[-1])), (u0, vco(alphas[-1]))))


def add_eyelid(bm: bmesh.types.BMesh, center: Vector, radius: float, e0: float, e1: float, mat_index: int) -> None:
    """Thin 3D eyelid shell hugging the eyeball between elevations e0..e1 (radians)."""
    rows, cols = 4, 12
    a_max = 1.22
    outer, inner = [], []
    for r in range(rows + 1):
        e = e0 + (e1 - e0) * r / rows
        ro, ri = [], []
        margin = 1.0 if r != 0 else 0.0
        for c in range(cols + 1):
            a = -a_max + 2.0 * a_max * c / cols
            ee = e * (1.0 - 0.18 * (abs(a) / a_max) ** 2)  # lid margin curves toward the canthi
            d = Vector((math.sin(a) * math.cos(ee), math.sin(ee), math.cos(a) * math.cos(ee)))
            ro.append(center + d * (radius + 0.0016 + 0.0010 * margin))
            ri.append(center + d * (radius + 0.0004))
        outer.append(ro)
        inner.append(ri)
    add_grid_slab(bm, outer, inner, mat_index)


def build_head_zone_meshes(
    arm_obj: bpy.types.Object,
    pal: Dict[str, bpy.types.Material],
    collection: bpy.types.Collection,
) -> List[bpy.types.Object]:
    """Zone_HEAD_CRANIUM + Zone_HEAD_FACE_JAW sculpted from ONE analytic head surface (zero seam step)."""
    uks = head_ring_params()
    seam_row = int(np.where(np.isclose(uks, float(HEAD_SEAM_KEY)))[0][0])
    S = HEAD_SIDES
    ss = np.arange(S, dtype=np.float64) / S
    UK, SS = np.meshgrid(uks, ss, indexing="ij")
    P = head_surface(UK, SS)
    Nrm = head_normal(UK, SS)
    Kmax = float(HEAD_KEYS.shape[0] - 1)
    V = uks / Kmax

    def build_section(bm: bmesh.types.BMesh, r0: int, r1: int, mat_index: int):
        uv_layer = bm.loops.layers.uv.verify()
        rows: List[List[bmesh.types.BMVert]] = []
        normals: Dict[bmesh.types.BMVert, Vector] = {}
        for r in range(r0, r1 + 1):
            ring = []
            for c in range(S):
                bv = bm.verts.new(pc_vec_to_bl(P[r, c]))
                normals[bv] = _v(Nrm[r, c])
                ring.append(bv)
            rows.append(ring)
        for i in range(len(rows) - 1):
            ra, rb = rows[i], rows[i + 1]
            va, vb = float(V[r0 + i]), float(V[r0 + i + 1])
            for c in range(S):
                cn = (c + 1) % S
                f = bm.faces.new((ra[c], ra[cn], rb[cn], rb[c]))
                f.material_index = mat_index
                f.smooth = True
                f.loops[0][uv_layer].uv = (c / S, va)
                f.loops[1][uv_layer].uv = ((c + 1) / S, va)
                f.loops[2][uv_layer].uv = ((c + 1) / S, vb)
                f.loops[3][uv_layer].uv = (c / S, vb)
        return rows, normals

    def fan(bm: bmesh.types.BMesh, ring, center_pc, v_coord: float, mat_index: int, upward: bool):
        uv_layer = bm.loops.layers.uv.verify()
        cv = bm.verts.new(pc_to_bl(*center_pc))
        for c in range(S):
            cn = (c + 1) % S
            f = bm.faces.new((cv, ring[c], ring[cn]) if upward else (cv, ring[cn], ring[c]))
            f.material_index = mat_index
            f.smooth = True
            f.loops[0][uv_layer].uv = (0.5, v_coord)
            f.loops[1][uv_layer].uv = ((c if upward else cn) / S, v_coord)
            f.loops[2][uv_layer].uv = ((cn if upward else c) / S, v_coord)
        return cv

    objs: List[bpy.types.Object] = []

    # ---- Zone_HEAD_CRANIUM: seam ring -> rounded crown (+ ears, eyeballs, eyelids) ----
    bm = bmesh.new()
    rows, normals = build_section(bm, seam_row, len(uks) - 1, 0)
    apex = fan(bm, rows[-1], HEAD_APEX, 1.0, 0, upward=True)
    normals[apex] = Vector((0.0, 1.0, 0.0))
    # Recessed internal cut cap tucked deep inside the skull (never visible while the jaw is attached)
    fan(bm, rows[0], (0.0, 1.664, -0.012), float(V[seam_row]), 0, upward=False)

    for sx in (-1.0, 1.0):
        add_anatomical_ear(bm, sx, mat_index=1)

    uk_eye = head_uk_at_front_y(EYE_CENTER_Y)
    s_grid = np.linspace(0.5, 0.8, 6001)
    xb, yb_, zb_, _nx, _nz, _c, _sn = head_base(np.full_like(s_grid, uk_eye), s_grid)
    i_eye = int(np.argmin(np.abs(xb - EYE_CENTER_X)))
    z_eye_base = float(zb_[i_eye])
    eye_z = z_eye_base - 0.0035 - EYE_RADIUS
    for sx in (-1.0, 1.0):
        ec = Vector((sx * EYE_CENTER_X, EYE_CENTER_Y, eye_z))
        add_eyeball(bm, ec, EYE_RADIUS, Vector((sx * 0.05, -0.02, 1.0)), mat_index=2)
        add_eyelid(bm, ec, EYE_RADIUS, 0.17, 1.25, mat_index=1)    # upper lid
        add_eyelid(bm, ec, EYE_RADIUS, -0.38, -1.15, mat_index=1)  # lower lid

    objs.append(finalize_skinned_mesh_object(
        "Zone_HEAD_CRANIUM", bm,
        [pal["head_skin"], pal["skin_tone"], pal["eye"]],
        arm_obj, [("Bone_HEAD_CRANIUM", 1.0)], collection,
        custom_normals_pc=normals,
    ))

    # ---- Zone_HEAD_FACE_JAW: under-chin -> IDENTICAL seam ring (lips, chin, gonial angle) ----
    bm = bmesh.new()
    rows, normals = build_section(bm, 0, seam_row, 0)
    fan(bm, rows[0], (0.0, 1.592, 0.010), 0.0, 0, upward=False)   # submental cap hidden inside the throat
    fan(bm, rows[-1], (0.0, 1.611, 0.004), float(V[seam_row]), 0, upward=True)  # internal cut cap inside the mouth
    objs.append(finalize_skinned_mesh_object(
        "Zone_HEAD_FACE_JAW", bm,
        [pal["jaw_skin"]],
        arm_obj, [("Bone_HEAD_FACE_JAW", 1.0)], collection,
        custom_normals_pc=normals,
    ))
    return objs


def _bone_spec(name: str):
    for b_name, parent, head, tail in GHOUL_BONE_SPECS:
        if b_name == name:
            return _v(head), _v(tail)
    raise KeyError(name)


def build_tactical_glove(bm: bmesh.types.BMesh, sx: float) -> None:
    """
    Articulated 5-finger Mechanix/Oakley-style tactical glove built in the hand bone's rest frame.
    Material slots: 0 = synthetic leather glove, 1 = molded carbon knuckle guards, 2 = velcro/polymer strap.
    Palm faces the body at rest (bone local -X for LEFT, +X for RIGHT); thumb points forward (+Z).
    """
    H, Tl = _bone_spec("Bone_HAND_LEFT" if sx < 0 else "Bone_HAND_RIGHT")
    Y = (Tl - H).normalized()
    Z0 = Vector((0.0, 0.0, 1.0))
    Z = (Z0 - Y * Z0.dot(Y)).normalized()
    X = Y.cross(Z)
    N = X * sx   # palm normal
    T = Z        # thumb side

    def P(a: float, b: float, c: float) -> Vector:
        return H + Y * a + T * b + N * c

    # Gauntlet cuff overlapping the forearm wrist band
    add_frame_loft(bm, [
        (P(-0.026, 0.0, 0.0), T, N, 0.0335, 0.0290),
        (P(-0.004, 0.0, 0.0), T, N, 0.0320, 0.0255),
        (P(0.008, 0.0, 0.0), T, N, 0.0285, 0.0200),
    ], sides=16, mat_index=0, dome_start=0.10, dome_end=0.10)

    # Palm / metacarpal block (rounded-rectangle cross-section)
    palm = [(0.000, 0.0255, 0.0170, 0.000), (0.024, 0.0345, 0.0185, 0.001), (0.058, 0.0420, 0.0168, 0.001),
            (0.082, 0.0432, 0.0140, 0.000), (0.094, 0.0395, 0.0110, -0.001)]
    add_frame_loft(bm, [(P(a, 0.0, c), T, N, ra, rb) for a, ra, rb, c in palm],
                   sides=16, mat_index=0, dome_start=0.20, dome_end=0.40, exponent=0.85)

    # Four curled fingers (index straighter for trigger discipline)
    fingers = [
        (0.0290, 0.086, (0.036, 0.022, 0.018), 0.0106, (22.0, 38.0, 20.0)),
        (0.0098, 0.090, (0.040, 0.025, 0.019), 0.0110, (44.0, 74.0, 40.0)),
        (-0.0098, 0.088, (0.037, 0.024, 0.018), 0.0104, (48.0, 78.0, 42.0)),
        (-0.0272, 0.082, (0.029, 0.018, 0.016), 0.0092, (52.0, 80.0, 42.0)),
    ]
    for b, ka, lens, r, curl in fingers:
        p = P(ka, b, 0.001)
        ang = 0.0
        for j in range(3):
            ang += math.radians(curl[j])
            d = Y * math.cos(ang) + N * math.sin(ang)
            Bn = N * math.cos(ang) - Y * math.sin(ang)
            rr = r * (1.0 - 0.08 * j)
            q = p + d * lens[j]
            add_frame_loft(bm, [
                (p, T, Bn, rr * 1.04, rr * 0.92),
                (p + d * (lens[j] * 0.5), T, Bn, rr * 1.00, rr * 0.95),
                (q, T, Bn, rr * 0.96, rr * 0.88),
            ], sides=8, mat_index=0, dome_start=0.55, dome_end=0.80 if j == 2 else 0.55)
            p = q
        # Molded carbon-fibre knuckle guard over each MCP joint
        add_oriented_box(bm, P(ka - 0.002, b, -0.0150), T, Y, -N, (0.0082, 0.0070, 0.0024), 0.0016, mat_index=1)

    # Opposable thumb (metacarpal, proximal, distal) wrapping toward the palm
    tp = P(0.020, 0.030, 0.008)
    t_dirs = [Y * 0.62 + T * 0.62 + N * 0.48, Y * 0.60 + T * 0.30 + N * 0.74, Y * 0.40 + T * 0.04 + N * 0.92]
    t_lens = [0.042, 0.032, 0.027]
    t_rads = [0.0128, 0.0108, 0.0097]
    for j in range(3):
        d = t_dirs[j].normalized()
        Bn = (N - d * N.dot(d)).normalized()
        A = d.cross(Bn).normalized()
        q = tp + d * t_lens[j]
        add_frame_loft(bm, [
            (tp, A, Bn, t_rads[j] * 1.02, t_rads[j] * 0.92),
            (tp + d * (t_lens[j] * 0.5), A, Bn, t_rads[j], t_rads[j] * 0.94),
            (q, A, Bn, t_rads[j] * 0.94, t_rads[j] * 0.88),
        ], sides=8, mat_index=0, dome_start=0.55, dome_end=0.80 if j == 2 else 0.55)
        tp = q

    # Back-of-hand molded TPR plate + wrist velcro strap with pull tab
    add_oriented_box(bm, P(0.050, 0.003, -0.0168), T, Y, -N, (0.026, 0.017, 0.0020), 0.0016, mat_index=0)
    add_frame_loft(bm, [
        (P(0.002, 0.0, 0.0), T, N, 0.0300, 0.0222),
        (P(0.020, 0.0, 0.0), T, N, 0.0315, 0.0222),
    ], sides=16, mat_index=2, dome_start=0.05, dome_end=0.05, exponent=0.9)
    add_oriented_box(bm, P(0.011, -0.006, -0.0222), T, Y, -N, (0.012, 0.0085, 0.0020), 0.0010, mat_index=2)


def build_combat_boot(bm: bmesh.types.BMesh, sx: float) -> None:
    """
    8-inch tactical combat boot grounded at y = 0.000 (Vibram lugs) .. 0.005 (outsole).
    Material slots: 0 = leather/Cordura upper, 1 = Vibram rubber, 2 = laces/polymer, 3 = gunmetal eyelets.
    """
    X0 = sx * 0.115
    Xv, Yv, Zv = Vector((1.0, 0.0, 0.0)), Vector((0.0, 1.0, 0.0)), Vector((0.0, 0.0, 1.0))
    zs = [-0.074, -0.068, -0.052, -0.020, 0.020, 0.060, 0.100, 0.130, 0.158, 0.176, 0.188]
    ws = [0.012, 0.027, 0.038, 0.040, 0.036, 0.043, 0.050, 0.050, 0.045, 0.034, 0.015]
    hu = [0.030, 0.050, 0.066, 0.072, 0.066, 0.052, 0.040, 0.034, 0.028, 0.020, 0.010]

    def xc(z: float) -> float:
        return X0 + sx * 0.010 * max(0.0, z) / 0.19  # natural toe-out

    def w_at(z: float) -> float:
        return float(np.interp(z, zs, ws))

    # Vibram outsole slab (bottom flat at y = 0.005)
    sole_st = []
    for z, w in zip(zs, ws):
        rb = 0.0135 * min(1.0, (w / 0.026) ** 0.5)
        sole_st.append((Vector((xc(z), 0.005 + rb, z)), Xv, Yv, w + 0.002, rb))
    add_frame_loft(bm, sole_st, sides=14, mat_index=1, dome_start=0.25, dome_end=0.25, exponent=0.45)

    # Lugged tread (chevron lugs y = 0.000 .. 0.006)
    z = -0.060
    k = 0
    while z < 0.176:
        w = w_at(z)
        for xo in (-0.017, 0.017):
            if w < 0.030:
                continue
            yaw = math.radians(28.0 if (k % 2 == 0) == (xo <= 0.0) else -28.0)
            ax = Vector((math.cos(yaw), 0.0, -math.sin(yaw)))
            az = Vector((math.sin(yaw), 0.0, math.cos(yaw)))
            add_oriented_box(bm, Vector((xc(z) + xo * (w / 0.045), 0.0032, z)), ax, Yv, az,
                             (0.0070, 0.0032, 0.0052), 0.0, mat_index=1)
        z += 0.026
        k += 1

    # Stitched sole welt around the outline (y ~ 0.032)
    zz = np.linspace(-0.066, 0.184, 12)
    right = [Vector((xc(float(q)) + sx * (w_at(float(q)) + 0.0025), 0.0325, float(q))) for q in zz]
    left = [Vector((xc(float(q)) - sx * (w_at(float(q)) + 0.0025), 0.0325, float(q))) for q in zz[::-1]]
    loop = right + [Vector((xc(0.19), 0.0325, 0.192))] + left + [Vector((xc(-0.07), 0.0325, -0.076))]
    add_tube_path(bm, loop, (0.0032, 0.0026), sides=5, mat_index=1, closed=True)

    # Leather upper: heel counter -> instep vamp -> toe box (flattened bottom tucked into the sole)
    def flat_bottom(i, th, la, lb):
        return la, (lb if lb > 0.0 else lb * 0.15)

    up_st = [(Vector((xc(z), 0.031, z)), Xv, Yv, max(0.006, w - 0.003), h) for z, w, h in zip(zs, ws, hu)]
    add_frame_loft(bm, up_st, sides=16, mat_index=0, dome_start=0.25, dome_end=0.30, exponent=0.9, sculpt_fn=flat_bottom)

    # Rubber toe cap & heel counter overlays
    toe = [(Vector((xc(z), 0.031, z)), Xv, Yv, max(0.006, w_at(z) - 0.001), float(np.interp(z, zs, hu)) * 0.62 + 0.0015)
           for z in (0.128, 0.150, 0.168, 0.180, 0.1895)]
    add_frame_loft(bm, toe, sides=14, mat_index=1, dome_start=0.05, dome_end=0.35, exponent=0.9, sculpt_fn=flat_bottom)
    heel = [(Vector((xc(z), 0.031, z)), Xv, Yv, max(0.008, w_at(z) - 0.001), min(0.034, float(np.interp(z, zs, hu)) + 0.0015))
            for z in (-0.0755, -0.068, -0.052, -0.034)]
    add_frame_loft(bm, heel, sides=14, mat_index=1, dome_start=0.30, dome_end=0.05, exponent=0.9, sculpt_fn=flat_bottom)

    # 8-inch shaft (upper part tucks into the bloused BDU cuff) + padded collar
    add_sculpted_loft(
        bm, (X0, 0.060, -0.006), (X0, 0.190, -0.006),
        [
            (0.00, 0.0440, 0.0540, 0.0, 0.004),
            (0.35, 0.0420, 0.0470, 0.0, 0.0),
            (0.80, 0.0420, 0.0460, 0.0, 0.0),
            (1.00, 0.0440, 0.0480, 0.0, 0.0),
        ],
        sides=14, mat_index=0, start_dome_scale=0.05, end_dome_scale=0.10,
    )

    # Gusseted tongue + crossed laces + gunmetal eyelets following the instep / shaft front
    rungs = [(0.095, 0.0745), (0.082, 0.0805), (0.069, 0.0870), (0.058, 0.0935), (0.051, 0.1010)]
    lace_pts = [Vector((xc(z), y, z)) for z, y in rungs]
    t_dir = (lace_pts[-1] - lace_pts[0]).normalized()
    t_nrm = Xv.cross(t_dir).normalized()
    if t_nrm.z < 0.0:
        t_nrm = -t_nrm
    t_c = (lace_pts[0] + lace_pts[-1]) * 0.5
    add_oriented_box(bm, t_c + t_nrm * 0.0008, Xv, t_dir, t_nrm, (0.0165, 0.0225, 0.0022), 0.0015, mat_index=0)
    for li, base0 in enumerate(lace_pts):
        base = base0 + t_nrm * 0.0042
        jit = t_dir * (0.0040 if li % 2 == 0 else -0.0040)
        add_tube_path(bm, [base - Xv * 0.0170 - jit, base, base + Xv * 0.0170 + jit], (0.0018, 0.0015), sides=5, mat_index=2)
        if li % 2 == 0:
            for side in (-1.0, 1.0):
                add_oriented_box(bm, base + Xv * (side * 0.0188) - t_nrm * 0.0010, Xv, t_dir, t_nrm,
                                 (0.0026, 0.0026, 0.0016), 0.0, mat_index=3)
    # Heel pull tab
    add_oriented_box(bm, Vector((X0, 0.178, -0.064)), Xv, Yv, Zv, (0.010, 0.016, 0.0025), 0.0015, mat_index=2)


def head_s_of_theta(theta: float) -> float:
    s_grid = np.linspace(0.0, 1.0, 20001)
    return float(s_grid[int(np.argmin(np.abs(head_theta(s_grid) - theta)))])


def _hp(uk: float, s: float, offset: float, features: bool = False, nose: bool = False) -> Vector:
    return _v(head_surface(uk, s, offset, features=features, nose=nose))


def _hn(uk: float, s: float) -> Vector:
    return _v(head_normal(uk, s, features=False, nose=False))


def build_plate_carrier(arm_obj, pal, collection) -> bpy.types.Object:
    """JPC/AVS-style plate carrier: swimmer-cut plate bags, MOLLE PALS rows, padded shoulder straps,
    cummerbund, triple STANAG mag pouches with bungee pull tabs, admin pouch, radio + PTT."""
    bm = bmesh.new()
    Yv = Vector((0.0, 1.0, 0.0))
    # Swimmer-cut front & rear plate bags (inner surface clears pectorals / scapulae)
    add_curved_shell_patch_pc(bm, 1.188, 1.456, -0.66, 0.66, 0.196, 0.158, 0.024, center_xz=(0.0, 0.004), cols=12, rows=6, mat_index=0, top_narrow=0.70)
    add_curved_shell_patch_pc(bm, 1.196, 1.458, math.pi - 0.64, math.pi + 0.64, 0.192, 0.142, 0.020, center_xz=(0.0, 0.004), cols=12, rows=6, mat_index=0, top_narrow=0.74)
    # Elastic cummerbund wraps
    for sx in (-1.0, 1.0):
        th_side = sx * (math.pi * 0.5)
        add_curved_shell_patch_pc(bm, 1.196, 1.312, th_side - 0.62, th_side + 0.62, 0.188, 0.140, 0.012, center_xz=(0.0, 0.004), cols=8, rows=3, mat_index=0)
        for yy in (1.214, 1.252, 1.290):  # cummerbund PALS rows
            add_curved_shell_patch_pc(bm, yy, yy + 0.014, th_side - 0.50, th_side + 0.50, 0.201, 0.153, 0.003, center_xz=(0.0, 0.004), cols=4, rows=1, mat_index=1)
    # Front PALS rows above admin pouch + full rear PALS grid
    for yy in (1.392, 1.420):
        add_curved_shell_patch_pc(bm, yy, yy + 0.015, -0.44, 0.44, 0.220, 0.182, 0.003, center_xz=(0.0, 0.004), cols=8, rows=1, mat_index=1)
    for yy in (1.222, 1.258, 1.294, 1.330, 1.366, 1.402):
        add_curved_shell_patch_pc(bm, yy, yy + 0.015, math.pi - 0.50, math.pi + 0.50, 0.212, 0.162, 0.003, center_xz=(0.0, 0.004), cols=6, rows=1, mat_index=1)

    # Padded shoulder straps over the trapezius
    def out_from_chest(p: Vector) -> Vector:
        return (p - Vector((0.0, 1.40, 0.0))).normalized()

    for sx in (-1.0, 1.0):
        pts = [Vector((sx * 0.074, 1.448, 0.158)), Vector((sx * 0.082, 1.494, 0.112)), Vector((sx * 0.089, 1.522, 0.040)),
               Vector((sx * 0.090, 1.524, -0.030)), Vector((sx * 0.084, 1.496, -0.098)), Vector((sx * 0.076, 1.450, -0.140))]
        add_tube_path(bm, pts, (0.024, 0.0075), sides=8, mat_index=0, up_fn=out_from_chest)

    # Triple STANAG mag pouches with bungee retention + pull tabs and visible PMAG baseplates
    for xo in (-0.068, 0.0, 0.068):
        th = math.asin(xo / 0.220)
        ax = Vector((math.cos(th), 0.0, -math.sin(th)))
        az = Vector((math.sin(th), 0.0, math.cos(th)))
        c = Vector((math.sin(th) * 0.236, 1.262, 0.004 + math.cos(th) * 0.198))
        add_oriented_box(bm, c, ax, Yv, az, (0.0315, 0.055, 0.0165), 0.004, mat_index=1)
        mag = c + Yv * 0.064 - az * 0.001
        add_oriented_box(bm, mag, ax, Yv, az, (0.0300, 0.012, 0.0115), 0.003, mat_index=2)
        add_oriented_box(bm, mag + Yv * 0.0125, ax, Yv, az, (0.0315, 0.0025, 0.0125), 0.0012, mat_index=2)
        loop = [c - az * 0.010 + Yv * 0.055, c - az * 0.004 + Yv * 0.080, c + az * 0.010 + Yv * 0.080,
                c + az * 0.018 + Yv * 0.062, c + az * 0.019 + Yv * 0.040]
        add_tube_path(bm, loop, (0.0022, 0.0022), sides=6, mat_index=2)
        add_oriented_box(bm, c + az * 0.0195 + Yv * 0.034, ax, Yv, az, (0.0085, 0.010, 0.0020), 0.0010, mat_index=2)
        # Stitched webbing band across each pouch
        add_oriented_box(bm, c + az * 0.0168 + Yv * 0.010, ax, Yv, az, (0.0322, 0.0075, 0.0012), 0.0006, mat_index=0)

    # Admin pouch with velcro ID panel & zipper pull
    adm = Vector((0.0, 1.360, 0.004 + 0.182 + 0.013))
    add_oriented_box(bm, adm, Vector((1.0, 0.0, 0.0)), Yv, Vector((0.0, 0.0, 1.0)), (0.072, 0.021, 0.013), 0.004, mat_index=1)
    add_oriented_box(bm, adm + Vector((0.0, 0.0, 0.0135)), Vector((1.0, 0.0, 0.0)), Yv, Vector((0.0, 0.0, 1.0)), (0.040, 0.013, 0.0012), 0.0008, mat_index=2)
    add_oriented_box(bm, adm + Vector((0.055, 0.022, 0.006)), Vector((1.0, 0.0, 0.0)), Yv, Vector((0.0, 0.0, 1.0)), (0.004, 0.006, 0.0018), 0.0008, mat_index=3)

    # Radio pouch (rear-left), radio body, whip antenna, PTT on the shoulder strap + cable
    th_r = -2.2
    axr = Vector((math.cos(th_r), 0.0, -math.sin(th_r)))
    azr = Vector((math.sin(th_r), 0.0, math.cos(th_r)))
    cr = Vector((math.sin(th_r) * 0.236, 1.262, 0.004 + math.cos(th_r) * 0.180))
    add_oriented_box(bm, cr, axr, Yv, azr, (0.026, 0.050, 0.020), 0.004, mat_index=1)
    add_oriented_box(bm, cr + Yv * 0.060, axr, Yv, azr, (0.022, 0.014, 0.016), 0.003, mat_index=2)
    add_tube_path(bm, [cr + Yv * 0.074 + axr * 0.010, cr + Yv * 0.150 + axr * 0.006 - azr * 0.004, cr + Yv * 0.235 - azr * 0.016],
                  (0.0032, 0.0032), sides=6, mat_index=2)
    add_tube_path(bm, [cr + Yv * 0.062 - axr * 0.016, Vector((-0.190, 1.335, 0.070)), Vector((-0.120, 1.420, 0.160)), Vector((-0.080, 1.458, 0.168))],
                  (0.0024, 0.0024), sides=6, mat_index=2)
    add_oriented_box(bm, Vector((-0.078, 1.468, 0.172)), Vector((1.0, 0.0, 0.0)), Yv, Vector((0.0, 0.0, 1.0)), (0.013, 0.017, 0.0085), 0.003, mat_index=2)
    add_oriented_box(bm, Vector((-0.078, 1.468, 0.181)), Vector((1.0, 0.0, 0.0)), Yv, Vector((0.0, 0.0, 1.0)), (0.008, 0.008, 0.0016), 0.0008, mat_index=3)

    return finalize_skinned_mesh_object(
        "Gear_ESAPI_PlateCarrier", bm,
        [pal["esapi_plate"], pal["webbing_tan"], pal["polymer_dark"], pal["metal_hw"]],
        arm_obj, [("Bone_TORSO_UPPER_THORAX", 0.88), ("Bone_TORSO_LOWER_ABDOMEN", 0.12)], collection,
    )


def build_helmet(arm_obj, pal, collection) -> bpy.types.Object:
    """Low-sitting Ops-Core FAST high-cut ballistic helmet hugging brow & temples, Wilcox NVG shroud,
    ARC side rails, velcro panels, rubber edge trim and 4-point chinstrap retention."""
    bm = bmesh.new()
    C, R = 40, 10
    Kmax = float(HEAD_KEYS.shape[0] - 1)
    s_cols = [c / C for c in range(C)]
    rim_uk = [float(np.interp(abs(float(head_theta(s))), [0.0, 0.70, 1.20, 1.85, 2.30, math.pi],
                              [10.70, 10.86, 11.55, 11.55, 9.70, 8.75])) for s in s_cols]
    outer_rings, inner_rings, trim = [], [], []
    for r in range(R):
        f = (r / R) ** 0.85
        o_ring, i_ring = [], []
        for c, s in enumerate(s_cols):
            uk = rim_uk[c] + (Kmax - rim_uk[c]) * f
            flare = 0.0025 if r == 0 else 0.0
            o_ring.append(_hp(uk, s, 0.0245 + flare))
            i_ring.append(_hp(uk, s, 0.0105))
            if r == 0:
                trim.append(_hp(uk, s, 0.0175))
        outer_rings.append(o_ring)
        inner_rings.append(i_ring)
    apex = Vector(HEAD_APEX)
    add_wrapped_dome_slab(bm, outer_rings, inner_rings, apex + Vector((0.0, 0.0245, 0.0)), apex + Vector((0.0, 0.0105, 0.0)), mat_index=0)

    def out_from_head(p: Vector) -> Vector:
        return (p - Vector((0.0, 1.70, -0.006))).normalized()

    add_tube_path(bm, trim, (0.0072, 0.0050), sides=5, mat_index=1, closed=True, up_fn=out_from_head)

    # Wilcox-style NVG shroud on the front
    s0 = 0.5
    sp = _hp(11.65, s0, 0.0245)
    sn = _hn(11.65, s0)
    up = (Vector((0.0, 1.0, 0.0)) - sn * sn.y).normalized()
    add_oriented_box(bm, sp + sn * 0.006, Vector((1.0, 0.0, 0.0)), up, sn, (0.024, 0.017, 0.0065), 0.003, mat_index=2)
    add_oriented_box(bm, sp + sn * 0.013 - up * 0.004, Vector((1.0, 0.0, 0.0)), up, sn, (0.010, 0.010, 0.0035), 0.002, mat_index=2)
    # Bungee retention cords from the shroud to the rear
    for sx in (-1.0, 1.0):
        pts = [_hp(11.9, head_s_of_theta(sx * th), 0.0262) for th in (0.30, 0.80, 1.40, 2.00, 2.55)]
        add_tube_path(bm, pts, (0.0018, 0.0018), sides=5, mat_index=1)

    # ARC accessory side rails
    for sx in (-1.0, 1.0):
        o_rows, i_rows = [], []
        for uk in (11.95, 12.25, 12.55):
            o_row, i_row = [], []
            for k in range(9):
                th = sx * (1.00 + 1.00 * k / 8.0)
                s = head_s_of_theta(th)
                o_row.append(_hp(uk, s, 0.0325))
                i_row.append(_hp(uk, s, 0.0230))
            o_rows.append(o_row if sx > 0 else o_row[::-1])
            i_rows.append(i_row if sx > 0 else i_row[::-1])
        add_grid_slab(bm, o_rows, i_rows, mat_index=1)

    # Velcro loop panels on crown & rear
    for (uk0, uk1, s0, s1) in ((14.0, 15.4, 0.43, 0.57), (11.8, 13.4, 0.02, 0.10)):
        o_rows, i_rows = [], []
        for uk in np.linspace(uk0, uk1, 3):
            o_rows.append([_hp(float(uk), float(s), 0.0262) for s in np.linspace(s0, s1, 4)])
            i_rows.append([_hp(float(uk), float(s), 0.0240) for s in np.linspace(s0, s1, 4)])
        add_grid_slab(bm, o_rows, i_rows, mat_index=3)

    # 4-point chinstrap retention + buckles + chin cup
    path = [(11.30, 1.25), (9.60, 1.30), (7.60, 1.38), (5.20, 1.44), (3.20, 1.32), (1.70, 0.98), (0.80, 0.45), (0.45, 0.0)]
    pts_r = [_hp(uk, head_s_of_theta(th), 0.0040, features=True, nose=False) for uk, th in path]
    pts_l = [_hp(uk, head_s_of_theta(-th), 0.0040, features=True, nose=False) for uk, th in path]
    add_tube_path(bm, pts_l + pts_r[::-1][1:], (0.0062, 0.0016), sides=6, mat_index=3, up_fn=out_from_head)
    for sx in (-1.0, 1.0):
        rear = [_hp(uk, head_s_of_theta(sx * th), 0.0040, features=True, nose=False) for uk, th in ((9.6, 2.25), (8.2, 1.95), (7.0, 1.55))]
        add_tube_path(bm, rear, (0.0055, 0.0016), sides=6, mat_index=3, up_fn=out_from_head)
        s_b = head_s_of_theta(sx * 1.47)
        nb = _v(head_normal(5.6, s_b))
        add_oriented_box(bm, _hp(5.6, s_b, 0.0062, features=True, nose=False), Vector((0.0, 0.0, 1.0)), Vector((0.0, 1.0, 0.0)), nb,
                         (0.0085, 0.011, 0.0028), 0.0015, mat_index=1)
    return finalize_skinned_mesh_object(
        "Gear_PASGT_Helmet", bm,
        [pal["helmet_kevlar"], pal["polymer_dark"], pal["metal_hw"], pal["webbing_tan"]],
        arm_obj, [("Bone_HEAD_CRANIUM", 1.0)], collection,
    )


def build_visor(arm_obj, pal, collection) -> bpy.types.Object:
    """Wrap-around ballistic eye-pro: tinted polycarbonate lens, top frame bar & temple arms over the ears."""
    bm = bmesh.new()
    uks = np.linspace(8.05, 9.95, 6)
    ths = np.linspace(-1.30, 1.30, 19)
    outer = [[_hp(float(uk), head_s_of_theta(float(th)), 0.0190) for th in ths] for uk in uks]
    inner = [[_hp(float(uk), head_s_of_theta(float(th)), 0.0168) for th in ths] for uk in uks]
    add_grid_slab(bm, outer, inner, mat_index=0, rim_mat_index=1)
    top = [_hp(10.02, head_s_of_theta(float(th)), 0.0186) for th in ths]
    add_tube_path(bm, top, (0.0030, 0.0024), sides=6, mat_index=1)
    for sx in (-1.0, 1.0):
        arm = [_hp(uk, head_s_of_theta(sx * th), off) for uk, th, off in
               ((9.95, 1.28, 0.0180), (10.05, 1.55, 0.0095), (10.05, 1.85, 0.0075), (9.55, 2.12, 0.0045))]
        add_tube_path(bm, arm, (0.0028, 0.0020), sides=6, mat_index=1)
    return finalize_skinned_mesh_object(
        "Gear_TacticalVisor", bm, [pal["visor_glass"], pal["polymer_dark"]],
        arm_obj, [("Bone_HEAD_CRANIUM", 1.0)], collection,
    )


def build_beret(arm_obj, pal, collection) -> bpy.types.Object:
    """Felted Spetsnaz beret draped to one side over a leather sweatband with a cap badge."""
    bm = bmesh.new()
    C, R = 32, 7
    Kmax = float(HEAD_KEYS.shape[0] - 1)
    s_cols = [c / C for c in range(C)]
    rims = []
    for s in s_cols:
        th = float(head_theta(s))
        rims.append(11.30 - 1.00 * max(0.0, math.sin(th)) ** 2)
    outer_rings, inner_rings, band = [], [], []
    for r in range(R):
        f = (r / R) ** 0.8
        o_ring, i_ring = [], []
        for c, s in enumerate(s_cols):
            th = float(head_theta(s))
            uk = rims[c] + (Kmax - rims[c]) * f
            puff = 0.030 * max(0.0, math.sin(th)) ** 1.2 * math.sin(math.pi * min(1.0, f * 1.15)) + 0.010 * math.sin(math.pi * f)
            o_ring.append(_hp(uk, s, 0.0085 + puff))
            i_ring.append(_hp(uk, s, 0.0040))
            if r == 0:
                band.append(_hp(uk, s, 0.0068))
        outer_rings.append(o_ring)
        inner_rings.append(i_ring)
    apex = Vector(HEAD_APEX)
    add_wrapped_dome_slab(bm, outer_rings, inner_rings, apex + Vector((0.016, 0.020, 0.0)), apex + Vector((0.0, 0.004, 0.0)), mat_index=0)
    add_tube_path(bm, band, (0.0046, 0.0034), sides=6, mat_index=1, closed=True,
                  up_fn=lambda p: (p - Vector((0.0, 1.70, -0.006))).normalized())
    s_b = head_s_of_theta(-0.55)
    nb = _hn(11.7, s_b)
    add_oriented_box(bm, _hp(11.7, s_b, 0.0125), Yaxis_cross(nb), Vector((0.0, 1.0, 0.0)), nb, (0.0075, 0.0095, 0.0020), 0.0015, mat_index=2)
    return finalize_skinned_mesh_object(
        "Gear_SpetsnazBeret", bm, [pal["beret_crimson"], pal["polymer_dark"], pal["metal_hw"]],
        arm_obj, [("Bone_HEAD_CRANIUM", 1.0)], collection,
    )


def Yaxis_cross(n: Vector) -> Vector:
    v = Vector((0.0, 1.0, 0.0)).cross(n)
    return v.normalized() if v.length > 1e-6 else Vector((1.0, 0.0, 0.0))


def build_mohawk(arm_obj, pal, collection) -> bpy.types.Object:
    """Gelled punk mohawk: shaved-in crest strip + 7 swept liberty spikes along the sagittal midline."""
    bm = bmesh.new()

    def mid(t: float) -> Tuple[float, float]:
        if t <= 0.5:
            return 12.30 + (16.0 - 12.30) * (t / 0.5), 0.5
        return 16.0 - (16.0 - 9.60) * ((t - 0.5) / 0.5), 0.0

    crest = []
    for k in range(17):
        uk, s = mid(k / 16.0)
        crest.append(_hp(uk, s, 0.0030))
    add_tube_path(bm, crest, (0.0115, 0.0040), sides=8, mat_index=0,
                  up_fn=lambda p: (p - Vector((0.0, 1.70, -0.006))).normalized())
    for k in range(7):
        t = 0.06 + 0.86 * k / 6.0
        uk, s = mid(t)
        base = _hp(uk, s, 0.002)
        n = _hn(min(uk, 15.6), s)
        d = (n + Vector((0.0, 0.25, -0.30))).normalized()
        length = 0.062 + 0.018 * math.sin(math.pi * t)
        tip = base + d * length
        add_sculpted_loft(
            bm, tuple(base), tuple(tip),
            [(0.00, 0.0085, 0.0200, 0.0, 0.0), (0.45, 0.0060, 0.0130, 0.0, 0.0), (1.00, 0.0012, 0.0024, 0.0, 0.0)],
            sides=8, mat_index=0, start_dome_scale=0.15, end_dome_scale=0.40,
        )
    return finalize_skinned_mesh_object(
        "Gear_PunkMohawk", bm, [pal["mohawk_punk"]],
        arm_obj, [("Bone_HEAD_CRANIUM", 1.0)], collection,
    )


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
    add_curved_shell_patch_pc(bm, 0.964, 1.022, -math.pi * 0.99, math.pi * 0.99, 0.171, 0.118, 0.008, cols=28, rows=2, mat_index=1)
    add_curved_shell_patch_pc(bm, 0.970, 1.016, -0.16, 0.16, 0.179, 0.126, 0.007, cols=4, rows=2, mat_index=2)
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
        bm, (0.0, 1.485, -0.004), (0.0, 1.612, -0.014),
        [
            (0.00, 0.076, 0.072, 0.0, 0.0),
            (0.32, 0.067, 0.064, 0.0, 0.0),
            (0.70, 0.059, 0.056, 0.0, -0.002),
            (1.00, 0.054, 0.050, 0.0, -0.004),
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

    # 5..6. Zone_HEAD_CRANIUM + Zone_HEAD_FACE_JAW — unified analytic anatomical head (seamless maxilla seam,
    #        3D eyes in recessed orbits, eyelids, brow ridge, nose, lips, chin, gonial angle, sculpted ears)
    objs.extend(build_head_zone_meshes(arm_obj, pal, collection))

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

        # Hand — articulated 5-finger Mechanix/Oakley tactical glove (carbon knuckles, velcro wrist strap)
        bm = bmesh.new()
        build_tactical_glove(bm, sx)
        objs.append(finalize_skinned_mesh_object(
            f"Zone_HAND_{side_label}", bm,
            [pal["glove_leather"], pal["carbon"], pal["polymer_dark"]],
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

        # Foot — 8-inch tactical combat boot: Vibram lugs, welt, toe cap, heel counter, tongue & laces
        bm = bmesh.new()
        build_combat_boot(bm, sx)
        objs.append(finalize_skinned_mesh_object(
            f"Zone_FOOT_{side_label}", bm,
            [pal["boot_leather"], pal["boot_rubber"], pal["polymer_dark"], pal["metal_hw"]],
            arm_obj, [(f"Bone_FOOT_{side_label}", 1.0)], collection,
        ))

    # -----------------------------------------------------------------------
    # Modular Ballistic Armor, Archetype Headgear & Gore Submeshes
    # -----------------------------------------------------------------------
    objs.append(build_plate_carrier(arm_obj, pal, collection))
    objs.append(build_helmet(arm_obj, pal, collection))
    objs.append(build_visor(arm_obj, pal, collection))
    objs.append(build_beret(arm_obj, pal, collection))
    objs.append(build_mohawk(arm_obj, pal, collection))

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


def _bl_to_pc(v: Vector) -> Tuple[float, float, float]:
    return (v.x, v.z, -v.y)


def pose_bone_head_pc(arm_obj: bpy.types.Object, bone_name: str) -> Vector:
    bpy.context.view_layer.update()
    return Vector(_bl_to_pc(arm_obj.pose.bones[bone_name].matrix.translation))


def solve_arm_ik_pc(
    arm_obj: bpy.types.Object,
    upper_name: str,
    fore_name: str,
    hand_name: str,
    wrist_target_pc: Vector,
    pole_pc: Vector,
    hand_dir_pc: Vector,
    palm_dir_pc: Vector,
    hand_sx: float,
) -> Vector:
    """
    Analytic 2-bone IK: places the wrist (hand bone head) on `wrist_target_pc` with the elbow bent toward
    `pole_pc`, then orients the gloved hand so its long axis follows `hand_dir_pc` and the palm faces
    `palm_dir_pc` (palm normal == hand_sx * bone local X). Returns the achieved wrist position (pc).
    """
    bpy.context.view_layer.update()
    pb_u = arm_obj.pose.bones[upper_name]
    pb_f = arm_obj.pose.bones[fore_name]
    S = pb_u.matrix.translation.copy()
    L1, L2 = pb_u.bone.length, pb_f.bone.length
    T = pc_vec_to_bl(wrist_target_pc)
    d = T - S
    dist = min(max(d.length, 1e-4), (L1 + L2) * 0.995)
    dn = d.normalized()
    a = (L1 * L1 - L2 * L2 + dist * dist) / (2.0 * dist)
    h = math.sqrt(max(0.0, L1 * L1 - a * a))
    pole = pc_vec_to_bl(pole_pc)
    pp = pole - dn * pole.dot(dn)
    if pp.length < 1e-5:
        pp = Vector((0.0, 0.0, -1.0)) - dn * (-dn.z)
    pp.normalize()
    E = S + dn * a + pp * h
    W = S + dn * dist

    yh = Vector(hand_dir_pc).normalized()
    palm = Vector(palm_dir_pc)
    palm = (palm - yh * palm.dot(yh)).normalized()
    xh = palm * hand_sx
    zh = xh.cross(yh).normalized()

    aim_pose_bone_pc(arm_obj, upper_name, _bl_to_pc(E - S))
    aim_pose_bone_pc(arm_obj, fore_name, _bl_to_pc(W - E), z_hint_pc=tuple(zh))
    aim_pose_bone_pc(arm_obj, hand_name, tuple(yh), z_hint_pc=tuple(zh))
    return pose_bone_head_pc(arm_obj, hand_name)


def apply_combat_ready_pose(arm_obj: bpy.types.Object, breath: float = 0.0, southpaw: bool = False) -> None:
    reset_armature_pose(arm_obj)
    sgn = -1.0 if southpaw else 1.0
    tw = -sgn  # bladed stance: support shoulder rotates forward, trigger shoulder back
    set_pelvis_offset_pc(arm_obj, 0.0, -0.032 + breath * 0.008, 0.0)
    aim_pose_bone_pc(arm_obj, "Bone_PELVIS_GROIN", (0.0, 1.0, 0.05), twist_deg=10.0 * tw)
    aim_pose_bone_pc(arm_obj, "Bone_TORSO_LOWER_ABDOMEN", (0.0, 1.0, 0.09 + breath * 0.02), twist_deg=8.0 * tw)
    aim_pose_bone_pc(arm_obj, "Bone_TORSO_UPPER_THORAX", (0.0, 1.0, 0.14 + breath * 0.025), twist_deg=7.0 * tw)
    aim_pose_bone_pc(arm_obj, "Bone_NECK_CERVICAL", (0.0, 1.0, 0.04), twist_deg=-11.0 * tw)
    aim_pose_bone_pc(arm_obj, "Bone_HEAD_CRANIUM", (0.0, 1.0, -0.02), twist_deg=-13.0 * tw)

    # Rifle line: buttstock in the trigger-side shoulder pocket, muzzle forward & slightly depressed.
    tx = 1.0 if southpaw else -1.0  # world X side of the trigger arm
    trig_upper = side_bone("UPPER_ARM", "TRIGGER", southpaw)
    supp_upper = side_bone("UPPER_ARM", "SUPPORT", southpaw)
    shoulder = pose_bone_head_pc(arm_obj, trig_upper)
    pocket = shoulder + Vector((-tx * 0.050, -0.030 - breath * 0.004, 0.070))
    G = Vector((-tx * 0.10, -0.075 - breath * 0.01, 1.0)).normalized()
    grip_wrist = pocket + G * 0.185 + Vector((0.0, -0.085, 0.0))
    fore_wrist = grip_wrist + G * 0.235 + Vector((-tx * 0.004, 0.010, 0.0))

    # Trigger hand: wraps the pistol grip, palm toward the receiver, elbow tucked down/out.
    solve_arm_ik_pc(
        arm_obj, trig_upper, side_bone("FOREARM", "TRIGGER", southpaw), side_bone("HAND", "TRIGGER", southpaw),
        grip_wrist, Vector((tx * 0.55, -0.82, -0.12)),
        G + Vector((0.0, -0.42, 0.0)), Vector((-tx, 0.05, 0.0)), tx,
    )
    # Support hand: cradles the handguard ~23.5 cm forward along the barrel line, palm up & inward.
    solve_arm_ik_pc(
        arm_obj, supp_upper, side_bone("FOREARM", "SUPPORT", southpaw), side_bone("HAND", "SUPPORT", southpaw),
        fore_wrist, Vector((-tx * 0.30, -0.92, 0.05)),
        G * 0.80 + Vector((tx * 0.48, 0.06, 0.0)), Vector((tx * 0.50, 0.85, 0.0)), -tx,
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


def quantize_glb_skin_weights(path: str) -> None:
    """
    Repacks every float WEIGHTS_0 accessor as normalized UNSIGNED_BYTE (valid core glTF 2.0) so the
    high-resolution sculpted combatant stays well inside the 2 MB runtime budget. Rows are renormalized
    to sum exactly 255, so single-bone severable zones keep a 255/255 = 1.0 primary weight.
    """
    import json
    import struct

    data = open(path, "rb").read()
    json_len = struct.unpack("<I", data[12:16])[0]
    gltf = json.loads(data[20:20 + json_len].decode("utf-8"))
    bin_off = 20 + json_len
    bin_len = struct.unpack("<I", data[bin_off:bin_off + 4])[0]
    binary = data[bin_off + 8:bin_off + 8 + bin_len]

    accessors = gltf["accessors"]
    views = gltf["bufferViews"]
    view_users: Dict[int, int] = {}
    for acc in accessors:
        if "bufferView" in acc:
            view_users[acc["bufferView"]] = view_users.get(acc["bufferView"], 0) + 1

    new_view_bytes: Dict[int, bytes] = {}
    for mesh in gltf.get("meshes", []):
        for prim in mesh["primitives"]:
            a_idx = prim["attributes"].get("WEIGHTS_0")
            if a_idx is None:
                continue
            acc = accessors[a_idx]
            bv_idx = acc.get("bufferView")
            if acc["componentType"] != 5126 or bv_idx is None or view_users.get(bv_idx, 0) != 1 or bv_idx in new_view_bytes:
                continue
            bv = views[bv_idx]
            stride = bv.get("byteStride", 16)
            start = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
            rows = np.lib.stride_tricks.as_strided(
                np.frombuffer(binary, dtype="<f4", count=(stride // 4) * (acc["count"] - 1) + 4, offset=start),
                shape=(acc["count"], 4), strides=(stride, 4),
            ).astype(np.float64)
            sums = np.maximum(rows.sum(axis=1, keepdims=True), 1e-9)
            q = np.floor(rows / sums * 255.0 + 0.5).astype(np.int32)
            diff = 255 - q.sum(axis=1)
            amax = np.argmax(q, axis=1)
            q[np.arange(q.shape[0]), amax] += diff
            new_view_bytes[bv_idx] = np.clip(q, 0, 255).astype(np.uint8).tobytes()
            acc["componentType"] = 5121
            acc["normalized"] = True
            acc["byteOffset"] = 0
            acc.pop("min", None)
            acc.pop("max", None)

    if not new_view_bytes:
        return
    out = bytearray()
    for i, bv in enumerate(views):
        chunk = new_view_bytes.get(i)
        if chunk is None:
            o = bv.get("byteOffset", 0)
            chunk = binary[o:o + bv["byteLength"]]
        else:
            bv.pop("byteStride", None)
        while len(out) % 4:
            out.append(0)
        bv["byteOffset"] = len(out)
        bv["byteLength"] = len(chunk)
        out.extend(chunk)
    while len(out) % 4:
        out.append(0)
    gltf["buffers"][0]["byteLength"] = len(out)

    js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    js += b" " * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(out)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, total))
        fh.write(struct.pack("<II", len(js), 0x4E4F534A))
        fh.write(js)
        fh.write(struct.pack("<II", len(out), 0x004E4942))
        fh.write(bytes(out))


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
        export_image_format="JPEG",
        export_jpeg_quality=86,
        export_skins=True,
        export_all_influences=False,
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_rest_position_armature=True,
        export_lights=False,
    )
    quantize_glb_skin_weights(OUT_GLB)

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
