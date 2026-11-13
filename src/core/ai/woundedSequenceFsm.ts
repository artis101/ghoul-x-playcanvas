import type { TargetHealthState, WoundedPhase } from '../../contracts/ballistics/targetHealthContracts.ts';
import { transitionTargetLifecycle } from '../ballistics/lifecycle/targetLifecycleFsm.ts';
import { isFaceDownPending, resolveDownedFacing, yawForward } from '../ballistics/triage/faceDownLanding.ts';
import { isSeatedAnimated } from '../ballistics/triage/seatedLastStand.ts';
import { listLostLimbs } from '../ballistics/trauma/limbLossDeathRule.ts';
import {
  SEATED_DRAW_S,
  STUMP_KNEEL_S,
  WOUND_CLIP_SECONDS,
  clutchSeconds,
  isCommittedWoundReaction,
  isFallingReaction,
} from '../ballistics/trauma/woundReactionTimings.ts';
import { effectiveFortitude, rollFortitude } from './fortitude.ts';

export { effectiveFortitude, rollFortitude };
export { isSeatedAnimated };

/**
 * The wounded sequence (docs/wound-movement.md): one thing at a time. An arm comes off, the body
 * clutches the stump, then by its fortitude it stands and guns (BLAZE), kneels and shoots
 * (KNEEL_DOWN then KNEEL_FIRE), or sits down (SIT_DOWN) and is downed. A body on the floor only
 * shoots at a player straight in front of it (DOWNED_ENGAGE); otherwise it crawls away or lies
 * there. One that lands on its face never fires again.
 */

const DEG = Math.PI / 180;
/** A downed body only fires at a player within this of where it faces; it never turns to track. */
export const DOWNED_FIRE_CONE_RAD = 30 * DEG;
/** A kneeling shooter covers a little more, turning slowly on its knees. */
export const KNEEL_FIRE_CONE_RAD = 40 * DEG;

/** At or above this effective fortitude a clutching body draws and guns on its feet. */
const BLAZE_FORTITUDE = 0.6;
/** At or above this (and below BLAZE) it kneels first; below it, it sits down. */
const KNEEL_FORTITUDE = 0.35;
/** A crawler must be awake enough to drag itself... */
const CRAWL_MIN_CONSCIOUSNESS = 0.5;
/** ...and not so gritty that it would rather wait for a shot than run. */
const CRAWL_MAX_FORTITUDE = 0.75;

export interface WoundedSequenceInput {
  readonly dt: number;
  /** Carries a backup sidearm it can still use. */
  readonly hasSidearm: boolean;
  /** At least one arm chain intact and working well enough to hold a pistol. */
  readonly freeArmWorks: boolean;
  /**
   * Unsigned angle between the body's facing (`downedFacingWorld` on the floor, else the yaw
   * forward) and the flat direction to the player; null when unknown.
   */
  readonly playerBearingRad: number | null;
  /** Line of sight to the player. */
  readonly playerVisible: boolean;
}

const DOWNED_PHASES: ReadonlySet<WoundedPhase> = new Set<WoundedPhase>([
  'DOWNED_ENGAGE',
  'DOWNED_CRAWL',
  'DOWNED_AGONY',
  'FACE_DOWN',
]);

function phaseOf(hs: TargetHealthState): WoundedPhase {
  return hs.woundedPhase ?? 'NONE';
}

/** Enters a phase; its clock restarts only when the phase actually changes. */
function setPhase(hs: TargetHealthState, phase: WoundedPhase): void {
  if (phaseOf(hs) === phase) return;
  hs.woundedPhase = phase;
  hs.woundedPhaseTimerS = 0;
}

function committedReactionPlaying(hs: TargetHealthState): boolean {
  const type = hs.activeReaction.type;
  return type !== 'NONE' && isCommittedWoundReaction(type);
}

function withinCone(bearingRad: number | null, coneRad: number): boolean {
  return bearingRad !== null && bearingRad <= coneRad;
}

/** Straight in front, in sight, with a pistol and an arm to hold it: the only way a downed body shoots. */
function canEngageFromFloor(input: WoundedSequenceInput): boolean {
  return (
    input.hasSidearm &&
    input.freeArmWorks &&
    input.playerVisible &&
    withinCone(input.playerBearingRad, DOWNED_FIRE_CONE_RAD)
  );
}

/** What a falling body will do once it is down, decided again every frame of the fall. */
export function planDownedPhase(hs: TargetHealthState, input: WoundedSequenceInput): WoundedPhase {
  if (canEngageFromFloor(input)) return 'DOWNED_ENGAGE';
  if (
    input.freeArmWorks &&
    hs.consciousness >= CRAWL_MIN_CONSCIOUSNESS &&
    effectiveFortitude(hs) < CRAWL_MAX_FORTITUDE
  ) {
    return 'DOWNED_CRAWL';
  }
  return 'DOWNED_AGONY';
}

/** Advances `hs.woundedPhase` and `hs.woundedPhaseTimerS` by one frame. */
export function stepWoundedSequence(hs: TargetHealthState, input: WoundedSequenceInput): void {
  if (!hs.alive) return;
  rollFortitude(hs);

  const reaction = hs.activeReaction.type;
  if (!hs.isRagdollActive && reaction !== 'NONE' && isFallingReaction(reaction)) {
    // Still on its way down: nothing acts on it, but the plan for the floor follows the player.
    // A body sitting down shows SIT_DOWN until its collapse ends; the lifecycle then hands it the
    // plan, so a downed phase never shows while the clip is still playing.
    // A crawler that already landed is down for good and never becomes a shooter, so a fall
    // started on it never replans it. Only a landed crawler has run its phase clock: during a
    // fall the clock is never advanced, so a crawl merely planned in this fall still reads 0.
    if (phaseOf(hs) === 'DOWNED_CRAWL' && (hs.woundedPhaseTimerS ?? 0) > 0) return;
    hs.plannedDownedPhase = planDownedPhase(hs, input);
    if (phaseOf(hs) !== 'SIT_DOWN') setPhase(hs, hs.plannedDownedPhase);
    return;
  }
  if (hs.isRagdollActive) {
    stepDownedRagdoll(hs, input);
    return;
  }
  // A recoil or a loss owns the body until its clip ends; nothing else starts meanwhile.
  if (committedReactionPlaying(hs)) return;

  hs.woundedPhaseTimerS = (hs.woundedPhaseTimerS ?? 0) + input.dt;
  switch (phaseOf(hs)) {
    case 'NONE':
      if (listLostLimbs(hs.severedZones).some((limb) => limb.startsWith('ARM'))) setPhase(hs, 'CLUTCH');
      break;
    case 'CLUTCH':
      stepClutch(hs, input);
      break;
    case 'BLAZE':
      // The pistol or the arm holding it is gone: nothing left to gun with but the stump to hold.
      if (!input.hasSidearm || !input.freeArmWorks) setPhase(hs, 'CLUTCH');
      break;
    case 'KNEEL_DOWN':
      if ((hs.woundedPhaseTimerS ?? 0) >= STUMP_KNEEL_S) setPhase(hs, 'KNEEL_FIRE');
      break;
    case 'DOWNED_AGONY':
    case 'DOWNED_ENGAGE':
      stepSeated(hs, input);
      break;
    default:
      // KNEEL_FIRE holds; SIT_DOWN waits on its collapse; a crawler keeps crawling.
      break;
  }
}

/**
 * A body sitting animated in its last stand. Lying in pain, it reaches for the pistol once the
 * player steps in front of it (the phase clock restarts, so the seated draw plays from the start);
 * engaging, it gives up only when no arm is left to hold the gun. With the player outside its cone
 * it keeps aiming ahead and holds fire (woundedPhaseAllowsFire); it never turns.
 */
function stepSeated(hs: TargetHealthState, input: WoundedSequenceInput): void {
  if (!isSeatedAnimated(hs)) return;
  if (phaseOf(hs) === 'DOWNED_AGONY' && canEngageFromFloor(input)) setPhase(hs, 'DOWNED_ENGAGE');
  else if (phaseOf(hs) === 'DOWNED_ENGAGE' && !input.freeArmWorks) setPhase(hs, 'DOWNED_AGONY');
}

function stepClutch(hs: TargetHealthState, input: WoundedSequenceInput): void {
  const grit = effectiveFortitude(hs);
  if ((hs.woundedPhaseTimerS ?? 0) < clutchSeconds(grit)) return;
  // No pistol, or no hand to hold one: it keeps clutching, harmless, until it bleeds down.
  if (!input.hasSidearm || !input.freeArmWorks) return;
  if (grit >= BLAZE_FORTITUDE) {
    setPhase(hs, 'BLAZE');
  } else if (grit >= KNEEL_FORTITUDE) {
    setPhase(hs, 'KNEEL_DOWN');
  } else {
    setPhase(hs, 'SIT_DOWN');
    hs.weaponDropped = true;
    transitionTargetLifecycle(hs, {
      kind: 'START_PAIN_REACTION',
      reactionType: 'DOWNED_COLLAPSE',
      durationS: WOUND_CLIP_SECONDS.DOWNED_COLLAPSE,
      intensity: 0.8,
      hitDirectionWorld: yawForward(hs),
      postureOverride: 'LEG_BUCKLED',
    });
  }
}

/**
 * A living ragdoll. Every ragdoll is downed for good, so it always holds a downed phase; one
 * knocked over without a fall clip lies in agony until it is known to face the player. FACE_DOWN
 * itself is committed by the lifecycle once a face-down landing has settled (stepFaceDownSettle).
 */
function stepDownedRagdoll(hs: TargetHealthState, input: WoundedSequenceInput): void {
  hs.woundedPhaseTimerS = (hs.woundedPhaseTimerS ?? 0) + input.dt;
  const phase = phaseOf(hs);
  if (phase === 'FACE_DOWN') return;
  const grounded = hs.posture === 'RAGDOLL_GROUNDED';
  // A crawler knocked into the ragdoll lies on its belly; it never fires, so it stays harmless.
  if (phase === 'DOWNED_CRAWL') {
    setPhase(hs, 'FACE_DOWN');
    return;
  }
  if (!DOWNED_PHASES.has(phase)) setPhase(hs, 'DOWNED_AGONY');
  if (grounded && hs.downedFacingWorld === undefined) hs.downedFacingWorld = resolveDownedFacing(hs);

  if (phaseOf(hs) === 'DOWNED_AGONY' && grounded && !isFaceDownPending(hs) && canEngageFromFloor(input)) {
    // It was just lying there, then the player stepped in front of it.
    setPhase(hs, 'DOWNED_ENGAGE');
  } else if (phaseOf(hs) === 'DOWNED_ENGAGE' && !input.freeArmWorks) {
    setPhase(hs, 'DOWNED_AGONY');
  }
}

/**
 * A downed engager acts only once it lies on the floor in the ragdoll and is not showing the
 * face-down shape: never while still tumbling, never while it may be settling onto its face.
 */
function downedBodyReady(hs: TargetHealthState): boolean {
  return hs.isRagdollActive && hs.posture === 'RAGDOLL_GROUNDED' && !isFaceDownPending(hs);
}

/** A seated engager has finished its draw clip and holds the pistol up. */
function seatedDrawDone(hs: TargetHealthState): boolean {
  return isSeatedAnimated(hs) && (hs.woundedPhaseTimerS ?? 0) >= SEATED_DRAW_S;
}

/** May the body reach for its sidearm now? Only in a shooting phase, never mid-clip. */
export function woundedPhaseAllowsDraw(hs: TargetHealthState): boolean {
  if (!hs.alive || committedReactionPlaying(hs)) return false;
  const phase = phaseOf(hs);
  // Seated and animated, it draws as soon as it is engaging; the draw clip takes SEATED_DRAW_S.
  if (phase === 'DOWNED_ENGAGE') return downedBodyReady(hs) || isSeatedAnimated(hs);
  return phase === 'BLAZE' || phase === 'KNEEL_FIRE';
}

/** May the body pull the trigger on the player now? */
export function woundedPhaseAllowsFire(
  hs: TargetHealthState,
  input: Pick<WoundedSequenceInput, 'playerBearingRad' | 'playerVisible'>
): boolean {
  if (!hs.alive || committedReactionPlaying(hs)) return false;
  switch (phaseOf(hs)) {
    case 'NONE':
    case 'BLAZE':
      return true;
    case 'KNEEL_FIRE':
      return withinCone(input.playerBearingRad, KNEEL_FIRE_CONE_RAD);
    case 'DOWNED_ENGAGE':
      return (
        (downedBodyReady(hs) || seatedDrawDone(hs)) &&
        input.playerVisible &&
        withinCone(input.playerBearingRad, DOWNED_FIRE_CONE_RAD)
      );
    default:
      return false;
  }
}

/**
 * True when the body must not walk or turn by itself. KNEEL_FIRE may still turn slowly and a
 * crawler drags itself along; the AI handles both.
 */
export function woundedPhaseKeepsBodyStill(hs: TargetHealthState): boolean {
  const phase = phaseOf(hs);
  return phase !== 'NONE' && phase !== 'BLAZE';
}
