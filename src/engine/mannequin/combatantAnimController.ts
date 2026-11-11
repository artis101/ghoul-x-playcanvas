import type { TargetHealthState } from '../../contracts/ballistics.ts';
import type { CombatantAnimationClipName, CombatantGlbInstance } from '../assets/glbLoader.ts';

// The crawl clip reaches its grounded pose at frame 28 of a 24 fps export.
const LEG_COLLAPSE_TIME_S = 27 / 24;

export class CombatantAnimController {
  private activeGlbClipKey: string | null = null;
  private lastReaction: TargetHealthState['activeReaction'] | null = null;

  public resolveDesiredClip(healthState: TargetHealthState, guarding = false): CombatantAnimationClipName {
    const { posture, activeReaction } = healthState;
    if (posture === 'LEG_BUCKLED' || activeReaction.type.startsWith('LEG_BUCKLE')) {
      return 'LegCollapseCrawl';
    }
    if (
      posture === 'GUT_HURT' || posture === 'THROAT_CLUTCH' ||
      activeReaction.type === 'GUT_FOLD' || activeReaction.type === 'THROAT_CLUTCH'
    ) return 'DiaphragmDropKneel';
    if (posture === 'STAGGERED' || activeReaction.type !== 'NONE') return 'HitStaggerChest';
    return guarding || healthState.weaponDropped ? 'UnsuspectingIdle' : 'CombatReadyIdle';
  }

  public syncAnimation(glb: CombatantGlbInstance, healthState: TargetHealthState, guarding = false): void {
    if (!glb.animComponent) return;

    if (!glb.animComponent.playing) {
      glb.animComponent.playing = true;
    }

    const isSouthpaw = healthState.isLeftHanded;
    const desiredClip = this.resolveDesiredClip(healthState, guarding);
    const clipKey = `${desiredClip}_${isSouthpaw ? 'L' : 'R'}`;

    const reaction = healthState.activeReaction;
    const repeatStagger =
      desiredClip === 'HitStaggerChest' && reaction.type !== 'NONE' && reaction !== this.lastReaction;
    this.lastReaction = reaction;
    if (clipKey !== this.activeGlbClipKey || repeatStagger) {
      const collapse = desiredClip === 'LegCollapseCrawl';
      const speed = collapse && reaction.type.startsWith('LEG_BUCKLE') && reaction.durationS > 0
        ? Math.max(1, LEG_COLLAPSE_TIME_S / reaction.durationS)
        : 1;
      if (glb.playClip(desiredClip, 0.12, speed, isSouthpaw)) this.activeGlbClipKey = clipKey;
    }
  }

  public freezeAnimation(glb: CombatantGlbInstance): void {
    if (glb.animComponent) {
      glb.animComponent.playing = false;
    }
    this.activeGlbClipKey = null;
    this.lastReaction = null;
  }
}
