"""Replace the GHOUL combatant's GLB animation set with retargeted SOMA takes."""

import argparse
import math
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from combatant_blender_scene import save_blend
from combatant_glb_animation import CombatantGlbAnimation
from retarget_soma_combatant import CombatantRetarget, load_soma

EXPORT_FPS = 24

# clip, take, first frame, last frame, seconds, cross-fade frames, share of root travel kept.
# Source frame ranges are 1-based. Looping clips come from second-pass takes whose first pose is
# pinned at both ends (see kimodo_loop_constraints.py), so they repeat without a cross-fade.
TAKES = (
    ("CombatReadyIdle", "ready_loop", 1, 94, 3.1, 0, 0),
    ("UnsuspectingIdle", "guard_loop", 1, 105, 3.47, 0, 0),
    ("LongGunAim", "long_aim", 12, 63, 1.0, 0, 0.12),
    ("PistolAim", "pistol_aim", 108, 27, 0.9, 0, 0),
    ("HitStaggerChest", "stagger", 1, 36, 1.17, 0, 0.28),
    ("DiaphragmDropKneel", "kneel", 6, 115, 1.8, 0, 0.32),
    ("LegCollapseCrawl", "crawl", 12, 113, 2.0, 0, 0.38),
    ("Crawl", "crawl_loop", 1, 69, 2.27, 0, 0),
    ("Walk", "walk_loop", 1, 31, 1.0, 0, 0),
    ("Run", "run_loop", 1, 26, 0.83, 0, 0),
    ("StrafeLeft", "strafe_loop", 1, 32, 1.03, 0, 0),
    ("StrafeRight", "strafe_loop", 1, 32, 1.03, 0, 0),
)


LOOPING = {"CombatReadyIdle", "UnsuspectingIdle", "Crawl", "Walk", "Run", "StrafeLeft", "StrafeRight"}
# A looping clip must end in its opening pose to within these limits.
MAX_SEAM_DEGREES = 1.5
MAX_SEAM_METRES = 0.01


def check_seam(clip, frames):
    first, last = frames[0], frames[-1]
    for key, value in first.items():
        if key[1] == "rotation":
            gap = math.degrees(value.rotation_difference(last[key]).angle)
            if gap > MAX_SEAM_DEGREES:
                raise ValueError(f"{clip} does not loop: {key[0]} is {gap:.1f} degrees off at the seam")
        elif (value - last[key]).length > MAX_SEAM_METRES:
            raise ValueError(f"{clip} does not loop: {key[0]} moves {(value - last[key]).length:.3f} m at the seam")


def blend_loop(frames, length):
    first = frames[0]
    for index in range(1, length + 1):
        frame = frames[index - length - 1]
        t = index / length
        weight = t * t * (3 - 2 * t)
        for key, value in frame.items():
            blend = value.slerp if key[1] == "rotation" else value.lerp
            frame[key] = blend(first[key], weight)


def build_clips(glb, motion):
    for clip, take, start, end, duration, loop, xz_scale in TAKES:
        source = load_soma(motion / (take + ".bvh"))
        count = round(duration * EXPORT_FPS)
        times = [index / EXPORT_FPS for index in range(count + 1)]
        strafing = clip.startswith("Strafe")
        traveling = clip in {"Walk", "Run"} or strafing
        for suffix in ("", "_Southpaw"):
            mirror = clip == "StrafeRight" if strafing else bool(suffix)
            retarget = CombatantRetarget(glb, source, start, mirror, end if clip == "Crawl" else None)
            frames = [retarget.sample(start + (end - start) * index / count, traveling, xz_scale)
                      for index in range(count + 1)]
            if loop:
                blend_loop(frames, round(loop * EXPORT_FPS / 30))
            if clip in LOOPING:
                check_seam(clip + suffix, frames)
            glb.add_clip(clip + suffix, times, frames)
            if clip == "Walk":
                glb.add_clip("WalkBackward" + suffix, times, list(reversed(frames)))
        bpy.data.objects.remove(source, do_unlink=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("motion", type=Path)
    parser.add_argument("combatant_glb", type=Path)
    parser.add_argument("output_glb", type=Path)
    parser.add_argument("--blend", type=Path)
    parser.add_argument("--m4a1-reference", type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    if args.m4a1_reference and not args.blend:
        parser.error("--m4a1-reference requires --blend")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    glb = CombatantGlbAnimation(args.combatant_glb)
    for material in glb.doc["materials"]:
        if material.get("name") in {"Mat_Skin_Tactical", "Mat_Head_Sculpted"}:
            material.pop("normalTexture", None)
    glb.prune_unused_images()
    glb.clear_animations()
    build_clips(glb, args.motion)
    glb.write(args.output_glb)
    if args.blend:
        save_blend(args.blend.resolve(), args.output_glb.resolve(), args.m4a1_reference,
                   glb.model_rest_rotations())


if __name__ == "__main__":
    main()
