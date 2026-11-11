import type * as RAPIER from '@dimforge/rapier3d-compat';
import type { BlastEvent } from '../../../contracts/destruction.ts';

export function executeRadialBlastImpulse(
  world: RAPIER.World,
  dynamicBodyHandles: Set<number>,
  bodySettleTimers: Map<number, number>,
  blast: BlastEvent,
  scratchTranslation: RAPIER.Vector,
  scratchImpulse: RAPIER.Vector,
  scratchTorque: RAPIER.Vector
): number {
  if (blast.radiusM <= 0 || blast.peakImpulseNs <= 0) return 0;

  const radiusSq = blast.radiusM * blast.radiusM;
  const cx = blast.centerWorld.x;
  const cy = blast.centerWorld.y;
  const cz = blast.centerWorld.z;
  let affectedCount = 0;

  for (const bodyHandle of dynamicBodyHandles) {
    const body = world.getRigidBody(bodyHandle) as RAPIER.RigidBody | undefined;
    if (!body) {
      dynamicBodyHandles.delete(bodyHandle);
      bodySettleTimers.delete(bodyHandle);
      continue;
    }

    const pos = body.translation();
    const dx = pos.x - cx;
    const dy = pos.y - cy;
    const dz = pos.z - cz;
    const distSq = dx * dx + dy * dy + dz * dz;

    if (distSq > radiusSq) continue;

    const dist = Math.sqrt(distSq);
    const linearFalloff = Math.max(0, 1 - dist / blast.radiusM);
    const attenuation = linearFalloff * (0.35 + 0.65 * linearFalloff);
    const impulseMag = blast.peakImpulseNs * attenuation;
    if (impulseMag <= 1e-6) continue;

    let rx = 0;
    let ry = 1;
    let rz = 0;
    if (dist > 1e-4) {
      const invDist = 1 / dist;
      rx = dx * invDist;
      ry = dy * invDist;
      rz = dz * invDist;
    }

    let lx = rx;
    let ly = ry + 0.42;
    let lz = rz;
    const lLen = Math.hypot(lx, ly, lz);
    if (lLen > 1e-5) {
      lx /= lLen;
      ly /= lLen;
      lz /= lLen;
    }

    scratchImpulse.x = lx * impulseMag;
    scratchImpulse.y = ly * impulseMag;
    scratchImpulse.z = lz * impulseMag;

    body.wakeUp();
    bodySettleTimers.set(bodyHandle, 0);
    body.applyImpulse(scratchImpulse, true);

    const spinPhase = ((bodyHandle * 2654435761) >>> 0) * 1.462918079e-9;
    const torqueScale = impulseMag * 0.14;
    scratchTorque.x = (-rz + Math.sin(spinPhase) * 0.35) * torqueScale;
    scratchTorque.y = Math.cos(spinPhase * 1.7) * 0.45 * torqueScale;
    scratchTorque.z = (rx + Math.cos(spinPhase) * 0.35) * torqueScale;
    body.applyTorqueImpulse(scratchTorque, true);

    affectedCount++;
  }

  return affectedCount;
}
