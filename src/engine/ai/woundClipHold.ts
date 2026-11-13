import type { TargetHealthState } from '../../contracts/ballistics.ts';
import { isCommittedWoundReaction } from '../../core/ballistics/trauma/woundReactionTimings.ts';
import { isSeatedAnimated } from '../../core/ballistics/triage/seatedLastStand.ts';

/**
 * True while a fall, loss or collapse clip is playing on a standing body. The clip owns the body
 * then: the AI must not walk, crawl, turn or shoot it, must not draw a sidearm, and must not
 * write a posture over the one the reaction chose (see docs/wound-movement.md).
 */
export function isWoundClipHoldingBody(hs: TargetHealthState): boolean {
  return hs.alive && !hs.isRagdollActive && isCommittedWoundReaction(hs.activeReaction.type);
}

/**
 * True when the body's posture belongs to its clip and the AI must not write over it: a fall,
 * loss or collapse playing, or a seated last stand (LEG_BUCKLED for as long as it sits there).
 */
export function isPostureHeldByClip(hs: TargetHealthState): boolean {
  return isWoundClipHoldingBody(hs) || isSeatedAnimated(hs);
}

/**
 * Bodies whose flinch clip is still playing out after its reaction ended. The mannequin writes
 * this each frame (the AI cannot see the animation), keyed by the health state so it goes away
 * with the combatant.
 */
const flinchClipHeld = new WeakSet<TargetHealthState>();

/** Called by the mannequin after its clip choice: whether a flinch clip still holds the body. */
export function markFlinchClipHeld(hs: TargetHealthState, held: boolean): void {
  if (held) flinchClipHeld.add(hs);
  else flinchClipHeld.delete(hs);
}

/**
 * True while a body is taking a hit: any reaction is running, or its flinch clip has not played
 * out yet. A body that is being shot stands and takes it; walking or strafing it meanwhile makes
 * it skate across the floor with its feet planted in the flinch. It moves again once the clip
 * has handed it back.
 */
export function isFlinchHoldingBody(hs: TargetHealthState): boolean {
  if (!hs.alive || hs.isRagdollActive) return false;
  return hs.activeReaction.type !== 'NONE' || flinchClipHeld.has(hs);
}
