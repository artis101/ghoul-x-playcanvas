import type { BrutalKillRewardKind, PlayerCombatVitals, TacticalCombatAiOptions } from './tacticalAiTypes.ts';

export function createDefaultPlayerVitals(options: TacticalCombatAiOptions = {}): PlayerCombatVitals {
  const maxHealth = 100;
  const maxArmor = 100;
  return {
    health: Math.max(1, Math.min(maxHealth, options.initialPlayerHealth ?? 100)),
    maxHealth,
    armor: Math.max(0, Math.min(maxArmor, options.initialPlayerArmor ?? 50)),
    maxArmor,
    damageEnabled: options.playerDamageEnabled ?? true,
    timeSinceLastHitS: 10,
    invulnerabilityRemainingS: 0,
  };
}

export function stepPlayerVitalsRegen(vitals: PlayerCombatVitals, dt: number): void {
  if (vitals.invulnerabilityRemainingS > 0) {
    vitals.invulnerabilityRemainingS = Math.max(
      0,
      vitals.invulnerabilityRemainingS - dt
    );
  }
  vitals.timeSinceLastHitS += dt;

  if (vitals.timeSinceLastHitS >= 3.5 && vitals.health < vitals.maxHealth) {
    vitals.health = Math.min(
      vitals.maxHealth,
      vitals.health + 8.5 * dt
    );
  }
}

export function grantBrutalKillReward(vitals: PlayerCombatVitals, kind: BrutalKillRewardKind): void {
  const armorGain =
    kind === 'MULTI_KILL_BLAST'
      ? 22
      : kind === 'CRANIAL_POP'
        ? 16
        : kind === 'CLEAN_SEVER' || kind === 'EVISCERATED'
          ? 14
          : 6;
  const hpGain =
    kind === 'MULTI_KILL_BLAST'
      ? 18
      : kind === 'CRANIAL_POP'
        ? 12
        : kind === 'CLEAN_SEVER' || kind === 'EVISCERATED'
          ? 10
          : 4;

  vitals.armor = Math.min(vitals.maxArmor, vitals.armor + armorGain);
  vitals.health = Math.min(vitals.maxHealth, vitals.health + hpGain);
}

export function notifyWaveCleared(vitals: PlayerCombatVitals): void {
  vitals.health = vitals.maxHealth;
  vitals.armor = Math.min(vitals.maxArmor, vitals.armor + 35);
  vitals.invulnerabilityRemainingS = 0;
}

export class PlayerVitalsController {
  public readonly playerVitals: PlayerCombatVitals;

  public constructor(
    playerDamageEnabled = true,
    initialPlayerHealth = 100,
    initialPlayerArmor = 100
  ) {
    this.playerVitals = createDefaultPlayerVitals({
      playerDamageEnabled,
      initialPlayerHealth,
      initialPlayerArmor,
    });
  }

  public stepRegen(dt: number): void {
    stepPlayerVitalsRegen(this.playerVitals, dt);
  }

  public grantBrutalKillReward(kind: BrutalKillRewardKind): void {
    grantBrutalKillReward(this.playerVitals, kind);
  }

  public notifyWaveCleared(): void {
    notifyWaveCleared(this.playerVitals);
  }
}
