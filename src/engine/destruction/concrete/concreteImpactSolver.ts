import * as RAPIER from '@dimforge/rapier3d-compat';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type {
  BallisticPenetrationResult,
  BallisticSegmentImpact,
  BlastEvent,
  ColliderSurfaceTag,
} from '../../../contracts/destruction.ts';
import {
  findDetachedChunkIndices,
  localToWorldPoint,
  severEdgesFromBlast,
} from '../../../core/destruction/connectivityGraph.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import type { PomCraterDecalSystem } from '../pomCraterDecals.ts';
import type { ConcreteDynamicChunkPool } from './concreteDynamicPool.ts';
import {
  type ConcreteWallInstanceState,
  IDENTITY_QUAT,
} from './concreteWallTypes.ts';

export function createStaticChunkColliders(
  wall: ConcreteWallInstanceState,
  rapierWorld: RapierPhysicsWorld
): void {
  const chunks = wall.voronoiData.chunks;
  const rot = wall.transform.rotation ?? IDENTITY_QUAT;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const worldCenter = localToWorldPoint(chunk.localCenter, wall.transform);
    const tag: ColliderSurfaceTag = {
      material: 'CONCRETE_INTACT',
      objectId: wall.wallId,
      chunkIndex: i,
      thicknessM: wall.voronoiData.depth,
      penetrationResistanceJ: 14000,
    };

    let handle = -1;
    const hullDesc =
      chunk.hullVertices.length >= 9
        ? RAPIER.ColliderDesc.convexHull(chunk.hullVertices)
        : null;

    if (hullDesc !== null) {
      hullDesc
        .setTranslation(worldCenter.x, worldCenter.y, worldCenter.z)
        .setRotation(rot)
        .setRestitution(0.15)
        .setFriction(0.75);
      const collider = rapierWorld.world.createCollider(hullDesc);
      rapierWorld.setSurfaceTag(collider.handle, tag);
      handle = collider.handle;
    } else {
      handle = rapierWorld.createStaticBox(
        worldCenter,
        chunk.halfExtents,
        rot,
        tag
      );
    }

    wall.staticColliderHandles[i] = handle;
    wall.dynamicBodyHandles[i] = -1;
  }
}

export function rebuildWallMultiDraw(wall: ConcreteWallInstanceState): void {
  const subDraws = wall.voronoiData.combinedBuffer.subDraws;
  const detached = wall.graph.detached;
  const cmd = wall.drawCommands;

  let activeSlot = 0;
  for (let i = 0; i < subDraws.length; i++) {
    if (detached[i] === 0) {
      const range = subDraws[i];
      if (cmd && range.indexCount > 0) {
        cmd.add(activeSlot, range.indexCount, 1, range.firstIndex, 0);
      }
      activeSlot++;
    }
  }

  wall.activeIntactChunkCount = activeSlot;
  wall.detachedChunkCount = subDraws.length - activeSlot;

  if (cmd) {
    cmd.update(activeSlot);
  }
  wall.intactEntity.enabled = activeSlot > 0;
}

export function handleConcreteRaySegment(
  seg: BallisticSegmentImpact,
  wallsById: Map<string, ConcreteWallInstanceState>,
  rapierWorld: RapierPhysicsWorld,
  pomDecals: PomCraterDecalSystem
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
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    if (
      (h.surface.material === 'CONCRETE_INTACT' ||
        h.surface.material === 'CONCRETE_CHUNKS') &&
      wallsById.has(h.surface.objectId)
    ) {
      matchedHit = h;
      break;
    }
  }

  if (!matchedHit) {
    return null;
  }

  pomDecals.spawnCraterImpact(
    matchedHit.pointWorld,
    matchedHit.normalWorld,
    seg.directionWorld,
    seg.kineticEnergyJ,
    seg.caliberRadiusM
  );

  return {
    remainingEnergyJ: 0,
    remainingSpeedMs: 0,
    stopped: true,
    impactPointWorld: matchedHit.pointWorld,
    impactNormalWorld: matchedHit.normalWorld,
    hitMaterial: matchedHit.surface.material,
  };
}

export function applyConcreteBlast(
  blast: BlastEvent,
  wallsById: Map<string, ConcreteWallInstanceState>,
  dynamicPool: ConcreteDynamicChunkPool,
  pomDecals: PomCraterDecalSystem,
  nextRandom: () => number
): void {
  if (blast.radiusM <= 0 || blast.peakEnergyJ <= 0) {
    return;
  }

  for (const wall of wallsById.values()) {
    severEdgesFromBlast(wall.graph, wall.transform, blast);
    const newlyDetached = findDetachedChunkIndices(wall.graph);
    if (newlyDetached.length === 0) {
      continue;
    }

    for (let i = 0; i < newlyDetached.length; i++) {
      const chunkIdx = newlyDetached[i];
      const chunk = wall.voronoiData.chunks[chunkIdx];
      const worldPos = localToWorldPoint(chunk.localCenter, wall.transform);

      const dx = worldPos.x - blast.centerWorld.x;
      const dy = worldPos.y - blast.centerWorld.y;
      const dz = worldPos.z - blast.centerWorld.z;
      const dist = Math.hypot(dx, dy, dz);

      let linVel: Vec3Like;
      let angVel: Vec3Like;

      if (dist <= blast.radiusM * 1.2) {
        const falloff = Math.max(0.1, 1 - dist / (blast.radiusM * 1.2));
        const speed = Math.min(
          14,
          (blast.peakImpulseNs / Math.max(1.5, chunk.massKg)) * falloff
        );
        const invD = dist > 1e-4 ? 1 / dist : 0;
        const rx = dist > 1e-4 ? dx * invD : 0;
        const ry = dist > 1e-4 ? dy * invD : 1;
        const rz = dist > 1e-4 ? dz * invD : 0;

        linVel = {
          x: rx * speed,
          y: Math.max(0.75, (ry + 0.4) * speed * 0.85),
          z: rz * speed,
        };
        angVel = {
          x: (-rz + (nextRandom() - 0.5)) * speed * 0.65,
          y: (nextRandom() - 0.5) * speed * 0.7,
          z: (rx + (nextRandom() - 0.5)) * speed * 0.65,
        };
      } else {
        linVel = {
          x: (nextRandom() - 0.5) * 0.35,
          y: -0.25,
          z: (nextRandom() - 0.5) * 0.35,
        };
        angVel = {
          x: (nextRandom() - 0.5) * 1.4,
          y: (nextRandom() - 0.5) * 1.1,
          z: (nextRandom() - 0.5) * 1.4,
        };
      }

      dynamicPool.detachChunkToDynamicPool(wall, chunkIdx, linVel, angVel, wallsById);
    }

    rebuildWallMultiDraw(wall);

    pomDecals.spawnSpallChipBurst(
      blast.centerWorld,
      { x: 0, y: 1, z: 0 },
      { x: 0, y: -1, z: 0 },
      2.1,
      Math.min(24, newlyDetached.length * 3)
    );
  }

  if (dynamicPool.dynamicTopologyDirty) {
    dynamicPool.syncDynamicCombinedMesh(0, true, wallsById);
  }
}

export function releaseWallPhysicsAndDynamicChunks(
  wall: ConcreteWallInstanceState,
  rapierWorld: RapierPhysicsWorld,
  dynamicPool: ConcreteDynamicChunkPool,
  wallsById: Map<string, ConcreteWallInstanceState>
): void {
  for (let i = 0; i < wall.staticColliderHandles.length; i++) {
    const staticCol = wall.staticColliderHandles[i];
    if (staticCol >= 0) {
      rapierWorld.removeCollider(staticCol);
      wall.staticColliderHandles[i] = -1;
    }
    wall.dynamicBodyHandles[i] = -1;
  }

  let removedAny = false;
  for (let i = dynamicPool.activeDynamicChunks.length - 1; i >= 0; i--) {
    if (dynamicPool.activeDynamicChunks[i].wallId === wall.wallId) {
      rapierWorld.removeBody(dynamicPool.activeDynamicChunks[i].bodyHandle);
      dynamicPool.activeDynamicChunks.splice(i, 1);
      removedAny = true;
    }
  }
  if (removedAny) {
    dynamicPool.repackAllDynamicChunkOffsets();
  }
}
