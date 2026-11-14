import * as pc from 'playcanvas';
import type { DismembermentEvent, TargetHealthState, Vec3Like } from '../../../contracts/ballistics.ts';
import { copyInto, copyVec3, length, normalizeInto, subInto } from '../../../core/ballistics/vec3.ts';
import type { ArterialFountainStream } from './goreTypes.ts';

const scratchOut = { x: 0, y: 0, z: 0 };
const scratchSprayDir = { x: 0, y: 0, z: 0 };

export function attachArterialFountain(
  arterialFountains: ArterialFountainStream[],
  target: TargetHealthState,
  event: DismembermentEvent,
): void {
  arterialFountains.push({
    target,
    zone: event.zone,
    parentZone: event.parentZone,
    stumpPos: copyVec3(event.stumpWorldPosition),
    sprayDir: copyVec3(event.arterialSprayDirection),
    durationS: 3.8,
    elapsedS: 0,
    dropTimerS: 0,
  });
}

export function updateArterialFountains(
  arterialFountains: ArterialFountainStream[],
  dt: number,
  onSpawnBloodBurst: (pos: Vec3Like, dir: Vec3Like, energyJ: number, count: number) => void,
): void {
  for (let i = arterialFountains.length - 1; i >= 0; i--) {
    const f = arterialFountains[i];
    f.elapsedS += dt;
    f.dropTimerS += dt;

    if (f.target) {
      const socketZone = f.parentZone || f.zone;
      if (socketZone && f.target.ragdollBones[socketZone]) {
        const b = f.target.ragdollBones[socketZone];
        copyInto(f.stumpPos, b.distalPosition || b.position);
        subInto(scratchOut, b.distalPosition, b.position);
        if (length(scratchOut) > 0.02) {
          normalizeInto(f.sprayDir, scratchOut);
        } else {
          copyInto(f.sprayDir, b.basisUp);
        }
      }
    }

    const pressureDecay = Math.max(0.28, 1.0 - (f.elapsedS / f.durationS) * 0.65);
    const systolicPulse = 1.0 + Math.max(0, Math.sin(f.elapsedS * 11.2)) * 0.95;
    const pulseRate = systolicPulse * pressureDecay;
    if (f.dropTimerS >= 0.11 / Math.max(0.3, pulseRate)) {
      f.dropTimerS = 0;
      const sprayDirNorm = normalizeInto(scratchSprayDir, f.sprayDir);
      onSpawnBloodBurst(f.stumpPos, sprayDirNorm, 48 * pulseRate, 3);
    }

    if (f.elapsedS >= f.durationS) {
      arterialFountains.splice(i, 1);
    }
  }
}
