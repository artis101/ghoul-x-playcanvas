import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { HardwareInstancedPool } from '../../physics/instancedPool.ts';

export function spawnSpallChipBurst(
  chipPool: HardwareInstancedPool,
  nextRandom: () => number,
  pointWorld: Vec3Like,
  normalWorld: Vec3Like,
  incidentDirWorld: Vec3Like,
  intensityScale = 1.0,
  chipCountOverride?: number,
): number {
  const dotIN = incidentDirWorld.x * normalWorld.x + incidentDirWorld.y * normalWorld.y + incidentDirWorld.z * normalWorld.z;
  const reflX = incidentDirWorld.x - 2 * dotIN * normalWorld.x;
  const reflY = incidentDirWorld.y - 2 * dotIN * normalWorld.y;
  const reflZ = incidentDirWorld.z - 2 * dotIN * normalWorld.z;

  const count = chipCountOverride ?? Math.max(6, Math.min(16, Math.round(9 * intensityScale)));
  let spawned = 0;

  for (let i = 0; i < count; i++) {
    const speed = (2.8 + nextRandom() * 5.8) * Math.max(0.65, intensityScale);
    const jitterX = (nextRandom() - 0.5) * 1.25;
    const jitterY = nextRandom() * 0.95;
    const jitterZ = (nextRandom() - 0.5) * 1.25;

    let dirX = normalWorld.x * 0.62 + reflX * 0.38 + jitterX;
    let dirY = normalWorld.y * 0.62 + reflY * 0.38 + jitterY + 0.26;
    let dirZ = normalWorld.z * 0.62 + reflZ * 0.38 + jitterZ;
    const dLen = Math.hypot(dirX, dirY, dirZ) || 1;
    dirX /= dLen;
    dirY /= dLen;
    dirZ /= dLen;

    const chipSize = (0.011 + nextRandom() * 0.024) * Math.min(1.65, intensityScale);
    const slot = chipPool.spawnKinematicParticle(
      {
        x: pointWorld.x + normalWorld.x * 0.016,
        y: pointWorld.y + normalWorld.y * 0.016,
        z: pointWorld.z + normalWorld.z * 0.016,
      },
      { x: dirX * speed, y: dirY * speed, z: dirZ * speed },
      {
        x: (nextRandom() - 0.5) * 26,
        y: (nextRandom() - 0.5) * 26,
        z: (nextRandom() - 0.5) * 26,
      },
      {
        x: chipSize,
        y: chipSize * (0.62 + nextRandom() * 0.35),
        z: chipSize * (0.72 + nextRandom() * 0.35),
      },
      -9.81,
      0.38,
      1.45 + nextRandom() * 0.95,
    );
    if (slot >= 0) spawned++;
  }

  chipPool.upload();
  return spawned;
}
