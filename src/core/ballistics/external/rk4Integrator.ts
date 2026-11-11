import {
  EnvironmentState,
  ProjectileState,
} from '../../../contracts/ballistics.ts';
import { computeMachDragMultiplier } from './machDrag.ts';

/**
 * 4th-Order Runge-Kutta (RK4) numerical ballistic integrator.
 */
export function stepProjectileRK4(
  proj: ProjectileState,
  env: EnvironmentState,
  dt: number,
  pelletIndexOverride?: number
): ProjectileState {
  if (!proj.alive || dt <= 0) return proj;

  const m = proj.ammo.massKg;
  const halfDiam = proj.currentDiameterM * 0.5;
  const area = Math.PI * halfDiam * halfDiam;
  const baseCd = proj.ammo.dragCoefficient;
  const rho = env.airDensityKgM3;
  const vsound = env.speedOfSoundMs;
  const gravX = env.gravity.x;
  const gravY = env.gravity.y;
  const gravZ = env.gravity.z;
  const windX = env.windVelocity.x;
  const windY = env.windVelocity.y;
  const windZ = env.windVelocity.z;
  const spinRadS = proj.spinRadS;
  const distTraveled = proj.distanceTraveledM;

  let buckshotPelletIdx = 0;
  if (proj.ammo.type === 'BUCKSHOT_00' && proj.ammo.pelletCount > 1) {
    if (pelletIndexOverride !== undefined) {
      buckshotPelletIdx = pelletIndexOverride > 0 ? pelletIndexOverride : 0;
    } else {
      const pPos = proj.id.lastIndexOf('_p');
      if (pPos !== -1) {
        const parsed = Number.parseInt(proj.id.slice(pPos + 2), 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          buckshotPelletIdx = parsed;
        }
      }
    }
  }

  let accX = 0;
  let accY = 0;
  let accZ = 0;

  const computeAccelerationScalar = (vx: number, vy: number, vz: number): void => {
    const vRelX = vx - windX;
    const vRelY = vy - windY;
    const vRelZ = vz - windZ;
    const speedRelSq = vRelX * vRelX + vRelY * vRelY + vRelZ * vRelZ;
    if (speedRelSq < 1e-8) {
      accX = gravX;
      accY = gravY;
      accZ = gravZ;
      return;
    }

    const speedRel = Math.sqrt(speedRelSq);
    const invSpeedRel = 1 / speedRel;
    const mach = speedRel / vsound;
    const cd = baseCd * computeMachDragMultiplier(mach);

    const dragAccelMag = (0.5 * rho * speedRelSq * cd * area) / m;
    let ax = gravX - vRelX * invSpeedRel * dragAccelMag;
    let ay = gravY - vRelY * invSpeedRel * dragAccelMag;
    let az = gravZ - vRelZ * invSpeedRel * dragAccelMag;

    if (spinRadS !== 0 && speedRel > 10) {
      const vLen = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (vLen > 1e-8) {
        const vnx = vx / vLen;
        const vnz = vz / vLen;
        const dLen = Math.hypot(vnz, vnx);
        if (dLen > 1e-8) {
          const driftAccelMag = (0.00012 * spinRadS * (speedRel / vsound)) / dLen;
          ax += vnz * driftAccelMag;
          az += -vnx * driftAccelMag;
        }
      }
    }

    if (buckshotPelletIdx > 0 && distTraveled > 2.8) {
      const vLen = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (vLen > 1e-8) {
        const vnx = vx / vLen;
        const vny = vy / vLen;
        const vnz = vz / vLen;
        let rx: number;
        let ry: number;
        let rz: number;
        if (Math.abs(vny) < 0.999) {
          rx = vnz;
          ry = 0;
          rz = -vnx;
        } else {
          rx = 0;
          ry = -vnz;
          rz = vny;
        }
        const rLen = Math.hypot(rx, ry, rz);
        if (rLen > 1e-8) {
          rx /= rLen;
          ry /= rLen;
          rz /= rLen;
        }
        const ux = vny * rz - vnz * ry;
        const uy = vnz * rx - vnx * rz;
        const uz = vnx * ry - vny * rx;

        const goldenRatio = 1.618033988749895;
        const theta = 2 * Math.PI * (buckshotPelletIdx * goldenRatio + 0.337);
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        const rNorm = Math.sqrt(buckshotPelletIdx / Math.max(1, proj.ammo.pelletCount - 1));
        const bloomRamp = Math.min(1.0, (distTraveled - 2.8) / 3.5);
        const liftMag = dragAccelMag * 0.48 * rNorm * bloomRamp;
        ax += (rx * cosT + ux * sinT) * liftMag;
        ay += (ry * cosT + uy * sinT) * liftMag;
        az += (rz * cosT + uz * sinT) * liftMag;
      }
    }

    accX = ax;
    accY = ay;
    accZ = az;
  };

  const p0x = proj.position.x;
  const p0y = proj.position.y;
  const p0z = proj.position.z;
  const v0x = proj.velocity.x;
  const v0y = proj.velocity.y;
  const v0z = proj.velocity.z;
  const halfDt = 0.5 * dt;
  const sixthDt = dt / 6;

  computeAccelerationScalar(v0x, v0y, v0z);
  const a1x = accX;
  const a1y = accY;
  const a1z = accZ;

  const v1x = v0x + a1x * halfDt;
  const v1y = v0y + a1y * halfDt;
  const v1z = v0z + a1z * halfDt;
  computeAccelerationScalar(v1x, v1y, v1z);
  const a2x = accX;
  const a2y = accY;
  const a2z = accZ;

  const v2x = v0x + a2x * halfDt;
  const v2y = v0y + a2y * halfDt;
  const v2z = v0z + a2z * halfDt;
  computeAccelerationScalar(v2x, v2y, v2z);
  const a3x = accX;
  const a3y = accY;
  const a3z = accZ;

  const v3x = v0x + a3x * dt;
  const v3y = v0y + a3y * dt;
  const v3z = v0z + a3z * dt;
  computeAccelerationScalar(v3x, v3y, v3z);
  const a4x = accX;
  const a4y = accY;
  const a4z = accZ;

  const dpx = (v0x + 2 * (v1x + v2x) + v3x) * sixthDt;
  const dpy = (v0y + 2 * (v1y + v2y) + v3y) * sixthDt;
  const dpz = (v0z + 2 * (v1z + v2z) + v3z) * sixthDt;

  const dvx = (a1x + 2 * (a2x + a3x) + a4x) * sixthDt;
  const dvy = (a1y + 2 * (a2y + a3y) + a4y) * sixthDt;
  const dvz = (a1z + 2 * (a2z + a3z) + a4z) * sixthDt;

  const nextVx = v0x + dvx;
  const nextVy = v0y + dvy;
  const nextVz = v0z + dvz;
  const nextSpeedSq = nextVx * nextVx + nextVy * nextVy + nextVz * nextVz;
  const stepDist = Math.sqrt(dpx * dpx + dpy * dpy + dpz * dpz);

  return {
    ...proj,
    position: { x: p0x + dpx, y: p0y + dpy, z: p0z + dpz },
    velocity: { x: nextVx, y: nextVy, z: nextVz },
    flightTimeS: proj.flightTimeS + dt,
    distanceTraveledM: distTraveled + stepDist,
    kineticEnergyJ: 0.5 * m * nextSpeedSq,
  };
}
