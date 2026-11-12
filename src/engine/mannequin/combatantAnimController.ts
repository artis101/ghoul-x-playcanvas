import type { PainReactionType, TargetHealthState } from '../../contracts/ballistics.ts';
import type { CombatantAnimationClipName, CombatantGlbInstance } from '../assets/glbLoader.ts';
import type { CombatantMovementClip } from './combatantLocomotion.ts';

// The retargeted clip reaches hand contact near source frame 71 of the 12–113 range.
const LEG_COLLAPSE_TIME_S = 1.17;

export interface CombatantAimPose {
  readonly clip: 'LongGunAim' | 'PistolAim';
  readonly hand?: 'LEFT' | 'RIGHT';
}

export type AnimClipState =
  | { readonly kind: 'FROZEN' }
  | {
      readonly kind: 'PLAYING';
      readonly clip: CombatantAnimationClipName;
      readonly isSouthpaw: boolean;
      readonly clipKey: string;
      readonly reactionType: PainReactionType;
      readonly reactionEpoch: number;
      readonly reactionTimerS: number;
    };

export class CombatantAnimController {
  public clipState: AnimClipState = { kind: 'FROZEN' };

  public reset(): void {
    this.clipState = { kind: 'FROZEN' };
  }

  public resolveDesiredClip(
    healthState: TargetHealthState,
    guarding = false
  ): CombatantAnimationClipName {
    const { posture, activeReaction } = healthState;
    if (posture === 'LEG_BUCKLED' || activeReaction.type.startsWith('LEG_BUCKLE')) {
      return 'LegCollapseCrawl';
    }
    if (
      posture === 'GUT_HURT' ||
      posture === 'THROAT_CLUTCH' ||
      activeReaction.type === 'GUT_FOLD' ||
      activeReaction.type === 'THROAT_CLUTCH'
    ) {
      return 'DiaphragmDropKneel';
    }
    if (posture === 'STAGGERED' || activeReaction.type !== 'NONE') {
      return 'HitStaggerChest';
    }
    return guarding ? 'UnsuspectingIdle' : 'CombatReadyIdle';
  }

  public syncAnimation(
    glb: Pick<CombatantGlbInstance, 'animComponent' | 'playClip'>,
    healthState: TargetHealthState,
    guarding = false,
    movement?: CombatantMovementClip,
    aim?: CombatantAimPose
  ): void {
    if (!glb.animComponent) return;

    if (!glb.animComponent.playing) {
      glb.animComponent.playing = true;
    }

    const baseClip = this.resolveDesiredClip(healthState, guarding);
    const canAim = baseClip === 'CombatReadyIdle';
    const locomotion = canAim || baseClip === 'UnsuspectingIdle' ? movement : undefined;
    const desiredClip = locomotion?.clip ?? (canAim ? aim?.clip : undefined) ?? baseClip;
    const aimHand = desiredClip === 'PistolAim' ? aim?.hand : undefined;
    const isSouthpaw = aimHand ? aimHand === 'RIGHT' : healthState.isLeftHanded;
    const clipKey = `${desiredClip}_${isSouthpaw ? 'L' : 'R'}`;

    const reaction = healthState.activeReaction;
    const reactionEpoch = reaction.epoch ?? 0;
    const prev = this.clipState;

    const repeatStagger =
      desiredClip === 'HitStaggerChest' &&
      reaction.type !== 'NONE' &&
      (prev.kind !== 'PLAYING' ||
        reactionEpoch !== prev.reactionEpoch ||
        reaction.type !== prev.reactionType ||
        reaction.timerS < prev.reactionTimerS - 1e-4);

    const clipChanged = prev.kind !== 'PLAYING' || prev.clipKey !== clipKey;

    if (clipChanged || repeatStagger) {
      const collapse = desiredClip === 'LegCollapseCrawl';
      const speed =
        collapse && reaction.type.startsWith('LEG_BUCKLE') && reaction.durationS > 0
          ? Math.max(1, LEG_COLLAPSE_TIME_S / reaction.durationS)
          : locomotion?.playbackSpeed ?? 1;
      if (glb.playClip(desiredClip, 0.12, speed, isSouthpaw)) {
        this.clipState = {
          kind: 'PLAYING',
          clip: desiredClip,
          isSouthpaw,
          clipKey,
          reactionType: reaction.type,
          reactionEpoch,
          reactionTimerS: reaction.timerS,
        };
      }
    } else if (prev.kind === 'PLAYING') {
      if (locomotion) glb.animComponent.speed = locomotion.playbackSpeed;
      this.clipState = {
        ...prev,
        reactionType: reaction.type,
        reactionEpoch,
        reactionTimerS: reaction.timerS,
      };
    }
  }

  public freezeAnimation(glb: CombatantGlbInstance): void {
    if (glb.animComponent) {
      glb.animComponent.playing = false;
    }
    this.clipState = { kind: 'FROZEN' };
  }
}
