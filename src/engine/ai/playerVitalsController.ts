import type {
  ArterialBleedState, HealthGateState, PlayerCombatVitals,
  PlayerNearMissGrazeKind, PlayerNearMissGrazePayload, PlayerSurvivalPhase,
} from '../../contracts/ai/aiContracts.ts';
import type { EnemyArchetypeId, Vec3Like } from '../../contracts/ballistics.ts';
import { copyVec3 } from '../../core/ballistics/vec3.ts';
import type { BrutalKillRewardKind, TacticalCombatAiOptions } from './tacticalAiTypes.ts';

export type { ArterialBleedState, HealthGateState, PlayerSurvivalPhase };

export interface IncomingPlayerShotContext {
  readonly rawChipDamage: number;
  readonly attackerId: string;
  readonly archetype: EnemyArchetypeId;
  readonly hitPointWorld: Vec3Like;
  readonly playerEyeWorldPos: Vec3Like;
}

export interface PlayerShotDamageResolution {
  readonly armorChipApplied: number;
  readonly healthDamageApplied: number;
  readonly grazeEvent: PlayerNearMissGrazePayload | null;
}

const REGEN_QUIET_DELAY_S = 3.5;

export function syncPlayerVitalsFsm(vitals: PlayerCombatVitals): void {
  if (vitals.health <= 0 || vitals.survivalPhase?.kind === 'DEAD') {
    vitals.health = 0;
    vitals.invulnerabilityRemainingS = 0;
    vitals.healthGateReady = false;
    vitals.urgentBleedHpPerSec = 0;
    vitals.urgentBleedRemainingS = 0;
    vitals.arterialBleed = { kind: 'NONE' };
    vitals.healthGate = { kind: 'RECHARGING', quietElapsedS: vitals.timeSinceLastHitS };
    vitals.survivalPhase = { kind: 'DEAD' };
    return;
  }

  const bleedRate = vitals.urgentBleedHpPerSec ?? 0;
  const bleedRem = vitals.urgentBleedRemainingS ?? 0;
  if (bleedRate > 0 && bleedRem > 0) {
    vitals.arterialBleed = { kind: 'BLEEDING', hpPerSec: bleedRate, remainingS: bleedRem };
  } else {
    vitals.urgentBleedHpPerSec = 0;
    vitals.urgentBleedRemainingS = 0;
    vitals.arterialBleed = { kind: 'NONE' };
  }

  const gateReady = vitals.healthGateReady ?? vitals.health >= 35;
  vitals.healthGateReady = gateReady;
  if (vitals.invulnerabilityRemainingS > 0) {
    vitals.healthGate = { kind: 'INVULNERABLE_WINDOW', remainingS: vitals.invulnerabilityRemainingS, gateReady };
  } else if (gateReady) {
    vitals.healthGate = { kind: 'READY' };
  } else {
    vitals.healthGate = { kind: 'RECHARGING', quietElapsedS: vitals.timeSinceLastHitS };
  }

  if (vitals.arterialBleed.kind === 'BLEEDING') {
    vitals.survivalPhase = {
      kind: 'BLEEDING_URGENT',
      hpPerSec: vitals.arterialBleed.hpPerSec,
      remainingS: vitals.arterialBleed.remainingS,
    };
  } else if (vitals.health >= vitals.maxHealth) {
    vitals.survivalPhase = { kind: 'FULL_HEALTH' };
  } else if (vitals.timeSinceLastHitS < REGEN_QUIET_DELAY_S) {
    vitals.survivalPhase = { kind: 'RECOVERING_DELAY', quietElapsedS: vitals.timeSinceLastHitS };
  } else {
    vitals.survivalPhase = { kind: 'REGENERATING' };
  }
}

export function createDefaultPlayerVitals(options: TacticalCombatAiOptions = {}): PlayerCombatVitals {
  const maxHealth = 100;
  const maxArmor = 100;
  const rawInitialHp = options.initialPlayerHealth ?? 100;
  const health = rawInitialHp <= 0 ? 0 : Math.max(1, Math.min(maxHealth, rawInitialHp));
  const vitals: PlayerCombatVitals = {
    health,
    maxHealth,
    armor: Math.max(0, Math.min(maxArmor, options.initialPlayerArmor ?? 50)),
    maxArmor,
    damageEnabled: options.playerDamageEnabled ?? true,
    timeSinceLastHitS: 10,
    invulnerabilityRemainingS: 0,
    healthGateReady: health >= 35,
    helmetIntact: true,
    urgentBleedHpPerSec: 0,
    urgentBleedRemainingS: 0,
  };
  syncPlayerVitalsFsm(vitals);
  return vitals;
}

export function stepPlayerVitalsRegen(vitals: PlayerCombatVitals, dt: number): void {
  if (vitals.health <= 0 || vitals.survivalPhase?.kind === 'DEAD') {
    syncPlayerVitalsFsm(vitals);
    return;
  }

  if (vitals.invulnerabilityRemainingS > 0) {
    vitals.invulnerabilityRemainingS = Math.max(0, vitals.invulnerabilityRemainingS - dt);
  }
  syncPlayerVitalsFsm(vitals);

  if (vitals.arterialBleed?.kind === 'BLEEDING') {
    const { hpPerSec, remainingS } = vitals.arterialBleed;
    const stepBleedS = Math.min(dt, remainingS);
    vitals.urgentBleedRemainingS = Math.max(0, remainingS - dt);
    if (vitals.health > 1) {
      vitals.health = Math.max(1, vitals.health - hpPerSec * stepBleedS);
    }
    if (vitals.urgentBleedRemainingS <= 0) {
      vitals.urgentBleedHpPerSec = 0;
    }
  }

  vitals.timeSinceLastHitS += dt;
  syncPlayerVitalsFsm(vitals);

  if (vitals.survivalPhase?.kind === 'REGENERATING') {
    vitals.health = Math.min(vitals.maxHealth, vitals.health + 8.5 * dt);
    if (vitals.health >= 35) vitals.healthGateReady = true;
    syncPlayerVitalsFsm(vitals);
  }
}

export interface BrutalKillVitalsDelta {
  readonly armorRestored: number;
  readonly healthRestored: number;
}

export function grantBrutalKillReward(
  vitals: PlayerCombatVitals,
  kind: BrutalKillRewardKind
): BrutalKillVitalsDelta {
  if (vitals.health <= 0 || vitals.survivalPhase?.kind === 'DEAD') {
    syncPlayerVitalsFsm(vitals);
    return { armorRestored: 0, healthRestored: 0 };
  }

  const prevArmor = vitals.armor;
  const prevHealth = vitals.health;

  if (kind === 'STANDARD_KILL') {
    vitals.armor = Math.min(vitals.maxArmor, vitals.armor + 4);
    vitals.health = Math.min(vitals.maxHealth, vitals.health + 2);
    if (vitals.health >= 35) vitals.healthGateReady = true;
    syncPlayerVitalsFsm(vitals);
    return {
      armorRestored: vitals.armor - prevArmor,
      healthRestored: vitals.health - prevHealth,
    };
  }

  const armorGain =
    kind === 'MULTI_KILL_BLAST'
      ? 22
      : kind === 'DECAPITATION'
        ? 18
        : kind === 'CRANIAL_POP'
          ? 16
          : kind === 'CLEAN_SEVER' || kind === 'EVISCERATED'
            ? 14
            : 12;
  const hpGain =
    kind === 'MULTI_KILL_BLAST'
      ? 18
      : kind === 'DECAPITATION'
        ? 14
        : kind === 'CRANIAL_POP'
          ? 12
          : kind === 'CLEAN_SEVER' || kind === 'EVISCERATED'
            ? 10
            : 9;

  vitals.armor = Math.min(vitals.maxArmor, vitals.armor + armorGain);
  vitals.health = Math.min(vitals.maxHealth, vitals.health + hpGain);
  vitals.urgentBleedHpPerSec = 0;
  vitals.urgentBleedRemainingS = 0;
  if (vitals.health >= 20) vitals.healthGateReady = true;
  syncPlayerVitalsFsm(vitals);
  return {
    armorRestored: vitals.armor - prevArmor,
    healthRestored: vitals.health - prevHealth,
  };
}

export function notifyWaveCleared(vitals: PlayerCombatVitals): void {
  vitals.health = vitals.maxHealth;
  vitals.armor = Math.min(vitals.maxArmor, vitals.armor + 35);
  vitals.invulnerabilityRemainingS = 0;
  vitals.healthGateReady = true;
  vitals.helmetIntact = true;
  vitals.urgentBleedHpPerSec = 0;
  vitals.urgentBleedRemainingS = 0;
  vitals.survivalPhase = { kind: 'FULL_HEALTH' };
  syncPlayerVitalsFsm(vitals);
}

export function resolveIncomingPlayerShotDamage(
  vitals: PlayerCombatVitals,
  ctx: IncomingPlayerShotContext
): PlayerShotDamageResolution {
  if (
    !vitals.damageEnabled ||
    vitals.invulnerabilityRemainingS > 0 ||
    vitals.health <= 0 ||
    vitals.survivalPhase?.kind === 'DEAD'
  ) {
    return { armorChipApplied: 0, healthDamageApplied: 0, grazeEvent: null };
  }

  if (vitals.healthGateReady === undefined && vitals.health >= 35) vitals.healthGateReady = true;
  if (vitals.helmetIntact === undefined) vitals.helmetIntact = true;
  syncPlayerVitalsFsm(vitals);

  let armorChipApplied = 0;
  let healthDamageApplied = 0;
  if (vitals.armor > 0) {
    armorChipApplied = Math.min(vitals.armor, ctx.rawChipDamage * 0.7);
    vitals.armor = Math.max(0, vitals.armor - armorChipApplied);
    healthDamageApplied = ctx.rawChipDamage * 0.35;
  } else {
    healthDamageApplied = ctx.rawChipDamage;
  }

  const isHeadLevelShot = ctx.hitPointWorld.y >= ctx.playerEyeWorldPos.y - 0.1;
  const isHeavyCaliber = ctx.archetype === 'SNIPER_OPERATIVE' || ctx.archetype === 'HEAVY_ENFORCER';
  const wouldBeLethal = vitals.health - healthDamageApplied <= 0;
  const gateArmed = vitals.healthGate?.kind === 'READY' || vitals.healthGateReady === true;

  if (
    (wouldBeLethal && gateArmed) ||
    (isHeadLevelShot && isHeavyCaliber && (vitals.helmetIntact || gateArmed))
  ) {
    const side: 'LEFT' | 'RIGHT' = ctx.hitPointWorld.x < ctx.playerEyeWorldPos.x ? 'LEFT' : 'RIGHT';
    let kind: PlayerNearMissGrazeKind;
    let helmetPopped = false;
    let bleedRate = 0;

    if (isHeadLevelShot && vitals.helmetIntact) {
      kind = 'HELMET_DEFLECT';
      vitals.helmetIntact = false;
      helmetPopped = true;
      healthDamageApplied = Math.min(healthDamageApplied * 0.45, Math.max(0, vitals.health - 2));
    } else if (isHeadLevelShot || wouldBeLethal) {
      kind = isHeadLevelShot ? 'NECK_ARTERIAL_GRAZE' : 'LAST_CHANCE_GATE';
      vitals.healthGateReady = false;
      bleedRate = 3.5;
      vitals.urgentBleedHpPerSec = bleedRate;
      vitals.urgentBleedRemainingS = 4.0;
      healthDamageApplied = Math.max(0, vitals.health - 2);
    } else {
      kind = 'LAST_CHANCE_GATE';
    }

    vitals.health = Math.max(2, vitals.health - healthDamageApplied);
    vitals.timeSinceLastHitS = 0;
    vitals.invulnerabilityRemainingS = helmetPopped ? 0.45 : 0.65;
    syncPlayerVitalsFsm(vitals);

    return {
      armorChipApplied,
      healthDamageApplied,
      grazeEvent: {
        kind,
        side,
        attackerId: ctx.attackerId,
        hitPointWorld: copyVec3(ctx.hitPointWorld),
        tinnitusIntensity: helmetPopped ? 0.82 : 0.68,
        tinnitusDurationS: helmetPopped ? 2.4 : 1.9,
        bleedRateHpPerSec: bleedRate,
        helmetPopped,
      },
    };
  }

  vitals.health = Math.max(0, vitals.health - healthDamageApplied);
  vitals.timeSinceLastHitS = 0;
  vitals.invulnerabilityRemainingS = vitals.health > 0 ? 0.22 : 0;
  syncPlayerVitalsFsm(vitals);
  return { armorChipApplied, healthDamageApplied, grazeEvent: null };
}

export class PlayerVitalsController {
  public readonly playerVitals: PlayerCombatVitals;

  public constructor(playerDamageEnabled = true, initialPlayerHealth = 100, initialPlayerArmor = 100) {
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
