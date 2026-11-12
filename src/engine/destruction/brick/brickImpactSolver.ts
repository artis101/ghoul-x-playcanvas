import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type {
  BallisticPenetrationResult,
  BallisticSegmentImpact,
  BlastEvent,
} from '../../../contracts/destruction.ts';
import {
  applyBallisticHitToBrickGrid,
  applyBlastToBrickGrid,
  findBrickAtLocalUV,
  findFirstSolidBrickAlongLocalRay,
  isPlayerPassableInBrickGrid,
} from '../../../core/destruction/brickWallMesh.ts';
import {
  localToWorldPoint,
  rotateVec3ByQuat,
  worldToLocalPoint,
} from '../../../core/destruction/connectivityGraph.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import { syncBrickWallMeshAndState } from './brickColliders.ts';
import type { BrickDynamicPool } from './brickDynamicPool.ts';
import {
  type BrickWallInstanceState,
  IDENTITY_QUAT,
} from './brickWallTypes.ts';

function normalizeDir(dir: Vec3Like): Vec3Like {
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (len <= 1e-8) {
    return { x: 0, y: 0, z: -1 };
  }
  return { x: dir.x / len, y: dir.y / len, z: dir.z / len };
}

export function isBrickWallOpenAlongRay(
  wall: BrickWallInstanceState | undefined,
  rayOriginWorld: Vec3Like,
  unitDirWorld: Vec3Like,
  maxDistM: number,
  fallbackPointWorld?: Vec3Like
): boolean {
  if (!wall) return false;
  if (wall.intactBrickCount <= 0 || wall.lastMeshStats.indexCount <= 0) {
    return true;
  }

  const localOrigin = worldToLocalPoint(rayOriginWorld, wall.transform);
  const localDir = rotateVec3ByQuat(unitDirWorld, wall.invRotation);
  const solidHit = findFirstSolidBrickAlongLocalRay(
    wall.grid,
    localOrigin,
    localDir,
    maxDistM + wall.grid.thicknessM
  );
  if (solidHit !== null) {
    return false;
  }

  if (fallbackPointWorld) {
    const lp = worldToLocalPoint(fallbackPointWorld, wall.transform);
    const u = lp.x + wall.grid.widthM * 0.5;
    const v = lp.y;
    const idx = findBrickAtLocalUV(wall.grid, u, v);
    if (idx >= 0) {
      return wall.grid.hp[idx] <= 0;
    }
  }

  return true;
}

export function isBrickWallPlayerPassable(
  wall: BrickWallInstanceState | undefined,
  worldPoint: Vec3Like,
  playerRadiusM = 0.36
): boolean {
  if (!wall) return false;
  if (wall.intactBrickCount <= 0) return true;
  const localPt = worldToLocalPoint(worldPoint, wall.transform);
  return isPlayerPassableInBrickGrid(wall.grid, localPt.x, playerRadiusM);
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

  const dirNorm = normalizeDir(seg.directionWorld);
  const hits = rapierWorld.castPenetrationRay(
    seg.originWorld,
    dirNorm,
    seg.maxDistanceM
  );

  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    if (h.surface.material !== 'BRICK_MASONRY') continue;
    const wall = wallsById.get(h.surface.objectId);
    if (!wall || wall.intactBrickCount <= 0) continue;

    const localOrigin = worldToLocalPoint(seg.originWorld, wall.transform);
    const localDir = rotateVec3ByQuat(dirNorm, wall.invRotation);
    const solidHit = findFirstSolidBrickAlongLocalRay(
      wall.grid,
      localOrigin,
      localDir,
      seg.maxDistanceM + wall.grid.thicknessM
    );

    // Ray passed cleanly through an open punched-out hole in the brick wall!
    if (!solidHit) {
      continue;
    }

    const outcome = applyBallisticHitToBrickGrid(
      wall.grid,
      solidHit.brickIndex,
      seg.kineticEnergyJ,
      seg.isArmorPiercing,
      solidHit.hitFromFront
    );

    const rot = wall.transform.rotation ?? IDENTITY_QUAT;
    const hitNormalWorld = rotateVec3ByQuat(
      { x: 0, y: 0, z: solidHit.hitFromFront ? 1 : -1 },
      rot
    );
    const hitPointWorld = localToWorldPoint(solidHit.hitLocal, wall.transform);

    // Always emit fine clay & mortar dust chips when a brick suffers impact damage
    const chipCount = outcome.brickBrokeOut ? 11 : seg.kineticEnergyJ >= 1200 ? 7 : 4;
    const chipSpeed = outcome.brickBrokeOut ? 1.35 : seg.kineticEnergyJ >= 1200 ? 1.0 : 0.72;
    dynamicPool.spawnMortarChips(
      hitPointWorld,
      hitNormalWorld,
      chipCount,
      chipSpeed,
      nextRandom
    );

    // When a brick finally shatters out completely, eject kinematic broken-brick chunks out the exit side
    if (outcome.brickBrokeOut && outcome.newlyDestroyedIndices.length > 0) {
      const exitNormalWorld = {
        x: -hitNormalWorld.x,
        y: -hitNormalWorld.y,
        z: -hitNormalWorld.z,
      };
      const maxBursts = Math.min(outcome.newlyDestroyedIndices.length, 6);
      for (let d = 0; d < maxBursts; d++) {
        const bIdx = outcome.newlyDestroyedIndices[d];
        const brickWorld = localToWorldPoint(wall.grid.cells[bIdx].localCenter, wall.transform);
        dynamicPool.spawnBrokenBrickRubble(
          brickWorld,
          d === 0 ? dirNorm : exitNormalWorld,
          d === 0 ? 3 : 2,
          d === 0 ? 1.15 : 0.65,
          nextRandom
        );
      }
    }

    syncBrickWallMeshAndState(wall, rapierWorld);

    const ratio =
      seg.kineticEnergyJ > 1e-6 ? outcome.remainingEnergyJ / seg.kineticEnergyJ : 0;
    const remainingSpeedMs = outcome.stopped
      ? 0
      : seg.speedMs * Math.sqrt(Math.max(0, ratio));

    return {
      remainingEnergyJ: outcome.stopped ? 0 : outcome.remainingEnergyJ,
      remainingSpeedMs,
      stopped: outcome.stopped,
      impactPointWorld: hitPointWorld,
      impactNormalWorld: hitNormalWorld,
      hitMaterial: 'BRICK_MASONRY',
    };
  }

  return null;
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

  for (const wall of wallsById.values()) {
    const localBlast = worldToLocalPoint(blast.centerWorld, wall.transform);
    const outcome = applyBlastToBrickGrid(
      wall.grid,
      localBlast,
      blast.radiusM,
      blast.peakEnergyJ
    );
    if (!outcome.changed) {
      continue;
    }

    const rot = wall.transform.rotation ?? IDENTITY_QUAT;
    const awayLocalZ = localBlast.z >= 0 ? -1 : 1;
    const wallAwayWorld = rotateVec3ByQuat({ x: 0, y: 0, z: awayLocalZ }, rot);

    const destroyedCount = outcome.newlyDestroyedIndices.length;
    const sampleStride = Math.max(1, Math.ceil(destroyedCount / 14));
    for (let i = 0; i < destroyedCount; i += sampleStride) {
      const bIdx = outcome.newlyDestroyedIndices[i];
      const brickWorld = localToWorldPoint(wall.grid.cells[bIdx].localCenter, wall.transform);
      const dx = brickWorld.x - blast.centerWorld.x;
      const dy = brickWorld.y - blast.centerWorld.y;
      const dz = brickWorld.z - blast.centerWorld.z;
      const dist = Math.hypot(dx, dy, dz) || 1;
      const ejectDir: Vec3Like = {
        x: (dx / dist) * 0.65 + wallAwayWorld.x * 0.65,
        y: Math.max(0.25, dy / dist),
        z: (dz / dist) * 0.65 + wallAwayWorld.z * 0.65,
      };
      dynamicPool.spawnBrokenBrickRubble(brickWorld, ejectDir, 2, 1.35, nextRandom);
    }

    dynamicPool.spawnMortarChips(
      blast.centerWorld,
      { x: 0, y: 1, z: 0 },
      Math.min(24, Math.max(6, destroyedCount * 2 + outcome.damagedBrickCount)),
      1.6,
      nextRandom
    );

    syncBrickWallMeshAndState(wall, rapierWorld);
  }
}
