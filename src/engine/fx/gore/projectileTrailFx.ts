import * as pc from 'playcanvas';
import type { TrajectorySample } from '../../../contracts/ballistics.ts';
import { length, normalize } from '../../../core/ballistics/vec3.ts';
import type { EngineMaterialPalette } from '../../materials.ts';
import type { ActiveProjectileFx, WetGoreMaterialSuite } from './goreTypes.ts';

export function spawnFlyingProjectile(
  fxRoot: pc.Entity,
  materials: EngineMaterialPalette,
  goreSuite: WetGoreMaterialSuite,
  activeProjectiles: ActiveProjectileFx[],
  trajectorySamples: TrajectorySample[],
  isShotgunPellet = false,
): ActiveProjectileFx | null {
  if (!trajectorySamples || trajectorySamples.length < 2) return null;

  const pEntity = new pc.Entity(isShotgunPellet ? 'PelletProjectile' : 'RifleProjectile');
  pEntity.addComponent('render', {
    type: isShotgunPellet ? 'sphere' : 'capsule',
    material: isShotgunPellet ? materials.copperPelletMat : materials.brassBulletMat,
  });

  if (isShotgunPellet) {
    pEntity.setLocalScale(0.015, 0.015, 0.015);
  } else {
    pEntity.setLocalScale(0.016, 0.052, 0.016);

    const tracerTail = new pc.Entity('ProjectileTracerStreak');
    tracerTail.addComponent('render', {
      type: 'cone',
      material: goreSuite.tracerTailMat,
      castShadows: false,
    });
    tracerTail.setLocalPosition(0, -1.8, 0);
    tracerTail.setLocalEulerAngles(180, 0, 0);
    tracerTail.setLocalScale(0.85, 3.6, 0.85);
    pEntity.addChild(tracerTail);
  }

  const firstPos = trajectorySamples[0].position;
  pEntity.setPosition(firstPos.x, firstPos.y, firstPos.z);
  fxRoot.addChild(pEntity);

  let shockwaveRing: pc.Entity | undefined;
  if (!isShotgunPellet && trajectorySamples[0].mach > 1.0) {
    shockwaveRing = new pc.Entity('MachShockwaveRing');
    shockwaveRing.addComponent('render', {
      type: 'cone',
      material: materials.shockwaveRingMat,
      castShadows: false,
    });
    shockwaveRing.setLocalScale(4.8, 1.4, 4.8);
    pEntity.addChild(shockwaveRing);
  }

  const totalFlightTimeS = Math.max(0.045, trajectorySamples[trajectorySamples.length - 1].timeS);

  const projFx: ActiveProjectileFx = {
    entity: pEntity,
    shockwaveRing,
    trajectorySamples,
    currentSampleIndex: 0,
    progressTimeS: 0,
    totalFlightTimeS,
    finished: false,
    trailPoints: [new pc.Vec3(firstPos.x, firstPos.y, firstPos.z)],
  };

  activeProjectiles.push(projFx);
  return projFx;
}

export function updateProjectiles(
  app: pc.AppBase,
  activeProjectiles: ActiveProjectileFx[],
  dt: number,
  showTrails: boolean,
): void {
  for (let i = activeProjectiles.length - 1; i >= 0; i--) {
    const p = activeProjectiles[i];
    p.progressTimeS += dt;

    const samples = p.trajectorySamples;
    while (
      p.currentSampleIndex < samples.length - 1 &&
      samples[p.currentSampleIndex + 1].timeS <= p.progressTimeS
    ) {
      p.currentSampleIndex++;
    }

    const curSample = samples[p.currentSampleIndex];
    const nextSample = samples[Math.min(samples.length - 1, p.currentSampleIndex + 1)];

    let px = curSample.position.x;
    let py = curSample.position.y;
    let pz = curSample.position.z;

    const segDt = nextSample.timeS - curSample.timeS;
    if (segDt > 1e-6) {
      const factor = Math.min(1.0, (p.progressTimeS - curSample.timeS) / segDt);
      px += (nextSample.position.x - curSample.position.x) * factor;
      py += (nextSample.position.y - curSample.position.y) * factor;
      pz += (nextSample.position.z - curSample.position.z) * factor;
    }

    p.entity.setPosition(px, py, pz);

    const vel = curSample.velocity;
    const speed = length(vel);
    if (speed > 1e-2) {
      const dir = normalize(vel);
      const lookTarget = new pc.Vec3(px + dir.x, py + dir.y, pz + dir.z);
      p.entity.lookAt(lookTarget);
      p.entity.rotateLocal(90, 0, 0);
    }

    const curPosVec = new pc.Vec3(px, py, pz);
    if (
      p.trailPoints.length === 0 ||
      curPosVec.distance(p.trailPoints[p.trailPoints.length - 1]) > 0.35
    ) {
      p.trailPoints.push(curPosVec);
    }

    if (showTrails && p.trailPoints.length >= 2) {
      for (let ptIdx = 0; ptIdx < p.trailPoints.length - 1; ptIdx++) {
        app.drawLine(p.trailPoints[ptIdx], p.trailPoints[ptIdx + 1], pc.Color.YELLOW, true);
      }
    }

    if (p.progressTimeS >= p.totalFlightTimeS) {
      p.finished = true;
      p.entity.destroy();
      activeProjectiles.splice(i, 1);
    }
  }
}
