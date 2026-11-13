import type { PainReactionType } from '../../../contracts/ballistics.ts';

/**
 * How long the authored wound clips run at normal speed, in seconds. A fall, loss or collapse
 * reaction lasts exactly this long, so the downed gate hands the body to the ragdoll on the frame
 * its clip has put it on the floor. Keep in step with `TAKES` in
 * `scripts/blender/bake_kimodo_combatant.py`.
 */
/**
 * A lost leg plays in three clips: the stump jerks up into a one-leg stance, the body hops in
 * place on the good leg (a loop, played for `LEG_LOSS_HOP`), then it topples into a seat.
 */
export const LEG_LOSS_PHASE_SECONDS = {
  LIFT: 0.87,
  HOP: 2.1,
  FALL: 1.77,
} as const;

export const WOUND_CLIP_SECONDS = {
  LEG_SHOT_FALL: 2.37,
  LEG_LOSS: LEG_LOSS_PHASE_SECONDS.LIFT + LEG_LOSS_PHASE_SECONDS.HOP + LEG_LOSS_PHASE_SECONDS.FALL,
  ARM_LOSS: 2.37,
  DOWNED_COLLAPSE: 2.37,
} as const;

/**
 * Lengths of the wounded-sequence clips that are phases rather than pain reactions: dropping onto
 * the knees from the stump clutch (`StumpKneel*`), and rolling from the seat onto the belly to
 * crawl (`SitToCrawl`). Keep in step with `TAKES` in `scripts/blender/bake_kimodo_combatant.py`.
 */
export const STUMP_KNEEL_S = 1.57;
export const SIT_TO_CRAWL_S = 1.97;

/**
 * A seated last-stander's draw (`SeatedPistolDraw`): it leans back on its off hand, reaches the hip,
 * draws and raises the pistol. Slower than the 0.6 s standing draw because the whole body has to
 * shift its weight first. Keep in step with the take's length once it is baked.
 */
export const SEATED_DRAW_S = 2.0;

/** Clutching the stump lasts this long with no fortitude at all... */
export const CLUTCH_MAX_S = 2.5;
/** ...and this long at full fortitude: the gritty let go of the wound sooner. */
export const CLUTCH_MIN_S = 0.8;

/** How long a body clutches its stump before it decides what to do, by effective fortitude 0..1. */
export function clutchSeconds(effectiveFortitude: number): number {
  const f = Math.max(0, Math.min(1, effectiveFortitude));
  return CLUTCH_MAX_S + (CLUTCH_MIN_S - CLUTCH_MAX_S) * f;
}

/** Reactions whose clip takes the body down to the floor; the living ragdoll follows them. */
export function isFallingReaction(type: PainReactionType): boolean {
  return (
    type === 'LEG_BUCKLE_RIGHT' ||
    type === 'LEG_BUCKLE_LEFT' ||
    type === 'LEG_LOST_RIGHT' ||
    type === 'LEG_LOST_LEFT' ||
    type === 'DOWNED_COLLAPSE'
  );
}

/**
 * Reactions that play one long authored clip which a new, lesser hit must not restart: falls,
 * losses and the collapse. A hit during one of them only jolts the body.
 */
export function isCommittedWoundReaction(type: PainReactionType): boolean {
  return isFallingReaction(type) || type === 'ARM_LOST_RIGHT' || type === 'ARM_LOST_LEFT';
}

/** Seconds a committed wound reaction lasts, which is its clip's length. */
export function committedReactionSeconds(type: PainReactionType): number {
  switch (type) {
    case 'LEG_BUCKLE_RIGHT':
    case 'LEG_BUCKLE_LEFT':
      return WOUND_CLIP_SECONDS.LEG_SHOT_FALL;
    case 'LEG_LOST_RIGHT':
    case 'LEG_LOST_LEFT':
      return WOUND_CLIP_SECONDS.LEG_LOSS;
    case 'ARM_LOST_RIGHT':
    case 'ARM_LOST_LEFT':
      return WOUND_CLIP_SECONDS.ARM_LOSS;
    case 'DOWNED_COLLAPSE':
      return WOUND_CLIP_SECONDS.DOWNED_COLLAPSE;
    default:
      return 0;
  }
}
