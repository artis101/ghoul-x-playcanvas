import { AmmoSpec, Vec3Like } from '../../../contracts/ballistics.ts';
import { ArmorPlateId } from '../../../contracts/physiology.ts';
import { TIER1_ARMOR_PLATES } from '../../ghoul/bvhVolumes.ts';
import { cross, normalize, rotateAroundAxis } from '../vec3.ts';

export type ProjectileTerminalBehavior =
  | 'SPITZER_HIGH_VEL_YAW'
  | 'RIFLE_FMJ_OTM_YAW'
  | 'AP_PENETRATOR_STABLE'
  | 'EXPANDING_JHP_MUSHROOM'
  | 'SOLID_SLUG_OR_BALL';

export function createInitialPlateIntegrityMap(
  overrides?: Partial<Record<ArmorPlateId, number>>
): Record<ArmorPlateId, number> {
  const map: Record<ArmorPlateId, number> = {
    FRONT_ESAPI_PLATE: 1.0,
    BACK_ESAPI_PLATE: 1.0,
    SIDE_SAPI_LEFT: 1.0,
    SIDE_SAPI_RIGHT: 1.0,
    HELMET_BALLISTIC_SHELL: 1.0,
  };
  if (overrides) {
    for (const plate of TIER1_ARMOR_PLATES) {
      const val = overrides[plate.id];
      if (val !== undefined) {
        map[plate.id] = Math.max(0, Math.min(1, val));
      }
    }
  }
  return map;
}

export function classifyTerminalBehavior(ammo: AmmoSpec, entryVelocityMs: number): ProjectileTerminalBehavior {
  if (ammo.type === 'JHP') {
    return 'EXPANDING_JHP_MUSHROOM';
  }
  if (ammo.type === 'AP' && ammo.diameterM < 0.012 && ammo.armorPenetrationFactor >= 1.4) {
    return 'AP_PENETRATOR_STABLE';
  }
  // 5.56x45mm / 5.45x39mm lightweight high-velocity spitzer FMJ (d <= 6.2mm)
  if (ammo.type === 'FMJ' && ammo.diameterM <= 0.0062 && entryVelocityMs >= 620) {
    return 'SPITZER_HIGH_VEL_YAW';
  }
  // 7.62mm FMJ / Match OTM spitzer
  if (ammo.type === 'FMJ' && ammo.diameterM <= 0.0086 && entryVelocityMs >= 600) {
    return 'RIFLE_FMJ_OTM_YAW';
  }
  return 'SOLID_SLUG_OR_BALL';
}

export function computeProjectileLengthM(ammo: AmmoSpec, behavior: ProjectileTerminalBehavior): number {
  switch (behavior) {
    case 'SPITZER_HIGH_VEL_YAW':
      return ammo.diameterM * 4.15; // e.g. 5.7mm * 4.15 = 23.6mm M855/M193 spitzer
    case 'RIFLE_FMJ_OTM_YAW':
      return ammo.diameterM * 3.95; // e.g. 7.82mm * 3.95 = 30.9mm 7.62 spitzer
    case 'AP_PENETRATOR_STABLE':
      return ammo.diameterM * 3.8;
    case 'EXPANDING_JHP_MUSHROOM':
      return ammo.diameterM * 1.65;
    case 'SOLID_SLUG_OR_BALL':
      return ammo.type === 'BUCKSHOT_00' ? ammo.diameterM : ammo.diameterM * 1.75;
  }
}

export function buildConeRayDirection(
  forwardUnit: Vec3Like,
  polarAngleRad: number,
  azimuthRad: number
): Vec3Like {
  const refUp = Math.abs(forwardUnit.y) < 0.98 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const orthoRight = normalize(cross(refUp, forwardUnit));
  const tilted = rotateAroundAxis(forwardUnit, orthoRight, polarAngleRad);
  return normalize(rotateAroundAxis(tilted, forwardUnit, azimuthRad));
}
