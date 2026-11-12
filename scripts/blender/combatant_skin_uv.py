"""Puts the rigid parts (head, hands, boots, hat) on the skin atlas, and builds the parts that only exist for it."""

import math
from typing import Callable, Sequence

import bmesh
from mathutils import Vector

from combatant_skin_atlas import rect_uv


def _pc(co) -> Vector:
    """Blender vertex position -> PlayCanvas / glTF coordinates."""
    return Vector((co.x, co.z, -co.y))


def remap_faces(bm: bmesh.types.BMesh, faces: Sequence, rect: str) -> None:
    """Moves faces whose UVs already fill 0..1 into an atlas rectangle."""
    uv_layer = bm.loops.layers.uv.verify()
    for face in faces:
        face.material_index = 0
        for loop in face.loops:
            u, v = loop[uv_layer].uv
            loop[uv_layer].uv = rect_uv(rect, min(1.0, max(0.0, u)), min(1.0, max(0.0, v)))


def swatch_faces(bm: bmesh.types.BMesh, faces: Sequence, rect: str) -> None:
    """Gives faces one flat colour from the middle of a swatch rectangle."""
    uv_layer = bm.loops.layers.uv.verify()
    for face in faces:
        face.material_index = 0
        for loop in face.loops:
            loop[uv_layer].uv = rect_uv(rect, 0.5, 0.5)


def project_hand(bm: bmesh.types.BMesh, rect: str, wrist: Vector, axis: Vector, thumb: Vector, palm: Vector) -> None:
    """U runs from the middle of the back of the hand (0) round to the middle of the palm (1); V from cuff to fingertips."""
    uv_layer = bm.loops.layers.uv.verify()
    for face in bm.faces:
        face.material_index = 0
        for loop in face.loops:
            p = _pc(loop.vert.co) - wrist
            u = abs(math.atan2(p.dot(thumb), -p.dot(palm))) / math.pi
            loop[uv_layer].uv = rect_uv(rect, u, min(1.0, max(0.0, (p.dot(axis) + 0.03) / 0.20)))


def project_boot(bm: bmesh.types.BMesh, rect: str) -> None:
    """Side view: U heel to toe, V ground to the top of the shaft."""
    uv_layer = bm.loops.layers.uv.verify()
    for face in bm.faces:
        face.material_index = 0
        for loop in face.loops:
            p = _pc(loop.vert.co)
            loop[uv_layer].uv = rect_uv(rect, min(1.0, max(0.0, (p.z + 0.08) / 0.275)), min(1.0, max(0.0, p.y / 0.215)))


def build_boonie(surface: Callable[[float, float, float], Vector], to_blender: Callable, centre_z: float) -> bmesh.types.BMesh:
    """A soft jungle hat: a flat brim and a low, boxy crown. `surface(uk, s, offset)` is the head surface."""
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.verify()
    columns, rim = 16, 11.15
    rings, vs = [], []
    brim = []
    for c in range(columns):
        s = c / columns
        base = surface(rim, s, 0.012)
        out = Vector((base.x, 0.0, base.z - centre_z)).normalized()
        wave = 0.005 * math.sin(4 * math.pi * s) - 0.006 * math.cos(2 * math.pi * s)
        brim.append(base + out * 0.064 + Vector((0.0, -0.009 + wave, 0.0)))
    rings.append(brim)
    vs.append(0.0)
    for t, v in ((0.0, 0.45), (0.4, 0.62), (0.8, 0.80), (1.0, 0.90)):
        rings.append([surface(rim + (14.3 - rim) * t, c / columns, 0.012 + 0.012 * t) for c in range(columns)])
        vs.append(v)
    top_y = max(p.y for p in rings[-1]) + 0.004
    rings.append([Vector((p.x * 0.55, top_y, centre_z + (p.z - centre_z) * 0.55)) for p in rings[-1]])
    vs.append(0.97)
    verts = [[bm.verts.new(to_blender(p)) for p in ring] for ring in rings]
    for r in range(len(rings) - 1):
        for c in range(columns):
            cn = (c + 1) % columns
            face = bm.faces.new((verts[r][c], verts[r][cn], verts[r + 1][cn], verts[r + 1][c]))
            face.smooth = True
            for loop, uv in zip(face.loops, ((c / columns, vs[r]), ((c + 1) / columns, vs[r]),
                                             ((c + 1) / columns, vs[r + 1]), (c / columns, vs[r + 1]))):
                loop[uv_layer].uv = rect_uv("SWATCH_HAT", *uv)
    apex = bm.verts.new(to_blender(Vector((0.0, top_y + 0.002, centre_z))))
    for c in range(columns):
        cn = (c + 1) % columns
        face = bm.faces.new((apex, verts[-1][c], verts[-1][cn]))
        face.smooth = True
        for loop, uv in zip(face.loops, ((0.5, 1.0), (c / columns, 0.97), ((c + 1) / columns, 0.97))):
            loop[uv_layer].uv = rect_uv("SWATCH_HAT", *uv)
    return bm


def build_skin_library(count: int, to_blender: Callable) -> bmesh.types.BMesh:
    """One hidden triangle per skin page, so every page travels inside the GLB. Face i uses material slot i."""
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.verify()
    for index in range(count):
        y = 0.94 + 0.004 * index
        corners = [bm.verts.new(to_blender(Vector(p))) for p in ((-0.002, y, 0.0), (0.002, y, 0.0), (0.0, y + 0.003, 0.0))]
        face = bm.faces.new(corners)
        face.material_index = index
        for loop in face.loops:
            loop[uv_layer].uv = rect_uv("SWATCH_SKIN", 0.5, 0.5)
    return bm
