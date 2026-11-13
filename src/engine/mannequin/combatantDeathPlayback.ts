import type { TargetHealthState } from '../../contracts/ballistics.ts';
import { DEATH_CLIP_SECONDS, deathClipFor } from '../../core/ballistics/lifecycle/deathAnimation.ts';
import type { CombatantAnimationClipName, CombatantDeathClipName } from '../assets/glbTypes.ts';
import type { AnimClipState, ClipGlb } from './combatantAnimController.ts';

/**
 * A body killed on its feet plays its death clip (DeathFallBack, DeathFallForward, DeathCrumple,
 * DeathSpin or DeathBleedOut; the core picks it, deathAnimation.ts) before the corpse ragdoll
 * takes over. The clip is started once, never restarted by a later hit (the jolt shows those),
 * plays as long as the core's dying timer says, and holds its last frame, lying still, until the
 * ragdoll takes the body from that pose.
 */

/** Blend from whatever the body was doing (aim, walk, flinch) into the fall. */
export const DEATH_BLEND_S = 0.15;

export interface DeathPlayback {
  readonly state: AnimClipState;
  /** A clip playClip refused on a GLB that does not list its clips, so it is not asked for again. */
  readonly missing: CombatantAnimationClipName | null;
}

/** Playback speed that makes a clip baked `bakedS` long last `wantedS`. */
export function deathPlaybackSpeed(bakedS: number | undefined, wantedS: number | undefined): number {
  if (!bakedS || !wantedS || !(bakedS > 0) || !(wantedS > 0)) return 1;
  return Math.max(0.25, Math.min(4, bakedS / wantedS));
}

/** How long the dying body's clip should last: the core's duration, or the baked length. */
function wantedSeconds(hs: TargetHealthState, clip: CombatantDeathClipName): number {
  return hs.dying?.durationS ?? DEATH_CLIP_SECONDS[clip];
}

/**
 * Plays the death clip for this frame. With no death clip in the GLB the body keeps whatever it
 * was playing, frozen where it stands, until the ragdoll takes over.
 */
export function playDeathClip(
  glb: ClipGlb,
  hs: TargetHealthState,
  has: (clip: CombatantAnimationClipName) => boolean,
  prev: AnimClipState,
): DeathPlayback {
  const clip = deathClipFor(hs) as CombatantDeathClipName | null;
  const reaction = hs.activeReaction;
  if (!clip || !has(clip)) return { state: prev, missing: null };
  const clipKey = `${clip}_R`;
  let state: AnimClipState;
  if (prev.kind === 'PLAYING' && prev.clipKey === clipKey) {
    state = { ...prev, reactionType: reaction.type, reactionTimerS: reaction.timerS };
  } else if (glb.playClip(clip, DEATH_BLEND_S, 1, false)) {
    state = {
      kind: 'PLAYING', clip, isSouthpaw: false, clipKey, reactionType: reaction.type,
      reactionEpoch: reaction.epoch ?? 0, reactionTimerS: reaction.timerS, woundKind: 'COMMITTED',
    };
  } else {
    return { state: prev, missing: glb.availableClips ? null : clip };
  }
  // Every frame, since the layer reports the new clip's length only once the transition starts.
  const anim = glb.animComponent;
  if (anim) anim.speed = deathPlaybackSpeed(anim.baseLayer?.activeStateDuration, wantedSeconds(hs, clip));
  return { state, missing: null };
}
