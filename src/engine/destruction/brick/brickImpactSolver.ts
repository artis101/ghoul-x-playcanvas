import type * as RAPIER from '@dimforge/rapier3d-compat';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type {
  BallisticPenetrationResult,
  BallisticSegmentImpact,
  BlastEvent,
  ChunkConnectivityNode,
} from '../../../contracts/destruction.ts';
import {
  findDetachedChunkIndices,
  findDetachedSubgraphs,
  localToWorldPoint,
  rotateVec3ByQuat,
  severEdgesAtPoint,
  severEdgesFromBlast,
  worldToLocalPoint,
} from '../../../core/destruction/connectivityGraph.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import {
  convertBrickIslandToCompoundBody,
  convertBrickToDynamicBody,
} from './brickColliders.ts';
import type { BrickDynamicPool } from './brickDynamicPool.ts';
import {
  BRICK_HEAVY_PENETRATOR_THRESHOLD_J,
  BrickPhase,
  type BrickWallInstanceState,
  IDENTITY_QUAT,
} from './brickWallTypes.ts';

const LOOSE_BRICK_DEFLECTION_LOSS_J = 180;

function normalizeDir(dir: Vec3Like): Vec3Like {
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (len <= 1e-8) {
    return { x: 0, y: 0, z: -1 };
  }
  return { x: dir.x / len, y: dir.y / len, z: dir.z / len };
}

function severDirectHitBrickBonds(
  wall: BrickWallInstanceState,
  brickIdx: number,
  kineticEnergyJ: number
): void {
  const nodes = (wall.graph.nodes ?? []) as ChunkConnectivityNode[];
  if (brickIdx < 0 || brickIdx >= nodes.length) return;
  const node = nodes[brickIdx];
  if (node.isAnchored && kineticEnergyJ >= 1800) {
    node.isAnchored = false;
  }
  for (let e = 0; e < node.edges.length; e++) {
    const edge = node.edges[e];
    edge.severed = true;
    const neighbor = nodes[edge.neighborIndex];
    if (!neighbor) continue;
    for (let k = 0; k < neighbor.edges.length; k++) {
      if (neighbor.edges[k].neighborIndex === brickIdx) {
        neighbor.edges[k].severed = true;
        break;
      }
    }
  }
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

  const dirNorm = normalizeDir(seg.directionWorld);
  const hitChunkIdx = matchedHit.surface.chunkIndex ?? -1;
  const hitPhase =
    hitChunkIdx >= 0
      ? (matchedWall.brickPhase[hitChunkIdx] as BrickPhase)
      : BrickPhase.INTACT_STATIC;
  const isAlreadyDetachedBrick =
    hitChunkIdx >= 0 &&
    (hitPhase !== BrickPhase.INTACT_STATIC || matchedWall.graph.detached[hitChunkIdx] === 1);

  dynamicPool.spawnMortarChips(
    matchedHit.pointWorld,
    matchedHit.normalWorld,
    seg.kineticEnergyJ > BRICK_HEAVY_PENETRATOR_THRESHOLD_J ? 9 : 5,
    seg.kineticEnergyJ > BRICK_HEAVY_PENETRATOR_THRESHOLD_J ? 1.25 : 0.75,
    nextRandom
  );

  if (isAlreadyDetachedBrick) {
    const dynBodyHandle = matchedWall.dynamicBodyHandles[hitChunkIdx];
    if (dynBodyHandle >= 0) {
      const body = rapierWorld.world.getRigidBody(dynBodyHandle) as RAPIER.RigidBody | undefined;
      if (body) {
        const kickNs = Math.min(18, 2.5 + seg.kineticEnergyJ * 0.004);
        body.applyImpulse(
          { x: dirNorm.x * kickNs, y: dirNorm.y * kickNs + 1.2, z: dirNorm.z * kickNs },
          true
        );
      }
    }
    const remJ = Math.max(0, seg.kineticEnergyJ - LOOSE_BRICK_DEFLECTION_LOSS_J);
    const stopped = remJ <= 25;
    const ratio = seg.kineticEnergyJ > 1e-6 ? remJ / seg.kineticEnergyJ : 0;
    return {
      remainingEnergyJ: stopped ? 0 : remJ,
      remainingSpeedMs: stopped ? 0 : seg.speedMs * Math.sqrt(Math.max(0, ratio)),
      stopped,
      impactPointWorld: matchedHit.pointWorld,
      impactNormalWorld: matchedHit.normalWorld,
      hitMaterial: 'BRICK_MASONRY',
    };
  }

  if (seg.kineticEnergyJ > BRICK_HEAVY_PENETRATOR_THRESHOLD_J) {
    const localImpact = worldToLocalPoint(matchedHit.pointWorld, matchedWall.transform);
    const localOrigin = worldToLocalPoint(seg.originWorld, matchedWall.transform);
    const exitLocalZ = localOrigin.z >= 0 ? -1 : 1;
    const rot = matchedWall.transform.rotation ?? IDENTITY_QUAT;
    const wallExitNormal = rotateVec3ByQuat({ x: 0, y: 0, z: exitLocalZ }, rot);
    const severRadius = Math.max(matchedWall.brickW * 0.85, matchedWall.brickH * 1.65);

    severEdgesAtPoint(
      matchedWall.graph,
      localImpact,
      seg.kineticEnergyJ * 1.25,
      severRadius
    );
    severDirectHitBrickBonds(matchedWall, hitChunkIdx, seg.kineticEnergyJ);

    const subgraphs = findDetachedSubgraphs(matchedWall.graph, undefined, 10);

    for (let i = 0; i < subgraphs.length; i++) {
      const island = subgraphs[i];
      const brickIdx = island[0];
      const isPrimaryHit = island.length === 1 && brickIdx === hitChunkIdx;
      const speedKick = isPrimaryHit
        ? Math.min(9.5, 3.0 + (seg.kineticEnergyJ - BRICK_HEAVY_PENETRATOR_THRESHOLD_J) * 0.0022)
        : 2.2;

      const linVel: Vec3Like = isPrimaryHit
        ? {
            x: dirNorm.x * speedKick + (nextRandom() - 0.5) * 0.9,
            y: dirNorm.y * speedKick + 0.15 + nextRandom() * 0.25,
            z: dirNorm.z * speedKick + (nextRandom() - 0.5) * 0.9,
          }
        : {
            x: wallExitNormal.x * speedKick + (nextRandom() - 0.5) * 0.45,
            y: -0.25,
            z: wallExitNormal.z * speedKick + (nextRandom() - 0.5) * 0.45,
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

      const clearDistM = matchedWall.brickD * (isPrimaryHit ? 1.08 : 1.02);
      const spawnOffset: Vec3Like = {
        x: wallExitNormal.x * clearDistM,
        y: 0,
        z: wallExitNormal.z * clearDistM,
      };

      convertBrickIslandToCompoundBody(
        matchedWall,
        island,
        linVel,
        angVel,
        rapierWorld,
        dynamicPool,
        spawnOffset
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
    const subgraphs = findDetachedSubgraphs(wall.graph, undefined, 10);
    if (subgraphs.length === 0) {
      continue;
    }

    anyBrickDetached = true;
    const localBlast = worldToLocalPoint(blast.centerWorld, wall.transform);
    const awayLocalZ = localBlast.z >= 0 ? -1 : 1;
    const rot = wall.transform.rotation ?? IDENTITY_QUAT;
    const wallAwayWorld = rotateVec3ByQuat({ x: 0, y: 0, z: awayLocalZ }, rot);
    const nodes = wall.graph.nodes ?? (wall.graph as { chunks?: ChunkConnectivityNode[] }).chunks ?? [];
    let totalDetachedCount = 0;

    for (let i = 0; i < subgraphs.length; i++) {
      const island = subgraphs[i];
      totalDetachedCount += island.length;
      const brickIdx = island[0];
      const node = nodes[brickIdx];
      const worldPos = localToWorldPoint(node.localCenter, wall.transform);

      const dx = worldPos.x - blast.centerWorld.x;
      const dy = worldPos.y - blast.centerWorld.y;
      const dz = worldPos.z - blast.centerWorld.z;
      const dist = Math.hypot(dx, dy, dz);

      let linVel: Vec3Like;
      let angVel: Vec3Like;
      const outPush = 1.6 + nextRandom() * 0.9;

      if (dist <= blast.radiusM * 1.15) {
        const falloff = Math.max(0.12, 1 - dist / (blast.radiusM * 1.15));
        const speed = Math.min(
          18,
          Math.max(3.2 * falloff, (blast.peakImpulseNs / Math.max(0.4, node.massKg)) * falloff)
        );
        const invD = dist > 1e-4 ? 1 / dist : 0;
        const rx = dist > 1e-4 ? dx * invD : 0;
        const ry = dist > 1e-4 ? dy * invD : 1;
        const rz = dist > 1e-4 ? dz * invD : 0;

        linVel = {
          x: rx * speed + wallAwayWorld.x * outPush,
          y: Math.max(0.85, (ry + 0.45) * speed * 0.85),
          z: rz * speed + wallAwayWorld.z * outPush,
        };
        angVel = {
          x: (-rz + (nextRandom() - 0.5)) * speed * 0.85,
          y: (nextRandom() - 0.5) * speed * 0.9,
          z: (rx + (nextRandom() - 0.5)) * speed * 0.85,
        };
      } else {
        const sideSign = i % 2 === 0 ? 1 : -1;
        linVel = {
          x: wallAwayWorld.x * (1.25 * sideSign) + (nextRandom() - 0.5) * 0.6,
          y: -0.25,
          z: wallAwayWorld.z * (1.25 * sideSign) + (nextRandom() - 0.5) * 0.6,
        };
        angVel = {
          x: (nextRandom() - 0.5) * 2.4,
          y: (nextRandom() - 0.5) * 1.6,
          z: (nextRandom() - 0.5) * 2.4,
        };
      }

      const blastClearDistM = wall.brickD * 0.95;
      convertBrickIslandToCompoundBody(
        wall,
        island,
        linVel,
        angVel,
        rapierWorld,
        dynamicPool,
        {
          x: wallAwayWorld.x * blastClearDistM,
          y: 0,
          z: wallAwayWorld.z * blastClearDistM,
        }
      );
    }

    dynamicPool.spawnMortarChips(
      blast.centerWorld,
      { x: 0, y: 1, z: 0 },
      Math.min(20, totalDetachedCount * 2),
      1.7,
      nextRandom
    );
  }

  if (anyBrickDetached) {
    dynamicPool.uploadAllVariantPools();
  }
}
