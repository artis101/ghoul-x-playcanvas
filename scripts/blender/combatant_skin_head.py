"""Paints a combatant's face and scalp into the head's own UV (U = azimuth, V = ring)."""

import numpy as np

from combatant_skin_atlas import gs, noise, over, rect_grid, rgb, segment, shade, sm
from combatant_skin_paint import lit, tattoo


def paint_head(name: str, look, head_base, head_theta, key_count: int) -> np.ndarray:
    """`head_base` and `head_theta` are the analytic head surface from build_combatant_rigged.py."""
    u, v = rect_grid(name)
    x, y, _z, _nx, _nz, c, _sn = head_base(v * (key_count - 1), u)
    th = head_theta(u)
    ax, ath = np.abs(x), np.abs(th)
    f = sm(0.15, 0.55, c)
    shape = u.shape
    mottle = noise(shape, 5, 6, look.seed + 71, 3)

    # Painted light: a key from the upper front, deep sockets, and the planes of the face picked out.
    light = 1.0 - 0.30 * np.sin(th) ** 2 + 0.05 * np.cos(th - 0.3)
    light = light * (0.93 + 0.10 * mottle)
    light *= 1 - 0.42 * gs(ax - 0.032, 0.017) * gs(y - 1.690, 0.010) * f          # eye sockets
    light *= 1 - 0.20 * gs(ax - 0.013, 0.005) * sm(1.640, 1.655, y) * sm(1.702, 1.69, y) * f   # sides of the nose
    light *= 1 + 0.14 * gs(x, 0.0045) * sm(1.645, 1.66, y) * sm(1.705, 1.69, y) * f            # bridge
    light *= 1 - 0.32 * gs(y - 1.6355, 0.0035) * gs(x, 0.016) * f                 # under the nose
    light *= 1 - 0.24 * gs(y - 1.5965, 0.0035) * gs(x, 0.018) * f                 # under the lower lip
    light *= 1 + 0.10 * gs(ax - 0.048, 0.014) * gs(y - 1.668, 0.009) * f          # cheekbones
    light *= 1 - 0.16 * gs(ax - 0.046, 0.016) * gs(y - 1.630, 0.018) * f          # cheek hollows
    light *= 1 + 0.08 * gs(x, 0.03) * gs(y - 1.730, 0.012) * f                    # forehead
    light *= 1 + 0.10 * gs(x, 0.012) * gs(y - 1.583, 0.006) * f                   # chin
    light *= 1 - 0.30 * sm(1.595, 1.572, y) * (1 - 0.5 * f)                       # under the jaw
    light *= 1 - 0.16 * segment(ax, y, 0.017, 1.644, 0.028, 1.615, 0.003) * f     # nasolabial fold
    light *= 1 - look.hat_shadow * sm(1.700, 1.722, y)                            # brim shadow
    col = lit(look.skin, light)

    cheeks = gs(ax - 0.042, 0.016) * gs(y - 1.655, 0.012) + 0.8 * gs(x, 0.010) * gs(y - 1.652, 0.010)
    col = col + rgb(0.05, -0.012, -0.018) * (cheeks * f)[..., None]

    lip_w = 0.0215 * np.sqrt(np.clip(1.0 - ((y - 1.6115) / 0.0100) ** 2, 0.0, 1.0))
    lips = sm(lip_w, lip_w - 0.0032, ax) * sm(1.6010, 1.6040, y) * sm(1.6218, 1.6195, y) * (c > 0.5)
    col = over(col, lit(look.skin * rgb(0.86, 0.62, 0.62), light * 0.95), lips * 0.75)
    col = over(col, look.skin * 0.22, gs(y - 1.6115, 0.0009) * sm(0.0215, 0.0185, ax) * (c > 0.5))
    col = over(col, look.skin * 0.25, gs(ax - 0.0085, 0.0028) * gs(y - 1.6392, 0.0014) * (c > 0.5) * 0.85)

    strands = 0.5 + 0.5 * np.sin(y * 4200.0 + x * 900.0 + noise(shape, 16, 16, look.seed + 73, 2) * 9.0)
    brow_c = 1.7005 + 0.0042 * gs(ax - 0.035, 0.014) - 0.002 * sm(0.045, 0.055, ax) - look.scowl * (0.05 - ax) * 0.12
    brow = np.clip(1.0 - np.abs(y - brow_c) / 0.0052, 0.0, 1.0) ** 0.6
    brow = brow * sm(0.008, 0.014, ax) * sm(0.058, 0.050, ax) * (c > 0.3)
    col = over(col, look.hair_color * (0.75 + 0.4 * strands[..., None]), brow * 0.92)

    hairline = np.interp(ath, [0.0, 0.50, 0.80, 1.00, 1.14, 1.30, 1.80, 2.30, np.pi],
                         [1.751, 1.747, 1.738, 1.716, 1.700, 1.707, 1.709, 1.660, 1.624])
    hair = sm(hairline - 0.0025, hairline + 0.0055, y)
    if look.hair == "bald":
        col = over(col, look.hair_color, hair * 0.10)
        col = shade(col, 1 + 0.16 * gs(y - 1.775, 0.02) * gs(wrap_front(th), 0.9))
    else:
        tone = look.hair_color * (0.72 + 0.5 * strands[..., None]) * (0.85 + 0.35 * sm(1.74, 1.80, y))[..., None]
        col = over(col, tone * (light / np.maximum(light.max(), 1e-6))[..., None] ** 0.5, hair * look.hair_cover)

    btop_f = np.where(ax < 0.021, 1.6330, 1.6330 + (ax - 0.021) * 0.50)
    side = sm(0.60, 0.15, c)
    beard = sm(btop_f * (1 - side) + 1.690 * side + 0.002, btop_f * (1 - side) + 1.690 * side - 0.006, y) * (1 - lips) * sm(-0.45, -0.05, c)
    grit = 0.6 + 0.4 * (noise(shape, 64, 64, look.seed + 75, 1) > 0.5)
    col = over(col, look.hair_color * 0.9 + look.skin * 0.2, beard * look.stubble * grit)
    if look.facial in ("mustache", "goatee"):
        droop = 1.6290 - 9.0 * ax ** 2
        mustache = sm(0.0075, 0.0045, np.abs(y - droop)) * sm(0.034, 0.028, ax) * (c > 0.4)
        if look.facial == "goatee":
            ring = sm(0.0055, 0.003, np.abs(ax - 0.024)) * sm(1.590, 1.596, y) * sm(1.630, 1.622, y)
            chin = sm(0.027, 0.021, ax) * sm(1.600, 1.594, y) * sm(1.566, 1.574, y)
            mustache = np.clip(mustache + (ring + chin) * (c > 0.4), 0, 1)
        col = over(col, look.hair_color * (0.7 + 0.5 * strands[..., None]), mustache * 0.95)

    if look.face_ink:
        claws = sum(segment(x, y, -0.050 + k * 0.011, 1.745, -0.040 + k * 0.011, 1.640, 0.0028) for k in range(3))
        crown = sm(0.3, 0.6, np.sin(ath * 6.0 + y * 90.0)) * sm(1.755, 1.765, y) * sm(1.800, 1.792, y)
        col = tattoo(col, np.clip(claws * f * (np.abs(y - 1.690) > 0.011) + crown, 0, 1), 0.8)

    if look.balaclava is not None:
        knit = 0.90 + 0.10 * np.sign(np.sin(y * 2 * np.pi / 0.004))
        cloth_light = light * knit * (1 + 0.5 * gs(ax - 0.048, 0.02) * gs(y - 1.66, 0.02) * f + 0.4 * gs(x, 0.01) * gs(y - 1.655, 0.012) * f)
        mask_cloth = look.balaclava * cloth_light[..., None] + np.clip(cloth_light - 0.95, 0, 1)[..., None] * rgb(0.16, 0.17, 0.2)
        eyes = ((x / 0.062) ** 2 + ((y - 1.692) / 0.0175) ** 2) + (c < 0.2) * 4
        mouth = ((x / 0.026) ** 2 + ((y - 1.611) / 0.013) ** 2) + (c < 0.5) * 4
        hole = np.minimum(eyes, mouth)
        col = over(col, mask_cloth, sm(0.92, 1.05, hole))
        col = shade(col, 1 - 0.45 * gs(hole - 1.0, 0.10))
    return col


def wrap_front(th):
    return np.abs(th)
