# Combatant wound movement

How a combatant moves from the moment a bullet lands to the moment it shoots back, or doesn't.
Every clip named here is a Kimodo take in `scripts/blender/motion/`, baked into
`ghoul_combatant.glb`.

The rule over everything: **one thing at a time.** A body recoils, then clutches, then decides,
then moves, then draws, then aims. It never clutches while drawing, aims while falling, or fires
while kneeling down. Each phase finishes before the next starts.

## The loop

```
 COMBAT READY ── hit ──► FLINCH (by zone) ──► COMBAT READY ──► aim ──► fire
                              (graze: jolt only, keeps aiming)

 arm off ──► ARM LOSS ──► CLUTCH the stump ──┬─ no sidearm ─────────► keeps clutching, harmless
                                             │                         (weak: SIT DOWN ─► downed)
                                             ├─ high fortitude ──► DRAW ──► BLAZE: on its feet,
                                             │                               one-handed, advancing,
                                             │                               firing till it drops
                                             ├─ middling ───► KNEEL DOWN ──► DRAW ──► KNEEL FIRE
                                             └─ low ────────► SIT DOWN ────► downed

 leg crippled ─► LEG SHOT FALL ─────────────┐
 leg off ─► LIFT ─► HOP, HOP, HOP ─► FALL ──┼──► lands seated ──► downed
 arm gone + HP ≤ 32 % ─► DOWNED COLLAPSE ───┘

 downed (seated):
   you are straight in front of it (±30°), it can see you, it has a sidearm and an arm
        ─► DRAW ─► DOWNED ENGAGE: fires while you stay in front; holds fire when you step aside
   otherwise, arms work and it is conscious and not too gritty to run
        ─► SIT TO CRAWL ─► CRAWL away from you, face down: never fires
   otherwise ─► DOWNED AGONY: lies there

 landed on its face, or fell forward (ragdoll knockdowns) ─► FACE DOWN: no gun, no damage
```

## Fortitude

Rolled once per combatant (`fortitude`, 0..1). The base comes from the resolve profile: fanatic
berserker 0.9, hardened veteran 0.75, gritty regular 0.5, panicked scrapper 0.25. It is then
scaled by remaining health and consciousness when the branch is taken, with a fixed per-target
jitter so two regulars don't act alike.

| Fortitude when the clutch ends | Branch |
| --- | --- |
| ≥ 0.6 | BLAZE |
| 0.35 – 0.6 | KNEEL |
| < 0.35 | SIT DOWN |

High fortitude also clutches for a shorter time (0.8 s at 1.0, 2.5 s at 0).

## Every clip starts where the last one ends

Kimodo generates each take with full-body pose pins (`scripts/blender/kimodo_batch.py`), and the
prompts describe body mechanics, never events ("bends forward holding the stomach", not "is shot
in the gut").

- **Flinches** pin their first and last frames to the combat-ready idle.
- **Falls, losses and the collapse** start from the idle pose and end seated, leaning back on one
  hand: the SEATED target of the downed ragdoll (`groundedPoseTargets.ts`).
- **The leg loss** is three clips: `LegLoss*` lifts the stump into a one-leg stance, `OneLegHop*`
  loops a hop in place, `LegLossFall*` topples into the seat. Each is pinned to the last.
- **Stump clutch** loops on the last pose of the arm-loss take; **stump kneel** starts from it.
- **Sit to crawl** starts from the seated end of the leg-shot fall and blends into the crawl loop.

## Clips per phase

| Phase | Clip |
| --- | --- |
| Flinch: chest, head, gut, throat, arm, leg | `HitStaggerChest`, `HitFlinchHead`, `HitFlinchGut`, `HitFlinchThroat`, `HitFlinchArm*`, `HitFlinchLeg*` |
| Leg crippled | `LegShotFall*` |
| Leg off | `LegLoss*` → `OneLegHop*` → `LegLossFall*` |
| Arm off | `ArmLoss*` |
| CLUTCH | `StumpClutch*` (loop) |
| BLAZE | `PistolAimOneHand`, walking with the pistol arm aimed procedurally |
| KNEEL_DOWN, KNEEL_FIRE | `StumpKneel*`, then `KneelPistolAimOneHand` |
| SIT_DOWN, collapse | `DownedCollapse` |
| DOWNED_ENGAGE, DOWNED_AGONY, FACE_DOWN | living ragdoll (muscle drive) |
| DOWNED_CRAWL | `SitToCrawl` → `Crawl` (loop) |
| Aim raises | `LongGunAim`, `PistolAim` |

Flinches play to the end even when the reaction is shorter. A new hit during a flinch restarts it.
A new hit during a fall, loss, collapse or kneel-down only adds the spring jolt, unless it takes
another limb (a leg lost while clutching an arm stump starts the leg loss).

## Who owns which bones

While a wound clip plays, it owns the body: the spring jolt is scaled down, the prop-up and the
wound-clutch IK are off, and a stump arm follows the clip. The gun follows the animated trigger
hand; falls and losses drop it at the start. The sidearm arm is only aimed procedurally in BLAZE,
KNEEL_FIRE and DOWNED_ENGAGE, after the draw.

## Previewing

Character Lab (`/gm/characters`) plays every clip. Its wound sequence buttons run the real hit
path on a live mannequin, with a fortitude override and a player stand-in you can place in front
of or beside the downed body, so every branch can be watched start to finish.
