"""The four combatant looks, one painted atlas page each.

They are period-style originals: a tattooed skinhead in leathers; "the Muscle", a bald militia gunner
in a ribbed tank top, woodland trousers and canvas shoulder straps; "Bear", a red-haired bruiser in a
half-face respirator, olive tank top and woodland cargo trousers; a masked enforcer in black and urban
camouflage; and a contract operative in grey fatigues, a load-bearing vest and a boonie hat.

Every field of a Look is a knob, so new characters and per-spawn variants are a few values away.
"""

from dataclasses import dataclass, field
from typing import Callable, Dict, Optional

import numpy as np

from combatant_skin_atlas import ATLAS, ChainMap, chain_region, finish, paste, rgb
from combatant_skin_body import paint_arm, paint_boot, paint_hand, paint_hat, paint_leg, paint_torso, swatch
from combatant_skin_head import paint_head

BLACK = rgb(0.085, 0.085, 0.095)


@dataclass
class Look:
    skin: np.ndarray
    seed: int
    top: str = "bare"                      # bare, tank, tee or fatigue
    top_color: np.ndarray = field(default_factory=lambda: BLACK)
    neck_color: np.ndarray = field(default_factory=lambda: BLACK)
    pants: str = "plain"                   # plain, camo or leather
    pants_colors: tuple = (BLACK,)
    belt_color: np.ndarray = field(default_factory=lambda: rgb(0.07, 0.07, 0.075))
    buckle: np.ndarray = field(default_factory=lambda: rgb(0.55, 0.56, 0.58))
    tattoos: bool = False
    straps: bool = False
    strap_color: np.ndarray = field(default_factory=lambda: rgb(0.56, 0.48, 0.33))
    vest: bool = False
    vest_color: np.ndarray = field(default_factory=lambda: rgb(0.10, 0.145, 0.135))
    gloves: bool = False
    holster: bool = False
    boot_color: np.ndarray = field(default_factory=lambda: rgb(0.085, 0.080, 0.080))
    chest_hair: float = 0.0
    hair: str = "bald"                     # bald or cropped
    hair_color: np.ndarray = field(default_factory=lambda: rgb(0.09, 0.07, 0.06))
    hair_cover: float = 0.9
    stubble: float = 0.3
    facial: str = "none"                   # none, mustache or goatee
    scowl: float = 0.6
    face_ink: bool = False
    balaclava: Optional[np.ndarray] = None
    hat_shadow: float = 0.0
    hat_color: np.ndarray = field(default_factory=lambda: rgb(0.13, 0.13, 0.14))


LOOKS: Dict[str, Look] = {
    "SKINHEAD_PUNK": Look(
        skin=rgb(0.86, 0.69, 0.58), seed=100, tattoos=True, face_ink=True, pants="leather",
        pants_colors=(rgb(0.07, 0.07, 0.08),), stubble=0.12, scowl=1.0,
    ),
    "MILITIA_GUNNER": Look(   # the Muscle
        skin=rgb(0.44, 0.255, 0.185), seed=200, top="tank", top_color=rgb(0.40, 0.42, 0.31), pants="camo",
        pants_colors=(rgb(0.46, 0.47, 0.37), rgb(0.23, 0.285, 0.20), rgb(0.29, 0.225, 0.165), rgb(0.075, 0.08, 0.065)),
        belt_color=rgb(0.06, 0.06, 0.065), buckle=rgb(0.60, 0.61, 0.63), straps=True, strap_color=rgb(0.62, 0.54, 0.37),
        hair_color=rgb(0.10, 0.085, 0.08), facial="goatee", stubble=0.55, scowl=1.0,
        boot_color=rgb(0.075, 0.072, 0.072),
    ),
    "MASKED_BRUISER": Look(   # Bear
        skin=rgb(0.80, 0.59, 0.44), seed=500, top="tank", top_color=rgb(0.35, 0.41, 0.22), pants="camo",
        pants_colors=(rgb(0.37, 0.40, 0.24), rgb(0.22, 0.29, 0.15), rgb(0.40, 0.28, 0.17), rgb(0.075, 0.075, 0.06)),
        belt_color=rgb(0.06, 0.06, 0.065), buckle=rgb(0.62, 0.63, 0.66), hair="cropped",
        hair_color=rgb(0.40, 0.22, 0.12), hair_cover=0.97, stubble=0.18, scowl=1.0,
        boot_color=rgb(0.40, 0.27, 0.17), chest_hair=0.8,
    ),
    "HEAVY_ENFORCER": Look(
        skin=rgb(0.82, 0.57, 0.40), seed=300, top="tee", pants="camo",
        pants_colors=(rgb(0.46, 0.47, 0.49), rgb(0.25, 0.26, 0.28), rgb(0.09, 0.09, 0.10)),
        gloves=True, balaclava=rgb(0.085, 0.085, 0.095), stubble=0.0,
    ),
    "SNIPER_OPERATIVE": Look(
        skin=rgb(0.82, 0.63, 0.50), seed=400, top="fatigue", top_color=rgb(0.215, 0.225, 0.245),
        pants_colors=(rgb(0.205, 0.215, 0.235),), vest=True, gloves=True, holster=True, hair="cropped",
        hair_color=rgb(0.27, 0.18, 0.11), facial="mustache", stubble=0.25, hat_shadow=0.22, scowl=0.3,
    ),
}

# The look the body meshes carry in the GLB itself; the runtime swaps in the others by archetype.
DEFAULT_LOOK = "MILITIA_GUNNER"


def paint_page(look: Look, chains: Dict[str, ChainMap], head_base: Callable, head_theta: Callable, head_keys: int) -> np.ndarray:
    """Returns the 512 px atlas page, rows bottom-up."""
    page = np.zeros((ATLAS, ATLAS, 3))
    paste(page, "TORSO", paint_torso(chain_region("TORSO", chains["TORSO"]), look))
    for label, side in (("RIGHT", -1.0), ("LEFT", 1.0)):
        paste(page, f"ARM_{label}", paint_arm(chain_region(f"ARM_{label}", chains[f"ARM_{label}"], side), look))
        leg = chain_region(f"LEG_{label}", chains[f"LEG_{label}"], side)
        paste(page, f"LEG_{label}", paint_leg(leg, look, look.holster and label == "LEFT"))
        paste(page, f"HAND_{label}", paint_hand(f"HAND_{label}", look))
        paste(page, f"FOOT_{label}", paint_boot(f"FOOT_{label}", look.boot_color))
    paste(page, "HEAD", paint_head("HEAD", look, head_base, head_theta, head_keys))
    covered = look.balaclava is not None
    paste(page, "SWATCH_SKIN", swatch("SWATCH_SKIN", look.skin, 0.95))
    paste(page, "SWATCH_EAR", swatch("SWATCH_EAR", look.balaclava if covered else look.skin, 1.0 if covered else 0.86))
    paste(page, "SWATCH_LID", swatch("SWATCH_LID", look.skin, 0.60))
    paste(page, "SWATCH_HAT", paint_hat("SWATCH_HAT", look.hat_color))
    return finish(page, look.seed)
