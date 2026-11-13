"""The militia gunner's half-face respirator: a rubber face piece over the nose and mouth, two side
filter cartridges, a front exhale valve and two head straps.

It is built over the analytic head surface from build_combatant_rigged.py and painted on its own
small point-sampled page, with the light painted in like the skins.
"""

import math
from typing import Callable, List, Sequence, Tuple

import bmesh
import numpy as np
from mathutils import Vector

PAGE = 128
# Page regions as (u0, v0, u1, v1).
RUBBER = (0.0, 0.0, 0.5, 1.0)
FILTER_FACE = (0.5, 0.5, 1.0, 1.0)
FILTER_SIDE = (0.5, 0.25, 1.0, 0.5)
STRAP = (0.5, 0.0, 1.0, 0.25)

Surface = Callable[..., Vector]


def _gauss(x, w):
    return math.exp(-((x / w) ** 2))


def _region(rect, u: float, v: float) -> Tuple[float, float]:
    u0, v0, u1, v1 = rect
    pad_u, pad_v = 0.5 / PAGE, 0.5 / PAGE
    u = min(1.0, max(0.0, u))
    v = min(1.0, max(0.0, v))
    return (u0 + pad_u + u * (u1 - u0 - 2 * pad_u), v0 + pad_v + v * (v1 - v0 - 2 * pad_v))


class _Builder:
    def __init__(self, to_blender: Callable):
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.verify()
        self.to_blender = to_blender

    def vert(self, p: Vector):
        return self.bm.verts.new(self.to_blender(p))

    def face(self, verts, uvs, smooth=True):
        f = self.bm.faces.new(verts)
        f.smooth = smooth
        for loop, uv in zip(f.loops, uvs):
            loop[self.uv].uv = uv
        return f

    def cylinder(self, base: Vector, axis: Vector, radius: float, depth: float, sides: int,
                 face_rect=FILTER_FACE, side_rect=FILTER_SIDE, bevel: float = 0.0, bulge: float = 0.0) -> None:
        """A capped cylinder from `base` along `axis`; the outer cap is a fan mapped flat onto `face_rect`."""
        axis = axis.normalized()
        ref = Vector((0.0, 1.0, 0.0)) if abs(axis.y) < 0.9 else Vector((1.0, 0.0, 0.0))
        a = axis.cross(ref).normalized()
        b = axis.cross(a).normalized()
        rings = [(0.0, radius), (depth - bevel, radius), (depth, radius - bevel)] if bevel > 0 else [(0.0, radius), (depth, radius)]
        verts = []
        for h, r in rings:
            verts.append([self.vert(base + axis * h + (a * math.cos(2 * math.pi * k / sides) + b * math.sin(2 * math.pi * k / sides)) * r)
                          for k in range(sides)])
        for i in range(len(rings) - 1):
            v0, v1 = i / (len(rings) - 1), (i + 1) / (len(rings) - 1)
            for k in range(sides):
                kn = (k + 1) % sides
                self.face((verts[i][k], verts[i][kn], verts[i + 1][kn], verts[i + 1][k]),
                          (_region(side_rect, k / sides, v0), _region(side_rect, (k + 1) / sides, v0),
                           _region(side_rect, (k + 1) / sides, v1), _region(side_rect, k / sides, v1)), smooth=False)
        top_r = rings[-1][1]
        centre = self.vert(base + axis * (depth + bulge))

        def cap_uv(k):
            ang = 2 * math.pi * k / sides
            return _region(face_rect, 0.5 + 0.5 * math.cos(ang) * top_r / radius, 0.5 + 0.5 * math.sin(ang) * top_r / radius)

        for k in range(sides):
            kn = (k + 1) % sides
            self.face((centre, verts[-1][k], verts[-1][kn]), (_region(face_rect, 0.5, 0.5), cap_uv(k), cap_uv(kn)), smooth=False)
        back = self.vert(base - axis * 0.002)
        for k in range(sides):
            kn = (k + 1) % sides
            self.face((back, verts[0][kn], verts[0][k]), (_region(side_rect, 0.5, 0.0),) * 3, smooth=False)

    def strap(self, pts: Sequence[Vector], half_width: float, thickness: float, centre: Vector) -> None:
        """A flat band through `pts`, lying on the head (its broad side faces away from `centre`)."""
        rows = []
        n = len(pts)
        for i, p in enumerate(pts):
            t = (pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized()
            out = (p - centre)
            out = (out - t * out.dot(t)).normalized()
            side = t.cross(out).normalized()
            rows.append([self.vert(p + side * sx * half_width + out * oz) for sx, oz in
                         ((-1, 0.0), (1, 0.0), (1, thickness), (-1, thickness))])
        for i in range(n - 1):
            v0, v1 = i / (n - 1), (i + 1) / (n - 1)
            for k in range(4):
                kn = (k + 1) % 4
                u0, u1 = k / 4, (k + 1) / 4
                self.face((rows[i][k], rows[i][kn], rows[i + 1][kn], rows[i + 1][k]),
                          (_region(STRAP, u0, v0 * 4 % 1.0), _region(STRAP, u1, v0 * 4 % 1.0),
                           _region(STRAP, u1, min(1.0, v0 * 4 % 1.0 + 0.25)), _region(STRAP, u0, min(1.0, v0 * 4 % 1.0 + 0.25))),
                          smooth=False)


# Face piece outline: half its angular width (radians from the front) at each head ring (uk).
_SPAN_UK = [1.0, 2.0, 3.2, 4.6, 5.8, 6.8, 7.6, 8.15]
_SPAN_TH = [0.78, 1.08, 1.22, 1.24, 1.12, 0.86, 0.52, 0.30]


def _snout(uk: float, th: float) -> float:
    """How far the rubber stands off the face: a rounded muzzle over the mouth."""
    return 0.007 + 0.017 * _gauss(th, 0.62) * _gauss(uk - 4.6, 2.3)


def build_gas_mask(
    surface: Surface,
    normal: Callable[[float, float], Vector],
    s_of_theta: Callable[[float], float],
    to_blender: Callable,
) -> bmesh.types.BMesh:
    """`surface(uk, s, offset, features, nose)` and `normal(uk, s)` are the analytic head; `s_of_theta`
    turns a face angle into the head's s coordinate."""
    mk = _Builder(to_blender)
    head_centre = Vector((0.0, 1.66, -0.006))

    rows, cols = len(_SPAN_UK), 13
    outer: List[List[Vector]] = []
    inner: List[List[Vector]] = []
    for uk, span in zip(_SPAN_UK, _SPAN_TH):
        o_row, i_row = [], []
        for c in range(cols):
            th = span * (2.0 * c / (cols - 1) - 1.0)
            s = s_of_theta(th)
            smooth = surface(uk, s, 0.0, False, False)
            feat = surface(uk, s, 0.0, True, True)
            n = normal(uk, s)
            relief = max(0.0, (feat - smooth).dot(n))
            o_row.append(smooth + n * max(_snout(uk, th), relief + 0.006))
            i_row.append(smooth + n * max(0.0015, relief + 0.0015))
        outer.append(o_row)
        inner.append(i_row)

    vo = [[mk.vert(p) for p in row] for row in outer]
    vi = [[mk.vert(p) for p in row] for row in inner]
    R, C = rows - 1, cols - 1
    for r in range(R):
        for c in range(C):
            uv = [_region(RUBBER, c / C, r / R), _region(RUBBER, (c + 1) / C, r / R),
                  _region(RUBBER, (c + 1) / C, (r + 1) / R), _region(RUBBER, c / C, (r + 1) / R)]
            mk.face((vo[r][c], vo[r][c + 1], vo[r + 1][c + 1], vo[r + 1][c]), uv)
            mk.face((vi[r][c + 1], vi[r][c], vi[r + 1][c], vi[r + 1][c + 1]), [uv[1], uv[0], uv[3], uv[2]])
    edge = _region(RUBBER, 0.5, 0.02)
    for c in range(C):
        mk.face((vi[0][c], vo[0][c], vo[0][c + 1], vi[0][c + 1]), (edge,) * 4)
        mk.face((vo[R][c], vi[R][c], vi[R][c + 1], vo[R][c + 1]), (edge,) * 4)
    for r in range(R):
        mk.face((vi[r][0], vi[r + 1][0], vo[r + 1][0], vo[r][0]), (edge,) * 4)
        mk.face((vo[r][C], vo[r + 1][C], vi[r + 1][C], vi[r][C]), (edge,) * 4)

    def on_mask(uk: float, th: float, lift: float = 0.0) -> Tuple[Vector, Vector]:
        s = s_of_theta(th)
        n = normal(uk, s)
        smooth = surface(uk, s, 0.0, False, False)
        feat = surface(uk, s, 0.0, True, True)
        relief = max(0.0, (feat - smooth).dot(n))
        return smooth + n * (max(_snout(uk, th), relief + 0.006) + lift), n

    # Filter cartridges on either cheek, canted forward and a little down.
    for sx in (-1.0, 1.0):
        p, n = on_mask(4.0, sx * 0.88, -0.003)
        axis = (n + Vector((sx * 0.25, -0.22, 0.30))).normalized()
        mk.cylinder(p, axis, 0.0215, 0.009, 10, side_rect=FILTER_SIDE)                       # threaded collar
        mk.cylinder(p + axis * 0.008, axis, 0.0305, 0.019, 12, bevel=0.003, bulge=0.002)      # cartridge

    # Exhale valve on the chin, with its slotted cover.
    p, n = on_mask(3.9, 0.0, -0.002)
    axis = (n + Vector((0.0, -0.30, 0.0))).normalized()
    mk.cylinder(p, axis, 0.0165, 0.012, 10, face_rect=(0.75, 0.5, 1.0, 0.75), bevel=0.0025, bulge=0.002)

    # Straps: the upper one runs above the ears to the back of the crown, the lower one under them to the nape.
    def strap_path(points: Sequence[Tuple[float, float]], lift: float) -> List[Vector]:
        return [surface(uk, s_of_theta(th), lift, False, False) for uk, th in points]

    upper = [(7.4, 1.00), (8.6, 1.30), (10.2, 1.62), (11.0, 1.95), (11.2, 2.40), (11.0, 2.85), (10.9, math.pi)]
    lower = [(3.2, 1.18), (3.4, 1.45), (3.9, 1.80), (4.6, 2.20), (5.0, 2.65), (5.1, math.pi)]
    for path in (upper, lower):
        right = strap_path([(uk, -th) for uk, th in path], 0.0035)
        left = strap_path(path, 0.0035)
        mk.strap(right + left[::-1][1:], 0.0068, 0.0022, head_centre)
    for sx in (-1.0, 1.0):   # buckles where the straps meet the face piece
        for uk, th in ((7.25, 0.98), (3.15, 1.16)):
            p, n = on_mask(uk, sx * th, 0.0)
            mk.cylinder(p - n * 0.002, n, 0.0072, 0.0045, 6, face_rect=STRAP, side_rect=STRAP)
    return mk.bm


# ---------------------------------------------------------------------------
# Page
# ---------------------------------------------------------------------------

def paint_gas_mask(seed: int = 41) -> np.ndarray:
    """The respirator's painted page, rows bottom-up, in 0..1 sRGB."""
    rng = np.random.default_rng(seed)
    v, u = np.meshgrid((np.arange(PAGE) + 0.5) / PAGE, (np.arange(PAGE) + 0.5) / PAGE, indexing="ij")
    page = np.zeros((PAGE, PAGE, 3))
    grain = 0.94 + 0.12 * rng.random((PAGE, PAGE))

    def smooth(e0, e1, x):
        t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
        return t * t * (3 - 2 * t)

    rubber = np.array([0.14, 0.14, 0.145])
    # Rubber face piece: local (a across, b up) in its region.
    a, b = u / 0.5, v
    across = (a - 0.5) * 2.0
    light = 0.80 + 0.55 * np.exp(-((across / 0.45) ** 2)) * smooth(0.15, 0.6, b) - 0.30 * smooth(0.55, 1.0, np.abs(across))
    light *= 1.0 - 0.35 * smooth(0.25, 0.0, b)                                      # under the chin
    light *= 1.0 + 0.45 * np.exp(-((b - 0.86) / 0.05) ** 2) * np.exp(-((across / 0.3) ** 2))   # nose bridge catch-light
    seam = np.exp(-(((b - 0.30 - 0.18 * across ** 2) / 0.018) ** 2))               # moulded seam round the muzzle
    light *= 1.0 - 0.45 * seam + 0.35 * np.exp(-(((b - 0.33 - 0.18 * across ** 2) / 0.014) ** 2))
    ribs = 0.5 + 0.5 * np.sign(np.sin(b * 2 * math.pi * 7.0))
    light *= 1.0 - 0.10 * ribs * smooth(0.35, 0.75, b) * smooth(0.75, 0.45, np.abs(across))
    edge = smooth(0.92, 1.0, np.abs(across)) + smooth(0.06, 0.0, b) + smooth(0.95, 1.0, b)
    light *= 1.0 - 0.5 * np.clip(edge, 0, 1)
    mask = u < 0.5
    page[mask] = (rubber * (light * grain)[..., None])[mask]

    # Filter face: a ribbed outer ring and a perforated grille.
    fu, fv = (u - 0.5) / 0.5, (v - 0.5) / 0.5
    r = np.hypot(fu - 0.5, fv - 0.5) * 2.0
    ang = np.arctan2(fv - 0.5, fu - 0.5)
    key = 0.85 + 0.35 * np.cos(ang - 2.2)                                           # light from the upper left
    ring = smooth(0.70, 0.74, r) * smooth(1.0, 0.96, r)
    knurl = 0.85 + 0.15 * np.sign(np.sin(ang * 18))
    holes = (np.sin(fu * math.pi * 14) * np.sin(fv * math.pi * 14) > 0.35) * smooth(0.62, 0.55, r)
    grille = np.array([0.22, 0.22, 0.23]) * (key * (1.0 - 0.75 * holes))[..., None]
    face = grille * (1 - ring[..., None]) + np.array([0.16, 0.16, 0.17]) * (key * knurl * (1.0 + 0.4 * (r > 0.86)))[..., None] * ring[..., None]
    face *= (1.0 - 0.55 * np.exp(-(((r - 0.70) / 0.03) ** 2)))[..., None]
    sel = (u >= 0.5) & (v >= 0.5) & (u < 0.75) | (u >= 0.5) & (v >= 0.75)
    page[sel] = face[sel]

    # Exhale valve cover: slotted dome.
    vu, vv = (u - 0.75) / 0.25, (v - 0.5) / 0.25
    vr = np.hypot(vu - 0.5, vv - 0.5) * 2.0
    slots = (np.abs(np.sin(vv * math.pi * 6)) > 0.55) * smooth(0.75, 0.6, vr) * smooth(0.18, 0.28, np.abs(vu - 0.5))
    valve = np.array([0.17, 0.17, 0.18]) * ((0.85 + 0.4 * smooth(0.9, 0.2, vr)) * (1 - 0.7 * slots))[..., None]
    sel = (u >= 0.75) & (v >= 0.5) & (v < 0.75)
    page[sel] = valve[sel]

    # Cartridge side: knurled plastic band.
    su, sv = (u - 0.5) / 0.5, (v - 0.25) / 0.25
    band = np.array([0.15, 0.15, 0.16]) * ((0.8 + 0.3 * np.cos(su * 2 * math.pi - 2.2)) * (0.85 + 0.15 * np.sign(np.sin(su * math.pi * 40))) * (1 + 0.4 * (sv > 0.85)))[..., None]
    sel = (u >= 0.5) & (v >= 0.25) & (v < 0.5)
    page[sel] = band[sel]

    # Straps: black elastic webbing with a weave and lighter edges.
    tu, tv = (u - 0.5) / 0.5, v / 0.25
    weave = 0.85 + 0.15 * np.sign(np.sin(tv * math.pi * 24))
    strap_light = (0.75 + 0.35 * np.sin(tu * math.pi)) * weave * (1 + 0.35 * (np.abs(tu - 0.5) > 0.42))
    strap = np.array([0.10, 0.10, 0.105]) * strap_light[..., None]
    sel = (u >= 0.5) & (v < 0.25)
    page[sel] = strap[sel]
    return np.clip(page, 0.0, 1.0)
