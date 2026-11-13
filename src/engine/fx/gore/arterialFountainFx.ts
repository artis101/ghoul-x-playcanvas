import * as pc from 'playcanvas';
import type { DismembermentEvent, TargetHealthState, Vec3Like } from '../../../contracts/ballistics.ts';
import { copyVec3, length, normalize, scale, sub } from '../../../core/ballistics/vec3.ts';
import type { ArterialFountainStream } from './goreTypes.ts';

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
        f.stumpPos = copyVec3(b.distalPosition || b.position);
        const out = sub(b.distalPosition, b.position);
        if (length(out) > 0.02) {
          f.sprayDir = normalize(scale(out, 1));
        } else {
          f.sprayDir = copyVec3(b.basisUp);
        }
      }
    }

    const pressureDecay = Math.max(0.28, 1.0 - (f.elapsedS / f.durationS) * 0.65);
    const systolicPulse = 1.0 + Math.max(0, Math.sin(f.elapsedS * 11.2)) * 0.95;
    const pulseRate = systolicPulse * pressureDecay;
    if (f.dropTimerS >= 0.11 / Math.max(0.3, pulseRate)) {
      f.dropTimerS = 0;
      const sprayDirNorm = normalize(f.sprayDir);
      onSpawnBloodBurst(f.stumpPos, sprayDirNorm, 48 * pulseRate, 3);
    }

    if (f.elapsedS >= f.durationS) {
      arterialFountains.splice(i, 1);
    }
  }
}
