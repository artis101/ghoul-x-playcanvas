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

# 20 fps keeps 79 clips inside the 2 MiB GLB budget and suits the late-90s look.
EXPORT_FPS = 20

# clip, take, first frame, last frame, seconds, cross-fade frames, share of root travel kept.
# Source frame ranges are 1-based. Looping clips come from second-pass takes whose first pose is
# pinned at both ends (see kimodo_loop_constraints.py), so they repeat without a cross-fade.
TAKES = (
    ("CombatReadyIdle", "ready_loop", 1, 94, 3.1, 0, 0),
    ("UnsuspectingIdle", "guard_loop", 1, 105, 3.47, 0, 0),
    ("LongGunAim", "long_aim", 1, 39, 1.27, 0, 0.12),
    ("PistolAim", "pistol_aim", 1, 39, 1.27, 0, 0),
    ("PistolAimOneHand", "pistol_one_hand", 1, 39, 1.27, 0, 0),
    ("KneelPistolAimOneHand", "kneel_pistol_one_hand", 1, 42, 1.37, 0, 0),
    # One-handed carry (other forearm tucked to the chest); the raise clips hold their last frame
    # as the aim, so no separate aim loops are needed.
    ("PistolOneHandHold", "pistol1_hold", 55, 81, 0.87, 4, 0),
    # Hit flinches play at twice the take's speed: a hit should snap, then hand the gun back fast.
    ("HitStaggerChest", "hit_chest", 1, 45, 0.735, 0, 0),
    ("HitFlinchHead", "hit_head", 1, 45, 0.735, 0, 0),
    ("HitFlinchGut", "hit_gut", 1, 48, 0.785, 0, 0),
    ("HitFlinchThroat", "hit_throat", 1, 51, 0.835, 0, 0),
    ("HitFlinchArmRight", "hit_arm_r", 1, 42, 0.685, 0, 0),
    ("HitFlinchArmLeft", "hit_arm_l", 1, 42, 0.685, 0, 0),
    ("HitFlinchLegRight", "hit_leg_r", 1, 45, 0.735, 0, 0),
    ("HitFlinchLegLeft", "hit_leg_l", 1, 45, 0.735, 0, 0),
    ("LegShotFallRight", "legshot_fall_r", 1, 72, 2.37, 0, 0.5),
    ("LegShotFallLeft", "legshot_fall_r", 1, 72, 2.37, 0, 0.5),
    # A lost leg: lift into a one-leg stance, hop in place (two hops cut from a free hop take,
    # cross-faded at the seam), then fall into a seat. The lift ends and the fall starts in the
    # hop take's landing crouch (pinned), so the three clips join.
    ("LegLossRight", "legloss_lift_r", 1, 27, 0.87, 0, 0.3),
    ("LegLossLeft", "legloss_lift_r", 1, 27, 0.87, 0, 0.3),
    ("OneLegHopRight", "hop_r", 36, 78, 1.4, 6, 0),
    ("OneLegHopLeft", "hop_r", 36, 78, 1.4, 6, 0),
    ("LegLossFallRight", "legloss_fall_r", 1, 54, 1.77, 0, 0.5),
    ("LegLossFallLeft", "legloss_fall_r", 1, 54, 1.77, 0, 0.5),
    ("ArmLossRight", "handloss_r", 1, 72, 2.37, 0, 0.3),
    ("ArmLossLeft", "handloss_r", 1, 72, 2.37, 0, 0.3),
    ("StumpClutchRight", "stump_loop", 1, 59, 1.93, 0, 0),
    ("StumpClutchLeft", "stump_loop", 1, 59, 1.93, 0, 0),
    ("StumpKneelRight", "stump_kneel_r", 1, 48, 1.57, 0, 0.3),
    ("StumpKneelLeft", "stump_kneel_r", 1, 48, 1.57, 0, 0.3),
    ("SitToCrawl", "sit_to_crawl", 1, 60, 1.97, 0, 0),
    # Seated last stand: the draw, then an aim loop or an agony loop, each cut from a free take.
    ("SeatedPistolDraw", "seated_draw", 1, 48, 1.57, 0, 0),
    # The held aim is the end of the draw itself, so the two join; sway gives it life in game.
    ("SeatedPistolAim", "seated_draw", 40, 48, 0.8, 4, 0),
    ("SeatedAgony", "seated_agony", 49, 79, 1.0, 4, 0),
    # Clips that replace procedural poses (docs/procedural-animation-audit.md).
    ("HurtIdle", "hurt_idle", 31, 61, 1.0, 4, 0),
    ("HurtWalk", "hurt_walk", 39, 79, 1.33, 4, 0),
    ("UnarmedIdle", "unarmed_idle", 6, 46, 1.33, 6, 0),
    ("UnarmedWalk", "unarmed_walk", 6, 39, 1.1, 4, 0),
    ("UnarmedRun", "unarmed_run", 5, 27, 0.73, 4, 0),
    ("PickupWeapon", "pickup_weapon", 1, 42, 1.37, 0, 0.3),
    ("PistolDraw", "pistol_draw", 1, 48, 1.57, 0, 0),
    ("StumpDrawRight", "stump_draw_r", 1, 60, 1.97, 0, 0),
    ("StumpDrawLeft", "stump_draw_r", 1, 60, 1.97, 0, 0),
    ("KneelStumpDrawRight", "kneel_stump_draw_r", 1, 54, 1.77, 0, 0),
    ("KneelStumpDrawLeft", "kneel_stump_draw_r", 1, 54, 1.77, 0, 0),
    ("CrawlDragLegRight", "crawl_drag_r", 13, 53, 1.33, 4, 0),
    ("CrawlDragLegLeft", "crawl_drag_r", 13, 53, 1.33, 4, 0),
    ("DownedCollapse", "downed_collapse", 1, 72, 2.37, 0, 0.5),
    # Deaths. A clean kill drops fast, so the shot deaths play about 1.6x the take's speed; the
    # corpse ragdoll takes over from the last frame. The gun is dropped, so there are no twins.
    ("DeathFallBack", "death_back", 1, 72, 1.5, 0, 0.5),
    ("DeathFallForward", "death_forward", 1, 72, 1.5, 0, 0.5),
    ("DeathCrumple", "death_crumple", 1, 48, 1.0, 0, 0.3),
    ("DeathSpin", "death_spin", 1, 66, 1.37, 0, 0.5),
    # Running out of health on the feet is slow: sway, knees, slump. It plays at the take's speed.
    ("DeathBleedOut", "death_bleedout", 1, 96, 3.17, 0, 0.5),
    ("Crawl", "crawl_loop", 1, 69, 2.27, 0, 0),
    ("Walk", "walk_loop", 1, 31, 1.0, 0, 0),
    ("Run", "run_loop", 1, 26, 0.83, 0, 0),
    ("StrafeLeft", "strafe_loop", 1, 32, 1.03, 0, 0),
    ("StrafeRight", "strafe_loop", 1, 32, 1.03, 0, 0),
)

# Side-specific clips: (source take, mirrored, southpaw twin as (take, mirrored) or None).
# Right-side flinches keep a twin: a left-handed body hit in the right arm is the right-handed
# body hit in its left arm, mirrored. Falls and losses drop the gun, so they need no twin; their
# Left clip is the Right take mirrored.
SIDED = {
    "HitFlinchArmRight": ("hit_arm_r", False, ("hit_arm_l", True)),
    "HitFlinchArmLeft": ("hit_arm_l", False, ("hit_arm_r", True)),
    "HitFlinchLegRight": ("hit_leg_r", False, ("hit_leg_l", True)),
    "HitFlinchLegLeft": ("hit_leg_l", False, ("hit_leg_r", True)),
    "LegShotFallRight": ("legshot_fall_r", False, None),
    "LegShotFallLeft": ("legshot_fall_r", True, None),
    "LegLossRight": ("legloss_lift_r", False, None),
    "LegLossLeft": ("legloss_lift_r", True, None),
    "OneLegHopRight": ("hop_r", False, None),
    "OneLegHopLeft": ("hop_r", True, None),
    "LegLossFallRight": ("legloss_fall_r", False, None),
    "LegLossFallLeft": ("legloss_fall_r", True, None),
    "ArmLossRight": ("handloss_r", False, None),
    "ArmLossLeft": ("handloss_r", True, None),
    "StumpClutchRight": ("stump_loop", False, None),
    "StumpClutchLeft": ("stump_loop", True, None),
    "StumpKneelRight": ("stump_kneel_r", False, None),
    "StumpKneelLeft": ("stump_kneel_r", True, None),
    "SitToCrawl": ("sit_to_crawl", False, None),
    # No gun in the hands, so nothing to mirror for a left-handed body.
    "UnarmedIdle": ("unarmed_idle", False, None),
    "UnarmedWalk": ("unarmed_walk", False, None),
    "UnarmedRun": ("unarmed_run", False, None),
    "StumpDrawRight": ("stump_draw_r", False, None),
    "StumpDrawLeft": ("stump_draw_r", True, None),
    "KneelStumpDrawRight": ("kneel_stump_draw_r", False, None),
    "KneelStumpDrawLeft": ("kneel_stump_draw_r", True, None),
    "CrawlDragLegRight": ("crawl_drag_r", False, None),
    "CrawlDragLegLeft": ("crawl_drag_r", True, None),
    "DownedCollapse": ("downed_collapse", False, None),
    "DeathFallBack": ("death_back", False, None),
    "DeathFallForward": ("death_forward", False, None),
    "DeathCrumple": ("death_crumple", False, None),
    "DeathSpin": ("death_spin", False, None),
    "DeathBleedOut": ("death_bleedout", False, None),
}

# Seated aims whose gun arm Kimodo leaves pointing at the floor: (degrees the upper arm is lifted,
# share of the clip where the lift starts, share where it is complete). The draw ends on its most
# extended frame and lifts the arm as it comes forward; the aim loop is lifted throughout.
ARM_LIFT = {
    "SeatedPistolDraw": (30.0, 0.55, 1.0),
    "SeatedPistolAim": (30.0, 0.0, 0.0),
}

# Takes whose body faces the floor; their heading comes from the direction they travel.
PRONE = {"Crawl", "CrawlDragLegRight", "CrawlDragLegLeft"}

LOOPING = {"CombatReadyIdle", "UnsuspectingIdle", "Crawl", "Walk", "Run", "StrafeLeft", "StrafeRight",
           "StumpClutchRight", "StumpClutchLeft", "OneLegHopRight", "OneLegHopLeft", "SeatedPistolAim",
           "SeatedAgony", "PistolOneHandHold", "HurtIdle", "HurtWalk", "UnarmedIdle", "UnarmedWalk", "UnarmedRun",
           "CrawlDragLegRight", "CrawlDragLegLeft"}
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


def arm_lift(clip, t):
    """Degrees the gun arm is lifted at share `t` of the clip (see ARM_LIFT)."""
    if clip not in ARM_LIFT:
        return 0.0
    degrees, begin, full = ARM_LIFT[clip]
    if full <= begin:
        return degrees
    ramp = min(1.0, max(0.0, (t - begin) / (full - begin)))
    return degrees * ramp * ramp * (3 - 2 * ramp)


def clip_variants(clip, take):
    """(name, take, mirrored) for each baked version of a clip.

    A clip normally gets a `_Southpaw` twin: the same take mirrored, for a left-handed character.
    Wound clips named after the body side they hurt carry their own mirror rule in `SIDED`.
    """
    if clip in SIDED:
        source, mirrored, twin = SIDED[clip]
        variants = [(clip, source, mirrored)]
        if twin:
            twin_take, twin_mirrored = twin
            variants.append((clip + "_Southpaw", twin_take, twin_mirrored))
        return variants
    if clip.startswith("Strafe"):
        return [(clip + suffix, take, clip == "StrafeRight") for suffix in ("", "_Southpaw")]
    return [(clip, take, False), (clip + "_Southpaw", take, True)]


def build_clips(glb, motion):
    sources = {}
    for clip, take, start, end, duration, loop, xz_scale in TAKES:
        count = round(duration * EXPORT_FPS)
        times = [index / EXPORT_FPS for index in range(count + 1)]
        traveling = clip in {"Walk", "Run", "HurtWalk", "UnarmedWalk", "UnarmedRun"} or clip.startswith("Strafe")
        for name, source_take, mirror in clip_variants(clip, take):
            if source_take not in sources:
                sources[source_take] = load_soma(motion / (source_take + ".bvh"))
            source = sources[source_take]
            retarget = CombatantRetarget(glb, source, start, mirror, end if clip in PRONE else None)
            arm = "Bone_UPPER_ARM_" + ("LEFT" if mirror else "RIGHT")
            frames = [retarget.sample(start + (end - start) * index / count, traveling, xz_scale,
                                      (arm, arm_lift(clip, index / count)))
                      for index in range(count + 1)]
            if loop:
                blend_loop(frames, round(loop * EXPORT_FPS / 30))
            if clip in LOOPING:
                check_seam(name, frames)
            glb.add_clip(name, times, frames)
            if clip == "Walk":
                glb.add_clip(name.replace("Walk", "WalkBackward"), times, list(reversed(frames)))
    for source in sources.values():
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
