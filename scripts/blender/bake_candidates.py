"""Bake candidate Kimodo takes onto the combatant for side-by-side review, not for shipping.

    blender -b --python-exit-code 1 --python scripts/blender/bake_candidates.py -- \
      work/takes public/models/ghoul_combatant.glb work/candidates.glb hit_head_00 hit_head_03 ...

Each take becomes one clip named after it, played over its whole length at its own speed and
retargeted exactly as `bake_kimodo_combatant.py` does. Render the result with
`render_clip_frames.py` to compare takes on the real body before picking one.
"""

import argparse
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bake_kimodo_combatant import EXPORT_FPS, PRONE
from combatant_glb_animation import CombatantGlbAnimation
from retarget_soma_combatant import CombatantRetarget, load_soma


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("takes", type=Path)
    parser.add_argument("combatant_glb", type=Path)
    parser.add_argument("output_glb", type=Path)
    parser.add_argument("names", nargs="+")
    parser.add_argument("--xz", type=float, default=0.3, help="Share of root travel kept")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    bpy.ops.wm.read_factory_settings(use_empty=True)
    glb = CombatantGlbAnimation(args.combatant_glb)
    glb.clear_animations()
    for name in args.names:
        source = load_soma(args.takes / (name + ".bvh"))
        start, end = 1, int(source.animation_data.action.frame_range[1])
        count = round((end - start) / 30 * EXPORT_FPS)
        retarget = CombatantRetarget(glb, source, start, False, end if name in PRONE else None)
        frames = [retarget.sample(start + (end - start) * i / count, False, args.xz) for i in range(count + 1)]
        glb.add_clip(name, [i / EXPORT_FPS for i in range(count + 1)], frames)
        bpy.data.objects.remove(source, do_unlink=True)
        print(f"baked {name}: {end} source frames")
    glb.write(args.output_glb)


if __name__ == "__main__":
    main()
