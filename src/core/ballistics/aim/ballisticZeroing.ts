import {
  AmmoSpec,
  EnvironmentState,
  ProjectileState,
  Vec3Like,
  WeaponSpec,
} from '../../../contracts/ballistics.ts';
import { add, copyVec3, distance, length, normalize, scale, sub } from '../vec3.ts';
import { stepProjectileRK4 } from '../external/rk4Integrator.ts';

/**
 * Computes the exact boresight aim direction required for a projectile fired from `originWorld`
 * to impact `desiredImpactWorld` under full RK4 gravity, Mach drag, crosswind, and spin drift.
 */
export function computeBallisticZeroAimDirection(
  weapon: WeaponSpec,
  ammo: AmmoSpec,
  originWorld: Vec3Like,
  desiredImpactWorld: Vec3Like,
  env: EnvironmentState
): Vec3Like {
  const directVec = sub(desiredImpactWorld, originWorld);
  const targetDist = length(directVec);
  if (targetDist < 0.5 || ammo.muzzleVelocityMs <= 0) {
    return normalize(directVec);
  }

  const dt = 0.0015;
  const spinRadS =
    weapon.role === 'SNIPER' ? 2400 : weapon.role === 'ASSAULT_RIFLE' ? 3000 : 0;
  const muzzleEnergyJ = 0.5 * ammo.massKg * ammo.muzzleVelocityMs * ammo.muzzleVelocityMs;

  let aimTarget = copyVec3(desiredImpactWorld);

  for (let iter = 0; iter < 3; iter++) {
    const aimDir = normalize(sub(aimTarget, originWorld));
    let proj: ProjectileState = {
      id: 'zero_probe',
      ammo,
      position: copyVec3(originWorld),
      velocity: scale(aimDir, ammo.muzzleVelocityMs),
      spinRadS,
      currentDiameterM: ammo.diameterM,
      flightTimeS: 0,
      distanceTraveledM: 0,
      kineticEnergyJ: muzzleEnergyJ,
      penetratedLayers: 0,
      alive: true,
    };

    let prevPos = copyVec3(proj.position);
    let prevDist = 0;
    while (proj.alive && proj.distanceTraveledM < targetDist && proj.flightTimeS < 2.0) {
      prevPos = copyVec3(proj.position);
      prevDist = proj.distanceTraveledM;
      proj = stepProjectileRK4(proj, env, dt);
    }

    const segDist = proj.distanceTraveledM - prevDist;
    const alpha =
      segDist > 1e-6 ? Math.min(1, Math.max(0, (targetDist - prevDist) / segDist)) : 1;
    const posAtRange = add(prevPos, scale(sub(proj.position, prevPos), alpha));
    const error = sub(posAtRange, desiredImpactWorld);
    aimTarget = sub(aimTarget, error);
  }

  return normalize(sub(aimTarget, originWorld));
}
