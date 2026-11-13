# Plan: remove procedural combatant animation (lead executes)

Current state, checked 2026-11-13:
- The other workflow already owns the seated last stand. `src/engine/mannequin/combatantSeatedClips.ts` is new and plays SeatedPistolDraw/Aim/Agony with a `_Southpaw` mirror, and `combatantAnimController.ts:280` drives the draw speed.
- That workflow also owns hit-slide removal (`reactionAgonyApplicator.ts:19-42`), weapon sway (`src/core/ai/weaponSway.ts`) and toughness. Do not touch those files.
- No PlayCanvas anim layers or masks are used anywhere. There is a single `baseLayer` (`combatantAnimController.ts:132`).
- The clip choice is `locomotion?.clip ?? aimClip ?? baseClip` (`combatantAnimController.ts:173-177`), so gait beats aim.
- `combatantAnimController.ts` is 341 LOC. New logic must go into new files.
- The takes already in the queue are listed in `scripts/blender/wound_takes_seated.json`: seated_draw2, seated_aim, seated_agony2, unarmed_idle, pistol_draw, stump_draw_r.

## Status (updated after Wave 3, fix round 3)

Done and deleted: C3 (`combatantWeaponHold.ts`, `combatantWeaponStance.ts`, `core/ghoul/anatomy/weaponHold.ts`), C4 (`combatantAimHead.ts`), C5 (`core/ghoul/anatomy/combatPose.ts`), C8 (`combatantUnarmedArms.ts`; UnarmedIdle/Walk/Run now play) and C10 (LegCollapseCrawl and DiaphragmDropKneel are gone from the GLB). B5 is `combatantAimDelta.ts`, called from `combatantWeaponMount.ts` whenever an aim clip plays and no reaction or wound clip holds the body, including hurt bodies that aim from HurtIdle. The file:line references below describe the code as it was when the plan was written; files marked "(deleted)" no longer exist.

Still open:
- **Support-hand gap (lead decision).** The C3 premise below did not hold: the rebaked Kimodo carry and aim takes do not hold the M4. The support palm sits 35-88 cm off the forend in CombatReadyIdle, LongGunAim, Walk/WalkBackward, Strafe*, UnsuspectingIdle and PickupWeapon. `combatantWeaponHands.ts` works round it with a wide reach band (`LOOSE_SUPPORT_*`, 0.95-1.1 m) for the first six of those clips only; everywhere else the 12/20 cm contact band of B4 applies. Either re-take those clips with the hands on a prop (then drop the wide band) or keep the wide band.
- **B3 is rigid in position only.** The gun sits rigidly in the animated palm, but its direction cannot come from the hand bone: glued to the hand's rotation the barrel points 30-100 degrees off the body's facing (straight up in parts of LongGunAim and the flinches, sideways in UnsuspectingIdle), because the takes were made without a prop. `combatantGunHeading.ts` takes the direction from the animated chest heading leaned by the animated forearm, and B5 then turns it onto the target. Re-taking the clips with a prop would allow full rigid glue.

Guiding rule: clips own the pose of every living, upright or seated body. Procedural code is allowed only for:
- physics
- rigid glue (gun to hand)
- small clamped corrections of a few cm or a few degrees: palm onto the grip, aim toward the target's pitch, a graze jolt

---

## A) REPLACE WITH AUTHORED CLIP

All takes are for Kimodo at 30 fps with the M4 reference prop where noted.
- "Sided" means a right-handed take plus a mirrored `Left` or `_Southpaw` twin through the existing mirror table (`bake_kimodo_combatant.py:68-94`).
- Put the new takes in a new `scripts/blender/wound_takes_round2.json`, not in `wound_takes_seated.json` or `bake_kimodo_combatant.py` TAKES, which the other workflow is editing. Add their TAKES rows only after that workflow lands.

### A1. Hurt stance (replaces the posture-held HitStaggerChest last frame and the standing wound-clutch IK)

| Clip | Kimodo motion (plain mechanics) | Dur | Loop | Pins | Sided |
|---|---|---|---|---|---|
| `HurtIdle` | "A person stands hunched forward, knees bent, pressing the left hand flat on the belly, holding a rifle low in the right hand pointing at the floor, breathing hard" | 3.0 s | loop | start = end, matched for the loop; first frame near the HitFlinchGut last frame | Southpaw mirror |
| `HurtWalk` | "A person walks forward slowly, hunched and limping slightly, left hand pressed on the belly, rifle held low in the right hand" | 1.2 s (1 stride cycle) | loop | in place, root-locked like Walk | Southpaw mirror |

Code changes:
- Map postures STAGGERED, GUT_HURT and THROAT_CLUTCH to `HurtIdle`, and to `HurtWalk` when moving, in `combatantAnimController.ts` (base clip, posture → clip, around :92 and the canAim gate at :159).
- Allow locomotion in those postures. This removes the "moving while hurt slides" bug.
- A throat variant is optional. Skip it for now, since HitFlinchThroat covers the onset.

Code to delete once the clips exist (shared with C2): the wound-clutch IK, `proceduralTraumaIk.ts:107-145, :238-274` and `combatantDeadLimbOverlay.ts:110-132`, plus HitStaggerChest in RELAXED_CLIPS for `combatantUnarmedArms`.

### A2. Sidearm draws (replace the procedural holster→aim arm in `offhandSidearmSync.ts:159-199`)

| Clip | Motion | Dur | Loop | Pins | Sided |
|---|---|---|---|---|---|
| `PistolDraw` (take `pistol_draw`, queued) | as queued | 1.6 s | one-shot, holds last frame | end = PistolAim frame 1 | Southpaw mirror |
| `StumpDrawRight` (take `stump_draw_r`, queued) | as queued; pinned to handloss_r frames 70-71 | 2.0 s | one-shot | start = StumpClutchRight, end ≈ PistolAimOneHand frame 1 | `StumpDrawLeft` mirror |
| `KneelStumpDrawRight` (new) | "A person kneeling on the right knee holds the right wrist to the chest with the left hand, lets go, pulls a pistol from the left hip with the left hand and raises it to eye level aiming ahead with the left arm straight" | 1.8 s | one-shot | start = StumpKneelRight last frame, end ≈ KneelPistolAimOneHand frame 1 | `KneelStumpDrawLeft` mirror |
| Seated draw | other workflow | | | | |

Code changes:
- The draw clip's `activeStateProgress` drives `drawProgress`, inverting the current direction. Copy the seated pattern (`seatedDrawPlaybackSpeed`, `SEATED_PISTOL_VISIBLE_PROGRESS`).
- The pistol stays holstered until about 0.45 progress, then it is aligned to the animated palm.

Code to delete:
- The holster→aim lerp, the fixed elbow bend and the writes into ragdollBones and GLB joints (`offhandSidearmSync.ts:159-199`).
- `DOWNED_ELBOW_BEND` / the cone rod arm at `:110-130`. Coordinate this with the other workflow, which may already be cutting it for seated.
- Keep the cone clamp only as the input to the aim delta in B5.

### A3. Unarmed

| Clip | Motion | Dur | Loop | Pins | Sided |
|---|---|---|---|---|---|
| `UnarmedIdle` (take `unarmed_idle`, queued) | as queued | 3.0 s | loop | start = end | symmetric, no twin |
| `UnarmedWalk` | "A person walks forward at a steady pace with empty hands, arms swinging naturally opposite the legs" | 1.0 s | loop | in place, phase matched to Walk | symmetric |
| `UnarmedRun` | "A person runs forward with empty hands, arms pumping bent at the elbows opposite the legs" | 0.83 s | loop | in place, phase matched to Run | symmetric |
| `PickupWeapon` | "A person standing with empty hands crouches down, grabs a rifle from the floor in front of the right foot with both hands, and stands back up holding it low across the body" | 1.2 s | one-shot | start = UnarmedIdle frame 1, end ≈ CombatReadyIdle frame 1 | Southpaw mirror |

Code changes:
- When `!armed`, choose Unarmed* in `combatantLocomotion.ts` / `combatantAnimController.ts`.
- Make `weaponRecovery.ts` (`PICKUP_DURATION_S` 0.7) take its duration from `PickupWeapon`.
- Show the gun at about 0.5 progress, in the hand, through the gun-follows-hand path.

Code to delete: `combatantUnarmedArms.ts` entirely (98 LOC) and its call sites `combatantWeaponMount.ts:166, :199`. Until UnarmedWalk/Run are baked, keep only its stride swing for gait.

### A4. Crawl drag-leg (replaces the leg slerp and head droop in `combatantCrawlOverlay.ts:30-83`)

| Clip | Motion | Dur | Loop | Pins | Sided |
|---|---|---|---|---|---|
| `CrawlDragLegRight` | "A person crawls forward on the stomach pulling with both forearms and pushing with the left leg only, the right leg lying straight and limp, dragged behind, head low" | 2.3 s | loop | in place, start = end; start ≈ Crawl frame 1 | `CrawlDragLegLeft` mirror |

Both legs useless still plays Crawl. Optionally add `CrawlDragBoth` (arms only) later.

Code to delete: `combatantCrawlOverlay.ts:53` and `:56-83` (leg slerp to bind and the head nod). Keep the blood trail, which is FX. The file shrinks to the trail only.

### A5. Turn in place (replaces root spin with skating feet; also the snap turn on recovery)

| Clip | Motion | Dur | Loop | Sided |
|---|---|---|---|---|
| `TurnRight90` | "A person holding a rifle at low ready steps around in place to turn 90 degrees to the right in two short steps" | 0.9 s | one-shot; start and end ≈ CombatReadyIdle frame 1; root yaw extracted, not root-locked | `TurnLeft90` mirror |

- Play it when |yaw rate| exceeds about 1.5 rad/s while gait speed is about 0, in a new `combatantTurnClips.ts`.
- The AI still owns the yaw, which is spread over the clip.
- Priority is medium. A kneel-shuffle turn is optional; skip it.

### A6. Reload (upper body)

| Clip | Motion | Dur | Loop | Sided |
|---|---|---|---|---|
| `ReloadRifle` | "A person standing holding a rifle at chest height pulls the magazine out with the left hand, reaches to the belt, pushes a new magazine in and pulls the charging handle" | weapon `reloadDurationS` (about 2.5 s) | one-shot on the upper-body layer (B4) | Southpaw |
| `ReloadPistol` | "A person holding a pistol in the right hand drops the magazine, takes a new one from the belt with the left hand, inserts it and racks the slide" | about 1.8 s | one-shot on the upper layer | Southpaw |

This needs the upper-body layer first. Priority is medium-low.

### A7. Face-down living (replaces the PRONE muscle drive in `groundedPoseTargets.ts`, the PRONE branch)

| Clip | Motion | Dur | Loop | Sided |
|---|---|---|---|---|
| `ProneAgony` | "A person lies face down propped on the left elbow, head raised, slowly dragging the right hand across the floor, breathing hard" | 3.0 s | loop; start = end | Southpaw mirror |

Wire it the same way as the seated clips: on a settled body the root sits on the ragdoll pelvis. Its owner is the other workflow's seated module pattern, so do it after they land.

### Not authored (low value or high effort)
- Get-up from a blast knockdown.
- Hurt-throat variant.
- Kneel turn.
- Walking-pistol clips, which the upper-body layer covers instead.

---

## B) KEEP (procedural or physics, minimised)

1. **Physics.** These are the motion of non-living or uncontrolled matter, not authorable poses. No change.
   - corpse Verlet/PBD solver and joint limits (`ragdollVerletStep.ts`)
   - `corpseSprawlDrive`
   - blast velocity (`externalExplosionRouter.ts:78-83`)
   - death slump and handoffs: `ragdollMuscleDrive.ts:93-115` releaseMuscleTone, `physiologySyncAdapter.ts:44-55`, `ragdollPoseStabilizer.ts:10-29`
   - severed-limb copy (`ghoulMannequinEntity.ts:186-193`)
   - CRANIAL_POP placeRigidlyOn (`combatantBoneSync.ts:63-70, 122-139`)
   - airborne knockdown
2. **Dead-arm Verlet pendulum** (`deadArmVerlet.ts:43-57, :86+`; `combatantDeadLimbOverlay.ts:139-171`). Secondary motion that depends on whatever the body is doing, so it cannot be authored. Keep as is.
3. **Gun follows the animated hand** (done; direction from the animated chest and forearm, see Status) (`combatantWeaponGrip.align`, `combatantWeaponGrip.ts:36-37`; the fallback path at `combatantWeaponMount.ts:206-244`). This is rigid attachment glue. It becomes the only gun placement, in every state.
4. **Support palm onto the forend: contact IK only** (done; plus the wide band for the loose clips, see Status) (`combatantSupportGrip.ts:14-48` via `CombatantWeaponHands.sync`, `combatantWeaponHands.ts:52-79`).
   - Why it stays: Kimodo's support hand is off by a few cm.
   - Minimise it: a weighted solve that runs only when the palm-to-forend distance is under about 12 cm and fades to 0 beyond about 20 cm. Then a clip that releases the gun, such as a clutch or flinch, is never yanked back.
   - Drop the cross-body bend heuristic.
   - Trigger-hand IK only during the gun's fire clip, as today (`:61-63`).
5. **Aim delta toward a moving target** (done: `combatantAimDelta.ts`; new, replacing the gun rotation in the fist and aimHead).
   - Additive rotation split over spine-upper and the trigger upper arm: yaw ±15°, pitch ±25°, eased.
   - The target's pitch and fine yaw cannot be pre-authored.
   - Apply it after the clip and before the gun-follows-hand step, so the gun inherits it.
   - It also replaces the in-fist gun twist in `offhandSidearmSync.ts:152-157`: the gun stays rigid in the fist and the arm carries the delta.
6. **Weapon sway.** Owned by the other workflow (`weaponSway.ts`). Keep it as an additive on the same delta.
7. **Hit jolt** (`proceduralTraumaIk.ts:175-221`, applied at `combatantDeadLimbOverlay.ts:91-107`). A cheap impact read for grazes, which have no clip.
   - Change the scale: 1.0 with no wound clip, 0 under any wound, seated or fall clip (currently 0.35 / 0.25).
8. **Root translation and yaw from the AI.** Keep. Gait clips are in place, and turns are dressed by A5.
9. **Not animation:** stump caps, severed skin, impact cuts and decals, zone nodes, `readAnimatedBone` read-back, crawl blood trail, lab-only `woundSequences.ts`.
10. **Muscle drive** (`ragdollMuscleDrive.ts:23-81`, `groundedPoseTargets.ts:51-186`). Keep only for FACE_DOWN until A7 lands, and for the brief settle before the seated clip takes over. The other workflow owns SEATED.

---

## C) DELETE

| # | System | Where | Why |
|---|---|---|---|
| C1 | Downed prop-up | `proceduralTraumaIk.ts:225-234` and its use in `combatantDeadLimbOverlay.ts:91-107` | Dead: LEG_BUCKLED is only set during COMMITTED falls |
| C2 | Wound-clutch two-bone IK | `proceduralTraumaIk.ts:107-145, :238-274`; `combatantDeadLimbOverlay.ts:110-132, :189-196` | Covered by HitFlinchGut, HitFlinchThroat, StumpClutch* and HurtIdle (A1). Also fixes the BLAZE / KNEEL_FIRE bug, where the sidearm arm counts as "available" (weaponDropped=true, owner null) and gets dragged to the wound before `offhandSidearmSync.ts:152-156` aligns the pistol to it. Delete now; don't wait for A1. Until HurtIdle bakes, HitStaggerChest's hold is acceptable. |
| C3 | Stance tables + both-arm hold IK | `core/ghoul/anatomy/weaponHold.ts:45-51` and the solver (174 LOC); `combatantWeaponHold.ts` (140 LOC, whole file); `combatantWeaponHands.ts:82-104` syncHold; `combatantWeaponStance.ts:5-18`; stance branches in `combatantWeaponMount.ts` | **Done, files deleted.** Premise turned out false: the rebaked takes do not hold the M4 (see Status, support-hand gap). Replaced by B3 + B4 + B5. |
| C4 | Aim head | `combatantAimHead.ts` (whole); calls at `combatantWeaponMount.ts:203, :207` | **Done, file deleted.** LongGunAim and PistolAim sight down the gun, and B5's spine delta carries the head |
| C5 | `updateStandingCombatPose` | `core/ghoul/anatomy/combatPose.ts` (208 LOC); calls at `tacticalAgentFsm.ts:111, :122, :192` and `tacticalAiRegistration.ts:39`; export in `core/ghoul/anatomy.ts` | **Done, file deleted.** A procedural fallback skeleton that is a no-op in game (`poseFromAnimation` is set at `ghoulMannequinEntity.ts:216`), and AGENTS.md §4 forbids it. `tests/blender_combatant_runtime.test.ts:19, :54-55` uses it: rewrite that test to pose the bones from a clip sample, or drop the assertion that needs it. Check headless AI tests for reliance on the `hs` fields it writes, such as stance and sink. |
| C6 | Hit slide | `reactionAgonyApplicator.ts:19-42` | Other workflow; verify it is gone |
| C7 | Procedural sidearm arm | `offhandSidearmSync.ts:159-199` (+ `:110-130` downed rod arm) | Replaced by A2 draws, the B-layer for walking, and B5 |
| C8 | Unarmed arms IK | `combatantUnarmedArms.ts` | **Done, file deleted.** UnarmedIdle/UnarmedWalk/UnarmedRun play instead. |
| C9 | Crawl leg slerp + head droop | `combatantCrawlOverlay.ts:53-83` | After A4 |
| C10 | Legacy clips LegCollapseCrawl, DiaphragmDropKneel | `bake_kimodo_combatant.py:54-55`; `combatantWoundedPhaseClips.ts:46-48, :93`; `combatantAnimController.ts:92, :144-147, :264`; `glbTypes.ts:44, :95` | **Done** (clips removed from the GLB). Re-point LEG_BUCKLED → DownedCollapse and collapsed → SitToCrawl → Crawl. Cleanup; the `blender_*` tests will need clip lists updated when the GLB is re-exported. Last. |

---

## B-layer: upper-body aim layer (code only, no new takes; the key enabler)

Add `src/engine/mannequin/combatantUpperBodyLayer.ts`, about 120 LOC:
- Create a second anim layer, `UpperBody`, with additive=false, weight blend 0.15 s.
- Assign a mask via PlayCanvas `AnimComponentLayer.assignMask`. The mask covers the spine from the lumbar/lower-thorax bone up, both arm chains, the neck and the head. Resolve the paths from the GLB hierarchy in `combatantGlbSetup.ts`, using the `Bone_<PART>_<SIDE>` names.
- The base layer plays the gait. The upper layer plays LongGunAim, PistolAim, PistolAimOneHand or CombatReadyIdle (carry) whenever the body is moving with `isPeekingOut`/aim, or in BLAZE.
- The same layer later hosts ReloadRifle/ReloadPistol (A6) and the arms of UnarmedIdle if gait clips lag.

In `combatantAnimController.ts:159-177`, stop letting `locomotion` suppress `aimClip`. Instead, pass `aimClip` to the upper layer when `locomotion` is set; otherwise layer weight 0. Leave stump-arm and wound/COMMITTED clips on the base layer, with the upper weight forced to 0.

This fixes:
- hip-low firing while charging, flanking or backpedalling
- the BLAZE walking rod arm
- the stump arm holding an invisible forend in Walk, since PistolAimOneHand carries the stump tucked

---

## Ordered implementation (disjoint file groups; at most 2-3 authors at a time; a single verifier runs tsc, vite build and targeted tests after each wave)

**Wave 0 (Blender on chonkster.local, in parallel with Wave 1)**
- Group BL owns `scripts/blender/wound_takes_round2.json` (new).
- Generate A1 HurtIdle/HurtWalk, A3 UnarmedWalk/UnarmedRun/PickupWeapon, A4 CrawlDragLegRight, A2 KneelStumpDrawRight, A5 TurnRight90.
- Then A6 Reload*, and A7 ProneAgony last.
- Add TAKES and mirror rows to `bake_kimodo_combatant.py` only after the other workflow's edits to that file are committed.
- Add `glbTypes.ts` clip names in Wave 2, again after the other workflow lands.

**Wave 1 (deletions plus "arms from clips"; no new assets needed)**
- **Author G1 (weapon mount):**
  - Files: `combatantWeaponMount.ts`, `combatantWeaponHold.ts`, `combatantWeaponHands.ts`, `combatantWeaponStance.ts`, `combatantAimHead.ts`, `combatantSupportGrip.ts`, `combatantWeaponGrip.ts`, `core/ghoul/anatomy/weaponHold.ts`, `combatantUnarmedArms.ts`.
  - Do C3 and C4: gun-follows-hand everywhere (B3), plus distance-gated support contact IK (B4).
  - Reduce the unarmed arms to the gait swing only.
  - Fix weaponHold-dependent tests (grep tests for `weaponHold` / `WeaponHold`).
- **Author G3 (overlays + core cleanup):**
  - Files: `combatantDeadLimbOverlay.ts`, `core/ghoul/anatomy/proceduralTraumaIk.ts`, `core/ghoul/anatomy/combatPose.ts`, `core/ghoul/anatomy.ts` barrel, `engine/ai/tacticalAgentFsm.ts`, `engine/ai/tacticalAiRegistration.ts`, `tests/blender_combatant_runtime.test.ts`.
  - Do C1, C2 and C5, and set the jolt to 0 under clips (B7).
- **Author G2 (anim controller + upper layer):**
  - Files: `combatantAnimController.ts`, `combatantUpperBodyLayer.ts` (new), `combatantGlbSetup.ts`, `combatantLocomotion.ts`.
  - Build the B-layer, and add the B5 aim delta as a new `combatantAimDelta.ts` applied before the gun-follows-hand step. B5 depends on G1's call order, so G2 exports the function and G1 calls it in `combatantWeaponMount.ts`; G1 and G2 coordinate only on that one call line.

**Wave 2 (after the other workflow's seated, sway and slide work lands; read the current `offhandSidearmSync.ts` and `combatantSeatedClips.ts` first)**
- **Author G4 (sidearm):** `offhandSidearmSync.ts`, plus a new `combatantDrawClips.ts` for the draw-stage selection. It must not go into `combatantAnimController.ts`, which is at 341 LOC.
  - Do A2 wiring and C7.
  - BLAZE walking uses G2's upper layer; the gun stays in the fist; the arm carries the B5 delta.
- **Author G2:** add the `glbTypes.ts` clip names. Hook the hurt posture → HurtIdle/HurtWalk (A1) in `combatantAnimController.ts` / `combatantWoundedPhaseClips.ts`, and wire `UnarmedIdle`.

**Wave 3 (as clips bake)**
- G1: delete `combatantUnarmedArms.ts` once UnarmedWalk/Run ship (C8).
- G5, files `engine/ai/weaponRecovery.ts` and `combatantCrawlOverlay.ts`:
  - PickupWeapon timing (A3)
  - the CrawlDragLeg* swap and C9 (A4)
  - the TurnRight/Left90 hook via a new `combatantTurnClips.ts` (A5)
- G2: Reload* on the upper layer (A6).
- ProneAgony (A7): coordinate with the owner of the seated module.
- C10 legacy-clip removal last, together with the GLB re-export and the `blender_*` test fixture updates.

**Verification after each wave:**
- line-count audit: everything under 450 LOC, and `combatantAnimController.ts` must not grow
- `npx tsc --noEmit`, then `npx vite build`
- targeted tests: `tests/blender_combatant_runtime.test.ts`, the weapon-mount/hold tests and the sidearm tests, in a single fork
- Character Lab (`/gm/characters`) visual check of idle, walk-aim, BLAZE, draw, hurt and crawl

**Files referenced** (all under /Users/artis/dev/ghoul-x-playcanvas):
- src/engine/mannequin/combatantAnimController.ts
- src/engine/mannequin/combatantSeatedClips.ts
- src/engine/mannequin/combatantWeaponMount.ts
- src/engine/mannequin/combatantWeaponHold.ts (deleted)
- src/engine/mannequin/combatantWeaponHands.ts
- src/engine/mannequin/combatantWeaponStance.ts (deleted)
- src/engine/mannequin/combatantAimHead.ts (deleted)
- src/engine/mannequin/combatantUnarmedArms.ts (deleted)
- src/engine/mannequin/combatantDeadLimbOverlay.ts
- src/engine/mannequin/combatantCrawlOverlay.ts
- src/engine/combat/offhandSidearmSync.ts
- src/engine/mannequin/combatantAimDelta.ts (new, B5)
- src/engine/mannequin/combatantGunHeading.ts (new, B3 barrel direction)
- src/core/ghoul/anatomy/proceduralTraumaIk.ts
- src/core/ghoul/anatomy/weaponHold.ts (deleted)
- src/core/ghoul/anatomy/combatPose.ts (deleted)
- src/core/ballistics/triage/groundedPoseTargets.ts
- scripts/blender/bake_kimodo_combatant.py
- scripts/blender/wound_takes_seated.json
- tests/blender_combatant_runtime.test.ts