import type { TargetHealthState } from '../../contracts/ballistics.ts';
import { isCommittedWoundReaction } from '../../core/ballistics/trauma/woundReactionTimings.ts';

/**
 * True while a fall, loss or collapse clip is playing on a standing body. The clip owns the body
 * then: the AI must not walk, crawl, turn or shoot it, must not draw a sidearm, and must not
 * write a posture over the one the reaction chose (see docs/wound-movement.md).
 */
export function isWoundClipHoldingBody(hs: TargetHealthState): boolean {
  return hs.alive && !hs.isRagdollActive && isCommittedWoundReaction(hs.activeReaction.type);
}
