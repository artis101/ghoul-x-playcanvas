import * as pc from 'playcanvas';
import type { TrajectorySample } from '../../../contracts/ballistics.ts';
import { length } from '../../../core/ballistics/vec3.ts';
import { recycleOldestWhenFull, releaseFxEntity } from '../particles/fxEntityPool.ts';
import type { ActiveProjectileFx } from './goreTypes.ts';
import { MAX_LIVE_PROJECTILES, getRifleRoundShockwaveRing, type GoreFxPools } from './goreFxPools.ts';

const scratchLookTarget = new pc.Vec3();
const scratchCurPos = new pc.Vec3();

export function spawnFlyingProjectile(
  pools: GoreFxPools,
  activeProjectiles: ActiveProjectileFx[],
  trajectorySamples: TrajectorySample[],
  isShotgunPellet = false,
): ActiveProjectileFx | null {
  if (!trajectorySamples || trajectorySamples.length < 2) return null;

  recycleOldestWhenFull(activeProjectiles, MAX_LIVE_PROJECTILES);
  const pEntity = (isShotgunPellet ? pools.pellet : pools.rifleRound).acquire();

  if (isShotgunPellet) {
    pEntity.setLocalScale(0.015, 0.015, 0.015);
  } else {
    pEntity.setLocalScale(0.016, 0.052, 0.016);
  }

  const firstPos = trajectorySamples[0].position;
  pEntity.setPosition(firstPos.x, firstPos.y, firstPos.z);

  let shockwaveRing: pc.Entity | undefined;
  if (!isShotgunPellet) {
    const ring = getRifleRoundShockwaveRing(pEntity);
    const supersonic = trajectorySamples[0].mach > 1.0;
    if (ring) ring.enabled = supersonic;
    if (supersonic && ring) shockwaveRing = ring;
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
      const inv = 1 / speed;
      scratchLookTarget.set(px + vel.x * inv, py + vel.y * inv, pz + vel.z * inv);
      p.entity.lookAt(scratchLookTarget);
      p.entity.rotateLocal(90, 0, 0);
    }

    scratchCurPos.set(px, py, pz);
    if (
      p.trailPoints.length === 0 ||
      scratchCurPos.distance(p.trailPoints[p.trailPoints.length - 1]) > 0.35
    ) {
      p.trailPoints.push(scratchCurPos.clone());
    }

    if (showTrails && p.trailPoints.length >= 2) {
      for (let ptIdx = 0; ptIdx < p.trailPoints.length - 1; ptIdx++) {
        app.drawLine(p.trailPoints[ptIdx], p.trailPoints[ptIdx + 1], pc.Color.YELLOW, true);
      }
    }

    if (p.progressTimeS >= p.totalFlightTimeS) {
      p.finished = true;
      releaseFxEntity(p.entity);
      activeProjectiles.splice(i, 1);
    }
  }
}
