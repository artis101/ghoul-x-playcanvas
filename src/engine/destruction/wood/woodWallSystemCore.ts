import * as pc from 'playcanvas';
import type {
  BallisticPenetrationResult,
  BallisticSegmentImpact,
  BlastEvent,
  IDestructibleSubsystem,
} from '../../../contracts/destruction.ts';
import {
  computePanelRemainingAreaM2,
  resetWoodPanelState,
  triangulateWoodPanelToBuffers,
} from '../../../core/destruction/woodPolygonClipper.ts';
import { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import {
  createProceduralPineStudTexture,
  createProceduralWoodPanelTexture,
} from './woodProceduralTextures.ts';
import { createProceduralSplinterMeshes } from './woodSplinterMeshes.ts';
import {
  buildStudAnchorsFromColumns,
  rebuildWallStudColliders,
  uploadWallStudFrameMesh,
} from './woodStudColliderSync.ts';
import { createWoodWallInstance } from './woodWallInstanceBuilder.ts';
import {
  applyWoodWallRadialBlast,
  handleWoodWallRaySegment,
  uploadWallPanelMesh,
} from './woodWallRayBlastSolver.ts';
import { WoodSlabDynamicPool } from './woodSlabDynamicPool.ts';
import {
  DEFAULT_WOOD_WALL_MAX_INDICES,
  DEFAULT_WOOD_WALL_MAX_VERTICES,
  STUD_SECTION_MAX_HP,
  type WallInternalState,
  type WoodWallConfig,
  type WoodWallInstance,
  type WoodWallSystemOptions,
} from './woodWallTypes.ts';

export class WoodWallSystem implements IDestructibleSubsystem {
  public readonly id: string;
  public readonly app: pc.Application;
  public readonly physicsWorld: RapierPhysicsWorld;
  public readonly splinterPools: readonly HardwareInstancedPool[];
  public readonly slabPool: WoodSlabDynamicPool;

  private readonly maxPanelVertices: number;
  private readonly maxPanelIndices: number;

  private readonly panelMaterial: pc.Material;
  private readonly studMaterial: pc.Material;
  private readonly splinterMaterial: pc.Material;

  private readonly ownedTextures: pc.Texture[] = [];
  private readonly ownedMaterials: pc.Material[] = [];
  private readonly ownedSplinterMeshes: pc.Mesh[] = [];

  private readonly walls: WoodWallInstance[] = [];
  private readonly wallsById = new Map<string, WoodWallInstance>();
  private readonly internalByWallId = new Map<string, WallInternalState>();

  private splinterRngState = 0x51f2a7c3;
  private elapsedSimTimeS = 0;
  private destroyed = false;

  public constructor(
    app: pc.Application,
    physicsWorld: RapierPhysicsWorld,
    options: WoodWallSystemOptions = {},
  ) {
    this.id = options.id ?? 'wood-wall-system';
    this.app = app;
    this.physicsWorld = physicsWorld;
    this.maxPanelVertices = Math.max(1024, options.maxPanelVertices ?? DEFAULT_WOOD_WALL_MAX_VERTICES);
    this.maxPanelIndices = Math.max(3072, options.maxPanelIndices ?? DEFAULT_WOOD_WALL_MAX_INDICES);

    const device = app.graphicsDevice;

    if (options.panelMaterial) {
      this.panelMaterial = options.panelMaterial;
      this.panelMaterial.cull = pc.CULLFACE_NONE;
      this.panelMaterial.update();
    } else {
      const panelTex = createProceduralWoodPanelTexture(device);
      this.ownedTextures.push(panelTex);

      const mat = new pc.StandardMaterial();
      mat.name = 'WoodWallPanelMat';
      mat.diffuse = new pc.Color(1, 1, 1);
      mat.diffuseMap = panelTex;
      mat.specular = new pc.Color(0.08, 0.07, 0.05);
      mat.gloss = 0.22;
      mat.cull = pc.CULLFACE_NONE;
      mat.update();
      this.panelMaterial = mat;
      this.ownedMaterials.push(mat);
    }

    if (options.studMaterial) {
      this.studMaterial = options.studMaterial;
      this.studMaterial.cull = pc.CULLFACE_NONE;
      this.studMaterial.update();
    } else {
      const studTex = createProceduralPineStudTexture(device);
      this.ownedTextures.push(studTex);

      const mat = new pc.StandardMaterial();
      mat.name = 'WoodWallStudMat';
      mat.diffuse = new pc.Color(1, 1, 1);
      mat.diffuseMap = studTex;
      mat.specular = new pc.Color(0.06, 0.05, 0.04);
      mat.gloss = 0.16;
      mat.cull = pc.CULLFACE_NONE;
      mat.update();
      this.studMaterial = mat;
      this.ownedMaterials.push(mat);
    }

    if (options.splinterMaterial) {
      this.splinterMaterial = options.splinterMaterial;
    } else {
      const mat = new pc.StandardMaterial();
      mat.name = 'WoodSplinterMat';
      mat.diffuse = new pc.Color(0.84, 0.67, 0.43);
      mat.specular = new pc.Color(0.1, 0.08, 0.05);
      mat.gloss = 0.2;
      mat.cull = pc.CULLFACE_NONE;
      mat.update();
      this.splinterMaterial = mat;
      this.ownedMaterials.push(mat);
    }

    let meshesToUse: readonly pc.Mesh[];
    if (options.splinterMeshes && options.splinterMeshes.length > 0) {
      meshesToUse = options.splinterMeshes;
    } else {
      const procedural = createProceduralSplinterMeshes(device);
      this.ownedSplinterMeshes.push(...procedural);
      meshesToUse = procedural;
    }

    const totalCap = Math.max(64, options.maxSplinterInstances ?? 1024);
    const perPoolCap = Math.max(32, Math.ceil(totalCap / meshesToUse.length));
    const pools: HardwareInstancedPool[] = [];
    for (let i = 0; i < meshesToUse.length; i++) {
      pools.push(
        new HardwareInstancedPool(
          app,
          meshesToUse[i],
          this.splinterMaterial,
          perPoolCap,
          `${this.id}_SplinterPool_${i}`,
          true,
        ),
      );
    }
    this.splinterPools = pools;
    this.slabPool = new WoodSlabDynamicPool(app, physicsWorld, this.panelMaterial);
  }

  public get wallCount(): number {
    return this.walls.length;
  }

  public get activeSplinterCount(): number {
    let total = 0;
    for (let i = 0; i < this.splinterPools.length; i++) {
      total += this.splinterPools[i].activeCount;
    }
    return total;
  }

  public getWall(wallId: string): WoodWallInstance | undefined {
    return this.wallsById.get(wallId);
  }

  public getAllWalls(): readonly WoodWallInstance[] {
    return this.walls;
  }

  public getWallBrokenStudSectionCount(wallId: string): number {
    const internal = this.internalByWallId.get(wallId);
    if (!internal) return 0;
    let broken = 0;
    for (let i = 0; i < internal.studColumns.length; i++) {
      const col = internal.studColumns[i];
      if (col.isBorderPost) continue;
      for (let s = 0; s < col.sections.length; s++) {
        if (col.sections[s].broken) broken++;
      }
    }
    return broken;
  }

  public createWall(config: WoodWallConfig): WoodWallInstance {
    if (this.destroyed) {
      throw new Error('Cannot createWall on a destroyed WoodWallSystem.');
    }
    if (this.wallsById.has(config.id)) {
      throw new Error(`Wood wall with id "${config.id}" already exists.`);
    }

    const { instance, internal } = createWoodWallInstance(
      this.app,
      this.physicsWorld,
      this.panelMaterial,
      this.studMaterial,
      this.maxPanelVertices,
      this.maxPanelIndices,
      config,
    );

    this.walls.push(instance);
    this.wallsById.set(config.id, instance);
    this.internalByWallId.set(config.id, internal);
    return instance;
  }

  public update(dt: number): void {
    if (this.destroyed) return;
    if (Number.isFinite(dt) && dt > 0) {
      this.elapsedSimTimeS += dt;
    }
    for (let i = 0; i < this.splinterPools.length; i++) {
      this.splinterPools[i].syncFromPhysics(this.physicsWorld, dt);
    }
    this.slabPool.syncFromPhysics(false);
  }

  public handleRaySegment(seg: BallisticSegmentImpact): BallisticPenetrationResult | null {
    if (this.destroyed) return null;
    return handleWoodWallRaySegment(
      this.physicsWorld,
      this.walls,
      this.wallsById,
      this.internalByWallId,
      this.splinterPools,
      () => this.nextRand(),
      this.elapsedSimTimeS,
      seg,
      this.slabPool,
    );
  }

  public applyBlast(blast: BlastEvent): void {
    if (this.destroyed) return;
    applyWoodWallRadialBlast(
      this.physicsWorld,
      this.walls,
      this.internalByWallId,
      this.splinterPools,
      () => this.nextRand(),
      blast,
      this.slabPool,
    );
  }

  public reset(): void {
    if (this.destroyed) return;
    for (let i = 0; i < this.walls.length; i++) {
      const wall = this.walls[i];
      const internal = this.internalByWallId.get(wall.id);
      if (internal) {
        internal.activeVolley = null;
        let hadBrokenStud = false;
        for (let c = 0; c < internal.studColumns.length; c++) {
          const col = internal.studColumns[c];
          if (col.isBorderPost) continue;
          for (let s = 0; s < col.sections.length; s++) {
            if (col.sections[s].broken || col.sections[s].hp < STUD_SECTION_MAX_HP) {
              if (col.sections[s].broken) {
                hadBrokenStud = true;
              }
              col.sections[s].broken = false;
              col.sections[s].hp = STUD_SECTION_MAX_HP;
            }
          }
        }
        wall.panelState.studAnchors = buildStudAnchorsFromColumns(internal.studColumns);
        if (hadBrokenStud) {
          rebuildWallStudColliders(this.physicsWorld, wall, internal);
          uploadWallStudFrameMesh(wall, internal);
        }
      }

      resetWoodPanelState(wall.panelState);
      const stats = triangulateWoodPanelToBuffers(wall.panelState, wall.scratchBuffers);
      uploadWallPanelMesh(wall, stats);
    }
    for (let i = 0; i < this.splinterPools.length; i++) {
      this.splinterPools[i].clear();
    }
    this.slabPool.clear();
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    for (let i = 0; i < this.walls.length; i++) {
      const wall = this.walls[i];
      this.physicsWorld.removeCollider(wall.drywallColliderHandle);
      for (let s = 0; s < wall.studColliderHandles.length; s++) {
        this.physicsWorld.removeCollider(wall.studColliderHandles[s]);
      }
      wall.rootEntity.destroy();
      wall.panelMesh.destroy();
      wall.studFrameMesh.destroy();
    }
    this.walls.length = 0;
    this.wallsById.clear();
    this.internalByWallId.clear();

    for (let i = 0; i < this.splinterPools.length; i++) {
      this.splinterPools[i].destroy();
    }
    this.slabPool.destroy();

    for (let i = 0; i < this.ownedSplinterMeshes.length; i++) {
      this.ownedSplinterMeshes[i].destroy();
    }
    this.ownedSplinterMeshes.length = 0;

    for (let i = 0; i < this.ownedMaterials.length; i++) {
      this.ownedMaterials[i].destroy();
    }
    this.ownedMaterials.length = 0;

    for (let i = 0; i < this.ownedTextures.length; i++) {
      this.ownedTextures[i].destroy();
    }
    this.ownedTextures.length = 0;
  }

  public getWallRemainingAreaM2(wallId: string): number {
    const wall = this.wallsById.get(wallId);
    if (!wall) return 0;
    return computePanelRemainingAreaM2(wall.panelState);
  }

  private nextRand(): number {
    let z = (this.splinterRngState = (this.splinterRngState + 0x6d2b79f5) >>> 0);
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  }
}
