import type { EnemyArchetypeId, GhoulZoneId } from '../../contracts/ballistics.ts';
import type { CombatantResolveProfile } from './tacticalAiTypes.ts';

export interface ArchetypeCombatTuning {
  readonly primaryWeaponId: string;
  readonly baseSpreadRad: number;
  /** Pause between trigger sequences. Shot spacing within one comes from the gun itself. */
  readonly burstCooldownS: number;
  readonly strafeSpeedMs: number;
  readonly tracerSpeedMs: number;
  readonly baseChipDamage: number;
}

export const ARCHETYPE_TUNING: Record<EnemyArchetypeId, ArchetypeCombatTuning> = {
  SKINHEAD_PUNK: {
    primaryWeaponId: 'silver_talon_50ae',
    baseSpreadRad: 0.052,
    burstCooldownS: 1.55,
    strafeSpeedMs: 2.15,
    tracerSpeedMs: 78,
    // .50 AE pistol round.
    baseChipDamage: 24.0,
  },
  MILITIA_GUNNER: {
    primaryWeaponId: 'm4a1_carbine',
    baseSpreadRad: 0.038,
    burstCooldownS: 1.75,
    strafeSpeedMs: 1.85,
    tracerSpeedMs: 92,
    // 5.56 rifle round.
    baseChipDamage: 18.0,
  },
  HEAVY_ENFORCER: {
    primaryWeaponId: 'm590_shotgun',
    baseSpreadRad: 0.062,
    burstCooldownS: 2.05,
    strafeSpeedMs: 1.35,
    tracerSpeedMs: 72,
    // A full 00 buckshot load landing.
    baseChipDamage: 34.0,
  },
  MASKED_BRUISER: {
    primaryWeaponId: 'm590_shotgun',
    baseSpreadRad: 0.058,
    burstCooldownS: 1.9,
    strafeSpeedMs: 1.55,
    tracerSpeedMs: 72,
    // A full 00 buckshot load landing.
    baseChipDamage: 34.0,
  },
  SNIPER_OPERATIVE: {
    primaryWeaponId: 'msg90_sniper',
    baseSpreadRad: 0.018,
    burstCooldownS: 2.65,
    strafeSpeedMs: 1.5,
    tracerSpeedMs: 125,
    // 7.62 rifle round.
    baseChipDamage: 60.0,
  },
};

/**
 * The backup handgun every combatant carries: a Silver Talon .50 AE, the punks' gun. Fired
 * one-handed from the fist, so it is a little looser and slower between pulls than in a punk's grip.
 */
export const BACKUP_SIDEARM_TUNING = {
  weaponId: 'silver_talon_50ae',
  baseSpreadRad: 0.052,
  burstCooldownS: 1.4,
  tracerSpeedMs: 78,
  // .50 AE pistol round.
  baseChipDamage: 24.0,
} as const;

export const TORSO_ZONES: ReadonlySet<GhoulZoneId> = new Set<GhoulZoneId>([
  'TORSO_UPPER_THORAX',
  'TORSO_LOWER_ABDOMEN',
  'PELVIS_GROIN',
]);

export const BACKUP_SIDEARM_WEAPON_ID = BACKUP_SIDEARM_TUNING.weaponId;
export const DOWNED_ONE_HANDED_SPREAD_MULTIPLIER = 4.5;
export const OFFHAND_SIDEARM_SPREAD_MULTIPLIER = 1.78;
export const SIDEARM_DRAW_DURATION_S = 0.6;
export const MIN_CONSCIOUSNESS_TO_FIGHT = 0.12;

export function hashCombatantTargetId(targetId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < targetId.length; i++) {
    h ^= targetId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Each combatant's temperament. Every one of them carries the backup handgun (a side piece), so
 * no fighter is ever left with empty hands while it still has an arm to shoot with.
 */
export function resolveDefaultCombatantProfile(
  targetId: string,
  archetype: EnemyArchetypeId
): { resolveProfile: CombatantResolveProfile; carriesBackupSidearm: boolean } {
  if (archetype === 'HEAVY_ENFORCER' || archetype === 'SNIPER_OPERATIVE') {
    return { resolveProfile: 'HARDENED_VETERAN', carriesBackupSidearm: true };
  }

  switch (targetId) {
    case 'target_0':
      return { resolveProfile: 'FANATIC_BERSERKER', carriesBackupSidearm: true };
    case 'target_1':
      return { resolveProfile: 'FANATIC_BERSERKER', carriesBackupSidearm: true };
    case 'target_2':
      return { resolveProfile: 'GRITTY_REGULAR', carriesBackupSidearm: true };
    case 'target_3':
      return { resolveProfile: 'GRITTY_REGULAR', carriesBackupSidearm: true };
    case 'target_4':
      return { resolveProfile: 'HARDENED_VETERAN', carriesBackupSidearm: true };
    case 'hostile_alpha':
      return { resolveProfile: 'GRITTY_REGULAR', carriesBackupSidearm: true };
    default:
      break;
  }

  const h = hashCombatantTargetId(targetId);
  if (archetype === 'SKINHEAD_PUNK') {
    return {
      resolveProfile: h % 2 === 0 ? 'FANATIC_BERSERKER' : 'GRITTY_REGULAR',
      carriesBackupSidearm: true,
    };
  }

  const bucket = h % 4;
  if (bucket === 1) {
    return { resolveProfile: 'HARDENED_VETERAN', carriesBackupSidearm: true };
  }
  if (bucket === 2) {
    return { resolveProfile: 'FANATIC_BERSERKER', carriesBackupSidearm: true };
  }
  if (bucket === 3) {
    return { resolveProfile: 'PANICKED_SCRAPPER', carriesBackupSidearm: true };
  }
  return { resolveProfile: 'GRITTY_REGULAR', carriesBackupSidearm: true };
}

