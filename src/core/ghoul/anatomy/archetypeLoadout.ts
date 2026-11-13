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
  /**
   * How tough the body is (src/core/ballistics/shot/archetypeToughness.ts). HP lost to meat and
   * bone on a round that went deeper is scaled by this; lungs, liver, gut and the skull and jaw by
   * its square root. The brain, heart, great vessels and the neck spine are never scaled: a vital
   * hit kills a big man just as dead.
   */
  readonly bodyDamageScale: number;
  /**
   * HP scale on a wound that only ever touched meat and fat, like a buckshot pellet stopping in
   * the chest muscle. Size matters most here: a big man shrugs off a spray of shallow pellet
   * wounds that would fold a skinny punk.
   */
  readonly shallowWoundScale: number;
  /**
   * A hard shove (a close shotgun blast) only knocks the body off its feet once the hit leaves it
   * at or below this fraction of its health. A healthy tough guy rocks and keeps standing.
   */
  readonly knockdownHpFraction: number;
}

export const ARCHETYPE_LOADOUTS: Readonly<Record<EnemyArchetypeId, ArchetypeLoadout>> = {
  // Vest and jeans, nothing over the skin.
  SKINHEAD_PUNK: {
    baseHp: 120, hasChestArmor: false, hasHelmetArmor: false,
    plateWearPerStop: 0, helmetWearPerStop: 0,
    bodyDamageScale: 1, shallowWoundScale: 0.7, knockdownHpFraction: 0.35,
  },
  // Field jacket and boonie hat: no ballistic protection.
  SNIPER_OPERATIVE: {
    baseHp: 135, hasChestArmor: false, hasHelmetArmor: false,
    plateWearPerStop: 0, helmetWearPerStop: 0,
    bodyDamageScale: 1, shallowWoundScale: 0.7, knockdownHpFraction: 0.35,
  },
  // "The Muscle": load-bearing webbing over fatigues, no ballistic protection, but built like a
  // door. A body blast hurts him; it does not fold him.
  MILITIA_GUNNER: {
    baseHp: 145, hasChestArmor: false, hasHelmetArmor: false,
    plateWearPerStop: 0, helmetWearPerStop: 0,
    bodyDamageScale: 0.8, shallowWoundScale: 0.22, knockdownHpFraction: 0.3,
  },
  // Tank top and a rubber respirator: nothing that stops a bullet, but he is big enough to shrug
  // off what would drop a smaller man.
  MASKED_BRUISER: {
    baseHp: 165, hasChestArmor: false, hasHelmetArmor: false,
    plateWearPerStop: 0, helmetWearPerStop: 0,
    bodyDamageScale: 0.8, shallowWoundScale: 0.22, knockdownHpFraction: 0.3,
  },
  // Plate carrier, PASGT helmet and visor: soaks several rifle rounds before the plate fails, and
  // only goes down once he is nearly spent.
  HEAVY_ENFORCER: {
    baseHp: 190, hasChestArmor: true, hasHelmetArmor: true,
    plateWearPerStop: 14, helmetWearPerStop: 22,
    bodyDamageScale: 0.85, shallowWoundScale: 0.25, knockdownHpFraction: 0.25,
  },
};

export function getArchetypeLoadout(archetype: EnemyArchetypeId): ArchetypeLoadout {
  return ARCHETYPE_LOADOUTS[archetype] ?? ARCHETYPE_LOADOUTS.MILITIA_GUNNER;
}
