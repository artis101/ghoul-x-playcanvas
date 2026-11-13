import type { CombatAudioDiagnostics } from '../../core/audio/types.ts';

export class AudioCounters {
  public weaponFireCount = 0;
  public casingBounceCount = 0;
  public materialImpactCount = 0;
  public goreImpactCount = 0;
  public vocalCueCount = 0;
  public explosionCount = 0;
  public tinnitusTriggerCount = 0;

  public buildDiagnostics(
    isAvailable: boolean,
    isUnlocked: boolean,
    pannerModel: PanningModelType,
    masterVolume: number,
    lastWeaponPitchJitter: number,
  ): CombatAudioDiagnostics {
    return {
      available: isAvailable,
      unlocked: isUnlocked,
      pannerModel,
      masterVolume,
      weaponFireCount: this.weaponFireCount,
      casingBounceCount: this.casingBounceCount,
      materialImpactCount: this.materialImpactCount,
      goreImpactCount: this.goreImpactCount,
      vocalCueCount: this.vocalCueCount,
      explosionCount: this.explosionCount,
      tinnitusTriggerCount: this.tinnitusTriggerCount,
      lastWeaponPitchJitter,
    };
  }
}
