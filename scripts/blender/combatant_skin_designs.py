"""The four combatant looks, one painted atlas page each.

They are period-style originals: a tattooed skinhead in leathers, a militia gunner in a tank top and
woodland trousers, a masked enforcer in black and urban camouflage, and a contract operative in grey
fatigues, a load-bearing vest and a boonie hat.
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
    "MILITIA_GUNNER": Look(
        skin=rgb(0.50, 0.32, 0.22), seed=200, top="tank", top_color=rgb(0.36, 0.39, 0.28), pants="camo",
        pants_colors=(rgb(0.36, 0.38, 0.23), rgb(0.19, 0.25, 0.14), rgb(0.37, 0.27, 0.16), rgb(0.07, 0.08, 0.06)),
        buckle=rgb(0.62, 0.52, 0.28), straps=True, facial="goatee", stubble=0.2,
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
        paste(page, f"FOOT_{label}", paint_boot(f"FOOT_{label}"))
    paste(page, "HEAD", paint_head("HEAD", look, head_base, head_theta, head_keys))
    covered = look.balaclava is not None
    paste(page, "SWATCH_SKIN", swatch("SWATCH_SKIN", look.skin, 0.95))
    paste(page, "SWATCH_EAR", swatch("SWATCH_EAR", look.balaclava if covered else look.skin, 1.0 if covered else 0.86))
    paste(page, "SWATCH_LID", swatch("SWATCH_LID", look.skin, 0.60))
    paste(page, "SWATCH_HAT", paint_hat("SWATCH_HAT", look.hat_color))
    return finish(page, look.seed)
