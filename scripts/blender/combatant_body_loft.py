"""Continuous skinned lofts for the combatant body, split into GHOUL zone meshes.

A chain is one smooth surface through a list of stations (a spine, an arm, a leg). It is cut
into zone meshes at shared rings: both neighbours get identical positions, normals and skin
weights there, so the surface reads as one piece. Every vertex is weighted only to its own
zone's bone and that bone's parent, which lets the runtime make a severed zone rigid.

Coordinates are PlayCanvas / glTF: +Y up, +Z front. `pc_to_bl` converts to Blender.
"""

import math
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import bmesh
import bpy
import numpy as np
from mathutils import Vector

from combatant_skin_atlas import ChainMap, rect_uv

Sculpt = Callable[[np.ndarray, float, float], float]


def pc_to_bl(p) -> Vector:
    return Vector((float(p[0]), -float(p[2]), float(p[1])))


@dataclass
class Station:
    center: Tuple[float, float, float]
    rx: float                      # half-width along `right`
    rf: float                      # half-depth toward the front
    rb: Optional[float] = None     # half-depth toward the back, defaults to rf
    zone: Optional[str] = None     # names the zone that starts at this station
    right: Optional[Tuple[float, float, float]] = None
    exponent: float = 2.0          # 2 is an ellipse, larger is boxier


@dataclass
class ZoneMesh:
    bm: bmesh.types.BMesh
    normals: Dict[bmesh.types.BMVert, Vector] = field(default_factory=dict)
    own_weight: Dict[bmesh.types.BMVert, float] = field(default_factory=dict)


def _unit(v: np.ndarray) -> np.ndarray:
    return v / max(1e-9, float(np.linalg.norm(v)))


def _catmull(p0, p1, p2, p3, t: float):
    return 0.5 * ((2 * p1) + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                  + (3 * p1 - p0 - 3 * p2 + p3) * t ** 3)


def _smoothstep(e0: float, e1: float, x: float) -> float:
    t = min(1.0, max(0.0, (x - e0) / max(1e-9, e1 - e0)))
    return t * t * (3 - 2 * t)


def _resample(stations: Sequence[Station], side: float, spacing: float):
    """Returns per-ring rows (center, right, fwd, rx, rf, rb, exponent) and each station's ring index."""
    keys = np.array([[*s.center, s.rx, s.rf, s.rf if s.rb is None else s.rb, s.exponent] for s in stations])
    count = len(stations)
    rights = []
    for i, station in enumerate(stations):
        if station.right is not None:
            rights.append(_unit(np.array(station.right, dtype=float)))
            continue
        tangent = _unit(keys[min(count - 1, i + 1), :3] - keys[max(0, i - 1), :3])
        fwd = _unit(np.array([0.0, 0.0, 1.0]) - tangent * tangent[2])
        out = np.array([side, 0.0, 0.0])
        rights.append(_unit(out - tangent * out.dot(tangent) - fwd * out.dot(fwd)))
    rows, key_ring = [], []
    for i in range(count - 1):
        key_ring.append(len(rows))
        a, b = keys[i], keys[i + 1]
        before, after = keys[max(0, i - 1)], keys[min(count - 1, i + 2)]
        steps = max(1, round(float(np.linalg.norm(b[:3] - a[:3])) / spacing))
        for step in range(steps):
            t = step / steps
            row = _catmull(before, a, b, after, t)
            # Keep interpolated radii inside the span so the surface cannot balloon.
            row[3:] = np.clip(row[3:], np.minimum(a[3:], b[3:]) * 0.97, np.maximum(a[3:], b[3:]) * 1.03)
            rows.append((row, _unit(rights[i] * (1 - t) + rights[i + 1] * t)))
    key_ring.append(len(rows))
    rows.append((keys[-1], rights[-1]))
    return rows, key_ring


def build_chain(
    stations: Sequence[Station],
    sides: int,
    blends: Dict[str, Optional[Tuple[float, float]]],
    side: float = 1.0,
    spacing: float = 0.026,
    sculpt: Optional[Sculpt] = None,
    rect: str = "TORSO",
) -> Tuple[Dict[str, ZoneMesh], ChainMap]:
    """Lofts the chain and cuts it into zones. UVs unwrap the whole chain into the atlas
    rectangle `rect`: U runs around from the back seam, V along the chain.

    `blends[zone]` is the distance range past the zone's first ring over which the skin weight
    moves from the parent bone to the zone's own bone. None keeps the whole zone on its own bone.
    """
    rows, key_ring = _resample(stations, side, spacing)
    centers = np.array([row[:3] for row, _ in rows])
    travel = np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(centers, axis=0), axis=1))])

    grid = np.zeros((len(rows), sides, 3))
    for r, (row, right) in enumerate(rows):
        center, (rx, rf, rb, exponent) = row[:3], row[3:]
        tangent = _unit(centers[min(len(rows) - 1, r + 1)] - centers[max(0, r - 1)])
        fwd = _unit(np.cross(right, tangent))
        if fwd[2] < 0:
            fwd = -fwd
        power = 2.0 / exponent
        for s in range(sides):
            theta = (s / sides - 0.5) * 2.0 * math.pi
            sn, cs = math.sin(theta), math.cos(theta)
            lx = math.copysign(abs(sn) ** power, sn) * rx
            lf = math.copysign(abs(cs) ** power, cs) * (rf if cs >= 0 else rb)
            point = center + right * lx + fwd * lf
            if sculpt is not None:
                point = point + _unit(right * sn + fwd * cs) * sculpt(center, travel[r], theta)
            grid[r, s] = point

    along = np.gradient(grid, axis=0)
    around = np.roll(grid, -1, axis=1) - np.roll(grid, 1, axis=1)
    normals = np.cross(around, along)
    normals /= np.maximum(1e-9, np.linalg.norm(normals, axis=2, keepdims=True))
    outward = grid - centers[:, None, :]
    normals *= np.where(np.einsum("rsk,rsk->rs", normals, outward) < 0, -1.0, 1.0)[..., None]

    starts = [(station.zone, key_ring[i]) for i, station in enumerate(stations) if station.zone]
    zones: Dict[str, ZoneMesh] = {}
    for index, (zone, first) in enumerate(starts):
        last = starts[index + 1][1] if index + 1 < len(starts) else len(rows) - 1
        mesh = ZoneMesh(bmesh.new())
        uv_layer = mesh.bm.loops.layers.uv.verify()
        blend = blends.get(zone)
        rings = []
        for r in range(first, last + 1):
            weight = 1.0 if blend is None else _smoothstep(blend[0], blend[1], travel[r] - travel[first])
            ring = []
            for s in range(sides):
                vert = mesh.bm.verts.new(pc_to_bl(grid[r, s]))
                mesh.normals[vert] = pc_to_bl(normals[r, s])
                mesh.own_weight[vert] = weight
                ring.append(vert)
            rings.append(ring)
        for r in range(len(rings) - 1):
            v0, v1 = travel[first + r] / travel[-1], travel[first + r + 1] / travel[-1]
            for s in range(sides):
                sn = (s + 1) % sides
                face = mesh.bm.faces.new((rings[r][s], rings[r][sn], rings[r + 1][sn], rings[r + 1][s]))
                face.smooth = True
                for loop, uv in zip(face.loops, ((s / sides, v0), ((s + 1) / sides, v0),
                                                 ((s + 1) / sides, v1), (s / sides, v1))):
                    loop[uv_layer].uv = rect_uv(rect, *uv)
        # Flat caps sit inside the neighbouring zone and only show once that zone is hidden.
        for ring, r in ((rings[0], first), (rings[-1], last)):
            hub = mesh.bm.verts.new(pc_to_bl(centers[r]))
            mesh.own_weight[hub] = mesh.own_weight[ring[0]]
            for s in range(sides):
                face = mesh.bm.faces.new((hub, ring[s], ring[(s + 1) % sides]))
                for loop in face.loops:
                    loop[uv_layer].uv = rect_uv(rect, 0.5, travel[r] / travel[-1])
        zones[zone] = mesh
    radius = np.array([float(np.mean(row[3:6])) for row, _ in rows])
    marks = {zone: float(travel[first]) for zone, first in starts}
    return zones, ChainMap(travel, centers, radius, marks)


def finalize_zone(
    name: str,
    zone: ZoneMesh,
    materials: Sequence[bpy.types.Material],
    armature: bpy.types.Object,
    own_bone: str,
    parent_bone: Optional[str],
    collection: bpy.types.Collection,
) -> bpy.types.Object:
    bm = zone.bm
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.verts.index_update()
    normals = {vert.index: normal.normalized() for vert, normal in zone.normals.items() if vert.is_valid}
    weights = {vert.index: weight for vert, weight in zone.own_weight.items() if vert.is_valid}
    mesh = bpy.data.meshes.new(name=name)
    bm.to_mesh(mesh)
    bm.free()
    for material in materials:
        mesh.materials.append(material)
    split = [tuple(normals.get(i, Vector(v.normal))) for i, v in enumerate(mesh.vertices)]
    mesh.normals_split_custom_set_from_vertices(split)

    obj = bpy.data.objects.new(name=name, object_data=mesh)
    collection.objects.link(obj)
    obj.parent = armature
    obj.modifiers.new(name="Armature", type="ARMATURE").object = armature
    own = obj.vertex_groups.new(name=own_bone)
    parent = obj.vertex_groups.new(name=parent_bone) if parent_bone else None
    for index in range(len(mesh.vertices)):
        weight = weights.get(index, 1.0) if parent else 1.0
        if weight > 0.002:
            own.add([index], weight, "REPLACE")
        if parent and weight < 0.998:
            parent.add([index], 1.0 - weight, "REPLACE")
    return obj
