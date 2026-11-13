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

export const SIDEARM_M9_TUNING = {
  weaponId: 'weapon_beretta_m9',
  baseSpreadRad: 0.042,
  burstCooldownS: 1.25,
  tracerSpeedMs: 88,
  // 9 mm pistol round.
  baseChipDamage: 14.0,
} as const;

export const TORSO_ZONES: ReadonlySet<GhoulZoneId> = new Set<GhoulZoneId>([
  'TORSO_UPPER_THORAX',
  'TORSO_LOWER_ABDOMEN',
  'PELVIS_GROIN',
]);

export const BACKUP_SIDEARM_WEAPON_ID = SIDEARM_M9_TUNING.weaponId;
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

export function resolveDefaultCombatantProfile(
  targetId: string,
  archetype: EnemyArchetypeId
): { resolveProfile: CombatantResolveProfile; carriesBackupSidearm: boolean } {
  if (archetype === 'HEAVY_ENFORCER' || archetype === 'SNIPER_OPERATIVE') {
    return { resolveProfile: 'HARDENED_VETERAN', carriesBackupSidearm: true };
  }

  switch (targetId) {
    case 'target_0':
      return { resolveProfile: 'FANATIC_BERSERKER', carriesBackupSidearm: false };
    case 'target_1':
      return { resolveProfile: 'FANATIC_BERSERKER', carriesBackupSidearm: true };
    case 'target_2':
      return { resolveProfile: 'GRITTY_REGULAR', carriesBackupSidearm: false };
    case 'target_3':
      return { resolveProfile: 'GRITTY_REGULAR', carriesBackupSidearm: false };
    case 'target_4':
      return { resolveProfile: 'HARDENED_VETERAN', carriesBackupSidearm: true };
    case 'hostile_alpha':
      return { resolveProfile: 'GRITTY_REGULAR', carriesBackupSidearm: false };
    default:
      break;
  }

  const h = hashCombatantTargetId(targetId);
  if (archetype === 'SKINHEAD_PUNK') {
    return {
      resolveProfile: h % 2 === 0 ? 'FANATIC_BERSERKER' : 'GRITTY_REGULAR',
      carriesBackupSidearm: false,
    };
  }

  const bucket = h % 4;
  if (bucket === 1) {
    return { resolveProfile: 'HARDENED_VETERAN', carriesBackupSidearm: true };
  }
  if (bucket === 2) {
    return { resolveProfile: 'FANATIC_BERSERKER', carriesBackupSidearm: false };
  }
  if (bucket === 3) {
    return { resolveProfile: 'PANICKED_SCRAPPER', carriesBackupSidearm: false };
  }
  return { resolveProfile: 'GRITTY_REGULAR', carriesBackupSidearm: false };
}

