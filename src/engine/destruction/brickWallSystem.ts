import * as pc from 'playcanvas';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import type {
  BallisticPenetrationResult,
  BallisticSegmentImpact,
  BlastEvent,
  IDestructibleSubsystem,
} from '../../contracts/destruction.ts';
import {
  createRuntimeConnectivityGraph,
  generateRunningBondBrickGraph,
  type WallTransformLike,
} from '../../core/destruction/connectivityGraph.ts';
import { HardwareInstancedPool } from '../physics/instancedPool.ts';
import { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import {
  getBrickWorldCenter,
  handleBrickPoolSlotExpired,
  populateIntactWallState,
  releaseWallResources,
} from './brick/brickColliders.ts';
import { BrickDynamicPool } from './brick/brickDynamicPool.ts';
import {
  applyBrickBlast,
  handleBrickRaySegment,
} from './brick/brickImpactSolver.ts';
import {
  createBeveledBrickMeshVariant,
  createProceduralBrickMaterial,
} from './brick/brickMaterial.ts';
import {
  BrickPhase,
  type BrickWallConfig,
  type BrickWallInstanceState,
  type BrickWallSystemOptions,
  IDENTITY_QUAT,
} from './brick/brickWallTypes.ts';

export * from './brick/brickWallTypes.ts';
export * from './brick/brickMaterial.ts';
export * from './brick/brickDynamicPool.ts';
export * from './brick/brickColliders.ts';
export * from './brick/brickImpactSolver.ts';

/**
 * Hardware-instanced Masonry Brick Wall Destruction Subsystem (`IDestructibleSubsystem`).
 *
 * Renders all intact and dynamically collapsing bricks across the entire arena in **3 hardware-instanced
 * draw calls** (`HardwareInstancedPool` variants `0..2`), backed by Rapier static box colliders while
 * intact and on-demand Rapier dynamic rigid bodies triggered via Connectivity BFS (`findDetachedChunkIndices`).
 */
export class BrickWallSystem implements IDestructibleSubsystem {
  public readonly id: string;
  public readonly app: pc.Application;
  public readonly rapierWorld: RapierPhysicsWorld;
  public readonly brickMaterial: pc.StandardMaterial;

  private readonly pool: BrickDynamicPool;
  private readonly variantMeshes: readonly [pc.Mesh, pc.Mesh, pc.Mesh];
  private readonly ownedDiffuseTexture: pc.Texture | null;
  private readonly ownsVariantMeshes: boolean;
  private readonly ownsMaterial: boolean;

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
      this.ownedDiffuseTexture = null;
      this.ownsMaterial = false;
    } else {
      const created = createProceduralBrickMaterial(device);
      this.brickMaterial = created.material;
      this.ownedDiffuseTexture = created.diffuseTexture;
      this.ownsMaterial = true;
    }

    this.pool = new BrickDynamicPool(
      app,
      this.brickMaterial,
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

  public get totalDrawCallPoolCount(): number {
    return this.pool.variantPools.length;
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

    const brickW = config.brickW ?? 0.215;
    const brickH = config.brickH ?? 0.065;
    const brickD = config.brickD ?? 0.1025;
    const cols = config.cols ?? 12;
    const rows = config.rows ?? 18;
    const mortarBreakJ = config.mortarBreakJ ?? 650;
    const mortarGapM = config.mortarGapM ?? 0.008;

    const baseJson =
      config.connectivityGraph ??
      generateRunningBondBrickGraph(
        config.wallId,
        cols,
        rows,
        brickW,
        brickH,
        brickD,
        mortarBreakJ,
        mortarGapM
      );

    const runtimeGraph = createRuntimeConnectivityGraph(baseJson);
    const n = runtimeGraph.nodes.length;
    const transform: WallTransformLike = {
      position: { ...config.position },
      rotation: config.rotation ? { ...config.rotation } : { ...IDENTITY_QUAT },
    };

    const state: BrickWallInstanceState = {
      wallId: config.wallId,
      transform,
      initialGraphSnapshot: baseJson,
      graph: runtimeGraph,
      brickW,
      brickH,
      brickD,
      dynamicDebrisTtlS: config.dynamicDebrisTtlS ?? 0,
      brickPhase: new Uint8Array(n).fill(BrickPhase.INTACT_STATIC),
      variantByBrick: new Uint8Array(n),
      poolSlotByBrick: new Int32Array(n).fill(-1),
      staticColliderHandles: new Float64Array(n).fill(-1),
      dynamicBodyHandles: new Float64Array(n).fill(-1),
      intactBrickCount: 0,
      detachedBrickCount: 0,
    };

    populateIntactWallState(state, this.rapierWorld, this.pool);
    this.wallsById.set(config.wallId, state);
    return state;
  }

  public removeBrickWall(wallId: string): void {
    const wall = this.wallsById.get(wallId);
    if (!wall) return;
    releaseWallResources(wall, this.rapierWorld, this.pool);
    this.wallsById.delete(wallId);
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
    applyBrickBlast(blast, this.wallsById, this.rapierWorld, this.pool, () => this.nextRandom());
  }

  public update(dt: number): void {
    if (this.destroyed) return;
    this.pool.syncFromPhysics(this.rapierWorld, dt, (variant, slotId, bodyHandle) => {
      handleBrickPoolSlotExpired(this.wallsById, variant, slotId, bodyHandle);
    });
  }

  public reset(): void {
    if (this.destroyed) return;
    this.pool.clear();
    for (const wall of this.wallsById.values()) {
      releaseWallResources(wall, this.rapierWorld, this.pool);
      wall.graph = createRuntimeConnectivityGraph(wall.initialGraphSnapshot);
      populateIntactWallState(wall, this.rapierWorld, this.pool);
    }
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const wall of this.wallsById.values()) {
      releaseWallResources(wall, this.rapierWorld, this.pool);
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
    if (this.ownedDiffuseTexture) {
      this.ownedDiffuseTexture.destroy();
    }
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
