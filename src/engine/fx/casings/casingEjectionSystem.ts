import type { AmmoSpec, Vec3Like, WeaponSpec } from '../../../contracts/ballistics.ts';
import { cross, normalize, vec3 } from '../../../core/ballistics/vec3.ts';
import type { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import {
  CASING_BOUNCE_FLOOR_Y,
  CasingBounceEvent,
  TRACKED_CASING_CAPACITY,
  TrackedCasingBuffer,
} from './casingTypes.ts';

export interface CasingSystemContext {
  brassCasingPool: HardwareInstancedPool;
  shotgunHullPool: HardwareInstancedPool;
  trackedBuffer: TrackedCasingBuffer;
  onCasingBounce?: (event: CasingBounceEvent) => void;
}

export function registerTrackedCasingBounce(
  buf: TrackedCasingBuffer,
  origin: Vec3Like,
  vel: Vec3Like,
  restitution: number,
  isShotgunHull: boolean,
): void {
  const idx = buf.trackWriteCursor % TRACKED_CASING_CAPACITY;
  buf.trackWriteCursor++;

  buf.trackActive[idx] = 1;
  buf.trackIsHull[idx] = isShotgunHull ? 1 : 0;
  buf.trackBounces[idx] = 0;
  buf.trackPosX[idx] = origin.x;
  buf.trackPosY[idx] = origin.y;
  buf.trackPosZ[idx] = origin.z;
  buf.trackVelX[idx] = vel.x;
  buf.trackVelY[idx] = vel.y;
  buf.trackVelZ[idx] = vel.z;
  buf.trackRestitution[idx] = restitution;
}

export function stepTrackedCasingBounces(
  buf: TrackedCasingBuffer,
  dt: number,
  onCasingBounce?: (event: CasingBounceEvent) => void,
): void {
  const stepDt = Math.min(0.1, dt);
  for (let i = 0; i < TRACKED_CASING_CAPACITY; i++) {
    if (buf.trackActive[i] === 0) continue;

    let vx = buf.trackVelX[i];
    let vy = buf.trackVelY[i] - 9.81 * stepDt;
    let vz = buf.trackVelZ[i];

    const px = buf.trackPosX[i] + vx * stepDt;
    let py = buf.trackPosY[i] + vy * stepDt;
    const pz = buf.trackPosZ[i] + vz * stepDt;

    if (py <= CASING_BOUNCE_FLOOR_Y) {
      const impactSpeed = Math.abs(vy);
      py = CASING_BOUNCE_FLOOR_Y;
      const bounceNum = buf.trackBounces[i] + 1;
      buf.trackBounces[i] = bounceNum;

      if (impactSpeed > 0.35 && bounceNum <= 2) {
        onCasingBounce?.({
          position: { x: px, y: CASING_BOUNCE_FLOOR_Y, z: pz },
          impactSpeedMs: impactSpeed,
          isShotgunHull: buf.trackIsHull[i] === 1,
          bounceIndex: bounceNum,
        });
      }

      const bouncedVy = impactSpeed * buf.trackRestitution[i];
      if (bouncedVy < 0.25 || bounceNum >= 2) {
        buf.trackActive[i] = 0;
        continue;
      }
      vy = bouncedVy;
      vx *= 0.72;
      vz *= 0.72;
    }

    buf.trackPosX[i] = px;
    buf.trackPosY[i] = py;
    buf.trackPosZ[i] = pz;
    buf.trackVelX[i] = vx;
    buf.trackVelY[i] = vy;
    buf.trackVelZ[i] = vz;
  }
}

export function ejectWeaponCasing(
  ctx: CasingSystemContext,
  eyeWorldPos: Vec3Like,
  aimDirectionWorld: Vec3Like,
  weapon: Pick<WeaponSpec, 'role'>,
  ammo?: Pick<AmmoSpec, 'type'>,
  seedCounter = 1,
): { slotId: number; nextSeed: number } {
  const fwd = normalize(aimDirectionWorld);
  const upRef = Math.abs(fwd.y) < 0.98 ? vec3(0, 1, 0) : vec3(0, 0, 1);
  const right = normalize(cross(fwd, upRef));
  const orthoUp = normalize(cross(right, fwd));

  const ejectOrigin: Vec3Like = {
    x: eyeWorldPos.x + fwd.x * 0.34 + right.x * 0.21 - orthoUp.x * 0.11,
    y: eyeWorldPos.y + fwd.y * 0.34 + right.y * 0.21 - orthoUp.y * 0.11,
    z: eyeWorldPos.z + fwd.z * 0.34 + right.z * 0.21 - orthoUp.z * 0.11,
  };

  const s = seedCounter;
  const jitterA = ((s * 73) % 19) / 19 - 0.5;
  const jitterB = ((s * 131) % 23) / 23 - 0.5;

  const isShotgunHull = weapon.role === 'SHOTGUN' || ammo?.type === 'BUCKSHOT_00';
  const sideSpeed = (isShotgunHull ? 2.15 : 2.75) + jitterA * 0.55;
  const upSpeed = (isShotgunHull ? 1.45 : 1.75) + jitterB * 0.45;
  const backSpeed = -0.55 + jitterA * 0.3;

  const ejectVel: Vec3Like = {
    x: right.x * sideSpeed + orthoUp.x * upSpeed + fwd.x * backSpeed,
    y: right.y * sideSpeed + orthoUp.y * upSpeed + fwd.y * backSpeed,
    z: right.z * sideSpeed + orthoUp.z * upSpeed + fwd.z * backSpeed,
  };

  const spin: Vec3Like = {
    x: 22 + jitterA * 16,
    y: -26 + jitterB * 18,
    z: 32 + jitterA * 14,
  };

  const casingScale: Vec3Like = isShotgunHull
    ? { x: 0.02, y: 0.062, z: 0.02 }
    : weapon.role === 'SNIPER'
      ? { x: 0.0125, y: 0.055, z: 0.0125 }
      : weapon.role === 'HEAVY_PISTOL'
        ? { x: 0.0145, y: 0.036, z: 0.0145 }
        : { x: 0.0105, y: 0.046, z: 0.0105 };

  const restitution = isShotgunHull ? 0.34 : 0.48;
  const pool = isShotgunHull ? ctx.shotgunHullPool : ctx.brassCasingPool;
  const slotId = pool.spawnKinematicParticle(
    ejectOrigin,
    ejectVel,
    spin,
    casingScale,
    -9.81,
    restitution,
    6.5,
  );

  registerTrackedCasingBounce(ctx.trackedBuffer, ejectOrigin, ejectVel, restitution, isShotgunHull);
  return { slotId, nextSeed: s + 1 };
}
