import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type {
  BallisticPenetrationResult,
  BallisticSegmentImpact,
  BlastEvent,
} from '../../../contracts/destruction.ts';
import {
  findDetachedChunkIndices,
  localToWorldPoint,
  severEdgesAtPoint,
  severEdgesFromBlast,
  worldToLocalPoint,
} from '../../../core/destruction/connectivityGraph.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import { convertBrickToDynamicBody } from './brickColliders.ts';
import type { BrickDynamicPool } from './brickDynamicPool.ts';
import {
  BRICK_HEAVY_PENETRATOR_THRESHOLD_J,
  type BrickWallInstanceState,
} from './brickWallTypes.ts';

function normalizeDir(dir: Vec3Like): Vec3Like {
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (len <= 1e-8) {
    return { x: 0, y: 0, z: -1 };
  }
  return { x: dir.x / len, y: dir.y / len, z: dir.z / len };
}

export function handleBrickRaySegment(
  seg: BallisticSegmentImpact,
  wallsById: Map<string, BrickWallInstanceState>,
  rapierWorld: RapierPhysicsWorld,
  dynamicPool: BrickDynamicPool,
  nextRandom: () => number
): BallisticPenetrationResult | null {
  if (wallsById.size === 0) {
    return null;
  }

  const hits = rapierWorld.castPenetrationRay(
    seg.originWorld,
    seg.directionWorld,
    seg.maxDistanceM
  );

  let matchedHit: (typeof hits)[number] | null = null;
  let matchedWall: BrickWallInstanceState | undefined;
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    if (h.surface.material === 'BRICK_MASONRY') {
      const w = wallsById.get(h.surface.objectId);
      if (w) {
        matchedHit = h;
        matchedWall = w;
        break;
      }
    }
  }

  if (!matchedHit || !matchedWall) {
    return null;
  }

  dynamicPool.spawnMortarChips(
    matchedHit.pointWorld,
    matchedHit.normalWorld,
    seg.kineticEnergyJ > BRICK_HEAVY_PENETRATOR_THRESHOLD_J ? 9 : 5,
    seg.kineticEnergyJ > BRICK_HEAVY_PENETRATOR_THRESHOLD_J ? 1.25 : 0.75,
    nextRandom
  );

  if (seg.kineticEnergyJ > BRICK_HEAVY_PENETRATOR_THRESHOLD_J) {
    const localImpact = worldToLocalPoint(matchedHit.pointWorld, matchedWall.transform);
    const severRadius = Math.max(matchedWall.brickW * 0.85, matchedWall.brickH * 1.75);

    severEdgesAtPoint(
      matchedWall.graph,
      localImpact,
      seg.kineticEnergyJ * 1.45,
      severRadius
    );

    const newlyDetached = findDetachedChunkIndices(matchedWall.graph);
    const dirNorm = normalizeDir(seg.directionWorld);
    const hitChunkIdx = matchedHit.surface.chunkIndex ?? -1;

    for (let i = 0; i < newlyDetached.length; i++) {
      const brickIdx = newlyDetached[i];
      const isPrimaryHit = brickIdx === hitChunkIdx;
      const speedKick = isPrimaryHit
        ? Math.min(9.5, 2.2 + (seg.kineticEnergyJ - BRICK_HEAVY_PENETRATOR_THRESHOLD_J) * 0.0022)
        : 0.45;

      const linVel: Vec3Like = isPrimaryHit
        ? {
            x: dirNorm.x * speedKick + (nextRandom() - 0.5) * 1.2,
            y: dirNorm.y * speedKick + 1.15 + nextRandom() * 0.7,
            z: dirNorm.z * speedKick + (nextRandom() - 0.5) * 1.2,
          }
        : {
            x: dirNorm.x * speedKick + (nextRandom() - 0.5) * 0.35,
            y: -0.15,
            z: dirNorm.z * speedKick + (nextRandom() - 0.5) * 0.35,
          };

      const angVel: Vec3Like = isPrimaryHit
        ? {
            x: (nextRandom() - 0.5) * 11,
            y: (nextRandom() - 0.5) * 11,
            z: (nextRandom() - 0.5) * 11,
          }
        : {
            x: (nextRandom() - 0.5) * 2.2,
            y: (nextRandom() - 0.5) * 2.2,
            z: (nextRandom() - 0.5) * 2.2,
          };

      convertBrickToDynamicBody(
        matchedWall,
        brickIdx,
        linVel,
        angVel,
        rapierWorld,
        dynamicPool
      );
    }

    dynamicPool.uploadAllVariantPools();

    const remainingEnergyJ = Math.max(
      0,
      seg.kineticEnergyJ - BRICK_HEAVY_PENETRATOR_THRESHOLD_J
    );
    const energyRatio =
      seg.kineticEnergyJ > 1e-6 ? remainingEnergyJ / seg.kineticEnergyJ : 0;
    const remainingSpeedMs = seg.speedMs * Math.sqrt(Math.max(0, energyRatio));
    const stopped = remainingEnergyJ <= 25;

    return {
      remainingEnergyJ: stopped ? 0 : remainingEnergyJ,
      remainingSpeedMs: stopped ? 0 : remainingSpeedMs,
      stopped,
      impactPointWorld: matchedHit.pointWorld,
      impactNormalWorld: matchedHit.normalWorld,
      hitMaterial: 'BRICK_MASONRY',
    };
  }

  return {
    remainingEnergyJ: 0,
    remainingSpeedMs: 0,
    stopped: true,
    impactPointWorld: matchedHit.pointWorld,
    impactNormalWorld: matchedHit.normalWorld,
    hitMaterial: 'BRICK_MASONRY',
  };
}

export function applyBrickBlast(
  blast: BlastEvent,
  wallsById: Map<string, BrickWallInstanceState>,
  rapierWorld: RapierPhysicsWorld,
  dynamicPool: BrickDynamicPool,
  nextRandom: () => number
): void {
  if (blast.radiusM <= 0 || blast.peakEnergyJ <= 0) {
    return;
  }

  let anyBrickDetached = false;

  for (const wall of wallsById.values()) {
    severEdgesFromBlast(wall.graph, wall.transform, blast);
    const newlyDetached = findDetachedChunkIndices(wall.graph);
    if (newlyDetached.length === 0) {
      continue;
    }

    anyBrickDetached = true;
    const nodes = wall.graph.nodes ?? (wall.graph as { chunks?: any[] }).chunks ?? [];
    for (let i = 0; i < newlyDetached.length; i++) {
      const brickIdx = newlyDetached[i];
      const node = nodes[brickIdx];
      const worldPos = localToWorldPoint(node.localCenter, wall.transform);

      const dx = worldPos.x - blast.centerWorld.x;
      const dy = worldPos.y - blast.centerWorld.y;
      const dz = worldPos.z - blast.centerWorld.z;
      const dist = Math.hypot(dx, dy, dz);

      let linVel: Vec3Like;
      let angVel: Vec3Like;

      if (dist <= blast.radiusM * 1.15) {
        const falloff = Math.max(0.08, 1 - dist / (blast.radiusM * 1.15));
        const speed = Math.min(
          18,
          (blast.peakImpulseNs / Math.max(0.4, node.massKg)) * falloff
        );
        const invD = dist > 1e-4 ? 1 / dist : 0;
        const rx = dist > 1e-4 ? dx * invD : 0;
        const ry = dist > 1e-4 ? dy * invD : 1;
        const rz = dist > 1e-4 ? dz * invD : 0;

        linVel = {
          x: rx * speed,
          y: Math.max(0.8, (ry + 0.45) * speed * 0.85),
          z: rz * speed,
        };
        angVel = {
          x: (-rz + (nextRandom() - 0.5)) * speed * 0.85,
          y: (nextRandom() - 0.5) * speed * 0.9,
          z: (rx + (nextRandom() - 0.5)) * speed * 0.85,
        };
      } else {
        linVel = {
          x: (nextRandom() - 0.5) * 0.4,
          y: -0.2,
          z: (nextRandom() - 0.5) * 0.4,
        };
        angVel = {
          x: (nextRandom() - 0.5) * 1.6,
          y: (nextRandom() - 0.5) * 1.2,
          z: (nextRandom() - 0.5) * 1.6,
        };
      }

      convertBrickToDynamicBody(
        wall,
        brickIdx,
        linVel,
        angVel,
        rapierWorld,
        dynamicPool
      );
    }

    dynamicPool.spawnMortarChips(
      blast.centerWorld,
      { x: 0, y: 1, z: 0 },
      Math.min(20, newlyDetached.length * 2),
      1.7,
      nextRandom
    );
  }

  if (anyBrickDetached) {
    dynamicPool.uploadAllVariantPools();
  }
}
