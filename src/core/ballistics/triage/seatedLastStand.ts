import type { TargetHealthState, WoundedPhase } from '../../../contracts/ballistics/targetHealthContracts.ts';
import { SEATED_DRAW_S, isFallingReaction } from '../trauma/woundReactionTimings.ts';

/**
 * The seated last stand (docs/wound-movement.md). A body that fell (leg shot, leg loss, sit-down
 * collapse) and plans to shoot from the floor or lie there in pain is not handed to the ragdoll any
 * more: it stays animated, sitting on its butt where the fall clip left it. The clips then own it:
 * `SeatedAgony` while it lies there, `SeatedPistolDraw` and `SeatedPistolAim` while it engages. The
 * mannequin reads the animated pose back into `ragdollBones`, so hitboxes follow the clip and a
 * death drops a corpse ragdoll straight from the seat.
 */

/** Seconds the seated draw clip takes: lean back on the off hand, reach the hip, draw, raise. */
export { SEATED_DRAW_S };

/** Fraction of the seated draw at which the pistol leaves the holster and shows in the hand. */
export const SEATED_DRAW_PISTOL_VISIBLE_AT = 0.45;

/** Floor phases a body plays out seated and animated rather than in the ragdoll. */
export function isSeatedPhase(phase: WoundedPhase | undefined): boolean {
  return phase === 'DOWNED_ENGAGE' || phase === 'DOWNED_AGONY';
}

/**
 * True while a living body sits animated on the floor in its last stand: in a seated phase, not in
 * the ragdoll, and no longer playing the fall that put it there.
 */
export function isSeatedAnimated(hs: TargetHealthState): boolean {
  if (!hs.alive || hs.isRagdollActive || !isSeatedPhase(hs.woundedPhase)) return false;
  const reaction = hs.activeReaction.type;
  return reaction === 'NONE' || !isFallingReaction(reaction);
}

/**
 * How far through its seated draw an engaging body is, 0..1 (1 once the pistol is up and it may
 * fire). 0 for any body that is not a seated engager. The pistol shows in the hand from
 * SEATED_DRAW_PISTOL_VISIBLE_AT on; before that it is still holstered.
 */
export function seatedDrawProgress(hs: TargetHealthState): number {
  if (hs.woundedPhase !== 'DOWNED_ENGAGE' || !isSeatedAnimated(hs)) return 0;
  return Math.min(1, Math.max(0, (hs.woundedPhaseTimerS ?? 0) / SEATED_DRAW_S));
}
