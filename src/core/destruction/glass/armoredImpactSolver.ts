import { createDeterministicPrng } from '../glassMarchingTiles.ts';
import {
  ARMORED_CHUNK_CRAZED,
  ARMORED_CHUNK_DETACHED,
  ARMORED_CHUNK_FRACTURED,
  ARMORED_CHUNK_PRISTINE,
  type ArmoredVoronoiImpactOptions,
  type ArmoredVoronoiImpactReport,
} from './glassShardTypes.ts';
import { pointToConvexPolygonDistance2D } from './polygonMath2D.ts';
import type { ArmoredVoronoiGlassPane } from './armoredGlassState.ts';
import { runArmoredBfsDetachment, propagateTendrilDamage } from './armoredBfsSolver.ts';

export function applyArmoredImpact(
  pane: ArmoredVoronoiGlassPane,
  options: ArmoredVoronoiImpactOptions,
): ArmoredVoronoiImpactReport {
  const hitX = Math.max(0, Math.min(pane.widthM, options.hitX));
  const hitY = Math.max(0, Math.min(pane.heightM, options.hitY));
  const energyJ = Math.max(0, options.energyJ);
  const requestedRadiusM = options.radiusM ?? 0.04;
  const isBlastOrHeavyBreach = energyJ >= 4500 || requestedRadiusM >= 0.20;

  const hitIdx = pane.findChunkAt(hitX, hitY);
  if (hitIdx < 0) {
    return makeReport(pane, [], 0, true);
  }

  if (pane.stage[hitIdx] === ARMORED_CHUNK_DETACHED && !isBlastOrHeavyBreach) {
    return makeReport(pane, [], 0, true);
  }

  if (pane.stage[hitIdx] === ARMORED_CHUNK_DETACHED && isBlastOrHeavyBreach) {
    let touchesAnySurviving = false;
    for (let i = 0; i < pane.chunks.length; i++) {
      if (pane.stage[i] === ARMORED_CHUNK_DETACHED) continue;
      if (pointToConvexPolygonDistance2D(pane.chunks[i].polygon, hitX, hitY) <= requestedRadiusM) {
        touchesAnySurviving = true;
        break;
      }
    }
    if (!touchesAnySurviving) {
      return makeReport(pane, [], 0, true);
    }
  }

  pane.impactCounter++;
  const rand = createDeterministicPrng(
    options.seed ??
      ((Math.round(hitX * 1000) * 73856093) ^
        (Math.round(hitY * 1000) * 19349663) ^
        (pane.impactCounter * 83492791) ^
        Math.round(energyJ * 11)),
  );

  const newlyDetached: number[] = [];
  let chunksCrazed = 0;

  const detachChunk = (idx: number): void => {
    if (idx < 0 || idx >= pane.chunks.length || pane.stage[idx] === ARMORED_CHUNK_DETACHED) return;
    pane.stage[idx] = ARMORED_CHUNK_DETACHED;
    pane.integrity[idx] = 0;
    pane.crazedIntensity[idx] = 1;
    pane.survivingCount--;
    newlyDetached.push(idx);
  };

  const damageChunk = (idx: number, dmg: number, allowDetach: boolean, fx: number, fy: number): void => {
    if (idx < 0 || idx >= pane.chunks.length || dmg <= 0) return;
    const prevStage = pane.stage[idx];
    if (prevStage === ARMORED_CHUNK_DETACHED) return;

    const minAllowed = allowDetach ? 0 : 0.14;
    const nextIntegrity = Math.max(minAllowed, pane.integrity[idx] - dmg);
    pane.integrity[idx] = nextIntegrity;
    pane.crazedIntensity[idx] = Math.min(1, Math.max(pane.crazedIntensity[idx], 1 - nextIntegrity));
    pane.focusX[idx] = pane.focusX[idx] * 0.45 + fx * 0.55;
    pane.focusY[idx] = pane.focusY[idx] * 0.45 + fy * 0.55;

    if (nextIntegrity <= 0.001 && allowDetach) {
      detachChunk(idx);
      return;
    }

    const nextStage =
      nextIntegrity <= 0.56
        ? ARMORED_CHUNK_FRACTURED
        : nextIntegrity < 0.96
          ? ARMORED_CHUNK_CRAZED
          : ARMORED_CHUNK_PRISTINE;
    pane.stage[idx] = nextStage;
    if (prevStage === ARMORED_CHUNK_PRISTINE && nextStage !== ARMORED_CHUNK_PRISTINE) {
      chunksCrazed++;
    }
  };

  const diagM = Math.hypot(pane.widthM, pane.heightM);
  const isRifle = energyJ >= 1350 || (options.isArmorPiercing === true && energyJ >= 950);

  if (isBlastOrHeavyBreach) {
    const blastR = Math.max(0.22, requestedRadiusM);
    for (let i = 0; i < pane.chunks.length; i++) {
      if (pane.stage[i] === ARMORED_CHUNK_DETACHED) continue;
      const dist = pointToConvexPolygonDistance2D(pane.chunks[i].polygon, hitX, hitY);
      if (dist <= blastR * (0.86 + rand() * 0.26)) {
        detachChunk(i);
      } else if (dist <= blastR * 1.85) {
        damageChunk(i, 0.35 + (1 - dist / (blastR * 1.85)) * 0.52, false, hitX, hitY);
      }
    }
  } else if (isRifle) {
    if (pane.stage[hitIdx] === ARMORED_CHUNK_PRISTINE) {
      detachChunk(hitIdx);
      for (const nIdx of pane.chunks[hitIdx].neighbors) {
        if (pane.stage[nIdx] !== ARMORED_CHUNK_DETACHED && pointToConvexPolygonDistance2D(pane.chunks[nIdx].polygon, hitX, hitY) <= 0.022) {
          detachChunk(nIdx);
        }
      }
      const haloR = Math.min(diagM * 0.38, 0.34 + Math.min(1, (energyJ - 1350) / 2400) * 0.16);
      for (let i = 0; i < pane.chunks.length; i++) {
        if (pane.stage[i] === ARMORED_CHUNK_DETACHED) continue;
        const dist = Math.hypot(pane.chunks[i].centroid.x - hitX, pane.chunks[i].centroid.y - hitY);
        if (dist <= haloR) {
          damageChunk(i, (0.24 + (1 - dist / haloR) * 0.56) * (0.88 + rand() * 0.24), false, hitX, hitY);
        }
      }
    } else {
      detachChunk(hitIdx);
      const shearR = Math.min(diagM * 0.24, 0.24 + (energyJ / 3600) * 0.08);
      for (let i = 0; i < pane.chunks.length; i++) {
        if (pane.stage[i] === ARMORED_CHUNK_DETACHED) continue;
        const dist = pointToConvexPolygonDistance2D(pane.chunks[i].polygon, hitX, hitY);
        if (dist <= shearR) {
          damageChunk(i, 0.52 + (1 - dist / shearR) * 0.48, true, hitX, hitY);
        } else if (dist <= shearR * 1.9) {
          damageChunk(i, 0.22 + (1 - dist / (shearR * 1.9)) * 0.35, false, hitX, hitY);
        }
      }
    }
  } else {
    const eNorm = Math.min(1, energyJ / 1350);
    damageChunk(hitIdx, 0.40 + eNorm * 0.32, true, hitX, hitY);
    const haloR = Math.min(diagM * 0.28, 0.22 + eNorm * 0.14);
    for (let i = 0; i < pane.chunks.length; i++) {
      if (i === hitIdx || pane.stage[i] === ARMORED_CHUNK_DETACHED) continue;
      const dist = pointToConvexPolygonDistance2D(pane.chunks[i].polygon, hitX, hitY);
      if (dist <= haloR) {
        const falloff = 1 - dist / haloR;
        const dmg = (0.18 + falloff * (0.22 + eNorm * 0.18)) * (0.88 + rand() * 0.24);
        damageChunk(i, dmg, pane.stage[i] === ARMORED_CHUNK_FRACTURED && dist <= haloR * 0.38, hitX, hitY);
      }
    }
  }

  propagateTendrilDamage(pane, hitIdx, hitX, hitY, rand, damageChunk);
  if (newlyDetached.length > 0 && pane.survivingCount > 0) {
    runArmoredBfsDetachment(pane, detachChunk);
  }

  return makeReport(pane, newlyDetached, chunksCrazed, false);
}

function makeReport(
  pane: ArmoredVoronoiGlassPane,
  detached: number[],
  crazed: number,
  alreadyBroken: boolean,
): ArmoredVoronoiImpactReport {
  return {
    alreadyBrokenHole: alreadyBroken,
    newlyDetachedIndices: detached,
    chunksCrazed: crazed,
    survivingChunkCount: pane.survivingChunkCount,
    detachedChunkCount: pane.detachedChunkCount,
  };
}
