"""Atlas layout and paint helpers for the combatant's hand-painted skins.

Every character is one 512 px diffuse page with the light painted in, the way late-90s shooter
skins were made: no normal maps, no roughness maps. Each body part owns a rectangle of the page
and a `Region` that tells a painter where each texel sits on the body, in metres.
"""

import math
from dataclasses import dataclass, field
from typing import Dict, Tuple

import numpy as np

ATLAS = 512        # the page is painted at this size...
EXPORT = 256       # ...and shipped at this size, point-sampled, for chunky period texels

# x, y, width, height in pixels; y counts up from the bottom row of the page.
RECTS: Dict[str, Tuple[int, int, int, int]] = {
    "LEG_RIGHT": (0, 256, 128, 256),
    "LEG_LEFT": (128, 256, 128, 256),
    "TORSO": (256, 256, 256, 256),
    "HEAD": (0, 0, 224, 256),
    "ARM_RIGHT": (224, 0, 96, 256),
    "ARM_LEFT": (320, 0, 96, 256),
    "HAND_RIGHT": (416, 160, 48, 96),
    "HAND_LEFT": (464, 160, 48, 96),
    "FOOT_RIGHT": (416, 64, 48, 96),
    "FOOT_LEFT": (464, 64, 48, 96),
    "SWATCH_SKIN": (416, 32, 32, 32),
    "SWATCH_EAR": (448, 32, 32, 32),
    "SWATCH_LID": (480, 32, 32, 32),
    "SWATCH_HAT": (416, 0, 96, 32),
}


def rect_uv(name: str, u: float, v: float) -> Tuple[float, float]:
    """Maps a part's own 0..1 UV into the page, half a texel inside its rectangle."""
    x, y, w, h = RECTS[name]
    return (x + 0.5 + u * (w - 1)) / ATLAS, (y + 0.5 + v * (h - 1)) / ATLAS


def rect_grid(name: str) -> Tuple[np.ndarray, np.ndarray]:
    """Per-texel 0..1 UV of a rectangle, matching `rect_uv`."""
    _x, _y, w, h = RECTS[name]
    return np.meshgrid(np.arange(w) / (w - 1), np.arange(h) / (h - 1))


@dataclass
class ChainMap:
    """Where a lofted chain's rings sit: distance along the chain, ring centres and mean radius."""
    travel: np.ndarray
    centers: np.ndarray
    radius: np.ndarray
    marks: Dict[str, float] = field(default_factory=dict)  # zone name -> distance where it starts


@dataclass
class Region:
    """Texel coordinates of a lofted part. `th` is 0 at the front, +pi/2 on the outer side
    (+X on the torso) and +-pi at the back seam; `d` is metres along the chain; `y` is height;
    `xm` is metres around the surface from the front centre line."""
    th: np.ndarray
    d: np.ndarray
    y: np.ndarray
    r: np.ndarray
    xm: np.ndarray
    marks: Dict[str, float]
    side: float = 1.0

    @property
    def front(self) -> np.ndarray:
        return np.cos(self.th)

    @property
    def back_xm(self) -> np.ndarray:
        """Metres around the surface from the back centre line."""
        return (np.abs(self.th) - math.pi) * self.r * np.sign(self.th)


def chain_region(name: str, chain: ChainMap, side: float = 1.0) -> Region:
    u, v = rect_grid(name)
    th = (u - 0.5) * 2.0 * math.pi
    d = v * chain.travel[-1]
    y = np.interp(d, chain.travel, chain.centers[:, 1])
    r = np.interp(d, chain.travel, chain.radius)
    return Region(th, d, y, r, th * r, dict(chain.marks), side)


# ---------------------------------------------------------------------------
# Paint helpers
# ---------------------------------------------------------------------------

def sm(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0 + 1e-12), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def gs(x, width):
    return np.exp(-((x / width) ** 2))


def rgb(r, g, b) -> np.ndarray:
    return np.array([r, g, b], dtype=np.float64)


def over(base: np.ndarray, color, mask) -> np.ndarray:
    m = np.clip(mask, 0.0, 1.0)[..., None]
    return base * (1.0 - m) + np.asarray(color, dtype=np.float64) * m


def shade(base: np.ndarray, amount) -> np.ndarray:
    """Multiplies brightness; `amount` is 1 for no change."""
    return base * np.asarray(amount)[..., None]


def box(x, y, cx, cy, hw, hh, soft=0.003):
    return sm(hw + soft, hw - soft, np.abs(x - cx)) * sm(hh + soft, hh - soft, np.abs(y - cy))


def frame(x, y, cx, cy, hw, hh, line=0.003):
    """Outline of a rectangle."""
    return np.clip(box(x, y, cx, cy, hw + line, hh + line, line) - box(x, y, cx, cy, hw - line, hh - line, line), 0, 1)


def segment(x, y, ax, ay, bx, by, width):
    """Soft line from A to B."""
    dx, dy = bx - ax, by - ay
    t = np.clip(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy + 1e-12), 0.0, 1.0)
    return gs(np.hypot(x - (ax + t * dx), y - (ay + t * dy)), width)


def noise(shape, cells_x: int, cells_y: int, seed: int, octaves: int = 3) -> np.ndarray:
    """Value noise in 0..1 that wraps horizontally, so it closes across a limb's back seam."""
    h, w = shape
    out = np.zeros(shape)
    amp, total = 1.0, 0.0
    rng = np.random.default_rng(seed)
    for octave in range(octaves):
        cx, cy = max(1, cells_x << octave), max(1, cells_y << octave)
        lattice = rng.random((cy + 1, cx))
        fx = np.arange(w) / w * cx
        fy = np.arange(h) / max(1, h - 1) * cy * 0.999
        ix, iy = fx.astype(int), fy.astype(int)
        tx, ty = fx - ix, fy - iy
        tx, ty = tx * tx * (3 - 2 * tx), ty * ty * (3 - 2 * ty)
        ix1 = (ix + 1) % cx
        top = lattice[iy][:, ix] * (1 - tx) + lattice[iy][:, ix1] * tx
        bottom = lattice[iy + 1][:, ix] * (1 - tx) + lattice[iy + 1][:, ix1] * tx
        out += amp * (top * (1 - ty[:, None]) + bottom * ty[:, None])
        total += amp
        amp *= 0.5
    return out / total


def round_light(th, strength=0.30, key=0.25):
    """The painted light on a limb: bright facing the viewer front and back, dark on the flanks,
    with the key light a little to one side."""
    return 1.0 - strength * np.sin(th) ** 2 + 0.06 * np.cos(th - key)


def folds(region: Region, seed: int, along=7.0, around=2, amp=0.16, slant=0.6) -> np.ndarray:
    """Painted cloth wrinkles as a brightness multiplier."""
    n = noise(region.th.shape, around + 1, 5, seed, 3)
    phase = region.d * along * 2 * math.pi + region.th * around * slant + n * 7.0
    wave = np.sin(phase)
    crease = np.sign(wave) * np.abs(wave) ** 0.6
    return 1.0 + amp * crease * (0.4 + 0.6 * noise(region.th.shape, 3, 4, seed + 1, 2))


def camo(shape, palette, seed: int, cells=5) -> np.ndarray:
    """Blotch camouflage: palette[0] is the ground, the rest are laid over it in order."""
    col = np.zeros(shape + (3,)) + palette[0]
    for index, color in enumerate(palette[1:]):
        n = noise(shape, cells, cells * 2, seed + 17 * index, 3)
        col = over(col, color, sm(0.545, 0.565, n))
    return col


BAYER = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]) / 16.0


def finish(page: np.ndarray, seed: int = 7) -> np.ndarray:
    """Shrinks the page to its shipped size and steps it down to 15-bit colour with an ordered
    dither, the way a console of the period stored and showed its textures."""
    rng = np.random.default_rng(seed)
    page = np.clip(page * (0.975 + 0.05 * rng.random(page.shape[:2])[..., None]), 0.0, 1.0)
    step = ATLAS // EXPORT
    page = page.reshape(EXPORT, step, EXPORT, step, 3).mean(axis=(1, 3))
    threshold = np.tile(BAYER, (EXPORT // 4, EXPORT // 4))[..., None]
    return np.clip(np.floor(page * 31.0 + threshold) / 31.0, 0.0, 1.0)


def paste(page: np.ndarray, name: str, tile: np.ndarray) -> None:
    x, y, w, h = RECTS[name]
    page[y:y + h, x:x + w] = tile
