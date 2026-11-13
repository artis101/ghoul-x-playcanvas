import type { TargetHealthState } from '../../contracts/ballistics.ts';
import type { CombatantAnimationClipName } from '../assets/glbTypes.ts';
import type { AnimClipState, ClipGlb } from './combatantAnimController.ts';
import { isSeatedClip, SEATED_BLEND_S, seatedDrawPlaybackSpeed, type SeatedClipPlan } from './combatantSeatedClips.ts';
import { isFallingClip } from './combatantWoundClips.ts';

export interface SeatedPlayback {
  readonly state: AnimClipState;
  /** A clip playClip refused on a GLB that does not list its clips, so it is not asked for again. */
  readonly missing: CombatantAnimationClipName | null;
}

/**
 * Plays the seated last-stand clip for this frame. A clip is started once and never restarted
 * while it lasts. One that is not baked yet leaves the body holding the last frame of the fall it
 * landed with (or of the seated clip before it), so it never pops back up to an idle; only with
 * no fall to hold does it fall back to the collapse take. The draw is sped up or slowed down so
 * it lasts `SEATED_DRAW_S`, whatever length it was baked at.
 */
export function playSeatedClip(
  glb: ClipGlb,
  hs: TargetHealthState,
  plan: SeatedClipPlan,
  has: (clip: CombatantAnimationClipName) => boolean,
  prev: AnimClipState,
): SeatedPlayback {
  const reaction = hs.activeReaction;
  const kept = (): AnimClipState => prev.kind === 'PLAYING'
    ? { ...prev, reactionType: reaction.type, reactionTimerS: reaction.timerS, woundKind: 'COMMITTED' }
    : prev;
  if (!has(plan.clip) && prev.kind === 'PLAYING' && (isFallingClip(prev.clip) || isSeatedClip(prev.clip))) {
    return { state: kept(), missing: null };
  }
  const clip = has(plan.clip) ? plan.clip : 'DownedCollapse';
  const clipKey = `${clip}_${plan.southpaw ? 'L' : 'R'}`;
  let state = kept();
  let missing: CombatantAnimationClipName | null = null;
  if (prev.kind !== 'PLAYING' || prev.clipKey !== clipKey) {
    if (glb.playClip(clip, SEATED_BLEND_S, 1, plan.southpaw)) {
      state = {
        kind: 'PLAYING', clip, isSouthpaw: plan.southpaw, clipKey, reactionType: reaction.type,
        reactionEpoch: reaction.epoch ?? 0, reactionTimerS: reaction.timerS, woundKind: 'COMMITTED',
      };
    } else if (!glb.availableClips) {
      missing = clip;
    }
  }
  if (state.kind === 'PLAYING' && state.clip === 'SeatedPistolDraw' && glb.animComponent) {
    glb.animComponent.speed = seatedDrawPlaybackSpeed(glb.animComponent.baseLayer?.activeStateDuration);
  }
  return { state, missing };
}
