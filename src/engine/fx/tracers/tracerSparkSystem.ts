import type { Vec3Like } from '../../../contracts/ballistics.ts';
import { add, length, normalize, scale } from '../../../core/ballistics/vec3.ts';
import type { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import { directionToStreakQuaternion } from '../math/surfaceAlignment.ts';

export interface TracerContext {
  tracerCorePool: HardwareInstancedPool;
  tracerHaloPool: HardwareInstancedPool;
}

export function spawnBulletTracer(
  ctx: TracerContext,
  originWorld: Vec3Like,
  directionWorld: Vec3Like,
  maxDistanceM = 48.0,
  streakLengthM = 1.65,
): void {
  const dir = normalize(directionWorld);
  if (length(dir) < 1e-6) return;

  const clampedDist = Math.max(1.2, Math.min(85.0, maxDistanceM));
  const ttl = Math.max(0.055, Math.min(0.24, clampedDist / 185.0));
  const speed = clampedDist / ttl;
  const startPos = add(originWorld, scale(dir, Math.min(0.55, clampedDist * 0.25)));
  const vel = scale(dir, speed);
  const quat = directionToStreakQuaternion(dir);

  ctx.tracerCorePool.spawnKinematicParticle(
    startPos,
    vel,
    { x: 0, y: 0, z: 0 },
    { x: 0.016, y: 0.016, z: streakLengthM },
    0,
    0,
    ttl,
    quat,
  );
  ctx.tracerHaloPool.spawnKinematicParticle(
    startPos,
    vel,
    { x: 0, y: 0, z: 0 },
    { x: 0.048, y: 0.048, z: streakLengthM * 1.18 },
    0,
    0,
    ttl,
    quat,
  );
}

export function spawnRicochetSparks(
  sparkPool: HardwareInstancedPool,
  origin: Vec3Like,
  normal: Vec3Like,
  tangentA: Vec3Like,
  tangentB: Vec3Like,
  sparkCount: number,
  isMetallic: boolean,
  energyScale: number,
  seedCounter: number,
): number {
  let seed = seedCounter;
  for (let i = 0; i < sparkCount; i++) {
    seed++;
    const angle = ((seed * 137.5) % 360) * (Math.PI / 180);
    const spread = 0.25 + ((seed * 31) % 17) / 22;
    const spd = (isMetallic ? 8.5 : 6.2) * energyScale * (0.65 + ((seed * 19) % 13) / 16);

    const sparkDir = normalize({
      x: normal.x + (tangentA.x * Math.cos(angle) + tangentB.x * Math.sin(angle)) * spread,
      y: normal.y + (tangentA.y * Math.cos(angle) + tangentB.y * Math.sin(angle)) * spread + 0.18,
      z: normal.z + (tangentA.z * Math.cos(angle) + tangentB.z * Math.sin(angle)) * spread,
    });

    const quat = directionToStreakQuaternion(sparkDir);
    sparkPool.spawnKinematicParticle(
      origin,
      scale(sparkDir, spd),
      { x: 0, y: 0, z: 0 },
      { x: 0.012, y: 0.012, z: isMetallic ? 0.24 : 0.16 },
      -11.5,
      0.48,
      0.18 + ((seed % 5) * 0.045),
      quat,
    );
  }
  return seed;
}
