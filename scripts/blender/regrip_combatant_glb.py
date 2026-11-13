"""Run the grip pass over the clips of an already baked combatant GLB, for fast iteration.

    blender -b --python-exit-code 1 --python scripts/blender/regrip_combatant_glb.py -- \
      public/models/ghoul_combatant.glb out.glb --drop-mirrored

The bake (`bake_kimodo_combatant.py`) runs the same pass on fresh retargets; this only saves the
retarget when the grip rules are what changed. `--drop-mirrored` leaves out every clip the game
mirrors at load (`combatantClipMirror.ts`).
"""

import argparse
import sys
from pathlib import Path

from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from combatant_glb_animation import CombatantGlbAnimation, gltf_quaternion
from combatant_grip_pass import GripPass

# Clips the runtime makes by mirroring another (combatantClipMirror.ts mirrorSources).
MIRRORED_SIDED = {
    "LegShotFallLeft", "LegLossLeft", "OneLegHopLeft", "LegLossFallLeft", "ArmLossLeft", "StumpClutchLeft",
    "StumpKneelLeft", "StumpDrawLeft", "KneelStumpDrawLeft", "CrawlDragLegLeft",
}


def is_mirrored(name):
    return name.endswith("_Southpaw") or name in MIRRORED_SIDED


def read_clip(glb, clip):
    times = None
    frames = None
    for name, _node, path, sampler in glb.channels(clip):
        if times is None:
            times = [row[0] for row in glb.read(sampler["input"], "SCALAR", 1)]
            frames = [{} for _ in times]
        if path == "rotation":
            for frame, row in zip(frames, glb.read(sampler["output"], "VEC4", 4)):
                frame[name, "rotation"] = gltf_quaternion(row).normalized()
        else:
            for frame, row in zip(frames, glb.read(sampler["output"], "VEC3", 3)):
                frame[name, path] = Vector(row)
    return times, frames


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--drop-mirrored", action="store_true")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    glb = CombatantGlbAnimation(args.source)
    clips = []
    for clip in glb.doc["animations"]:
        if args.drop_mirrored and is_mirrored(clip["name"]):
            continue
        clips.append((clip["name"], *read_clip(glb, clip)))
    grip = GripPass(glb)
    glb.clear_animations()
    for name, times, frames in clips:
        glb.add_clip(name, times, grip.apply(name, frames))
    glb.write(args.output)
    for clip, stats in grip.report.items():
        print(f"grip {clip:24s} wrist {stats['wrist_deg']:5.1f} deg, trigger short {stats['trigger_cm']:4.1f} cm, support short {stats['support_cm']:4.1f} cm, blade {stats.get('blade_deg', 0):4.1f} deg")
    print(f"wrote {args.output} with {len(clips)} clips, {args.output.stat().st_size} bytes")


if __name__ == "__main__":
    main()
