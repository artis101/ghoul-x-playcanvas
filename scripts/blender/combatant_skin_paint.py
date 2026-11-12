"""Shared brushes for the combatant skins: painted anatomy, cloth, and gear details.

All positions are metres on the rest-pose body (see Region in combatant_skin_atlas.py).
"""

import math

import numpy as np

from combatant_skin_atlas import Region, box, folds, frame, gs, noise, over, rgb, round_light, segment, shade, sm

PI = math.pi
INK = rgb(0.10, 0.12, 0.17)
STEEL = rgb(0.62, 0.63, 0.66)


def wrap(angle):
    return (angle + PI) % (2 * PI) - PI


def lit(color, light) -> np.ndarray:
    """Applies painted light; shadows go warmer and more saturated, as brushed skins do."""
    light = np.asarray(light)
    dark = np.clip(1.0 - light, 0.0, 1.0)
    out = np.asarray(color, dtype=np.float64) * light[..., None]
    out[..., 1] *= 1.0 - 0.22 * dark
    out[..., 2] *= 1.0 - 0.34 * dark
    return out


def flank(region: Region) -> np.ndarray:
    """Metres from the nearer centre line: front on the front half, back on the back half."""
    return np.where(region.front >= 0, np.abs(region.xm), np.abs(region.back_xm))


# ---------------------------------------------------------------------------
# Anatomy
# ---------------------------------------------------------------------------

def torso_muscle(region: Region) -> np.ndarray:
    """Chest, abdomen and back definition as a brightness multiplier."""
    x, y = region.xm, region.y
    ax = np.abs(x)
    f = sm(-0.10, 0.35, region.front)
    m = np.ones_like(x)
    pec_low = 1.292 + 2.2 * (ax - 0.095) ** 2
    m *= 1 - 0.36 * gs(y - pec_low, 0.007) * sm(0.215, 0.17, ax) * f
    m *= 1 - 0.12 * sm(pec_low, pec_low - 0.012, y) * sm(pec_low - 0.06, pec_low - 0.02, y) * sm(0.2, 0.15, ax) * f
    m *= 1 + 0.13 * gs(ax - 0.095, 0.06) * gs(y - 1.37, 0.04) * f
    m *= 1 - 0.24 * gs(x, 0.006) * sm(1.30, 1.33, y) * sm(1.45, 1.42, y) * f
    m *= 1 + 0.10 * segment(ax, y, 0.02, 1.452, 0.175, 1.470, 0.006) * f
    m *= 1 - 0.18 * segment(ax, y, 0.02, 1.440, 0.165, 1.456, 0.006) * f
    abz = sm(1.03, 1.05, y) * sm(1.295, 1.27, y) * f
    m *= 1 - 0.24 * gs(x, 0.005) * abz
    for row in (1.105, 1.165, 1.225):
        m *= 1 - 0.22 * gs(y - row, 0.005) * sm(0.078, 0.062, ax) * f
    m *= 1 - 0.18 * gs(ax - 0.074, 0.006) * abz
    m *= 1 + 0.06 * gs(ax - 0.037, 0.02) * abz
    ribs = 0.5 + 0.5 * np.sin((y + ax * 0.9) * 2 * PI / 0.035)
    m *= 1 - 0.13 * ribs * gs(ax - 0.135, 0.03) * sm(1.14, 1.18, y) * sm(1.30, 1.26, y) * f
    m *= 1 - 0.5 * gs(np.hypot(x, y - 1.062), 0.007) * f
    m *= 1 - 0.14 * segment(ax, y, 0.135, 1.03, 0.04, 0.92, 0.007) * f

    b = sm(-0.10, 0.35, -region.front)
    bx = region.back_xm
    abx = np.abs(bx)
    m *= 1 - 0.28 * gs(bx, 0.008) * sm(0.98, 1.02, y) * sm(1.47, 1.42, y) * b
    m *= 1 + 0.09 * gs(abx - 0.09, 0.05) * gs(y - 1.38, 0.05) * b
    m *= 1 - 0.16 * gs(abx - 0.045 - (y - 1.30) * 0.25, 0.007) * sm(1.30, 1.33, y) * sm(1.45, 1.42, y) * b
    m *= 1 - 0.15 * gs(y - (1.22 + abx * 0.5), 0.008) * sm(0.03, 0.06, abx) * sm(0.20, 0.17, abx) * b
    m *= 1 + 0.06 * gs(abx - 0.03, 0.015) * sm(1.0, 1.05, y) * sm(1.25, 1.2, y) * b
    return m


def neck_muscle(region: Region) -> np.ndarray:
    x, y = region.xm, region.y
    f = sm(0.0, 0.4, region.front)
    m = np.ones_like(x)
    m *= 1 - 0.20 * segment(np.abs(x), y, 0.012, 1.50, 0.055, 1.60, 0.006) * f   # sternomastoid
    m *= 1 - 0.14 * gs(np.hypot(x, y - 1.505), 0.012) * f                         # throat notch
    m *= 1 - 0.30 * sm(1.565, 1.61, y) * f                                        # shadow under the jaw
    return m


def arm_muscle(a, th) -> np.ndarray:
    """`a` is metres down the arm from the shoulder joint."""
    outer = wrap(th - PI / 2)
    back = np.abs(th) - PI
    m = np.ones_like(a)
    delt_edge = 0.132 - 0.05 * np.clip(np.abs(outer) / 1.6, 0, 1)
    m *= 1 - 0.28 * gs(a - delt_edge, 0.007) * sm(-0.02, 0.02, a)
    m *= 1 + 0.12 * gs(a - 0.05, 0.05) * gs(outer, 0.9)
    m *= 1 + 0.12 * gs(th, 0.5) * gs(a - 0.185, 0.05)
    m *= 1 - 0.18 * gs(wrap(outer - 0.25), 0.10) * sm(0.13, 0.15, a) * sm(0.27, 0.24, a)
    m *= 1 - 0.14 * gs(wrap(th + PI / 2 - 0.2), 0.12) * sm(0.10, 0.14, a) * sm(0.27, 0.24, a)
    m *= 1 + 0.08 * gs(back, 0.5) * gs(a - 0.16, 0.05)
    m *= 1 - 0.15 * gs(a - 0.238, 0.008) * gs(back, 0.5)
    m *= 1 - 0.24 * gs(a - 0.275, 0.006) * gs(th, 0.6)
    m *= 1 + 0.10 * gs(th - 0.8, 0.45) * gs(a - 0.35, 0.06)
    m *= 1 - 0.14 * gs(th + 0.5, 0.12) * sm(0.30, 0.33, a) * sm(0.50, 0.44, a)
    m *= 1 - 0.10 * gs(back, 0.14) * sm(0.32, 0.36, a)
    return m


def punch(form, gain: float) -> np.ndarray:
    """Exaggerates a brightness map around 1, the way a skin painter over-states anatomy."""
    return np.clip(1.0 + (form - 1.0) * gain, 0.35, 1.6)


def skin(region: Region, tone, muscle, seed: int) -> np.ndarray:
    mottle = 0.95 + 0.10 * noise(region.th.shape, 4, 8, seed, 3)
    return lit(tone, round_light(region.th, 0.36) * punch(muscle, 1.55) * mottle)


# ---------------------------------------------------------------------------
# Cloth
# ---------------------------------------------------------------------------

def cloth(region: Region, color, seed: int, fold_amp=0.16, along=7.0, form=None, form_gain=1.0) -> np.ndarray:
    """Painted fabric. `form` is a muscle map that shows through tight cloth."""
    light = round_light(region.th, 0.36) * folds(region, seed, along=along, amp=fold_amp)
    light = light * (0.86 + 0.28 * noise(region.th.shape, 3, 5, seed + 5, 3))
    if form is not None:
        light = light * (1.0 + (form - 1.0) * form_gain)
    color = np.asarray(color, dtype=np.float64)
    if color.ndim == 1:
        color = np.zeros(region.th.shape + (3,)) + color
    out = color * light[..., None]
    # Dark cloth keeps a cool grey sheen on what faces the light, so black never goes flat.
    sheen = np.clip(light - 0.98, 0.0, 1.0)[..., None] * (1.0 - color.mean(axis=-1, keepdims=True))
    return out + sheen * rgb(0.26, 0.28, 0.32)


def ribbing(region: Region, pitch=0.007) -> np.ndarray:
    return 0.93 + 0.07 * np.sign(np.sin(region.xm * 2 * PI / pitch))


def leather_gloss(region: Region, seed: int) -> np.ndarray:
    """Hard specular streaks, added on top of black leather."""
    n = noise(region.th.shape, 3, 9, seed, 3)
    streak = gs(wrap(region.th - 0.5), 0.22) * (0.5 + 0.5 * n) + 0.6 * gs(wrap(region.th + 2.4), 0.2) * n
    crinkle = sm(0.72, 0.9, np.sin(region.d * 2 * PI / 0.045 + n * 9.0 + region.th)) * gs(region.y - 0.50, 0.10)
    return 0.34 * streak + 0.30 * crinkle


def pocket(tile, x, y, cx, cy, hw, hh, flap=0.35, snap=True) -> np.ndarray:
    """A patch pocket with a flap, painted with a lit top edge and a shadow underneath."""
    inside = box(x, y, cx, cy, hw, hh)
    tile = shade(tile, 1 + 0.10 * inside)
    tile = shade(tile, 1 - 0.55 * frame(x, y, cx, cy, hw, hh, 0.0028))
    tile = shade(tile, 1 + 0.30 * box(x, y, cx, cy + hh - 0.006, hw - 0.006, 0.0025, 0.002))
    tile = shade(tile, 1 - 0.30 * box(x, y, cx, cy - hh - 0.008, hw, 0.006, 0.005))
    flap_y = cy + hh - 2 * hh * flap
    tile = shade(tile, 1 - 0.45 * box(x, y, cx, flap_y, hw - 0.003, 0.0022, 0.002))
    tile = shade(tile, 1 - 0.14 * box(x, y, cx, flap_y - 0.009, hw - 0.004, 0.007, 0.006))
    if snap:
        tile = over(tile, STEEL * 0.8, gs(np.hypot(x - cx, y - (flap_y + 0.012)), 0.0045))
    return tile


def strap(tile, x, y, cx, y0, y1, hw, color) -> np.ndarray:
    mask = box(x, y, cx, (y0 + y1) / 2, hw, (y1 - y0) / 2, 0.002)
    weave = 0.9 + 0.1 * np.sign(np.sin(y * 2 * PI / 0.008))
    tile = shade(tile, 1 - 0.35 * box(x, y, cx + 0.006, (y0 + y1) / 2, hw + 0.006, (y1 - y0) / 2, 0.006) * (1 - mask))
    edge = 1 - 0.35 * gs(np.abs(x - cx) - hw, 0.003)
    return over(tile, np.asarray(color) * (weave * edge)[..., None], mask)


def belt(tile, region: Region, color, buckle, y0=0.968, y1=1.008, studs=False) -> np.ndarray:
    x, y = region.xm, region.y
    mid, half = (y0 + y1) / 2, (y1 - y0) / 2
    band = sm(half + 0.002, half - 0.002, np.abs(y - mid))
    light = round_light(region.th, 0.36) * (1 + 0.35 * gs(y - (y1 - 0.006), 0.004) - 0.3 * gs(y - (y0 + 0.004), 0.004))
    tile = shade(tile, 1 - 0.4 * gs(y - (y0 - 0.008), 0.008))            # shadow the belt drops on the trousers
    tile = over(tile, lit(color, light), band)
    f = sm(0.0, 0.3, region.front)
    if studs:
        on_row = gs(y - mid, 0.006) * sm(0.55, 0.9, np.cos(region.th * 16))
        tile = over(tile, STEEL, on_row * band)
    tile = over(tile, lit(buckle, 0.75 + 0.5 * sm(-0.02, 0.02, y - mid + x)), box(x, y, 0, mid, 0.030, half + 0.004) * f)
    tile = shade(tile, 1 - 0.6 * frame(x, y, 0, mid, 0.018, half - 0.006, 0.0025) * f)
    return tile


def tribal(u, v, seed: float, bands=2.6, spikes=5.0) -> np.ndarray:
    """Hooked blackwork: thresholded swirl bands around the origin of (u, v), in metres."""
    radius = np.hypot(u, v)
    angle = np.arctan2(v, u)
    swirl = np.sin(radius * bands * 2 * PI / 0.05 + 2.2 * np.sin(angle * spikes + seed) + angle * 2 + seed)
    barbs = np.sin(angle * spikes * 2 + radius * 40 + seed * 3)
    return sm(0.35, 0.5, swirl + 0.35 * barbs)


def tattoo(tile, mask, strength=0.86) -> np.ndarray:
    return over(tile, INK + 0.25 * (tile - INK) * 0.2, np.clip(mask, 0, 1) * strength)
