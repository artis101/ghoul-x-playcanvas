import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type {
  ChunkConnectivityNode,
  ColliderSurfaceTag,
} from '../../../contracts/destruction.ts';
import {
  localToWorldPoint,
  rotateVec3ByQuat,
} from '../../../core/destruction/connectivityGraph.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import type { CompoundBoxChildSpec } from '../../physics/rapier/rapierBodies.ts';
import type { BrickDynamicPool } from './brickDynamicPool.ts';
import {
  BRICK_HEAVY_PENETRATOR_THRESHOLD_J,
  type BrickWallInstanceState,
  IDENTITY_QUAT,
} from './brickWallTypes.ts';

function getGraphNodes(wall: BrickWallInstanceState): ChunkConnectivityNode[] {
  return (wall.graph.nodes ?? (wall.graph as { chunks?: ChunkConnectivityNode[] }).chunks ?? []) as ChunkConnectivityNode[];
}

export function populateIntactWallState(
  wall: BrickWallInstanceState,
  rapierWorld: RapierPhysicsWorld,
  dynamicPool: BrickDynamicPool
): void {
  const nodes = getGraphNodes(wall);
  const rot = wall.transform.rotation ?? IDENTITY_QUAT;
  wall.intactBrickCount = 0;
  wall.detachedBrickCount = 0;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const variant = (node.meshVariant ?? i) % 3;
    wall.variantByBrick[i] = variant;

    const he = node.halfExtents ?? {
      x: wall.brickW * 0.5,
      y: wall.brickH * 0.5,
      z: wall.brickD * 0.5,
    };
    const norm = dynamicPool.variantNormScales[variant];
    const renderScale: Vec3Like = {
      x: he.x * 2 * norm.x,
      y: he.y * 2 * norm.y,
      z: he.z * 2 * norm.z,
    };

    const worldPos = localToWorldPoint(node.localCenter, wall.transform);
    const pool = dynamicPool.variantPools[variant];
    const slotId = pool.allocSlot();
    wall.poolSlotByBrick[i] = slotId;

    if (slotId >= 0) {
      pool.setSlotTRS(slotId, worldPos, rot, renderScale);
    }

    const tag: ColliderSurfaceTag = {
      material: 'BRICK_MASONRY',
      objectId: wall.wallId,
      chunkIndex: i,
      thicknessM: he.z * 2,
      penetrationResistanceJ: BRICK_HEAVY_PENETRATOR_THRESHOLD_J,
    };

    const colHandle = rapierWorld.createStaticBox(worldPos, he, rot, tag);
    wall.staticColliderHandles[i] = colHandle;
    wall.dynamicBodyHandles[i] = -1;
    wall.intactBrickCount++;
  }

  dynamicPool.uploadAllVariantPools();
}

export function convertBrickToDynamicBody(
  wall: BrickWallInstanceState,
  brickIndex: number,
  linVel: Vec3Like,
  angVel: Vec3Like,
  rapierWorld: RapierPhysicsWorld,
  dynamicPool: BrickDynamicPool,
  spawnOffsetWorld?: Vec3Like
): void {
  const staticCol = wall.staticColliderHandles[brickIndex];
  if (staticCol >= 0) {
    rapierWorld.removeCollider(staticCol);
    wall.staticColliderHandles[brickIndex] = -1;
  }

  if (wall.dynamicBodyHandles[brickIndex] >= 0) {
    return;
  }

  const nodes = getGraphNodes(wall);
  const node = nodes[brickIndex];
  if (!node) return;

  const he = node.halfExtents ?? {
    x: wall.brickW * 0.5,
    y: wall.brickH * 0.5,
    z: wall.brickD * 0.5,
  };
  const rot = wall.transform.rotation ?? IDENTITY_QUAT;
  const baseWorldPos = localToWorldPoint(node.localCenter, wall.transform);
  const worldPos: Vec3Like = spawnOffsetWorld
    ? {
        x: baseWorldPos.x + spawnOffsetWorld.x,
        y: baseWorldPos.y + spawnOffsetWorld.y,
        z: baseWorldPos.z + spawnOffsetWorld.z,
      }
    : baseWorldPos;

  const dynamicTag: ColliderSurfaceTag = {
    material: 'BRICK_MASONRY',
    objectId: wall.wallId,
    chunkIndex: brickIndex,
    thicknessM: he.z * 2,
    penetrationResistanceJ: BRICK_HEAVY_PENETRATOR_THRESHOLD_J,
  };

  const physicsHe: Vec3Like = {
    x: he.x * 0.96,
    y: he.y * 0.96,
    z: he.z * 0.96,
  };

  const { bodyHandle } = rapierWorld.spawnDynamicBox(
    worldPos,
    physicsHe,
    node.massKg,
    linVel,
    angVel,
    rot,
    dynamicTag
  );

  wall.dynamicBodyHandles[brickIndex] = bodyHandle;
  wall.intactBrickCount = Math.max(0, wall.intactBrickCount - 1);
  wall.detachedBrickCount++;

  const variant = wall.variantByBrick[brickIndex];
  const slotId = wall.poolSlotByBrick[brickIndex];
  if (slotId >= 0) {
    const norm = dynamicPool.variantNormScales[variant];
    const renderScale: Vec3Like = {
      x: he.x * 2 * norm.x,
      y: he.y * 2 * norm.y,
      z: he.z * 2 * norm.z,
    };
    dynamicPool.variantPools[variant].bindSlotToRapierBody(
      slotId,
      bodyHandle,
      renderScale,
      wall.dynamicDebrisTtlS
    );
  }
}

export function convertBrickIslandToCompoundBody(
  wall: BrickWallInstanceState,
  brickIndices: readonly number[],
  linVel: Vec3Like,
  angVel: Vec3Like,
  rapierWorld: RapierPhysicsWorld,
  dynamicPool: BrickDynamicPool,
  spawnOffsetWorld?: Vec3Like
): void {
  if (brickIndices.length === 0) return;
  if (brickIndices.length === 1) {
    convertBrickToDynamicBody(
      wall,
      brickIndices[0],
      linVel,
      angVel,
      rapierWorld,
      dynamicPool,
      spawnOffsetWorld
    );
    return;
  }

  const nodes = getGraphNodes(wall);
  const validIndices: number[] = [];
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;

  for (let i = 0; i < brickIndices.length; i++) {
    const idx = brickIndices[i];
    const staticCol = wall.staticColliderHandles[idx];
    if (staticCol >= 0) {
      rapierWorld.removeCollider(staticCol);
      wall.staticColliderHandles[idx] = -1;
    }
    if (wall.dynamicBodyHandles[idx] >= 0 || !nodes[idx]) continue;
    validIndices.push(idx);
    sumX += nodes[idx].localCenter.x;
    sumY += nodes[idx].localCenter.y;
    sumZ += nodes[idx].localCenter.z;
  }

  if (validIndices.length === 0) return;
  const invN = 1 / validIndices.length;
  const comLocal: Vec3Like = { x: sumX * invN, y: sumY * invN, z: sumZ * invN };
  const rot = wall.transform.rotation ?? IDENTITY_QUAT;
  const baseWorldCom = localToWorldPoint(comLocal, wall.transform);
  const worldCom: Vec3Like = spawnOffsetWorld
    ? {
        x: baseWorldCom.x + spawnOffsetWorld.x,
        y: baseWorldCom.y + spawnOffsetWorld.y,
        z: baseWorldCom.z + spawnOffsetWorld.z,
      }
    : baseWorldCom;

  const children: CompoundBoxChildSpec[] = [];
  for (let i = 0; i < validIndices.length; i++) {
    const idx = validIndices[i];
    const node = nodes[idx];
    const he = node.halfExtents ?? {
      x: wall.brickW * 0.5,
      y: wall.brickH * 0.5,
      z: wall.brickD * 0.5,
    };
    const localOffset: Vec3Like = {
      x: node.localCenter.x - comLocal.x,
      y: node.localCenter.y - comLocal.y,
      z: node.localCenter.z - comLocal.z,
    };
    const tag: ColliderSurfaceTag = {
      material: 'BRICK_MASONRY',
      objectId: wall.wallId,
      chunkIndex: idx,
      thicknessM: he.z * 2,
      penetrationResistanceJ: BRICK_HEAVY_PENETRATOR_THRESHOLD_J,
    };
    children.push({
      localOffset,
      halfExtents: { x: he.x * 0.96, y: he.y * 0.96, z: he.z * 0.96 },
      massKg: node.massKg,
      tag,
    });
  }

  const { bodyHandle } = rapierWorld.spawnDynamicCompoundBox(
    worldCom,
    children,
    linVel,
    angVel,
    rot
  );

  for (let i = 0; i < validIndices.length; i++) {
    const idx = validIndices[i];
    const node = nodes[idx];
    const he = node.halfExtents ?? {
      x: wall.brickW * 0.5,
      y: wall.brickH * 0.5,
      z: wall.brickD * 0.5,
    };
    wall.dynamicBodyHandles[idx] = bodyHandle;
    wall.intactBrickCount = Math.max(0, wall.intactBrickCount - 1);
    wall.detachedBrickCount++;

    const variant = wall.variantByBrick[idx];
    const slotId = wall.poolSlotByBrick[idx];
    if (slotId >= 0) {
      const norm = dynamicPool.variantNormScales[variant];
      const renderScale: Vec3Like = {
        x: he.x * 2 * norm.x,
        y: he.y * 2 * norm.y,
        z: he.z * 2 * norm.z,
      };
      dynamicPool.variantPools[variant].bindSlotToRapierBody(
        slotId,
        bodyHandle,
        renderScale,
        wall.dynamicDebrisTtlS,
        children[i].localOffset
      );
    }
  }
}

export function releaseWallResources(
  wall: BrickWallInstanceState,
  rapierWorld: RapierPhysicsWorld,
  dynamicPool: BrickDynamicPool
): void {
  const nodes = getGraphNodes(wall);
  const n = nodes.length;
  for (let i = 0; i < n; i++) {
    const staticCol = wall.staticColliderHandles[i];
    if (staticCol >= 0) {
      rapierWorld.removeCollider(staticCol);
      wall.staticColliderHandles[i] = -1;
    }

    const dynBody = wall.dynamicBodyHandles[i];
    if (dynBody >= 0) {
      rapierWorld.removeBody(dynBody);
      wall.dynamicBodyHandles[i] = -1;
    }

    const slotId = wall.poolSlotByBrick[i];
    if (slotId >= 0) {
      const variant = wall.variantByBrick[i];
      dynamicPool.variantPools[variant].freeSlot(slotId);
      wall.poolSlotByBrick[i] = -1;
    }
  }

  wall.intactBrickCount = 0;
  wall.detachedBrickCount = 0;
  dynamicPool.uploadAllVariantPools();
}

export function getBrickWorldCenter(
  wall: BrickWallInstanceState,
  brickIndex: number
): Vec3Like | null {
  const nodes = getGraphNodes(wall);
  if (brickIndex < 0 || brickIndex >= nodes.length) {
    return null;
  }
  const node = nodes[brickIndex];
  const rotated = rotateVec3ByQuat(
    node.localCenter,
    wall.transform.rotation ?? IDENTITY_QUAT
  );
  return {
    x: wall.transform.position.x + rotated.x,
    y: wall.transform.position.y + rotated.y,
    z: wall.transform.position.z + rotated.z,
  };
}
