import * as pc from 'playcanvas';
import { Vec3Like } from '../../contracts/ballistics.ts';
import type { ColliderSurfaceTag } from '../../contracts/destruction.ts';
import { EngineMaterialPalette } from '../materials.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';

export interface DestructionStationSpec {
  readonly id: string;
  readonly label: string;
  readonly center: Vec3Like;
  readonly widthM: number;
  readonly heightM: number;
  readonly thicknessM: number;
  readonly halfExtents: Vec3Like;
  readonly yawDeg: number;
}

export interface DestructionZoneLayout {
  readonly woodShootHouseWall: DestructionStationSpec;
  readonly glassMarchingWindow: DestructionStationSpec;
  readonly glassVoronoiWindow: DestructionStationSpec;
  readonly instancedBrickWall: DestructionStationSpec;
  readonly voronoiConcreteWall: DestructionStationSpec;
}

/**
 * Structured range station coordinates for destructible tactical cover stations.
 * Positioned along clear firing lanes and aligned with downrange GHOUL combatants.
 */
export const DESTRUCTION_ZONE_LAYOUT: DestructionZoneLayout = {
  woodShootHouseWall: {
    id: 'wood_shoot_house_wall',
    label: 'Wood & Drywall Shoot-House Partition',
    center: { x: -2.3, y: 1.2, z: -7.2 },
    widthM: 3.0,
    heightM: 2.4,
    thicknessM: 0.12,
    halfExtents: { x: 1.5, y: 1.2, z: 0.06 },
    yawDeg: 0,
  },
  glassMarchingWindow: {
    id: 'glass_marching_window',
    label: 'Marching-Squares 256 Tactical Window',
    center: { x: -5.5, y: 1.45, z: -6.5 },
    widthM: 2.2,
    heightM: 1.7,
    thicknessM: 0.03,
    halfExtents: { x: 1.1, y: 0.85, z: 0.015 },
    yawDeg: 0,
  },
  glassVoronoiWindow: {
    id: 'glass_voronoi_window',
    label: 'Runtime Voronoi Tempered Glass Window',
    center: { x: 5.5, y: 1.45, z: -6.5 },
    widthM: 2.2,
    heightM: 1.7,
    thicknessM: 0.03,
    halfExtents: { x: 1.1, y: 0.85, z: 0.015 },
    yawDeg: 0,
  },
  instancedBrickWall: {
    id: 'instanced_brick_wall',
    label: 'Instanced Masonry Brick Cover Wall',
    center: { x: -3.8, y: 1.05, z: -12.5 },
    widthM: 3.0,
    heightM: 2.1,
    thicknessM: 0.2,
    halfExtents: { x: 1.5, y: 1.05, z: 0.1 },
    yawDeg: 0,
  },
  voronoiConcreteWall: {
    id: 'voronoi_concrete_wall',
    label: 'MultiDraw Voronoi Concrete Barrier Wall',
    center: { x: 2.3, y: 1.15, z: -13.5 },
    widthM: 3.2,
    heightM: 2.3,
    thicknessM: 0.28,
    halfExtents: { x: 1.6, y: 1.15, z: 0.14 },
    yawDeg: 0,
  },
};

export const RANGE_MARKER_DISTANCES_M: readonly number[] = [5, 10, 15, 25, 42];
export const PERIMETER_BARRIER_Z_OFFSETS_M: readonly number[] = [-8, -20, -34, -48];

export class ArenaBuilder {
  public readonly app: pc.AppBase;
  public readonly materials: EngineMaterialPalette;
  public readonly rapierWorld: RapierPhysicsWorld | null;
  public readonly arenaRootEntity: pc.Entity;

  private readonly colliderHandles: number[] = [];

  constructor(
    app: pc.AppBase,
    materials: EngineMaterialPalette,
    rapierWorld: RapierPhysicsWorld | null = null,
  ) {
    this.app = app;
    this.materials = materials;
    this.rapierWorld = rapierWorld;
    this.arenaRootEntity = new pc.Entity('ArenaRoot');
    this.app.root.addChild(this.arenaRootEntity);
  }

  public get registeredColliderCount(): number {
    return this.colliderHandles.length;
  }

  public build(): void {
    this.clearPhysicsColliders();

    const sunLight = new pc.Entity('SunLight');
    sunLight.addComponent('light', {
      type: 'directional',
      color: new pc.Color(1.0, 0.96, 0.88),
      intensity: 1.55,
      castShadows: true,
      shadowResolution: 2048,
      shadowDistance: 75,
    });
    sunLight.setEulerAngles(48, 32, 0);
    this.arenaRootEntity.addChild(sunLight);

    const fillLight = new pc.Entity('FillLight');
    fillLight.addComponent('light', {
      type: 'directional',
      color: new pc.Color(0.28, 0.42, 0.58),
      intensity: 0.72,
      castShadows: false,
    });
    fillLight.setEulerAngles(-45, -145, 0);
    this.arenaRootEntity.addChild(fillLight);

    const floor = new pc.Entity('ArenaFloor');
    floor.addComponent('render', {
      type: 'box',
      material: this.materials.floorGridMat,
      receiveShadows: true,
    });
    floor.setLocalScale(40, 0.2, 160);
    floor.setPosition(0, -0.1, -50);
    this.arenaRootEntity.addChild(floor);

    for (const d of RANGE_MARKER_DISTANCES_M) {
      const lineMarker = new pc.Entity(`DistanceMarker_${d}m`);
      lineMarker.addComponent('render', {
        type: 'box',
        material: this.materials.rangeDistanceMarkerMat,
      });
      lineMarker.setLocalScale(17, 0.02, 0.08);
      lineMarker.setPosition(0, 0.01, -d);
      this.arenaRootEntity.addChild(lineMarker);

      for (const side of [-8.5, 8.5]) {
        const objectId = `MarkerPost_${d}m_${side}`;
        const post = new pc.Entity(objectId);
        post.addComponent('render', {
          type: 'box',
          material: this.materials.barrierConcreteMat,
        });
        post.setLocalScale(0.32, 1.1, 0.32);
        post.setPosition(side, 0.55, -d);
        this.arenaRootEntity.addChild(post);

        if (this.rapierWorld) {
          const postTag: ColliderSurfaceTag = {
            material: 'CONCRETE_INTACT',
            objectId,
            thicknessM: 0.32,
            penetrationResistanceJ: 12000,
          };
          this.colliderHandles.push(
            this.rapierWorld.createStaticBox(
              { x: side, y: 0.55, z: -d },
              { x: 0.16, y: 0.55, z: 0.16 },
              undefined,
              postTag,
            ),
          );
        }
      }
    }

    for (const z of PERIMETER_BARRIER_Z_OFFSETS_M) {
      for (const side of [-9.5, 9.5]) {
        const objectId = `Barrier_${side}_${z}`;
        const barrier = new pc.Entity(objectId);
        barrier.addComponent('render', {
          type: 'box',
          material: this.materials.barrierConcreteMat,
          castShadows: true,
        });
        barrier.setLocalScale(1.1, 1.35, 7.5);
        barrier.setPosition(side, 0.675, z);
        this.arenaRootEntity.addChild(barrier);

        if (this.rapierWorld) {
          const barrierTag: ColliderSurfaceTag = {
            material: 'CONCRETE_INTACT',
            objectId,
            thicknessM: 1.1,
            penetrationResistanceJ: 16000,
          };
          this.colliderHandles.push(
            this.rapierWorld.createStaticBox(
              { x: side, y: 0.675, z },
              { x: 0.55, y: 0.675, z: 3.75 },
              undefined,
              barrierTag,
            ),
          );
        }
      }
    }
  }

  public destroy(): void {
    this.clearPhysicsColliders();
    this.arenaRootEntity.destroy();
  }

  private clearPhysicsColliders(): void {
    if (this.rapierWorld) {
      for (const handle of this.colliderHandles) {
        this.rapierWorld.removeCollider(handle);
      }
    }
    this.colliderHandles.length = 0;
  }
}
