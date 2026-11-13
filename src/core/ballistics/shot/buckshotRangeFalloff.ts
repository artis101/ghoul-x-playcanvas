import type { AmmoSpec } from '../../../contracts/ballistics.ts';

/**
 * How buckshot loses its stopping power downrange, beyond the plain energy lost to drag.
 *
 * Soft lead balls flatten on impact only while they are fast: a 00 pellet at ~400 m/s deforms
 * noticeably, one that has slowed to ~250 m/s goes through like an undeformed ball. And the
 * "synergy" of a buckshot hit — several pellet channels landing close together in the same
 * second — exists only while the pattern is still tight; once it opens up, the few pellets that
 * still land are separate small wounds.
 *
 * Single-projectile ammunition (slugs, bullets) is passed through unchanged.
 */

/** Below this impact speed a lead pellet no longer deforms in tissue. */
const PELLET_NO_DEFORM_SPEED_MS = 240;
/** Range out to which the pattern is tight enough for pellet channels to overlap. */
const PATTERN_TIGHT_RANGE_M = 6;
/** Range by which the pattern has opened and the pellets act as separate wounds. */
const PATTERN_OPEN_RANGE_M = 20;
/** Damage bonus of a tight, overlapping multi-pellet hit. */
const TIGHT_PATTERN_SYNERGY = 1.48;

function isMultiPellet(ammo: AmmoSpec): boolean {
  return ammo.pelletCount > 1;
}

/**
 * Tissue expansion factor a pellet actually reaches when it strikes at `impactSpeedMs`:
 * the ammo's full value near the muzzle, falling to 1.0 (no deformation) at 240 m/s.
 */
export function pelletExpansionAtSpeed(ammo: AmmoSpec, impactSpeedMs: number): number {
  if (!isMultiPellet(ammo) || ammo.tissueExpansionFactor <= 1) return ammo.tissueExpansionFactor;
  const fullDeformSpeedMs = ammo.muzzleVelocityMs * 0.97;
  const span = Math.max(1, fullDeformSpeedMs - PELLET_NO_DEFORM_SPEED_MS);
  const t = Math.min(1, Math.max(0, (impactSpeedMs - PELLET_NO_DEFORM_SPEED_MS) / span));
  return 1 + (ammo.tissueExpansionFactor - 1) * t;
}

/**
 * Damage multiplier for several pellets landing together: full within 6 m, gone by 20 m.
 * `rangeM` is how far the pellet has flown.
 */
export function pelletPatternSynergy(ammo: AmmoSpec, rangeM: number): number {
  if (!isMultiPellet(ammo)) return 1;
  const t = Math.min(
    1,
    Math.max(0, (rangeM - PATTERN_TIGHT_RANGE_M) / (PATTERN_OPEN_RANGE_M - PATTERN_TIGHT_RANGE_M))
  );
  return TIGHT_PATTERN_SYNERGY + (1 - TIGHT_PATTERN_SYNERGY) * t;
}

/** The ammo as a pellet striking at `impactSpeedMs` behaves in tissue (for the organ march). */
export function pelletAmmoAtImpact(ammo: AmmoSpec, impactSpeedMs: number): AmmoSpec {
  if (!isMultiPellet(ammo)) return ammo;
  const expansion = pelletExpansionAtSpeed(ammo, impactSpeedMs);
  return expansion === ammo.tissueExpansionFactor ? ammo : { ...ammo, tissueExpansionFactor: expansion };
}
