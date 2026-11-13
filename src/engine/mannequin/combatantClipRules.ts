import type { PainReactionType, TargetHealthState } from '../../contracts/ballistics.ts';
import { isCommittedWoundReaction } from '../../core/ballistics/trauma/woundReactionTimings.ts';
import type { CombatantAnimationClipName } from '../assets/glbTypes.ts';
import { flinchPlaybackSpeed, isCommittedClip, isFlinchClip, pickAvailableClip, type WoundClipOwner } from './combatantWoundClips.ts';
import { KNEEL_AIM_CHAIN, type SidearmAimClip } from './combatantWoundedPhaseClips.ts';

/** Small rules the anim controller applies to the clip it picked: aim fallbacks, owner, speed. */

/** A flinch hands the body back once it is this far through; the last frames are the idle pose. */
export const FLINCH_END_PROGRESS = 0.98;

export interface CombatantAimPose {
  readonly clip: 'LongGunAim' | SidearmAimClip;
  readonly hand?: 'RIGHT' | 'LEFT';
}

type Has = (clip: CombatantAnimationClipName) => boolean;

/** The aim clip to play for `aim`, with stand-ins for takes this GLB does not hold. */
export function resolveAimClip(aim: CombatantAimPose, has: Has): CombatantAnimationClipName {
  if (aim.clip === 'KneelPistolAimOneHand') return pickAvailableClip(KNEEL_AIM_CHAIN, has) ?? 'PistolAim';
  // Until the one-handed pistol aim is baked the two-handed aim stands in for it.
  if (aim.clip === 'PistolAimOneHand' && !has('PistolAimOneHand')) return 'PistolAim';
  return aim.clip;
}

export function isPistolAimClip(clip: CombatantAnimationClipName): boolean {
  return clip === 'PistolAim' || clip === 'PistolAimOneHand' || clip === 'KneelPistolAimOneHand';
}

/** A clip that holds a pistol in the gun hand: an aim or the one-handed carry. Mirrored by that hand. */
export function isPistolHandClip(clip: CombatantAnimationClipName): boolean {
  return isPistolAimClip(clip) || clip === 'PistolOneHandHold';
}

/** Which kind of wound a clip started for a reaction stands for, if any. */
export function woundKindFor(clip: CombatantAnimationClipName, type: PainReactionType): 'FLINCH' | 'COMMITTED' | null {
  if (isCommittedClip(clip) || isCommittedWoundReaction(type)) return 'COMMITTED';
  return isFlinchClip(clip) ? 'FLINCH' : null;
}

/**
 * Playback speed for a clip the controller starts. Authored falls and losses last exactly as
 * long as their reaction, so they play at speed 1; flinches may be sped up for a short hit; the
 * crawl and the gaits follow the ground speed.
 */
export function clipPlaybackSpeed(
  woundKind: 'FLINCH' | 'COMMITTED' | null,
  hs: TargetHealthState,
  crawlRate: number | null,
  gaitSpeed: number | undefined,
): number {
  if (crawlRate !== null) return crawlRate;
  if (woundKind === 'COMMITTED') return 1;
  if (woundKind === 'FLINCH') return flinchPlaybackSpeed(hs.activeReaction);
  return gaitSpeed ?? 1;
}

/**
 * Who owns the body after this frame's clip choice. Authored falls own it until the ragdoll or
 * the next phase takes it; a flinch while its reaction lasts or until it has played out.
 */
export function resolveClipOwnership(
  state: { readonly kind: string; readonly clip?: CombatantAnimationClipName; readonly woundKind?: WoundClipOwner },
  reactionClip: boolean,
  type: PainReactionType,
  progress: number | undefined,
): WoundClipOwner {
  if (state.kind !== 'PLAYING' || !state.woundKind || !state.clip) return null;
  if (state.woundKind === 'COMMITTED') {
    return isCommittedClip(state.clip) || (reactionClip && isCommittedWoundReaction(type)) ? 'COMMITTED' : null;
  }
  return reactionClip || (progress ?? 1) < FLINCH_END_PROGRESS ? 'FLINCH' : null;
}
