import type { EnemyArchetypeId } from '../../../contracts/ballistics/ghoulZoneContracts';

/**
 * What an archetype wears that actually stops bullets. Damage itself always comes from the
 * anatomy the round passes through; clothing does not soak it, only plates and helmets do.
 */
export interface ArchetypeLoadout {
  readonly baseHp: number;
  readonly hasChestArmor: boolean;
  readonly hasHelmetArmor: boolean;
  /** Plate integrity lost per round it stops (integrity starts at 100). */
  readonly plateWearPerStop: number;
  /** Helmet integrity lost per round it deflects. */
  readonly helmetWearPerStop: number;
}

export const ARCHETYPE_LOADOUTS: Readonly<Record<EnemyArchetypeId, ArchetypeLoadout>> = {
  // Vest and jeans, nothing over the skin.
  SKINHEAD_PUNK: {
    baseHp: 120, hasChestArmor: false, hasHelmetArmor: false,
    plateWearPerStop: 0, helmetWearPerStop: 0,
  },
  // Field jacket and boonie hat: no ballistic protection.
  SNIPER_OPERATIVE: {
    baseHp: 135, hasChestArmor: false, hasHelmetArmor: false,
    plateWearPerStop: 0, helmetWearPerStop: 0,
  },
  // Load-bearing webbing over fatigues: no ballistic protection.
  MILITIA_GUNNER: {
    baseHp: 145, hasChestArmor: false, hasHelmetArmor: false,
    plateWearPerStop: 0, helmetWearPerStop: 0,
  },
  // Plate carrier, PASGT helmet and visor: soaks several rifle rounds before the plate fails.
  HEAVY_ENFORCER: {
    baseHp: 190, hasChestArmor: true, hasHelmetArmor: true,
    plateWearPerStop: 14, helmetWearPerStop: 22,
  },
};

export function getArchetypeLoadout(archetype: EnemyArchetypeId): ArchetypeLoadout {
  return ARCHETYPE_LOADOUTS[archetype] ?? ARCHETYPE_LOADOUTS.MILITIA_GUNNER;
}
