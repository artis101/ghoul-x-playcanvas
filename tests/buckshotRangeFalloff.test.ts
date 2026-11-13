import { describe, it, expect } from 'vitest';
import { length, normalize, sub, vec3 } from '../src/core/ballistics/vec3.ts';
import {
  AMMO_12G_00_BUCK,
  AMMO_12G_FLECHETTE_SLUG,
  DEFAULT_ENVIRONMENT,
  WEAPON_M590,
} from '../src/core/ballistics/weapons.ts';
import { simulateShot, stepProjectileRK4 } from '../src/core/ballistics/solver.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import {
  pelletAmmoAtImpact,
  pelletExpansionAtSpeed,
  pelletPatternSynergy,
} from '../src/core/ballistics/shot/buckshotRangeFalloff.ts';
import type { AmmoSpec, ProjectileState } from '../src/contracts/ballistics.ts';

/** Speed of a projectile flown straight out to each requested range. */
function speedsAtRanges(ammo: AmmoSpec, rangesM: number[]): number[] {
  let proj: ProjectileState = {
    id: 'range_probe',
    ammo,
    position: vec3(0, 1.5, 0),
    velocity: vec3(0, 0, -ammo.muzzleVelocityMs),
    spinRadS: 0,
    currentDiameterM: ammo.diameterM,
    flightTimeS: 0,
    distanceTraveledM: 0,
    kineticEnergyJ: 0.5 * ammo.massKg * ammo.muzzleVelocityMs ** 2,
    penetratedLayers: 0,
    alive: true,
  };
  const out: number[] = [];
  for (const r of rangesM) {
    while (-proj.position.z < r) proj = stepProjectileRK4(proj, DEFAULT_ENVIRONMENT, 0.0005);
    out.push(length(proj.velocity));
  }
  return out;
}

const energyJ = (ammo: AmmoSpec, speedMs: number): number => 0.5 * ammo.massKg * speedMs * speedMs;

function chestShot(ammo: AmmoSpec, rangeM: number) {
  const target = createTargetHealthState(`t_${rangeM}`, 'Militia', vec3(0, 0, -rangeM), 0, 'MILITIA_GUNNER');
  const shooter = vec3(0, 1.5, 0);
  const aim = normalize(sub(vec3(0, 1.3, -rangeM), shooter));
  const report = simulateShot(WEAPON_M590, ammo, shooter, aim, target, DEFAULT_ENVIRONMENT);
  const pelletsHit = report.pelletResults.filter((p) => p.hitTarget).length;
  return { report, pelletsHit };
}

describe('Buckshot loses its stopping power with range', () => {
  it('00 pellets shed velocity like real 8.4 mm lead balls; the slug keeps most of its energy', () => {
    const [v5, v25, v45] = speedsAtRanges(AMMO_12G_00_BUCK, [5, 25, 45]);
    const muzzle = AMMO_12G_00_BUCK.muzzleVelocityMs;
    // Real 00 buck: ~400 m/s at the muzzle, roughly two thirds of that by 45 m.
    expect(v45 / muzzle).toBeGreaterThan(0.55);
    expect(v45 / muzzle).toBeLessThan(0.75);
    expect(energyJ(AMMO_12G_00_BUCK, v25)).toBeLessThan(0.7 * energyJ(AMMO_12G_00_BUCK, v5));

    const [s5, s25] = speedsAtRanges(AMMO_12G_FLECHETTE_SLUG, [5, 25]);
    expect(energyJ(AMMO_12G_FLECHETTE_SLUG, s25)).toBeGreaterThan(0.85 * energyJ(AMMO_12G_FLECHETTE_SLUG, s5));
  });

  it('a pellet only flattens while fast, and the tight-pattern bonus is gone once the pattern opens', () => {
    const buck = AMMO_12G_00_BUCK;
    expect(pelletExpansionAtSpeed(buck, buck.muzzleVelocityMs)).toBeCloseTo(buck.tissueExpansionFactor, 5);
    expect(pelletExpansionAtSpeed(buck, 240)).toBe(1);
    expect(pelletExpansionAtSpeed(buck, 300)).toBeLessThan(1.2);
    expect(pelletPatternSynergy(buck, 4)).toBeCloseTo(1.48, 5);
    expect(pelletPatternSynergy(buck, 25)).toBe(1);

    // Single projectiles are untouched.
    const slug = AMMO_12G_FLECHETTE_SLUG;
    expect(pelletExpansionAtSpeed(slug, 200)).toBe(slug.tissueExpansionFactor);
    expect(pelletPatternSynergy(slug, 40)).toBe(1);
    expect(pelletAmmoAtImpact(slug, 200)).toBe(slug);
    expect(pelletAmmoAtImpact(buck, 280).tissueExpansionFactor).toBeLessThan(buck.tissueExpansionFactor);
  });

  it('a chest shot at 25 m lands a few weak pellets; at 5 m it is brutal', () => {
    const near = chestShot(AMMO_12G_00_BUCK, 5);
    const far = chestShot(AMMO_12G_00_BUCK, 25);

    expect(near.pelletsHit).toBeGreaterThanOrEqual(6);
    expect(far.pelletsHit).toBeGreaterThanOrEqual(1);
    expect(far.pelletsHit).toBeLessThanOrEqual(3);

    const nearPerPelletHp = near.report.totalDamageHp / near.pelletsHit;
    const farPerPelletHp = far.report.totalDamageHp / far.pelletsHit;
    expect(farPerPelletHp).toBeLessThan(0.45 * nearPerPelletHp);

    expect(near.report.totalDamageHp).toBeGreaterThan(90);
    expect(far.report.totalDamageHp).toBeLessThan(0.1 * near.report.totalDamageHp);

    // Each pellet that does land at 25 m carries well under the energy it had at 5 m.
    const entryJ = (r: typeof near.report): number[] =>
      r.pelletResults.filter((p) => p.woundEvents[0]).map((p) => p.woundEvents[0].entryEnergyJ);
    expect(Math.max(...entryJ(far.report))).toBeLessThan(0.7 * Math.min(...entryJ(near.report)));
  });
});
