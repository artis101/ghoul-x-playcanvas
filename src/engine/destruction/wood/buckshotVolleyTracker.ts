import type { QuatLike } from '../../../contracts/destruction.ts';
import {
  BUCKSHOT_VOLLEY_WINDOW_S,
  MAX_PELLETS_PER_VOLLEY,
  type CollectingPelletVolleyState,
  type PelletVolleyImpact,
  type PelletVolleyState,
  type WallInternalState,
} from './woodWallTypes.ts';

export function findBestPelletCluster(
  impacts: readonly PelletVolleyImpact[],
  radiusM: number,
): {
  count: number;
  centerU: number;
  centerV: number;
  maxSpreadM: number;
} {
  const n = impacts.length;
  if (n === 0) return { count: 0, centerU: 0, centerV: 0, maxSpreadM: 0 };

  const rSq = radiusM * radiusM;
  let bestCount = 0;
  let bestCenterU = impacts[0].u;
  let bestCenterV = impacts[0].v;
  let bestMaxSpread = 0;

  let meanU = 0;
  let meanV = 0;
  for (let i = 0; i < n; i++) {
    meanU += impacts[i].u;
    meanV += impacts[i].v;
  }
  meanU /= n;
  meanV /= n;

  for (let seedIdx = -1; seedIdx < n; seedIdx++) {
    let cu = seedIdx < 0 ? meanU : impacts[seedIdx].u;
    let cv = seedIdx < 0 ? meanV : impacts[seedIdx].v;

    for (let iter = 0; iter < 2; iter++) {
      let sumU = 0, sumV = 0, cnt = 0;
      for (let j = 0; j < n; j++) {
        const du = impacts[j].u - cu;
        const dv = impacts[j].v - cv;
        if (du * du + dv * dv <= rSq) {
          sumU += impacts[j].u;
          sumV += impacts[j].v;
          cnt++;
        }
      }
      if (cnt === 0) break;
      cu = sumU / cnt;
      cv = sumV / cnt;
    }

    let finalCnt = 0;
    let maxDistSq = 0;
    for (let j = 0; j < n; j++) {
      const du = impacts[j].u - cu;
      const dv = impacts[j].v - cv;
      const dSq = du * du + dv * dv;
      if (dSq <= rSq) {
        finalCnt++;
        if (dSq > maxDistSq) maxDistSq = dSq;
      }
    }

    if (finalCnt > bestCount || (finalCnt === bestCount && maxDistSq < bestMaxSpread * bestMaxSpread)) {
      bestCount = finalCnt;
      bestCenterU = cu;
      bestCenterV = cv;
      bestMaxSpread = Math.sqrt(maxDistSq);
    }
  }

  return {
    count: bestCount,
    centerU: bestCenterU,
    centerV: bestCenterV,
    maxSpreadM: bestMaxSpread,
  };
}

export function quatAlignUnitXToVector(dx: number, dy: number, dz: number, out: QuatLike): void {
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) {
    out.x = 0; out.y = 0; out.z = 0; out.w = 1;
    return;
  }
  const ux = dx / len, uy = dy / len, uz = dz / len;

  if (ux < -0.9999) {
    out.x = 0; out.y = 1; out.z = 0; out.w = 0;
    return;
  }

  const qx = 0, qy = -uz, qz = uy, qw = 1 + ux;
  const qNorm = Math.hypot(qx, qy, qz, qw);
  out.x = qx / qNorm;
  out.y = qy / qNorm;
  out.z = qz / qNorm;
  out.w = qw / qNorm;
}

export function resetPelletVolley(internal: WallInternalState): void {
  internal.volleyState = { kind: 'IDLE' };
}

export function acquirePelletVolley(
  internal: WallInternalState,
  elapsedSimTimeS: number,
): CollectingPelletVolleyState {
  const cur = internal.volleyState;
  if (
    cur.kind !== 'COLLECTING' ||
    Math.abs(elapsedSimTimeS - cur.simTimeS) > BUCKSHOT_VOLLEY_WINDOW_S ||
    cur.pelletRayCount >= MAX_PELLETS_PER_VOLLEY
  ) {
    const fresh: CollectingPelletVolleyState = {
      kind: 'COLLECTING',
      volleyId: internal.nextVolleyId++,
      simTimeS: elapsedSimTimeS,
      pelletRayCount: 1,
      tier: 'NONE',
      appliedStudDamageHp: 0,
      impacts: [],
      clusterCuts: [],
    };
    internal.volleyState = fresh;
    return fresh;
  }

  cur.pelletRayCount++;
  return cur;
}

export function wasPointCutByCurrentVolley(volley: PelletVolleyState, u: number, v: number): boolean {
  for (let i = 0; i < volley.impacts.length; i++) {
    const imp = volley.impacts[i];
    const du = u - imp.u, dv = v - imp.v;
    if (du * du + dv * dv <= imp.cutRadiusM * imp.cutRadiusM) return true;
  }
  for (let i = 0; i < volley.clusterCuts.length; i++) {
    const cc = volley.clusterCuts[i];
    const du = u - cc.u, dv = v - cc.v;
    if (du * du + dv * dv <= cc.cutRadiusM * cc.cutRadiusM) return true;
  }
  return false;
}
