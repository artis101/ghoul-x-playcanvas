import type { AmmoSpec, WeaponSpec } from '../../../contracts/ballistics.ts';
import type { PelletBehavior } from '../../../contracts/combatantConstitution.ts';
import { createSeededRng, mixSeed, rollRange } from '../../random/seededRng.ts';

export type { PelletBehavior };

export interface PelletVariance {
  readonly behavior: PelletBehavior;
  /** Energy dumped per layer, relative to nominal. Applied once the bullet is past `onsetDepthM`. */
  readonly depositScale: number;
  /** Tissue path before the behaviour kicks in (a tumbling rifle round yaws after some depth). */
  readonly onsetDepthM: number;
  /** Per-layer draws for rupture thresholds and rib glances. */
  readonly rng: () => number;
}

/** Above this entry energy a round goes through a rib rather than skating off it. */
const RIB_GLANCE_MAX_ENERGY_J = 2600;
const RIB_GLANCE_CHANCE = 0.16;

function behaviorOdds(weapon: WeaponSpec, ammo: AmmoSpec): Record<PelletBehavior, number> {
  if (ammo.pelletCount > 1) return { ICEPICK: 0.15, NOMINAL: 0.7, TUMBLE: 0, FRAGMENT: 0.15 };
  if (weapon.role === 'ASSAULT_RIFLE' || weapon.role === 'RIFLE') return { ICEPICK: 0.25, NOMINAL: 0.35, TUMBLE: 0.25, FRAGMENT: 0.15 };
  if (weapon.role === 'SNIPER') return { ICEPICK: 0.15, NOMINAL: 0.5, TUMBLE: 0.2, FRAGMENT: 0.15 };
  // Handgun-class rounds: either expand as designed, fail to, or over-perform.
  return { ICEPICK: 0.3, NOMINAL: 0.45, TUMBLE: 0.1, FRAGMENT: 0.15 };
}

/** Rolls pellet `pelletIndex`'s behaviour from the target's current variance seed. */
export function rollPelletVariance(
  seed: number,
  pelletIndex: number,
  weapon: WeaponSpec,
  ammo: AmmoSpec
): PelletVariance {
  const rng = createSeededRng(mixSeed(seed, pelletIndex + 1));
  const odds = behaviorOdds(weapon, ammo);
  let roll = rng();
  let behavior: PelletBehavior = 'NOMINAL';
  for (const key of ['ICEPICK', 'TUMBLE', 'FRAGMENT', 'NOMINAL'] as const) {
    if (roll < odds[key]) {
      behavior = key;
      break;
    }
    roll -= odds[key];
  }

  switch (behavior) {
    case 'ICEPICK':
      return { behavior, depositScale: rollRange(rng, 0.45, 0.75), onsetDepthM: 0, rng };
    case 'TUMBLE':
      return { behavior, depositScale: rollRange(rng, 1.3, 1.7), onsetDepthM: rollRange(rng, 0.06, 0.14), rng };
    case 'FRAGMENT':
      return { behavior, depositScale: rollRange(rng, 1.4, 1.9), onsetDepthM: rollRange(rng, 0.02, 0.06), rng };
    default:
      return { behavior, depositScale: rollRange(rng, 0.88, 1.12), onsetDepthM: 0, rng };
  }
}

/** Deposit multiplier for a layer entered after `tissueDepthM` of tissue. */
export function depositScaleAtDepth(v: PelletVariance, tissueDepthM: number): number {
  return tissueDepthM >= v.onsetDepthM ? v.depositScale : 1;
}

/** A rupture threshold shifted ±25%: tissue is not uniform, and sometimes a near miss is a miss. */
export function jitterThreshold(v: PelletVariance, thresholdJ: number): number {
  return thresholdJ * rollRange(v.rng, 0.75, 1.25);
}

/** Whether a round skates off a rib instead of carrying on into the chest. */
export function rollsRibGlance(v: PelletVariance, colliderId: string, entryEnergyJ: number): boolean {
  if (colliderId !== 'vol_thorax_ribcage' || entryEnergyJ > RIB_GLANCE_MAX_ENERGY_J) return false;
  const chance = v.behavior === 'ICEPICK' ? RIB_GLANCE_CHANCE * 0.5 : RIB_GLANCE_CHANCE;
  return v.rng() < chance;
}
