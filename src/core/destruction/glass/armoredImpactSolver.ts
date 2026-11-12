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

export interface ArmoredBallisticDamageProfile {
  readonly coreDamage: number;
  readonly haloRadiusM: number;
  readonly effectivePenetrationJ: number;
  readonly velocityFactor: number;
  readonly apMultiplier: number;
}

/**
 * Evaluates realistic multi-ply glass + polycarbonate interlayer resistance (BR6/BR7 class).
 * Defeating armored laminated glass requires BOTH high impact velocity (strain-rate shear above ~750 m/s)
 * AND high punching power (kinetic energy + hardened AP penetrator construction).
 */
export function computeArmoredBallisticDamage(
  energyJ: number,
  speedMs?: number,
  isArmorPiercing = false,
  armorPenetrationFactor?: number,
): ArmoredBallisticDamageProfile {
  const safeEnergyJ = Math.max(0, energyJ);
  const resolvedSpeedMs =
    speedMs !== undefined
      ? Math.max(0, speedMs)
      : safeEnergyJ >= 2800
        ? 805
        : safeEnergyJ >= 1450
          ? 780
          : 395;

  const vt = Math.max(0, Math.min(1, (resolvedSpeedMs - 360) / (860 - 360)));
  const velocityFactor = 0.35 + 0.67 * (vt * vt * (3 - 2 * vt));

  const apMultiplier =
    armorPenetrationFactor !== undefined
      ? Math.max(0.56, Math.min(1.42, 0.36 + armorPenetrationFactor * 0.44))
      : isArmorPiercing
        ? safeEnergyJ >= 3800
          ? 1.38
          : 1.03
        : 0.68;

  const effectivePenetrationJ = safeEnergyJ * velocityFactor * apMultiplier;
  const rawDamage = effectivePenetrationJ / 3850;
  const coreDamage = safeEnergyJ <= 0 ? 0 : Math.max(0.06, rawDamage);
  const haloRadiusM = 0.16 + Math.min(0.28, Math.sqrt(safeEnergyJ) * 0.0042);

  return {
    coreDamage,
    haloRadiusM,
    effectivePenetrationJ,
    velocityFactor,
    apMultiplier,
  };
}

export function applyArmoredImpact(
  pane: ArmoredVoronoiGlassPane,
  options: ArmoredVoronoiImpactOptions,
): ArmoredVoronoiImpactReport {
  const hitX = Math.max(0, Math.min(pane.widthM, options.hitX));
  const hitY = Math.max(0, Math.min(pane.heightM, options.hitY));
  const energyJ = Math.max(0, options.energyJ);
  const requestedRadiusM = options.radiusM ?? 0.04;
  const bluntImpactOnly = options.bluntImpactOnly === true;
  const isBlastOrHeavyBreach =
    !bluntImpactOnly &&
    (options.isBlast === true || (options.speedMs === undefined && energyJ >= 4500) || requestedRadiusM >= 0.22);

  const hitIdx = pane.findChunkAt(hitX, hitY);
  if (hitIdx < 0) {
    return makeReport(pane, [], 0, true, false, 0, 0);
  }

  const chunkIntegrityBefore = pane.integrity[hitIdx];

  if (pane.stage[hitIdx] === ARMORED_CHUNK_DETACHED && !isBlastOrHeavyBreach) {
    return makeReport(pane, [], 0, true, false, 0, 0);
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
      return makeReport(pane, [], 0, true, false, 0, 0);
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
    if (bluntImpactOnly) return;
    if (idx < 0 || idx >= pane.chunks.length || pane.stage[idx] === ARMORED_CHUNK_DETACHED) return;
    pane.stage[idx] = ARMORED_CHUNK_DETACHED;
    pane.integrity[idx] = 0;
    pane.crazedIntensity[idx] = 1;
    pane.survivingCount--;
    newlyDetached.push(idx);
  };

  const damageChunk = (
    idx: number,
    dmg: number,
    allowDetach: boolean,
    fx: number,
    fy: number,
    minVisualCraze = 0,
  ): void => {
    if (idx < 0 || idx >= pane.chunks.length || dmg <= 0) return;
    const prevStage = pane.stage[idx];
    if (prevStage === ARMORED_CHUNK_DETACHED) return;

    const canDetach = allowDetach && !bluntImpactOnly;
    const minAllowed = canDetach ? 0 : 0.16;
    const nextIntegrity = Math.max(minAllowed, pane.integrity[idx] - dmg);
    pane.integrity[idx] = nextIntegrity;
    pane.crazedIntensity[idx] = Math.min(
      1,
      Math.max(pane.crazedIntensity[idx], minVisualCraze, 1 - nextIntegrity),
    );
    pane.focusX[idx] = pane.focusX[idx] * 0.45 + fx * 0.55;
    pane.focusY[idx] = pane.focusY[idx] * 0.45 + fy * 0.55;

    if (nextIntegrity <= 0.001 && canDetach) {
      detachChunk(idx);
      return;
    }

    const nextStage =
      nextIntegrity <= 0.56
        ? ARMORED_CHUNK_FRACTURED
        : nextIntegrity < 0.995
          ? ARMORED_CHUNK_CRAZED
          : ARMORED_CHUNK_PRISTINE;
    pane.stage[idx] = nextStage;
    if (prevStage === ARMORED_CHUNK_PRISTINE && nextStage !== ARMORED_CHUNK_PRISTINE) {
      chunksCrazed++;
    }
  };

  const diagM = Math.hypot(pane.widthM, pane.heightM);

  if (bluntImpactOnly) {
    // Blunt impact (e.g. thrown grenade): visually fractures/crazes laminate in-place with ZERO detached chunks
    const crazeR = Math.min(diagM * 0.34, Math.max(0.22, requestedRadiusM));
    damageChunk(hitIdx, 0.52, false, hitX, hitY, 0.58);
    for (let i = 0; i < pane.chunks.length; i++) {
      if (i === hitIdx || pane.stage[i] === ARMORED_CHUNK_DETACHED) continue;
      const dist = pointToConvexPolygonDistance2D(pane.chunks[i].polygon, hitX, hitY);
      if (dist <= crazeR) {
        const falloff = 1 - dist / crazeR;
        const dmg = (0.16 + falloff * 0.34) * (0.88 + rand() * 0.24);
        damageChunk(i, dmg, false, hitX, hitY, 0.28 + falloff * 0.28);
      }
    }
  } else if (isBlastOrHeavyBreach) {
    const blastR = Math.max(0.22, requestedRadiusM);
    for (let i = 0; i < pane.chunks.length; i++) {
      if (pane.stage[i] === ARMORED_CHUNK_DETACHED) continue;
      const dist = pointToConvexPolygonDistance2D(pane.chunks[i].polygon, hitX, hitY);
      if (dist <= blastR * (0.86 + rand() * 0.26)) {
        detachChunk(i);
      } else if (dist <= blastR * 1.85) {
        damageChunk(i, 0.35 + (1 - dist / (blastR * 1.85)) * 0.52, false, hitX, hitY, 0.35);
      }
    }
  } else {
    const profile = computeArmoredBallisticDamage(
      energyJ,
      options.speedMs,
      options.isArmorPiercing,
      options.armorPenetrationFactor,
    );

    damageChunk(hitIdx, profile.coreDamage, true, hitX, hitY, 0.36);

    // Polycarbonate interlayer retains surrounding fractured glass in-place (allowDetach = false)
    const haloR = Math.min(diagM * 0.35, profile.haloRadiusM);
    for (let i = 0; i < pane.chunks.length; i++) {
      if (i === hitIdx || pane.stage[i] === ARMORED_CHUNK_DETACHED) continue;
      const dist = pointToConvexPolygonDistance2D(pane.chunks[i].polygon, hitX, hitY);
      if (dist <= haloR) {
        const falloff = 1 - dist / haloR;
        const haloDmg = (0.10 + falloff * Math.min(0.42, profile.coreDamage * 0.48)) * (0.88 + rand() * 0.24);
        damageChunk(i, haloDmg, false, hitX, hitY, 0.24 + falloff * 0.22);
      }
    }
  }

  propagateTendrilDamage(pane, hitIdx, hitX, hitY, rand, (idx, dmg, _allow, fx, fy) =>
    damageChunk(idx, dmg, false, fx, fy, 0.24),
  );
  if (!bluntImpactOnly && newlyDetached.length > 0 && pane.survivingCount > 0) {
    runArmoredBfsDetachment(pane, detachChunk);
  }

  const perforatedHitChunk = pane.stage[hitIdx] === ARMORED_CHUNK_DETACHED;
  const chunkIntegrityAfter = pane.integrity[hitIdx];
  return makeReport(
    pane,
    newlyDetached,
    chunksCrazed,
    false,
    perforatedHitChunk,
    chunkIntegrityBefore,
    chunkIntegrityAfter,
  );
}

function makeReport(
  pane: ArmoredVoronoiGlassPane,
  detached: number[],
  crazed: number,
  alreadyBroken: boolean,
  perforatedHitChunk: boolean,
  chunkIntegrityBefore: number,
  chunkIntegrityAfter: number,
): ArmoredVoronoiImpactReport {
  return {
    alreadyBrokenHole: alreadyBroken,
    perforatedHitChunk,
    chunkIntegrityBefore,
    chunkIntegrityAfter,
    newlyDetachedIndices: detached,
    chunksCrazed: crazed,
    survivingChunkCount: pane.survivingChunkCount,
    detachedChunkCount: pane.detachedChunkCount,
  };
}
