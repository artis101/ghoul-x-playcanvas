import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { ColliderSurfaceTag, QuatLike } from '../../../contracts/destruction.ts';
import {
  buildSolidBrickWallMesh,
  createSolidBrickWallGrid,
  getBrickDamageStage,
  resetSolidBrickWallGrid,
  type BrickWallMeshBuffers,
} from '../../../core/destruction/brickWallMesh.ts';
import {
  localToWorldPoint,
  rotateVec3ByQuat,
  type WallTransformLike,
} from '../../../core/destruction/connectivityGraph.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import {
  BRICK_WALL_STOPPING_RESISTANCE_J,
  BrickPhase,
  type BrickWallConfig,
  type BrickWallInstanceState,
  DEFAULT_BRICK_WALL_MAX_INDICES,
  DEFAULT_BRICK_WALL_MAX_VERTICES,
  IDENTITY_QUAT,
} from './brickWallTypes.ts';

function createSingleWallCollider(
  wallId: string,
  transform: WallTransformLike,
  widthM: number,
  heightM: number,
  thicknessM: number,
  rapierWorld: RapierPhysicsWorld
): number {
  const rot = transform.rotation ?? IDENTITY_QUAT;
  const worldCenter = localToWorldPoint({ x: 0, y: heightM * 0.5, z: 0 }, transform);
  const tag: ColliderSurfaceTag = {
    material: 'BRICK_MASONRY',
    objectId: wallId,
    thicknessM,
    penetrationResistanceJ: BRICK_WALL_STOPPING_RESISTANCE_J,
  };
  return rapierWorld.createStaticBox(
    worldCenter,
    { x: widthM * 0.5, y: heightM * 0.5, z: thicknessM * 0.5 },
    rot,
    tag
  );
}

export function syncBrickWallMeshAndState(
  wall: BrickWallInstanceState,
  rapierWorld: RapierPhysicsWorld
): void {
  const n = wall.grid.cells.length;
  for (let i = 0; i < n; i++) {
    const stage = getBrickDamageStage(wall.grid, i);
    switch (stage) {
      case 'INTACT':
        wall.brickPhase[i] = BrickPhase.INTACT;
        break;
      case 'CHIPPED':
        wall.brickPhase[i] = BrickPhase.CHIPPED;
        break;
      case 'CRACKED':
        wall.brickPhase[i] = BrickPhase.CRACKED;
        break;
      case 'DESTROYED':
        wall.brickPhase[i] = BrickPhase.DESTROYED;
        break;
    }
  }

  const stats = buildSolidBrickWallMesh(wall.grid, wall.meshBuffers);
  wall.lastMeshStats = stats;
  wall.intactBrickCount = stats.intactBrickCount;
  wall.damagedBrickCount = stats.damagedBrickCount;
  wall.destroyedBrickCount = stats.destroyedBrickCount;
  wall.detachedBrickCount = stats.destroyedBrickCount;

  if (stats.indexCount <= 0 || stats.vertexCount <= 0) {
    wall.wallEntity.enabled = false;
    if (wall.wallColliderHandle >= 0) {
      rapierWorld.removeCollider(wall.wallColliderHandle);
      wall.wallColliderHandle = -1;
    }
    return;
  }

  wall.wallMesh.setPositions(wall.meshBuffers.positions, 3, stats.vertexCount);
  wall.wallMesh.setNormals(wall.meshBuffers.normals, 3, stats.vertexCount);
  wall.wallMesh.setUvs(0, wall.meshBuffers.uvs, 2, stats.vertexCount);
  wall.wallMesh.setColors(wall.meshBuffers.colors, 4, stats.vertexCount);
  wall.wallMesh.setIndices(wall.meshBuffers.indices, stats.indexCount);
  wall.wallMesh.update(pc.PRIMITIVE_TRIANGLES, false);
  wall.wallEntity.enabled = true;
}

export function createBrickWallInstance(
  app: pc.Application,
  rapierWorld: RapierPhysicsWorld,
  wallMaterial: pc.StandardMaterial,
  config: BrickWallConfig,
  maxVertices = DEFAULT_BRICK_WALL_MAX_VERTICES,
  maxIndices = DEFAULT_BRICK_WALL_MAX_INDICES
): BrickWallInstanceState {
  const brickW = config.brickW ?? 0.215;
  const brickH = config.brickH ?? 0.072;
  const brickD = config.brickD ?? 0.18;
  const cols = config.cols ?? 12;
  const rows = config.rows ?? 18;
  const mortarGapM = config.mortarGapM ?? 0.008;

  const grid = createSolidBrickWallGrid({
    wallId: config.wallId,
    cols,
    rows,
    brickW,
    brickH,
    brickD,
    mortarGapM,
  });

  const rot: QuatLike = config.rotation ? { ...config.rotation } : { ...IDENTITY_QUAT };
  const invRotation: QuatLike = { x: -rot.x, y: -rot.y, z: -rot.z, w: rot.w };
  const transform: WallTransformLike = {
    position: { ...config.position },
    rotation: rot,
  };

  const safeMaxV = Math.max(2048, maxVertices);
  const safeMaxI = Math.max(3072, maxIndices);
  const meshBuffers: BrickWallMeshBuffers = {
    positions: new Float32Array(safeMaxV * 3),
    normals: new Float32Array(safeMaxV * 3),
    uvs: new Float32Array(safeMaxV * 2),
    colors: new Float32Array(safeMaxV * 4),
    indices: safeMaxV <= 65535 ? new Uint16Array(safeMaxI) : new Uint32Array(safeMaxI),
  };

  const wallMesh = new pc.Mesh(app.graphicsDevice);
  wallMesh.clear(true, true, safeMaxV, safeMaxI);
  const initialStats = buildSolidBrickWallMesh(grid, meshBuffers);
  wallMesh.setPositions(meshBuffers.positions, 3, initialStats.vertexCount);
  wallMesh.setNormals(meshBuffers.normals, 3, initialStats.vertexCount);
  wallMesh.setUvs(0, meshBuffers.uvs, 2, initialStats.vertexCount);
  wallMesh.setColors(meshBuffers.colors, 4, initialStats.vertexCount);
  wallMesh.setIndices(meshBuffers.indices, initialStats.indexCount);
  wallMesh.update(pc.PRIMITIVE_TRIANGLES, true);

  const wallMeshInstance = new pc.MeshInstance(wallMesh, wallMaterial);
  wallMeshInstance.castShadows = true;
  wallMeshInstance.cull = false;

  const wallEntity = new pc.Entity(`BrickWall_${config.wallId}`);
  wallEntity.setPosition(config.position.x, config.position.y, config.position.z);
  wallEntity.setRotation(rot.x, rot.y, rot.z, rot.w);
  wallEntity.addComponent('render', {
    meshInstances: [wallMeshInstance],
    castShadows: true,
    receiveShadows: true,
  });
  if (wallEntity.render) {
    const hSpan = Math.max(grid.widthM, grid.thicknessM) * 0.6 + 0.35;
    wallEntity.render.customAabb = new pc.BoundingBox(
      new pc.Vec3(0, grid.heightM * 0.5, 0),
      new pc.Vec3(hSpan, grid.heightM * 0.6 + 0.35, hSpan)
    );
  }
  app.root.addChild(wallEntity);

  const wallColliderHandle = createSingleWallCollider(
    config.wallId,
    transform,
    grid.widthM,
    grid.heightM,
    grid.thicknessM,
    rapierWorld
  );

  return {
    wallId: config.wallId,
    transform,
    invRotation,
    grid,
    brickW,
    brickH,
    brickD,
    dynamicDebrisTtlS: config.dynamicDebrisTtlS ?? 0,
    brickPhase: new Uint8Array(grid.cells.length).fill(BrickPhase.INTACT),
    wallColliderHandle,
    wallEntity,
    wallMesh,
    wallMeshInstance,
    meshBuffers,
    lastMeshStats: initialStats,
    intactBrickCount: initialStats.intactBrickCount,
    damagedBrickCount: initialStats.damagedBrickCount,
    destroyedBrickCount: initialStats.destroyedBrickCount,
    detachedBrickCount: initialStats.destroyedBrickCount,
  };
}

export function resetBrickWallInstance(
  wall: BrickWallInstanceState,
  rapierWorld: RapierPhysicsWorld
): void {
  resetSolidBrickWallGrid(wall.grid);
  if (wall.wallColliderHandle < 0) {
    wall.wallColliderHandle = createSingleWallCollider(
      wall.wallId,
      wall.transform,
      wall.grid.widthM,
      wall.grid.heightM,
      wall.grid.thicknessM,
      rapierWorld
    );
  }
  syncBrickWallMeshAndState(wall, rapierWorld);
}

export function releaseWallResources(
  wall: BrickWallInstanceState,
  rapierWorld: RapierPhysicsWorld
): void {
  if (wall.wallColliderHandle >= 0) {
    rapierWorld.removeCollider(wall.wallColliderHandle);
    wall.wallColliderHandle = -1;
  }
  wall.intactBrickCount = 0;
  wall.damagedBrickCount = 0;
  wall.destroyedBrickCount = wall.grid.cells.length;
  wall.detachedBrickCount = wall.destroyedBrickCount;
  wall.wallEntity.destroy();
  wall.wallMesh.destroy();
}

export function getBrickWorldCenter(
  wall: BrickWallInstanceState,
  brickIndex: number
): Vec3Like | null {
  if (brickIndex < 0 || brickIndex >= wall.grid.cells.length) {
    return null;
  }
  const rotated = rotateVec3ByQuat(
    wall.grid.cells[brickIndex].localCenter,
    wall.transform.rotation ?? IDENTITY_QUAT
  );
  return {
    x: wall.transform.position.x + rotated.x,
    y: wall.transform.position.y + rotated.y,
    z: wall.transform.position.z + rotated.z,
  };
}
