"""Paints the body parts of one combatant skin from a Look (see combatant_skin_designs.py)."""

import numpy as np

from combatant_skin_atlas import Region, box, camo, gs, noise, over, rect_grid, rgb, round_light, segment, shade, sm
from combatant_skin_paint import (
    PI, STEEL, arm_muscle, belt, cloth, flank, leather_gloss, lit, neck_muscle, pocket, ribbing, skin, strap,
    tattoo, torso_muscle, tribal, wrap,
)

BOOT = rgb(0.085, 0.080, 0.080)
GLOVE = rgb(0.095, 0.095, 0.105)


def _rim(mask) -> np.ndarray:
    """Darkens along a garment's edge so it reads as lying on top."""
    gy, gx = np.gradient(mask)
    return 1.0 - 0.5 * np.clip(np.hypot(gx, gy) * 1.6, 0.0, 1.0)


def _layer(tile, garment, mask) -> np.ndarray:
    return shade(over(tile, garment, mask), _rim(mask))


def _pants(region: Region, look, seed: int, cells_x: int) -> np.ndarray:
    if look.pants == "leather":
        base = cloth(region, look.pants_colors[0], seed, fold_amp=0.05)
        return base + leather_gloss(region, seed)[..., None] * rgb(0.62, 0.65, 0.72)
    color = camo(region.th.shape, look.pants_colors, seed, cells_x) if look.pants == "camo" else look.pants_colors[0]
    return cloth(region, color, seed, fold_amp=0.24, along=5.0)


def paint_torso(region: Region, look) -> np.ndarray:
    x, y, s = region.xm, region.y, flank(region)
    ax, bx = np.abs(x), region.back_xm
    f = sm(-0.05, 0.25, region.front)
    b = 1.0 - f
    xf = np.where(region.front > 0, x, 9.0)     # front-only and back-only coordinates
    xb = np.where(region.front > 0, 9.0, bx)
    form = torso_muscle(region)
    tile = skin(region, look.skin, form * neck_muscle(region), look.seed)

    if look.tattoos:
        chest = tribal(ax - 0.02, y - 1.375, 1.3) * sm(0.35, 0.6, gs(ax - 0.085, 0.085) * gs(y - 1.38, 0.06))
        hub = np.hypot(x, y - 1.40)
        spokes = sm(0.55, 0.8, np.cos(8 * np.arctan2(y - 1.40, x))) * sm(0.066, 0.05, hub) * sm(0.030, 0.036, hub)
        sun = gs(hub - 0.030, 0.0045) + spokes
        belly = sm(0.008, 0.004, np.abs(ax - ((1.27 - y) % 0.045) * 0.75)) * sm(1.075, 1.09, y) * sm(1.27, 1.25, y) * (ax < 0.04)
        back = tribal(bx, y - 1.36, 4.1, bands=2.0, spikes=4.0) * sm(0.3, 0.55, gs(bx, 0.15) * gs(y - 1.36, 0.085))
        tile = tattoo(tile, (chest + sun + belly) * f + back * b)

    if look.top == "tank":
        scoop = np.where(region.front >= 0, (x / 0.085) ** 2 + ((y - 1.505) / 0.10) ** 2,
                         (bx / 0.075) ** 2 + ((y - 1.505) / 0.055) ** 2)
        arm_edge = 0.118 + sm(1.44, 1.29, y) * 0.16
        mask = sm(1.502, 1.496, y) * sm(0.94, 1.02, scoop) * sm(arm_edge + 0.004, arm_edge - 0.004, s)
        top = shade(cloth(region, look.top_color, look.seed + 11, 0.07, form=form, form_gain=0.6), ribbing(region))
        tile = _layer(tile, top, mask)
    elif look.top == "tee":
        scoop = (x / 0.066) ** 2 + ((y - 1.515) / 0.040) ** 2 + (region.front < 0) * 4.0
        mask = sm(1.514, 1.508, y) * sm(0.94, 1.02, scoop)
        top = cloth(region, look.top_color, look.seed + 11, 0.08, form=form, form_gain=1.1)
        tile = _layer(tile, top, mask)
        collar = sm(1.02, 1.10, scoop) * sm(1.42, 1.30, scoop) + gs(y - 1.508, 0.005) * (scoop > 1.3)
        tile = shade(tile, 1 + 0.5 * collar * mask)
    elif look.top == "fatigue":
        tile = over(tile, cloth(region, look.neck_color, look.seed + 3, 0.05, along=14.0), sm(1.572, 1.566, y))
        vee = ax - (y - 1.40) * 0.45
        mask = sm(1.540, 1.534, y) * np.clip(1 - f * sm(0.004, -0.004, vee) * (y > 1.40), 0, 1)
        top = cloth(region, look.top_color, look.seed + 11, 0.22, along=6.0)
        lapel = sm(-0.002, 0.004, vee) * sm(0.034, 0.028, vee) * (y > 1.39) * f
        top = shade(top, 1 + 0.22 * lapel - 0.5 * gs(vee - 0.032, 0.003) * (y > 1.39) * f)
        top = shade(top, 1 - 0.45 * gs(x, 0.003) * (y < 1.40) * f)
        top = over(top, look.top_color * 0.45, gs(np.hypot(x - 0.012, (y - 1.03) % 0.075 - 0.037), 0.005) * f * (y < 1.40))
        tile = _layer(tile, top, mask)

    if look.straps:
        tile = strap(tile, s, y, 0.108, 1.10, 1.52, 0.021, look.strap_color)
        tile = over(tile, STEEL * 0.7, box(np.abs(xf), y, 0.108, 1.235, 0.026, 0.012))

    if look.vest:
        vee = ax - (y - 1.335) * 0.50
        arm_edge = 0.150 + sm(1.47, 1.27, y) * 0.13
        mask = (sm(1.012, 1.018, y) * sm(1.480, 1.472, y) * sm(arm_edge + 0.004, arm_edge - 0.004, s)
                * np.clip(1 - f * sm(0.004, -0.004, vee) * (y > 1.335), 0, 1))
        vest = cloth(region, look.vest_color, look.seed + 21, 0.05)
        quilt = (y > 1.395)
        vest = shade(vest, np.where(quilt, 0.88 + 0.16 * np.sign(np.sin(y * 2 * PI / 0.013)), 1.0))
        vest = shade(vest, 1 - 0.5 * gs(y - 1.395, 0.003))
        teeth = 0.55 + 0.45 * np.sign(np.sin(y * 2 * PI / 0.007))
        vest = over(vest, STEEL * 0.55 * teeth[..., None], sm(0.006, 0.004, ax) * (y < 1.335) * f)
        for cx in (-0.148, -0.060, 0.060, 0.148):
            vest = pocket(vest, xf, y, cx, 1.248, 0.037, 0.043)
            vest = pocket(vest, xf, y, cx, 1.118, 0.037, 0.050)
        for row in (1.30, 1.21, 1.12):
            web = gs(y - row, 0.009) * sm(0.19, 0.17, np.abs(bx)) * b
            vest = shade(vest, 1 - 0.35 * web + 0.5 * gs(y - row - 0.008, 0.003) * sm(0.19, 0.17, np.abs(bx)) * b)
        tile = _layer(tile, vest, mask)

    trousers = _pants(region, look, look.seed + 31, 12)
    trousers = shade(trousers, 1 - 0.45 * segment(x, y, 0.012, 0.865, 0.012, 0.962, 0.003) * f)       # fly
    trousers = shade(trousers, 1 - 0.40 * segment(ax, y, 0.095, 0.962, 0.160, 0.895, 0.004) * f)      # slash pockets
    trousers = shade(trousers, 1 - 0.30 * gs(bx, 0.004) * b)                                           # seat seam
    if look.pants != "leather":
        for cx in (-0.085, 0.085):
            trousers = pocket(trousers, xb, y, cx, 0.905, 0.045, 0.038, flap=0.3)
    tile = _layer(tile, trousers, sm(0.992, 0.986, y))
    tile = belt(tile, region, look.belt_color, look.buckle, studs=look.tattoos)
    if look.vest:
        for cx in (-0.150, 0.150):   # belt pouches
            tile = over(tile, lit(look.belt_color, 0.8 + 0.5 * sm(0.93, 1.0, y)), box(xf, y, cx, 0.962, 0.034, 0.042))
            tile = shade(tile, 1 - 0.5 * box(xf, y, cx, 0.978, 0.034, 0.0025, 0.002))
    return tile


def paint_arm(region: Region, look) -> np.ndarray:
    th = region.th
    a = region.d - region.marks["JOINT"]
    form = arm_muscle(a, th)
    tile = skin(region, look.skin, form, look.seed + 41)
    outer = wrap(th - PI / 2) * region.r

    if look.tattoos:
        cap = tribal(outer, a - 0.045, 2.2, bands=2.2) * sm(0.075, 0.06, np.hypot(outer, a - 0.045))
        saw = np.abs(((th * 7 / PI) % 2) - 1)
        band = sm(0.012, 0.008, np.abs(a - 0.185 - 0.014 * saw)) + sm(0.004, 0.002, np.abs(a - 0.215))
        blade = sm(0.012, 0.007, np.abs(outer) + np.abs(((a - 0.30) % 0.06) - 0.03) * 0.45) * sm(0.30, 0.31, a) * sm(0.47, 0.46, a)
        tile = tattoo(tile, cap + band + blade)

    if look.top in ("tee", "fatigue"):
        hem = 0.118 if look.top == "tee" else 0.492
        gain = 1.2 if look.top == "tee" else 0.35
        sleeve = cloth(region, look.top_color, look.seed + 43, 0.06 if look.top == "tee" else 0.22, form=form, form_gain=gain)
        if look.top == "fatigue":
            n = noise(th.shape, 3, 6, look.seed + 44, 2)
            sleeve = shade(sleeve, 1 + 0.26 * np.sin(a * 2 * PI / 0.03 + n * 6 + th) * gs(a - 0.27, 0.07))
            sleeve = shade(sleeve, 1 - 0.4 * gs(a - 0.462, 0.003) + 0.2 * sm(0.466, 0.47, a))    # cuff
        sleeve = shade(sleeve, 1 + 0.3 * gs(a - (hem - 0.006), 0.004))
        tile = shade(tile, 1 - 0.35 * gs(a - (hem + 0.008), 0.008))
        tile = _layer(tile, sleeve, sm(hem + 0.002, hem - 0.002, a))
    if look.gloves:
        tile = over(tile, lit(GLOVE, round_light(th, 0.4) * 1.2), sm(0.497, 0.501, a))
    return tile


def paint_leg(region: Region, look, holster: bool) -> np.ndarray:
    x, y, th = region.xm, region.y, region.th
    outer = wrap(th - PI / 2) * region.r
    inner = wrap(th + PI / 2) * region.r
    n = noise(th.shape, 3, 8, look.seed + 52, 2)
    tile = _pants(region, look, look.seed + 51 + (7 if region.side > 0 else 0), 6)
    knee = 1 + 0.24 * np.sin(y * 2 * PI / 0.034 + n * 6 + th) * gs(y - 0.49, 0.07)
    ankle = 1 + 0.26 * np.sin(y * 2 * PI / 0.027 + n * 5) * gs(y - 0.255, 0.05)
    tile = shade(tile, knee * ankle * (1 - 0.22 * gs(outer, 0.004)) * (1 - 0.22 * gs(inner, 0.004)))
    tile = shade(tile, 1 - 0.25 * sm(0.86, 0.93, y) * gs(inner, 0.05))
    if look.pants != "leather":
        tile = pocket(tile, outer, y, 0.0, 0.672, 0.052, 0.068, flap=0.3)
    if holster:
        black = rgb(0.07, 0.07, 0.075)
        for row in (0.752, 0.628):
            band = sm(0.014, 0.011, np.abs(y - row))
            tile = shade(tile, 1 - 0.3 * gs(y - row + 0.016, 0.006))
            tile = over(tile, lit(black, round_light(th, 0.4) * (1 + 0.5 * gs(y - row - 0.008, 0.003))), band)
        body = box(outer, y, 0.004, 0.668, 0.036, 0.098, 0.004)
        tile = shade(tile, 1 - 0.4 * box(outer, y, -0.006, 0.660, 0.044, 0.104, 0.008) * (1 - body))
        tile = over(tile, lit(black, 0.9 + 0.8 * gs(outer + 0.02, 0.008)), body)
        tile = over(tile, rgb(0.20, 0.20, 0.22), box(outer, y, 0.006, 0.752, 0.018, 0.028, 0.003))   # pistol grip
        tile = shade(tile, 1 - 0.5 * box(outer, y, 0.004, 0.722, 0.036, 0.0025, 0.002))

    boot = lit(BOOT, round_light(th, 0.4) * (1 + 0.9 * gs(th - 0.5, 0.25) * gs(y - 0.18, 0.02)))
    laces = sm(0.3, 0.6, np.sin(y * 2 * PI / 0.017)) * sm(0.024, 0.018, np.abs(x))
    boot = over(boot, rgb(0.30, 0.30, 0.31), laces)
    tile = shade(tile, 1 - 0.45 * gs(y - 0.204, 0.006))
    return over(tile, boot, sm(0.200, 0.196, y))


def paint_hand(name: str, look) -> np.ndarray:
    """U runs from the middle of the back of the hand to the middle of the palm; V from cuff to fingertips."""
    u, v = rect_grid(name)
    th = u * PI
    light = round_light(th, 0.32) * (1 - 0.15 * sm(0.5, 1.0, u))
    knuckles = 1 - 0.22 * gs(v - 0.50, 0.03) * sm(0.6, 0.3, u)
    if look.gloves:
        tile = lit(GLOVE, light * (1 + 0.5 * gs(v - 0.34, 0.08) * gs(th, 0.8)))
        tile = over(tile, rgb(0.21, 0.21, 0.23), sm(0.03, 0.02, np.abs(v - 0.50)) * sm(0.45, 0.35, u))     # knuckle pad
        return shade(tile, 1 + 0.5 * gs(v - 0.13, 0.02) - 0.4 * gs(v - 0.17, 0.012))                    # wrist strap
    tile = lit(look.skin, light * knuckles * (0.97 + 0.06 * noise(u.shape, 4, 6, look.seed + 61, 2)))
    if look.tattoos:
        tile = tattoo(tile, sm(0.03, 0.02, np.abs(v - 0.62)) * sm(0.4, 0.3, u), 0.7)
    return tile


def paint_boot(name: str) -> np.ndarray:
    """Side view of the boot: U runs heel to toe, V from the ground to the top of the shaft."""
    u, v = rect_grid(name)
    light = 0.85 + 0.25 * v + 0.9 * gs(u - 0.82, 0.07) * gs(v - 0.16, 0.06) + 0.35 * gs(u - 0.2, 0.05) * gs(v - 0.3, 0.2)
    creases = 1 - 0.2 * sm(0.5, 0.9, np.sin(v * 2 * PI * 9 + u * 6)) * gs(v - 0.42, 0.12)
    tile = lit(BOOT, light * creases)
    lace = sm(0.3, 0.6, np.sin(v * 2 * PI * 13)) * sm(0.07, 0.05, np.abs(u - 0.47)) * sm(0.34, 0.38, v)
    tile = over(tile, rgb(0.30, 0.30, 0.31), lace)
    tile = shade(tile, 1 - 0.5 * gs(v - 0.30, 0.012) * sm(0.55, 0.6, u))          # toe-cap seam
    sole = sm(0.135, 0.125, v)
    tread = 0.7 + 0.3 * np.sign(np.sin(u * 2 * PI * 9))
    tile = over(tile, rgb(0.05, 0.05, 0.05) * tread[..., None], sole)
    return shade(tile, 1 + 0.6 * gs(v - 0.145, 0.008))                           # welt


def swatch(name: str, color, light=1.0) -> np.ndarray:
    u, _v = rect_grid(name)
    return lit(color, np.full(u.shape, light))


def paint_hat(name: str, color) -> np.ndarray:
    """V 0..0.45 is the brim from its edge inward, above that the crown."""
    u, v = rect_grid(name)
    light = round_light((u - 0.5) * 2 * PI, 0.3)
    stitches = 1 - 0.25 * sm(0.5, 0.9, np.sin(v * 2 * PI * 9)) * (v < 0.42)
    band = 1 - 0.55 * sm(0.07, 0.05, np.abs(v - 0.56))
    crown = 1 + 0.25 * sm(0.62, 1.0, v)
    weave = 0.94 + 0.12 * noise(u.shape, 12, 4, 91, 2)
    return lit(color, light * stitches * band * crown * weave * (1 - 0.3 * gs(v - 0.45, 0.03)))
