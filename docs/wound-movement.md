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

 downed (seated, animated: no ragdoll):
   you are straight in front of it (±30°), it can see you, it has a sidearm and an arm
        ─► SEATED DRAW (2.0 s) ─► DOWNED ENGAGE: SEATED AIM loop, fires while you stay in
           front; holds fire (still aiming ahead) when you step aside; never turns
   otherwise, arms work and it is conscious and not too gritty to run
        ─► SIT TO CRAWL ─► CRAWL away from you, face down: never fires
   otherwise ─► DOWNED AGONY: SEATED AGONY loop; you step in front ─► SEATED DRAW ─► ENGAGE

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
| BLAZE | `PistolAimOneHand`; walking, the legs play the walk and the upper body holds the aim clip (`combatantUpperBodyLayer.ts`) |
| KNEEL_DOWN, KNEEL_FIRE | `StumpKneel*`, then `KneelPistolAimOneHand` |
| SIT_DOWN, collapse | `DownedCollapse` |
| DOWNED_AGONY (seated) | `SeatedAgony` (loop) |
| DOWNED_ENGAGE (seated) | `SeatedPistolDraw` (one shot, timed to 2.0 s) → `SeatedPistolAim` (loop) |
| FACE_DOWN, ragdoll knockdowns | living ragdoll (muscle drive) |
| DOWNED_CRAWL | `SitToCrawl` → `Crawl` (loop) |
| Aim raises | `LongGunAim`, `PistolAim` |

Flinches play to the end even when the reaction is shorter. A new hit during a flinch restarts it.
A new hit during a fall, loss, collapse or kneel-down only adds the spring jolt, unless it takes
another limb (a leg lost while clutching an arm stump starts the leg loss).

## The seated last stand

After a leg-shot fall, a leg-loss fall or the sit-down collapse, a body whose plan is
DOWNED_ENGAGE or DOWNED_AGONY is not handed to the ragdoll (a crawler never was). It stays
animated, sitting where the fall left it, posture `LEG_BUCKLED`; its pose is read back into the
ragdoll bones so hitboxes follow the clip, and a death drops the corpse ragdoll from the seat.

- **Clips.** Right-handed takes lean back on the left hand and work with the right; the
  `_Southpaw` twin is the mirror. ENGAGE uses the twin when the pistol is in the left hand; AGONY
  when the gun arm is a stump or dead, so the free hand holds the thigh. Until a seated clip is
  baked the body holds the last frame of its fall (`combatantSeatedPlayback.ts`). The three seated
  clips are baked into the GLB and listed in `COMBATANT_ANIMATION_CLIPS`, the asset gate.
- **The draw.** A seated draw takes `SEATED_DRAW_S` = 2.0 s instead of the 0.6 s standing draw;
  the draw clip's playback speed is set so it lasts exactly that. The pistol stays holstered for
  the first 45 % (the hand is reaching round to the hip), then sits in the animated fist; its
  barrel turns from pointing down the thigh to the aim by 90 %. The drawn pistol is a
  `LAST_STAND`. It fires only after the draw and only with you within ±30° of its facing.
- **Hits.** No flinch clip and no new committed reaction: only the spring jolt (a quarter, as
  under any committed clip). A limb shot off while seated adds gore and a jolt; it stays seated
  unless the wound is fatal. No shove knocks a seated body over; only a kill moves it. With no arm
  left to hold the pistol, ENGAGE gives up to AGONY.
- **Core API** (`src/core/ballistics/triage/seatedLastStand.ts`, re-exported from
  `woundedSequenceFsm.ts`): `isSeatedAnimated(hs)`, `seatedDrawProgress(hs)` (0..1 through the draw,
  from entering ENGAGE), `SEATED_DRAW_PISTOL_VISIBLE_AT` = 0.45, `SEATED_DRAW_S` (in
  `woundReactionTimings.ts`). The fire cone points along `downedFacingWorld`, fixed on the first
  seated frame from the body's yaw.
- **The AI** never moves or turns a seated body and never writes its posture.

## Standing and taking it

A body that is hit stops where it stands. The hit itself never shoves a living body across the
floor (the old knockback slide is gone); only a knockdown into the ragdoll moves it. The AI does
not walk, run or strafe it while any reaction is running or while its flinch clip is still
playing out (the mannequin tells the AI, `markFlinchClipHeld` in `woundClipHold.ts`). It turns
and moves again once the clip hands it back. Flinch clips are baked with no root travel.

## Toughness

`src/core/ballistics/shot/archetypeToughness.ts`; the numbers live in `archetypeLoadout.ts`. Each
pellet or bullet is one wound channel, and its HP is scaled by what it went through:

| Class | What | Scale |
| --- | --- | --- |
| Shallow | the channel only touched meat and fat (a buckshot pellet stopping in muscle, scalp or neck muscle) | `shallowWoundScale` |
| Deep meat and bone | meat and bone on a channel that went further in; armour blunt trauma | `bodyDamageScale` |
| Organ | lungs, liver, gut, skull and jaw bone | √`bodyDamageScale` |
| Vital | brain, heart, aorta and carotids, cervical spine | 1, never scaled |

| Archetype | baseHp | shallow | deep | knocked down only at HP ≤ |
| --- | --- | --- | --- | --- |
| SKINHEAD_PUNK | 120 | 0.7 | 1.0 | 35 % |
| SNIPER_OPERATIVE | 135 | 0.7 | 1.0 | 35 % |
| MILITIA_GUNNER ("the Muscle") | 145 | 0.22 | 0.8 | 30 % |
| MASKED_BRUISER | 165 | 0.22 | 0.8 | 30 % |
| HEAVY_ENFORCER (plate, helmet) | 190 | 0.25 | 0.85 | 25 % |

Why: a 00 buckshot blast puts each pellet's whole energy (about 230 J at 8 m) into the chest
muscle, and the pellet's HP is then boosted by its flattening (1.38^1.25) and the tight-pattern
bonus (×1.48 inside 6 m, gone by 20 m). A chest blast at 8 m took 60–75 % of the Muscle's health;
now about 17 % (about 22 % at 5 m, where it took 96 %). A punk still loses about
64 % at 8 m. Rifle and pistol rounds go deep, so they are softened much less: an M4 round to the
chest takes the Muscle 19 % before, 16 % now.

The instant kills ignore HP and are untouched: cranial burst, severed neck, destroyed brain or
cervical spine, fatal limb loss, and a ruptured heart's +68 HP.

**Knockdowns** (`shotLethalityPass.ts`): a shove of 230 N·s or more (a point-blank blast) or a
broken pelvis puts a body in the ragdoll only when the hit leaves it at or below its knockdown
fraction. Above it the body rocks and stays up; a broken pelvis then cripples the leg on the side
the round entered and plays the leg-shot fall. Both legs gone still knocks it down (fatal anyway).
A grenade within 5.8 m (`fragBlastCalculator.ts`) follows the same rule: it throws a living body
into the ragdoll only when the blast kills it or leaves it at or below its knockdown fraction, and
never throws a seated last-stand body that it does not kill.

## Who owns which bones

Clips own every living body that is upright, kneeling, seated or crawling. The hit jolt plays at
full strength with no wound clip and is off under a wound, seated or fall clip; a stump arm follows
the clip. The gun follows the animated trigger hand; falls and losses drop it at the start.
Nothing poses the sidearm arm in any state: the draw and aim clips move it (standing, one-handed,
kneeling, seated, and walking in BLAZE through the upper-body layer), and the pistol rides the
animated fist, appearing once the draw clip is 45 % through. The only correction is the clamped
aim delta (`combatantAimDelta.ts`: chest and gun arm, yaw up to 15 degrees, pitch up to 25), which
also carries the sway and recoil (`weaponSway.ts`), so the visible barrel points where the shots
go. A living body in the ragdoll (face down) keeps the pistol holstered.

A drawn sidearm is never disarmed: no hit, flinch, knockback, fall or knockdown takes it, and the
sequence's HOLSTER and DROP rules only keep a pistol from coming out. A draw already past
`SIDEARM_OUT_OF_HOLSTER_DRAW_FRACTION` (0.35, just before the pistol shows at 45 %) is paused in
the fist instead of undone. The pistol is lost only with the arm that holds it (severed or put
out of action) or on death. The long gun is knocked out of the hands by a hit only once the
health bar is red (`RED_HEALTH_HP_FRACTION`); see `hitDisarmPolicy.ts`.

## Previewing

Character Lab (`/gm/characters`) plays every clip. Its wound sequence buttons run the real hit
path on a live mannequin, with a fortitude override and a player stand-in you can place in front
of or beside the downed body, so every branch can be watched start to finish. "Leg off, you step
in front later" leaves the body in seated agony with you to its side, then moves you in front 3 s
after it lands: it draws from the hip and aims. The status line names the seated clip asked for
and says when it is not baked yet.
