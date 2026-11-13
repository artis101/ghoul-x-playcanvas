import type { ActivePainReaction, PainReactionType, TargetHealthState } from '../../contracts/ballistics.ts';
import type { WoundClipOwner } from '../../core/ghoul/anatomy/proceduralTraumaIk.ts';
import { LEG_LOSS_PHASE_SECONDS } from '../../core/ballistics/trauma/woundReactionTimings.ts';
import type { CombatantAnimationClipName } from '../assets/glbTypes.ts';
import { isArmChainIntactAndFunctional } from '../ai/combatantArmEvaluation.ts';

export type { WoundClipOwner };

/** Reactions this short are grazes: the spring jolt covers them and the body keeps its clip. */
export const GRAZE_REACTION_MAX_S = 0.25;
/** Below this, a flinch clip is sped up so the body is back on target about when the reaction ends. */
const SHORT_FLINCH_S = 0.5;
const MAX_FLINCH_SPEED = 1.5;

type ArmSide = 'RIGHT' | 'LEFT';

const FLINCH_CLIPS: ReadonlySet<CombatantAnimationClipName> = new Set<CombatantAnimationClipName>([
  'HitStaggerChest', 'HitFlinchHead', 'HitFlinchGut', 'HitFlinchThroat',
  'HitFlinchArmRight', 'HitFlinchArmLeft', 'HitFlinchLegRight', 'HitFlinchLegLeft',
]);

/** Authored clips that take the body down or off a limb; each one plays once, start to end. */
const COMMITTED_CLIPS: ReadonlySet<CombatantAnimationClipName> = new Set<CombatantAnimationClipName>([
  'LegShotFallRight', 'LegShotFallLeft', 'LegLossRight', 'LegLossLeft', 'OneLegHopRight', 'OneLegHopLeft',
  'LegLossFallRight', 'LegLossFallLeft', 'ArmLossRight', 'ArmLossLeft', 'DownedCollapse',
  // The wounded-sequence moves: kneeling down on a stump, and rolling from the seat onto the belly.
  'StumpKneelRight', 'StumpKneelLeft', 'SitToCrawl',
]);

/** Clips that end with the body on the floor, which the crawl or the ragdoll takes over from. */
const FALLING_CLIPS: ReadonlySet<CombatantAnimationClipName> = new Set<CombatantAnimationClipName>([
  'LegShotFallRight', 'LegShotFallLeft', 'LegLossFallRight', 'LegLossFallLeft', 'DownedCollapse',
]);

/**
 * The clip a reaction wants, then what to play when the GLB does not have it yet. Flinches fall
 * back to the chest stagger, falls and leg losses to the sit-down collapse (which also ends
 * seated), and an arm loss to the stagger.
 */
export function woundClipChain(type: PainReactionType): readonly CombatantAnimationClipName[] {
  switch (type) {
    case 'NONE': return [];
    case 'CHEST_STAGGER': return ['HitStaggerChest'];
    case 'HEAD_SNAP': return ['HitFlinchHead', 'HitStaggerChest'];
    case 'GUT_FOLD': return ['HitFlinchGut', 'HitStaggerChest'];
    case 'THROAT_CLUTCH': return ['HitFlinchThroat', 'HitStaggerChest'];
    case 'ARM_WRENCH_RIGHT': return ['HitFlinchArmRight', 'HitStaggerChest'];
    case 'ARM_WRENCH_LEFT': return ['HitFlinchArmLeft', 'HitStaggerChest'];
    case 'LEG_FLINCH_RIGHT': return ['HitFlinchLegRight', 'HitStaggerChest'];
    case 'LEG_FLINCH_LEFT': return ['HitFlinchLegLeft', 'HitStaggerChest'];
    case 'LEG_BUCKLE_RIGHT': return ['LegShotFallRight', 'DownedCollapse'];
    case 'LEG_BUCKLE_LEFT': return ['LegShotFallLeft', 'DownedCollapse'];
    case 'LEG_LOST_RIGHT': return ['LegLossRight', 'DownedCollapse'];
    case 'LEG_LOST_LEFT': return ['LegLossLeft', 'DownedCollapse'];
    case 'ARM_LOST_RIGHT': return ['ArmLossRight', 'HitStaggerChest'];
    case 'ARM_LOST_LEFT': return ['ArmLossLeft', 'HitStaggerChest'];
    case 'DOWNED_COLLAPSE': return ['DownedCollapse'];
    default: return ['HitStaggerChest'];
  }
}

/**
 * The clip chain for a reaction at its current time. A lost leg moves through three clips: the
 * lift into a one-leg stance, the hop loop, then the fall, each pinned to start where the last ends.
 */
export function woundClipChainAt(reaction: Pick<ActivePainReaction, 'type' | 'timerS'>): readonly CombatantAnimationClipName[] {
  if (reaction.type !== 'LEG_LOST_RIGHT' && reaction.type !== 'LEG_LOST_LEFT') return woundClipChain(reaction.type);
  const side = reaction.type === 'LEG_LOST_RIGHT' ? 'Right' : 'Left';
  const t = reaction.timerS;
  if (t < LEG_LOSS_PHASE_SECONDS.LIFT) return [`LegLoss${side}`, 'DownedCollapse'];
  if (t < LEG_LOSS_PHASE_SECONDS.LIFT + LEG_LOSS_PHASE_SECONDS.HOP) return [`OneLegHop${side}`, 'DownedCollapse'];
  return [`LegLossFall${side}`, 'DownedCollapse'];
}

/** First clip of the chain the GLB can play. With no clip list known, the preferred clip is used. */
export function pickAvailableClip(
  chain: readonly CombatantAnimationClipName[],
  isAvailable: (clip: CombatantAnimationClipName) => boolean,
): CombatantAnimationClipName | null {
  for (const clip of chain) if (isAvailable(clip)) return clip;
  return chain.length > 0 ? chain[chain.length - 1] : null;
}

/**
 * A graze plays no clip. A zero duration means the length is not known (set by hand in tests or
 * tools), so it is treated as a full reaction rather than a graze.
 */
export function isGrazeReaction(reaction: ActivePainReaction): boolean {
  return reaction.durationS > 0 && reaction.durationS <= GRAZE_REACTION_MAX_S;
}

/** True when the reaction should drive a body clip this frame. */
export function reactionWantsClip(reaction: ActivePainReaction): boolean {
  return reaction.type !== 'NONE' && !isGrazeReaction(reaction);
}

export function isFlinchClip(clip: string): boolean {
  return FLINCH_CLIPS.has(clip as CombatantAnimationClipName);
}

export function isCommittedClip(clip: string): boolean {
  return COMMITTED_CLIPS.has(clip as CombatantAnimationClipName);
}

/** A flinch, fall or loss clip: one that poses the arms itself rather than holding the gun. */
export function isWoundClip(clip: string): boolean {
  return isFlinchClip(clip) || isCommittedClip(clip);
}

export function isFallingClip(clip: string): boolean {
  return FALLING_CLIPS.has(clip as CombatantAnimationClipName);
}

export function isStumpClutchClip(clip: string): boolean {
  return clip === 'StumpClutchRight' || clip === 'StumpClutchLeft';
}

/**
 * Flinches play at normal speed. A short reaction speeds its clip up a little, never past 1.5x,
 * so a quick hit still reads as quick without the motion turning into a twitch.
 */
export function flinchPlaybackSpeed(reaction: ActivePainReaction): number {
  const d = reaction.durationS;
  if (!(d > 0) || d >= SHORT_FLINCH_S) return 1;
  return Math.min(MAX_FLINCH_SPEED, SHORT_FLINCH_S / d);
}

/**
 * The side whose arm has been cut short (hand, forearm, upper arm or shoulder gone), or null.
 * The gun arm counts first, since that is the loss the body reacts to most.
 */
export function lostArmSide(state: Pick<TargetHealthState, 'severedZones' | 'isLeftHanded'>): ArmSide | null {
  const lost = (side: ArmSide): boolean =>
    state.severedZones.has(`HAND_${side}`) ||
    state.severedZones.has(`FOREARM_${side}`) ||
    state.severedZones.has(`UPPER_ARM_${side}`) ||
    state.severedZones.has(`SHOULDER_${side}`);
  const gunSide: ArmSide = state.isLeftHanded ? 'LEFT' : 'RIGHT';
  const otherSide: ArmSide = gunSide === 'RIGHT' ? 'LEFT' : 'RIGHT';
  if (lost(gunSide)) return gunSide;
  return lost(otherSide) ? otherSide : null;
}

export function stumpClutchClip(side: ArmSide): CombatantAnimationClipName {
  return side === 'RIGHT' ? 'StumpClutchRight' : 'StumpClutchLeft';
}

/**
 * The pistol aim for a gun held in `hand`. With the other arm cut short or dead there is no
 * support hand, so the one-handed aim is used, the stump tucked to the chest.
 */
export function pistolAimClip(
  state: TargetHealthState,
  hand: ArmSide
): 'PistolAim' | 'PistolAimOneHand' {
  const support: ArmSide = hand === 'RIGHT' ? 'LEFT' : 'RIGHT';
  return isArmChainIntactAndFunctional(state, support) ? 'PistolAim' : 'PistolAimOneHand';
}
