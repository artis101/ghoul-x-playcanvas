"""Replace the GHOUL combatant's GLB animation set with retargeted SOMA takes."""

import argparse
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from combatant_blender_scene import save_blend
from combatant_glb_animation import CombatantGlbAnimation
from retarget_soma_combatant import CombatantRetarget, load_soma

EXPORT_FPS = 24

# Source frame ranges are 1-based. Locomotion ranges cover steady-state strides.
TAKES = (
    ("CombatReadyIdle", "ready", 12, 105, 3.1, 10, 0),
    ("UnsuspectingIdle", "guard", 8, 112, 3.47, 12, 0),
    ("LongGunAim", "long_aim", 12, 63, 1.0, 0, 0.12),
    ("PistolAim", "pistol_aim", 108, 27, 0.9, 0, 0),
    ("HitStaggerChest", "stagger", 1, 36, 1.17, 0, 0.28),
    ("DiaphragmDropKneel", "kneel", 6, 115, 1.8, 0, 0.32),
    ("LegCollapseCrawl", "crawl", 12, 113, 2.0, 0, 0.38),
    ("Walk", "walk", 40, 70, 1.0, 4, 0),
    ("Run", "run", 54, 79, 0.83, 4, 0),
    ("StrafeLeft", "strafe", 60, 91, 1.03, 5, 0),
    ("StrafeRight", "strafe", 60, 91, 1.03, 5, 0),
)


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
    ready = {}
    for clip, take, start, end, duration, loop, xz_scale in TAKES:
        source = load_soma(motion / (take + ".bvh"))
        count = round(duration * EXPORT_FPS)
        times = [index / EXPORT_FPS for index in range(count + 1)]
        strafing = take == "strafe"
        traveling = clip in {"Walk", "Run"} or strafing
        for suffix in ("", "_Southpaw"):
            mirror = clip == "StrafeRight" if strafing else bool(suffix)
            retarget = CombatantRetarget(glb, source, start, mirror)
            frames = [retarget.sample(start + (end - start) * index / count, traveling, xz_scale)
                      for index in range(count + 1)]
            if traveling:
                # Use the generated ready upper-body motion while the generated legs stride.
                for index, frame in enumerate(frames):
                    pose = ready[suffix][index % len(ready[suffix])]
                    for key, rotation in pose.items():
                        if key[1] == "rotation" and not key[0].startswith(
                            ("Bone_PELVIS", "Bone_THIGH", "Bone_KNEE", "Bone_SHIN", "Bone_FOOT")
                        ):
                            frame[key] = rotation.copy()
            if loop:
                blend_loop(frames, round(loop * EXPORT_FPS / 30))
            if clip == "CombatReadyIdle":
                ready[suffix] = frames
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
    glb.clear_animations()
    for material in glb.doc["materials"]:
        if material.get("name") in {"Mat_Skin_Tactical", "Mat_Head_Sculpted"}:
            material.pop("normalTexture", None)
    build_clips(glb, args.motion)
    glb.write(args.output_glb)
    if args.blend:
        save_blend(args.blend.resolve(), args.output_glb.resolve(), args.m4a1_reference,
                   glb.model_rest_rotations())


if __name__ == "__main__":
    main()
