import * as pc from 'playcanvas';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import type {
  BallisticPenetrationResult,
  BallisticSegmentImpact,
  BlastEvent,
  IDestructibleSubsystem,
} from '../../contracts/destruction.ts';
import { HardwareInstancedPool } from '../physics/instancedPool.ts';
import { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import {
  createBrickWallInstance,
  getBrickWorldCenter,
  releaseWallResources,
  resetBrickWallInstance,
} from './brick/brickColliders.ts';
import { BrickDynamicPool } from './brick/brickDynamicPool.ts';
import {
  applyBrickBlast,
  handleBrickRaySegment,
  isBrickWallOpenAlongRay,
  isBrickWallPlayerPassable,
} from './brick/brickImpactSolver.ts';
import {
  createBeveledBrickMeshVariant,
  createProceduralBrickMaterial,
} from './brick/brickMaterial.ts';
import {
  type BrickWallConfig,
  type BrickWallInstanceState,
  type BrickWallSystemOptions,
} from './brick/brickWallTypes.ts';

export * from './brick/brickWallTypes.ts';
export * from './brick/brickMaterial.ts';
export * from './brick/brickDynamicPool.ts';
export * from './brick/brickColliders.ts';
export * from './brick/brickImpactSolver.ts';

/**
 * Solid Running-Bond Masonry Brick Wall Destruction Subsystem (`IDestructibleSubsystem`).
 *
 * - Each wall is a single solid watertight masonry `pc.Mesh` + 1 single static Rapier box collider
 *   (zero wasteful per-brick colliders or solid Rapier rigid bodies).
 * - Bricks suffer progressive 3D spalling, chipping, and cracking damage (`hp` & recessed gouge pockets)
 *   before shattering out completely to punch clean 3D holes through the wall.
 * - Transient flying broken-brick fragments (`debris_pack.glb` `Brick_0..2`) and mortar chips use
 *   zero-Rapier packed kinematic instancing (`BrickDynamicPool`).
 */
export class BrickWallSystem implements IDestructibleSubsystem {
  public readonly id: string;
  public readonly app: pc.Application;
  public readonly rapierWorld: RapierPhysicsWorld;
  public readonly brickMaterial: pc.StandardMaterial;

  private readonly pool: BrickDynamicPool;
  private readonly variantMeshes: readonly [pc.Mesh, pc.Mesh, pc.Mesh];
  private readonly ownedTextures: pc.Texture[] = [];
  private readonly ownsVariantMeshes: boolean;
  private readonly ownsMaterial: boolean;
  private readonly maxWallVertices?: number;
  private readonly maxWallIndices?: number;

  private readonly wallsById = new Map<string, BrickWallInstanceState>();
  private rngState = 0x517cc1b7;
  private destroyed = false;

  public constructor(
    app: pc.Application,
    rapierWorld: RapierPhysicsWorld,
    options: BrickWallSystemOptions = {}
  ) {
    this.id = options.id ?? 'brick-wall-system';
    this.app = app;
    this.rapierWorld = rapierWorld;
    this.maxWallVertices = options.maxWallVertices;
    this.maxWallIndices = options.maxWallIndices;

    const device = app.graphicsDevice;

    if (options.variantMeshes) {
      this.variantMeshes = options.variantMeshes;
      this.ownsVariantMeshes = false;
    } else {
      this.variantMeshes = [
        createBeveledBrickMeshVariant(device, 0),
        createBeveledBrickMeshVariant(device, 1),
        createBeveledBrickMeshVariant(device, 2),
      ];
      this.ownsVariantMeshes = true;
    }

    if (options.material) {
      this.brickMaterial = options.material;
      this.ownsMaterial = false;
    } else {
      const created = createProceduralBrickMaterial(device);
      this.brickMaterial = created.material;
      this.ownedTextures.push(created.diffuseTexture, created.normalTexture);
      this.ownsMaterial = true;
    }

    const rubbleMat = options.rubbleMaterial ?? this.brickMaterial;
    this.pool = new BrickDynamicPool(
      app,
      rubbleMat,
      this.variantMeshes,
      options.maxBricksPerVariantPool,
      options.maxMortarChips
    );
  }

  public get variantPools(): readonly [
    HardwareInstancedPool,
    HardwareInstancedPool,
    HardwareInstancedPool,
  ] {
    return this.pool.variantPools;
  }

  public get mortarChipPool(): HardwareInstancedPool {
    return this.pool.mortarChipPool;
  }

  public get wallCount(): number {
    return this.wallsById.size;
  }

  public getWall(wallId: string): BrickWallInstanceState | undefined {
    return this.wallsById.get(wallId);
  }

  public addBrickWall(config: BrickWallConfig): BrickWallInstanceState {
    if (this.destroyed) {
      throw new Error('Cannot add brick wall to destroyed BrickWallSystem.');
    }
    if (this.wallsById.has(config.wallId)) {
      this.removeBrickWall(config.wallId);
    }

    const state = createBrickWallInstance(
      this.app,
      this.rapierWorld,
      this.brickMaterial,
      config,
      this.maxWallVertices,
      this.maxWallIndices
    );
    this.wallsById.set(config.wallId, state);
    return state;
  }

  public removeBrickWall(wallId: string): void {
    const wall = this.wallsById.get(wallId);
    if (!wall) return;
    releaseWallResources(wall, this.rapierWorld);
    this.wallsById.delete(wallId);
  }

  public isWallOpenAlongRay(
    wallId: string,
    rayOriginWorld: Vec3Like,
    unitDirWorld: Vec3Like,
    maxDistM: number,
    fallbackPointWorld?: Vec3Like
  ): boolean {
    if (this.destroyed) return true;
    return isBrickWallOpenAlongRay(
      this.wallsById.get(wallId),
      rayOriginWorld,
      unitDirWorld,
      maxDistM,
      fallbackPointWorld
    );
  }

  public isPlayerPassableAtWorldPoint(
    wallId: string,
    worldPoint: Vec3Like,
    playerRadiusM = 0.36
  ): boolean {
    if (this.destroyed) return true;
    return isBrickWallPlayerPassable(
      this.wallsById.get(wallId),
      worldPoint,
      playerRadiusM
    );
  }

  public handleRaySegment(seg: BallisticSegmentImpact): BallisticPenetrationResult | null {
    if (this.destroyed) return null;
    return handleBrickRaySegment(
      seg,
      this.wallsById,
      this.rapierWorld,
      this.pool,
      () => this.nextRandom()
    );
  }

  public applyBlast(blast: BlastEvent): void {
    if (this.destroyed) return;
    applyBrickBlast(
      blast,
      this.wallsById,
      this.rapierWorld,
      this.pool,
      () => this.nextRandom()
    );
  }

  public update(dt: number): void {
    if (this.destroyed) return;
    this.pool.syncFromPhysics(this.rapierWorld, dt);
  }

  public reset(): void {
    if (this.destroyed) return;
    this.pool.clear();
    for (const wall of this.wallsById.values()) {
      resetBrickWallInstance(wall, this.rapierWorld);
    }
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const wall of this.wallsById.values()) {
      releaseWallResources(wall, this.rapierWorld);
    }
    this.wallsById.clear();
    this.pool.destroy();

    if (this.ownsVariantMeshes) {
      this.variantMeshes[0].destroy();
      this.variantMeshes[1].destroy();
      this.variantMeshes[2].destroy();
    }
    if (this.ownsMaterial) {
      this.brickMaterial.destroy();
    }
    for (const tex of this.ownedTextures) {
      tex.destroy();
    }
    this.ownedTextures.length = 0;
  }

  public getBrickWorldCenter(wallId: string, brickIndex: number): Vec3Like | null {
    const wall = this.wallsById.get(wallId);
    if (!wall) return null;
    return getBrickWorldCenter(wall, brickIndex);
  }

  private nextRandom(): number {
    let x = this.rngState >>> 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x >>> 0;
    return (this.rngState >>> 0) / 4294967296;
  }
}
