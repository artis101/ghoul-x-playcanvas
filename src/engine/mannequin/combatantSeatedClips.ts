import type { TargetHealthState } from '../../contracts/ballistics.ts';
import {
  isSeatedAnimated, SEATED_DRAW_PISTOL_VISIBLE_AT, SEATED_DRAW_S,
} from '../../core/ballistics/triage/seatedLastStand.ts';
import { oppositeSide, triggerSide, type BodySide } from '../../core/ghoul/anatomy/handedness.ts';
import type { CombatantAnimationClipName } from '../assets/glbTypes.ts';
import { isArmChainIntactAndFunctional } from '../ai/combatantArmEvaluation.ts';

export { isSeatedAnimated, SEATED_DRAW_S };

/**
 * The animated seated last stand (docs/wound-movement.md, "Downed"). After a fall a body that
 * will fight from the floor or lie there in pain is no longer handed to the ragdoll: it stays on
 * its seat and plays authored clips, so it never ends up in a broken muscle-driven pose.
 *
 * - DOWNED_AGONY: `SeatedAgony` (loop), rocking with a hand on the thigh.
 * - DOWNED_ENGAGE: `SeatedPistolDraw` (one shot, `SEATED_DRAW_S` long) while the pistol comes
 *   out, then `SeatedPistolAim` (loop) for as long as it stays down.
 *
 * The right-handed takes lean back on the left hand and use the right; the `_Southpaw` twins are
 * the mirror. Until a clip is baked the body holds the last frame of the fall it landed with.
 */

/** Which seated clip a downed body plays. */
export type SeatedStage = 'AGONY' | 'DRAW' | 'AIM';

/** The pistol shows in the hand from this far through the draw; before that it is holstered. */
export const SEATED_PISTOL_VISIBLE_PROGRESS = SEATED_DRAW_PISTOL_VISIBLE_AT;

/** Blend into a seated clip: the same short blend as the other wounded phases. */
export const SEATED_BLEND_S = 0.2;

/** The seated clips, which own the whole body (no prop-up, no clutch IK, a quarter of the jolt). */
const SEATED_CLIPS: ReadonlySet<string> = new Set<CombatantAnimationClipName>([
  'SeatedPistolDraw', 'SeatedPistolAim', 'SeatedAgony',
]);

export function isSeatedClip(clip: string): boolean {
  return SEATED_CLIPS.has(clip);
}

/** The pistol is on its way out of the holster, or already out, by the armament's status tag. */
function sidearmStage(hs: TargetHealthState): 'HOLSTERED' | 'DRAWING' | 'DRAWN' {
  const tag = hs.combatantStatusTag;
  if (tag === 'SIDEARM_DRAWING') return 'DRAWING';
  if (tag === 'LAST_STAND' || tag === 'SIDEARM_DRAWN') return 'DRAWN';
  return 'HOLSTERED';
}

/** Which seated clip plays now. A downed engager that has not started its draw yet sits in agony. */
export function seatedStage(hs: TargetHealthState): SeatedStage {
  if (hs.woundedPhase !== 'DOWNED_ENGAGE') return 'AGONY';
  const stage = sidearmStage(hs);
  return stage === 'DRAWN' ? 'AIM' : stage === 'DRAWING' ? 'DRAW' : 'AGONY';
}

/**
 * The hand the seated clip works with. The pistol hand when one is out; otherwise the trigger
 * hand, or the other one when that arm is a stump or dead, so the free hand clutches the thigh
 * and the body leans on the stump side.
 */
export function seatedWorkingHand(hs: TargetHealthState, pistolHand?: BodySide): BodySide {
  if (pistolHand) return pistolHand;
  const gun = triggerSide(hs.isLeftHanded);
  return isArmChainIntactAndFunctional(hs, gun) ? gun : oppositeSide(gun);
}

export interface SeatedClipPlan {
  readonly stage: SeatedStage;
  readonly clip: CombatantAnimationClipName;
  /** Left hand works: play the `_Southpaw` mirror. */
  readonly southpaw: boolean;
  /** Loops (aim, agony) keep going; the draw plays once and is timed to the armament's draw. */
  readonly loop: boolean;
}

const STAGE_CLIP: Readonly<Record<SeatedStage, CombatantAnimationClipName>> = {
  AGONY: 'SeatedAgony',
  DRAW: 'SeatedPistolDraw',
  AIM: 'SeatedPistolAim',
};

/** The seated clip for this frame, or null when the body is not seated and animated. */
export function seatedClipPlan(hs: TargetHealthState, pistolHand?: BodySide): SeatedClipPlan | null {
  // The planned downed phase is set while the fall still plays; isSeatedAnimated waits for it to end.
  if (!isSeatedAnimated(hs)) return null;
  const stage = seatedStage(hs);
  const hand = seatedWorkingHand(hs, stage === 'AGONY' ? undefined : pistolHand);
  return { stage, clip: STAGE_CLIP[stage], southpaw: hand === 'LEFT', loop: stage !== 'DRAW' };
}

/**
 * Playback speed that makes a draw clip of `clipDurationS` last exactly `SEATED_DRAW_S`, so the
 * pistol appears in the hand on the frame the armament says it is out of the holster.
 */
export function seatedDrawPlaybackSpeed(clipDurationS: number | undefined): number {
  if (!(clipDurationS && clipDurationS > 0)) return 1;
  return Math.max(0.5, Math.min(2, clipDurationS / SEATED_DRAW_S));
}

/** True while a seated draw has not brought the pistol out of the holster yet. */
export function seatedPistolHolstered(drawing: boolean, drawProgress: number): boolean {
  return drawing && drawProgress < SEATED_PISTOL_VISIBLE_PROGRESS;
}
