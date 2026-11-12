import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type {
  BallisticPenetrationResult,
  BallisticSegmentImpact,
  BlastEvent,
  PenetrationRayHit,
  QuatLike,
} from '../../../contracts/destruction.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import type { GlassShardPool } from '../../../core/destruction/glassVoronoiShatter.ts';
import type { MarchingTileGlassWindow } from './marchingTileWindow.ts';
import type { VoronoiGlassWindow } from './voronoiGlassWindow.ts';
import {
  INSTANCED_SHARDS_PER_MARCHING_HIT,
  inverseRotateVec3ByQuat,
  rotateVec3ByQuat,
} from './glassSystemTypes.ts';

export function closestPointOnWindowWorld(
  pointWorld: Vec3Like,
  winCenter: Vec3Like,
  winRot: QuatLike,
  widthM: number,
  heightM: number,
): Vec3Like {
  const rel: Vec3Like = {
    x: pointWorld.x - winCenter.x,
    y: pointWorld.y - winCenter.y,
    z: pointWorld.z - winCenter.z,
  };
  const local = inverseRotateVec3ByQuat(rel, winRot);
  const clampedLocal: Vec3Like = {
    x: Math.max(-widthM * 0.5, Math.min(widthM * 0.5, local.x)),
    y: Math.max(-heightM * 0.5, Math.min(heightM * 0.5, local.y)),
    z: 0,
  };
  const clampedWorld = rotateVec3ByQuat(clampedLocal, winRot);
  return {
    x: winCenter.x + clampedWorld.x,
    y: winCenter.y + clampedWorld.y,
    z: winCenter.z + clampedWorld.z,
  };
}

export function handleGlassRaySegment(
  physics: RapierPhysicsWorld,
  marchingWindowMap: Map<string, MarchingTileGlassWindow>,
  voronoiWindowMap: Map<string, VoronoiGlassWindow>,
  voronoiShardPool: GlassShardPool,
  uploadBatchedMesh: () => void,
  seg: BallisticSegmentImpact,
): BallisticPenetrationResult | null {
  if (seg.maxDistanceM <= 0 || seg.kineticEnergyJ <= 0) return null;

  const allHits = physics.castPenetrationRay(seg.originWorld, seg.directionWorld, seg.maxDistanceM);
  const glassHits: PenetrationRayHit[] = [];

  for (let i = 0; i < allHits.length; i++) {
    const h = allHits[i];
    const mat = h.surface.material;
    if (
      (mat === 'GLASS_MARCHING_256' && marchingWindowMap.has(h.surface.objectId)) ||
      (mat === 'GLASS_VORONOI' && voronoiWindowMap.has(h.surface.objectId))
    ) {
      glassHits.push(h);
    }
  }

  if (glassHits.length === 0) return null;

  let remainingEnergyJ = seg.kineticEnergyJ;
  let stopped = false;
  let primaryHit: PenetrationRayHit = glassHits[0];
  let brokeAnyFreshGlass = false;
  let sawMarchingWindowHit = false;

  for (let i = 0; i < glassHits.length; i++) {
    const hit = glassHits[i];
    const mat = hit.surface.material;

    if (mat === 'GLASS_MARCHING_256') {
      const win = marchingWindowMap.get(hit.surface.objectId);
      if (!win) continue;
      sawMarchingWindowHit = true;

      const outcome = win.breakAtWorldPoint(
        hit.pointWorld,
        seg.directionWorld,
        remainingEnergyJ,
        Math.max(0.035, seg.caliberRadiusM * 5.5),
        INSTANCED_SHARDS_PER_MARCHING_HIT,
        seg.isArmorPiercing,
        seg.speedMs,
        seg.armorPenetrationFactor,
        false,
      );
      if (!outcome.alreadyBroken) {
        if (!brokeAnyFreshGlass) {
          primaryHit = hit;
          brokeAnyFreshGlass = true;
        }
        remainingEnergyJ = outcome.stopped
          ? 0
          : Math.max(0, remainingEnergyJ - outcome.energyAbsorbedJ);
        if (outcome.stopped) {
          stopped = true;
        }
        if (outcome.spawnedVoronoiChunks > 0) {
          uploadBatchedMesh();
          voronoiShardPool.clearDirty();
        }
      }
    } else if (mat === 'GLASS_VORONOI') {
      const win = voronoiWindowMap.get(hit.surface.objectId);
      if (!win) continue;

      const outcome = win.shatterAtWorldPoint(
        hit.pointWorld,
        seg.directionWorld,
        remainingEnergyJ,
        Math.max(0.03, seg.caliberRadiusM * 5.0),
      );
      if (!outcome.alreadyShattered) {
        if (!brokeAnyFreshGlass) {
          primaryHit = hit;
          brokeAnyFreshGlass = true;
        }
        remainingEnergyJ = Math.max(0, remainingEnergyJ - outcome.energyAbsorbedJ);
        uploadBatchedMesh();
        voronoiShardPool.clearDirty();
      }
    }

    if (remainingEnergyJ <= 0) {
      remainingEnergyJ = 0;
      stopped = true;
      break;
    }
  }

  if (!brokeAnyFreshGlass && !sawMarchingWindowHit) return null;

  const speedRatio = seg.kineticEnergyJ > 1e-6 ? Math.sqrt(Math.max(0, remainingEnergyJ) / seg.kineticEnergyJ) : 0;
  return {
    remainingEnergyJ,
    remainingSpeedMs: stopped ? 0 : seg.speedMs * speedRatio,
    stopped,
    impactPointWorld: primaryHit.pointWorld,
    impactNormalWorld: primaryHit.normalWorld,
    hitMaterial: primaryHit.surface.material,
  };
}

export function applyGlassRadialBlast(
  blast: BlastEvent,
  marchingWindowMap: Map<string, MarchingTileGlassWindow>,
  voronoiWindowMap: Map<string, VoronoiGlassWindow>,
  voronoiShardPool: GlassShardPool,
  uploadBatchedMesh: () => void,
): void {
  if (blast.radiusM <= 0 || blast.peakEnergyJ <= 0) return;
  voronoiShardPool.applyBlast(blast);

  for (const win of marchingWindowMap.values()) {
    if (win.survivingChunkCount === 0) continue;
    const closest = closestPointOnWindowWorld(blast.centerWorld, win.centerWorld, win.rotationQuat, win.widthM, win.heightM);
    const dx = closest.x - blast.centerWorld.x;
    const dy = closest.y - blast.centerWorld.y;
    const dz = closest.z - blast.centerWorld.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > blast.radiusM) continue;

    const falloff = Math.max(0.15, 1 - dist / blast.radiusM);
    const shockEnergyJ = blast.peakEnergyJ * falloff;
    const blastHoleRadiusM = Math.max(0.24, Math.hypot(win.widthM, win.heightM) * (0.35 + 0.65 * falloff));
    const dir = dist > 1e-4 ? { x: dx / dist, y: dy / dist, z: dz / dist } : rotateVec3ByQuat({ x: 0, y: 0, z: 1 }, win.rotationQuat);
    win.breakAtWorldPoint(
      closest,
      dir,
      shockEnergyJ,
      blastHoleRadiusM,
      INSTANCED_SHARDS_PER_MARCHING_HIT * 2,
      true,
      undefined,
      undefined,
      true,
    );
  }

  let shatteredAnyVoronoi = false;
  for (const win of voronoiWindowMap.values()) {
    if (win.shattered && win.survivingFangCount === 0) continue;
    const closest = closestPointOnWindowWorld(blast.centerWorld, win.centerWorld, win.rotationQuat, win.widthM, win.heightM);
    const dx = closest.x - blast.centerWorld.x;
    const dy = closest.y - blast.centerWorld.y;
    const dz = closest.z - blast.centerWorld.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > blast.radiusM) continue;

    const falloff = Math.max(0.2, 1 - dist / blast.radiusM);
    const shockEnergyJ = blast.peakEnergyJ * falloff;
    const blastRadiusOnPane = Math.max(0.35, Math.hypot(win.widthM, win.heightM) * (0.4 + 0.6 * falloff));
    const dir = dist > 1e-4 ? { x: dx / dist, y: dy / dist, z: dz / dist } : rotateVec3ByQuat({ x: 0, y: 0, z: 1 }, win.rotationQuat);
    const res = win.shatterAtWorldPoint(closest, dir, shockEnergyJ, blastRadiusOnPane);
    if (!res.alreadyShattered) shatteredAnyVoronoi = true;
  }

  if (shatteredAnyVoronoi || voronoiShardPool.dirty) {
    uploadBatchedMesh();
    voronoiShardPool.clearDirty();
  }
}
