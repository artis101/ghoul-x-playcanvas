import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { ImportedVoronoiChunkMesh } from '../../../core/destruction/voronoiWallGenerator.ts';
import type { GlbModelRegistry } from '../../assets/glbLoader.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import { DESTRUCTION_ZONE_LAYOUT } from '../../world/arenaBuilder.ts';
import type { BrickWallSystem } from '../brickWallSystem.ts';
import type { ConcreteWallSystem } from '../concreteWallSystem.ts';
import type { GlassSystem } from '../glassSystem.ts';
import type { WoodWallSystem } from '../woodWallSystem.ts';
import {
  extractImportedVoronoiChunkMesh,
  type StaticCoverFixture,
} from './destructionManagerTypes.ts';

export interface ArenaBuildContext {
  readonly app: pc.Application;
  readonly rootEntity: pc.Entity;
  readonly rapierWorld: RapierPhysicsWorld;
  readonly sillConcreteMat: pc.StandardMaterial;
  readonly staticFixtures: StaticCoverFixture[];
  readonly woodWalls: WoodWallSystem;
  readonly glassSystem: GlassSystem;
  readonly brickWalls: BrickWallSystem;
  readonly concreteWalls: ConcreteWallSystem;
}

export function createWindowParapetSill(
  ctx: ArenaBuildContext,
  objectId: string,
  centerX: number,
  centerZ: number,
  widthM: number,
  heightM: number
): void {
  const halfExtents: Vec3Like = {
    x: widthM * 0.5 + 0.04,
    y: heightM * 0.5,
    z: 0.11,
  };
  const center: Vec3Like = {
    x: centerX,
    y: heightM * 0.5,
    z: centerZ,
  };

  const colliderHandle = ctx.rapierWorld.createStaticBox(center, halfExtents, undefined, {
    material: 'CONCRETE_INTACT',
    objectId,
    thicknessM: halfExtents.z * 2,
    penetrationResistanceJ: 12000,
  });

  const entity = new pc.Entity(objectId);
  entity.addComponent('render', {
    type: 'box',
    material: ctx.sillConcreteMat,
    castShadows: true,
    receiveShadows: true,
  });
  entity.setLocalScale(halfExtents.x * 2, halfExtents.y * 2, halfExtents.z * 2);
  entity.setPosition(center.x, center.y, center.z);
  ctx.rootEntity.addChild(entity);

  ctx.staticFixtures.push({
    objectId,
    colliderHandle,
    entity,
  });
}

/**
 * Builds the tactical Max Mayhem breaching arena across firing lanes `z = -6.5m .. -14m`:
 * - Shoot-house wood & 2x4 stud partition (`z = -7.2m`, left-center lane)
 * - Marching-squares 256 tactical observation window (`z = -6.5m`, west lane)
 * - Runtime Delaunator Voronoi tempered plate window (`z = -6.5m`, east lane)
 * - Staggered running-bond instanced masonry brick wall (`z = -12.5m`, west-mid lane)
 * - 36-cell MultiDraw Voronoi reinforced concrete barrier (`z = -13.5m`, east-mid lane)
 */
export function buildBreachingArenaStations(
  ctx: ArenaBuildContext,
  glbRegistry?: GlbModelRegistry | null
): void {
  const layout = DESTRUCTION_ZONE_LAYOUT;

  // 1. R6 Shoot-House Wood & 2x4 Stud Partition
  ctx.woodWalls.createWall({
    id: layout.woodShootHouseWall.id,
    centerWorld: { ...layout.woodShootHouseWall.center },
    widthM: layout.woodShootHouseWall.widthM,
    heightM: layout.woodShootHouseWall.heightM,
    thicknessM: layout.woodShootHouseWall.thicknessM,
    yawRad: (layout.woodShootHouseWall.yawDeg * Math.PI) / 180,
    studSpacingM: 0.6,
  });

  // 2. West Lane: 256 Marching-Squares Tactical Glass Window + Low Concrete Parapet Sill
  ctx.glassSystem.createMarchingWindow({
    id: layout.glassMarchingWindow.id,
    centerWorld: { ...layout.glassMarchingWindow.center },
    widthM: layout.glassMarchingWindow.widthM,
    heightM: layout.glassMarchingWindow.heightM,
    thicknessM: layout.glassMarchingWindow.thicknessM,
    gridW: 16,
    gridH: 16,
  });
  createWindowParapetSill(
    ctx,
    'window_sill_marching_west',
    layout.glassMarchingWindow.center.x,
    layout.glassMarchingWindow.center.z,
    layout.glassMarchingWindow.widthM,
    Math.max(0.2, layout.glassMarchingWindow.center.y - layout.glassMarchingWindow.heightM * 0.5)
  );

  // 3. East Lane: Runtime Voronoi Tempered Glass Window + Low Concrete Parapet Sill
  ctx.glassSystem.createVoronoiWindow({
    id: layout.glassVoronoiWindow.id,
    centerWorld: { ...layout.glassVoronoiWindow.center },
    widthM: layout.glassVoronoiWindow.widthM,
    heightM: layout.glassVoronoiWindow.heightM,
    thicknessM: layout.glassVoronoiWindow.thicknessM,
    voronoiShardCount: 42,
  });
  createWindowParapetSill(
    ctx,
    'window_sill_voronoi_east',
    layout.glassVoronoiWindow.center.x,
    layout.glassVoronoiWindow.center.z,
    layout.glassVoronoiWindow.widthM,
    Math.max(0.2, layout.glassVoronoiWindow.center.y - layout.glassVoronoiWindow.heightM * 0.5)
  );

  // 4. Staggered Running-Bond Instanced Masonry Brick Wall (base flush at y = 0)
  ctx.brickWalls.addBrickWall({
    wallId: layout.instancedBrickWall.id,
    position: {
      x: layout.instancedBrickWall.center.x,
      y: 0,
      z: layout.instancedBrickWall.center.z,
    },
    cols: 13,
    rows: 26,
    brickW: 0.215,
    brickH: 0.072,
    brickD: 0.14,
    mortarBreakJ: 650,
    mortarGapM: 0.008,
  });

  // 5. 36-Cell MultiDraw Voronoi Reinforced Concrete Barrier (base flush at y = 0)
  const wallId = layout.voronoiConcreteWall.id;
  const wallPos: Vec3Like = {
    x: layout.voronoiConcreteWall.center.x,
    y: 0,
    z: layout.voronoiConcreteWall.center.z,
  };

  if (glbRegistry && glbRegistry.isLoaded('concrete_wall_fractured')) {
    try {
      const bundle = glbRegistry.getFracturedConcreteWallBundle();
      const importedMeshes: ImportedVoronoiChunkMesh[] = bundle.chunkMeshes.map((m, idx) =>
        extractImportedVoronoiChunkMesh(
          m,
          bundle.connectivity.nodes[idx]?.name ?? `Chunk_${String(idx).padStart(2, '0')}`
        )
      );

      ctx.concreteWalls.addConcreteWall({
        wallId,
        position: wallPos,
        importedChunks: {
          meshes: importedMeshes,
          connectivity: {
            ...bundle.connectivity,
            wallId,
          },
        },
      });
      return;
    } catch {
      // Fall through to procedural Voronoi
    }
  }

  ctx.concreteWalls.addConcreteWall({
    wallId,
    position: wallPos,
    width: layout.voronoiConcreteWall.widthM,
    height: 2.2,
    depth: layout.voronoiConcreteWall.thicknessM,
    cellCount: 36,
    seed: 1337,
  });
}
