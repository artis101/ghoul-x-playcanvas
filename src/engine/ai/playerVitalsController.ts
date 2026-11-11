import type {
  PlayerCombatVitals,
  PlayerNearMissGrazeKind,
  PlayerNearMissGrazePayload,
} from '../../contracts/ai/aiContracts.ts';
import type { EnemyArchetypeId, Vec3Like } from '../../contracts/ballistics.ts';
import { copyVec3 } from '../../core/ballistics/vec3.ts';
import type { BrutalKillRewardKind, TacticalCombatAiOptions } from './tacticalAiTypes.ts';

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

export function createDefaultPlayerVitals(options: TacticalCombatAiOptions = {}): PlayerCombatVitals {
  const maxHealth = 100;
  const maxArmor = 100;
  const health = Math.max(1, Math.min(maxHealth, options.initialPlayerHealth ?? 100));
  return {
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
}

export function stepPlayerVitalsRegen(vitals: PlayerCombatVitals, dt: number): void {
  if (vitals.invulnerabilityRemainingS > 0) {
    vitals.invulnerabilityRemainingS = Math.max(
      0,
      vitals.invulnerabilityRemainingS - dt
    );
  }

  const bleedRemaining = vitals.urgentBleedRemainingS ?? 0;
  const bleedRate = vitals.urgentBleedHpPerSec ?? 0;
  if (bleedRemaining > 0 && bleedRate > 0) {
    const stepBleedS = Math.min(dt, bleedRemaining);
    vitals.urgentBleedRemainingS = Math.max(0, bleedRemaining - dt);
    if (vitals.health > 1) {
      vitals.health = Math.max(1, vitals.health - bleedRate * stepBleedS);
    }
    if (vitals.urgentBleedRemainingS <= 0) {
      vitals.urgentBleedHpPerSec = 0;
    }
  }

  vitals.timeSinceLastHitS += dt;

  if (
    vitals.timeSinceLastHitS >= 3.5 &&
    (vitals.urgentBleedRemainingS ?? 0) <= 0 &&
    vitals.health < vitals.maxHealth
  ) {
    vitals.health = Math.min(
      vitals.maxHealth,
      vitals.health + 8.5 * dt
    );
    if (vitals.health >= 35) {
      vitals.healthGateReady = true;
    }
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
  vitals.urgentBleedHpPerSec = 0;
  vitals.urgentBleedRemainingS = 0;
  if (vitals.health >= 20) {
    vitals.healthGateReady = true;
  }
}

export function notifyWaveCleared(vitals: PlayerCombatVitals): void {
  vitals.health = vitals.maxHealth;
  vitals.armor = Math.min(vitals.maxArmor, vitals.armor + 35);
  vitals.invulnerabilityRemainingS = 0;
  vitals.healthGateReady = true;
  vitals.helmetIntact = true;
  vitals.urgentBleedHpPerSec = 0;
  vitals.urgentBleedRemainingS = 0;
}

/**
 * Resolves incoming enemy shot damage with Last-Chance Lethality Gate
 * and Near-Miss Helmet Pop / Ear-Neck Arterial Graze deflection.
 */
export function resolveIncomingPlayerShotDamage(
  vitals: PlayerCombatVitals,
  ctx: IncomingPlayerShotContext
): PlayerShotDamageResolution {
  if (!vitals.damageEnabled || vitals.invulnerabilityRemainingS > 0) {
    return { armorChipApplied: 0, healthDamageApplied: 0, grazeEvent: null };
  }

  if (vitals.healthGateReady === undefined && vitals.health >= 35) {
    vitals.healthGateReady = true;
  }
  if (vitals.helmetIntact === undefined) {
    vitals.helmetIntact = true;
  }

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
  const isHeavyCaliber =
    ctx.archetype === 'SNIPER_OPERATIVE' || ctx.archetype === 'HEAVY_ENFORCER';
  const wouldBeLethal = vitals.health - healthDamageApplied <= 0;
  const gateArmed = vitals.healthGateReady === true;

  let grazeEvent: PlayerNearMissGrazePayload | null = null;

  if ((wouldBeLethal && gateArmed) || (isHeadLevelShot && isHeavyCaliber && (vitals.helmetIntact || gateArmed))) {
    const side: 'LEFT' | 'RIGHT' =
      ctx.hitPointWorld.x < ctx.playerEyeWorldPos.x ? 'LEFT' : 'RIGHT';
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

    grazeEvent = {
      kind,
      side,
      attackerId: ctx.attackerId,
      hitPointWorld: copyVec3(ctx.hitPointWorld),
      tinnitusIntensity: helmetPopped ? 0.82 : 0.68,
      tinnitusDurationS: helmetPopped ? 2.4 : 1.9,
      bleedRateHpPerSec: bleedRate,
      helmetPopped,
    };

    return { armorChipApplied, healthDamageApplied, grazeEvent };
  }

  vitals.health = Math.max(0, vitals.health - healthDamageApplied);
  vitals.timeSinceLastHitS = 0;
  vitals.invulnerabilityRemainingS = 0.22;
  return { armorChipApplied, healthDamageApplied, grazeEvent: null };
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
