import type { TargetHealthState } from '../../contracts/ballistics.ts';
import type { CombatantAnimationClipName, CombatantGlbInstance } from '../assets/glbLoader.ts';

export class CombatantAnimController {
  private activeGlbClipKey: string | null = null;

  public resolveDesiredClip(healthState: TargetHealthState): CombatantAnimationClipName {
    switch (healthState.posture) {
      case 'LEG_BUCKLED':
        return 'LegCollapseCrawl';
      case 'GUT_HURT':
      case 'THROAT_CLUTCH':
        return 'DiaphragmDropKneel';
      case 'STAGGERED':
      case 'DISARMED':
        return 'HitStaggerChest';
      default:
        return 'CombatReadyIdle';
    }
  }

  public syncAnimation(glb: CombatantGlbInstance, healthState: TargetHealthState): void {
    if (!glb.animComponent) return;

    if (!glb.animComponent.playing) {
      glb.animComponent.playing = true;
    }

    const isSouthpaw = healthState.isLeftHanded;
    const desiredClip = this.resolveDesiredClip(healthState);
    const clipKey = `${desiredClip}_${isSouthpaw ? 'L' : 'R'}`;

    if (clipKey !== this.activeGlbClipKey) {
      glb.playClip(desiredClip, 0.12, 1.0, isSouthpaw);
      this.activeGlbClipKey = clipKey;
    }
  }

  public freezeAnimation(glb: CombatantGlbInstance): void {
    if (glb.animComponent) {
      glb.animComponent.playing = false;
    }
    this.activeGlbClipKey = null;
  }

  public reset(): void {
    this.activeGlbClipKey = null;
  }
}
