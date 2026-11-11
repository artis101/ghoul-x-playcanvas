import * as pc from 'playcanvas';
import type {
  BallisticPenetrationResult,
  BallisticSegmentImpact,
  BlastEvent,
  IDestructibleSubsystem,
} from '../../../contracts/destruction.ts';
import { GlassShardPool } from '../../../core/destruction/glassVoronoiShatter.ts';
import { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import type { GlassSystemOptions, GlassWindowCreateOptions } from './glassSystemTypes.ts';
import { createMarchingGlassAtlasTexture } from './marchingGlassAtlas.ts';
import { createWindowGlassPaneTexture } from './glassPaneTexture.ts';
import { createCrystallineTriangleShardMesh } from './glassShardMeshes.ts';
import { MarchingTileGlassWindow } from './marchingTileWindow.ts';
import { VoronoiGlassWindow } from './voronoiGlassWindow.ts';
import { applyGlassRadialBlast, handleGlassRaySegment } from './glassRayBlastSolver.ts';

export class GlassSystem implements IDestructibleSubsystem {
  public readonly id: string;
  public readonly atlasTexture: pc.Texture;
  public readonly windowGlassTexture: pc.Texture;
  public readonly instancedTrianglePool: HardwareInstancedPool;
  public readonly voronoiShardPool: GlassShardPool;
  public readonly voronoiBatchEntity: pc.Entity;
  public readonly voronoiBatchMesh: pc.Mesh;

  private readonly atlasSizePx: number;
  private readonly marchingMaterial: pc.StandardMaterial;
  private readonly voronoiIntactMaterial: pc.StandardMaterial;
  private readonly voronoiShardMaterial: pc.StandardMaterial;
  private readonly instancedTriangleMaterial: pc.StandardMaterial;
  private readonly instancedTriangleMesh: pc.Mesh;

  private readonly marchingWindowMap = new Map<string, MarchingTileGlassWindow>();
  private readonly voronoiWindowMap = new Map<string, VoronoiGlassWindow>();

  private readonly batchPositions: Float32Array;
  private readonly batchNormals: Float32Array;
  private readonly batchUvs: Float32Array;
  private readonly batchColors: Float32Array;
  private readonly batchIndices: Uint32Array;

  private destroyed = false;

  public constructor(
    private readonly app: pc.Application,
    private readonly physics: RapierPhysicsWorld,
    options: GlassSystemOptions = {},
  ) {
    this.id = options.id ?? 'glass';
    this.atlasSizePx = options.atlasSizePx ?? 512;
    const windowTexSizePx = options.windowTextureSizePx ?? 256;
    const maxInstancedTriangles = options.maxInstancedTriangles ?? 512;
    const maxVoronoiShards = options.maxVoronoiShards ?? 640;

    this.atlasTexture = createMarchingGlassAtlasTexture(app.graphicsDevice, this.atlasSizePx);
    this.windowGlassTexture = createWindowGlassPaneTexture(app.graphicsDevice, windowTexSizePx);

    this.marchingMaterial = new pc.StandardMaterial();
    this.marchingMaterial.name = 'ArmoredVoronoiGlassMaterial';
    this.marchingMaterial.diffuse.set(0.84, 0.96, 0.96);
    this.marchingMaterial.diffuseMap = this.windowGlassTexture;
    this.marchingMaterial.opacityMap = this.windowGlassTexture;
    this.marchingMaterial.opacityMapChannel = 'a';
    this.marchingMaterial.emissive.set(0.18, 0.30, 0.32);
    this.marchingMaterial.emissiveMap = this.windowGlassTexture;
    this.marchingMaterial.useMetalness = true;
    this.marchingMaterial.metalness = 0.16;
    this.marchingMaterial.gloss = 0.95;
    this.marchingMaterial.blendType = pc.BLEND_NORMAL;
    this.marchingMaterial.depthWrite = false;
    this.marchingMaterial.cull = pc.CULLFACE_NONE;
    this.marchingMaterial.diffuseVertexColor = true;
    this.marchingMaterial.opacityVertexColor = true;
    this.marchingMaterial.update();

    this.voronoiIntactMaterial = new pc.StandardMaterial();
    this.voronoiIntactMaterial.name = 'VoronoiIntactGlassMaterial';
    this.voronoiIntactMaterial.diffuse.set(0.82, 0.94, 1.0);
    this.voronoiIntactMaterial.diffuseMap = this.windowGlassTexture;
    this.voronoiIntactMaterial.opacityMap = this.windowGlassTexture;
    this.voronoiIntactMaterial.opacityMapChannel = 'a';
    this.voronoiIntactMaterial.emissive.set(0.14, 0.24, 0.28);
    this.voronoiIntactMaterial.emissiveMap = this.windowGlassTexture;
    this.voronoiIntactMaterial.useMetalness = true;
    this.voronoiIntactMaterial.metalness = 0.18;
    this.voronoiIntactMaterial.gloss = 0.96;
    this.voronoiIntactMaterial.blendType = pc.BLEND_NORMAL;
    this.voronoiIntactMaterial.depthWrite = false;
    this.voronoiIntactMaterial.cull = pc.CULLFACE_NONE;
    this.voronoiIntactMaterial.diffuseVertexColor = true;
    this.voronoiIntactMaterial.opacityVertexColor = true;
    this.voronoiIntactMaterial.update();

    this.voronoiShardMaterial = new pc.StandardMaterial();
    this.voronoiShardMaterial.name = 'VoronoiExtrudedShardMaterial';
    this.voronoiShardMaterial.diffuse.set(0.84, 0.95, 1.0);
    this.voronoiShardMaterial.diffuseMap = this.windowGlassTexture;
    this.voronoiShardMaterial.emissive.set(0.18, 0.28, 0.34);
    this.voronoiShardMaterial.emissiveMap = this.windowGlassTexture;
    this.voronoiShardMaterial.useMetalness = true;
    this.voronoiShardMaterial.metalness = 0.2;
    this.voronoiShardMaterial.gloss = 0.96;
    this.voronoiShardMaterial.blendType = pc.BLEND_NORMAL;
    this.voronoiShardMaterial.depthWrite = false;
    this.voronoiShardMaterial.cull = pc.CULLFACE_NONE;
    this.voronoiShardMaterial.diffuseVertexColor = true;
    this.voronoiShardMaterial.opacityVertexColor = true;
    this.voronoiShardMaterial.update();

    this.instancedTriangleMaterial = new pc.StandardMaterial();
    this.instancedTriangleMaterial.name = 'InstancedGlassTriangleMaterial';
    this.instancedTriangleMaterial.diffuse.set(0.84, 0.97, 1.0);
    this.instancedTriangleMaterial.emissive.set(0.28, 0.42, 0.48);
    this.instancedTriangleMaterial.useMetalness = true;
    this.instancedTriangleMaterial.metalness = 0.22;
    this.instancedTriangleMaterial.gloss = 0.96;
    this.instancedTriangleMaterial.opacity = 0.74;
    this.instancedTriangleMaterial.blendType = pc.BLEND_NORMAL;
    this.instancedTriangleMaterial.depthWrite = false;
    this.instancedTriangleMaterial.cull = pc.CULLFACE_NONE;
    this.instancedTriangleMaterial.update();

    this.instancedTriangleMesh = createCrystallineTriangleShardMesh(app.graphicsDevice);
    this.instancedTrianglePool = new HardwareInstancedPool(
      app,
      this.instancedTriangleMesh,
      this.instancedTriangleMaterial,
      maxInstancedTriangles,
      'GlassInstancedTrianglePool',
      false,
    );

    this.voronoiShardPool = new GlassShardPool(maxVoronoiShards);
    const maxBatchVerts = maxVoronoiShards * 48;
    const maxBatchIndices = maxVoronoiShards * 96;

    this.batchPositions = new Float32Array(maxBatchVerts * 3);
    this.batchNormals = new Float32Array(maxBatchVerts * 3);
    this.batchUvs = new Float32Array(maxBatchVerts * 2);
    this.batchColors = new Float32Array(maxBatchVerts * 4);
    this.batchIndices = new Uint32Array(maxBatchIndices);

    this.voronoiBatchMesh = new pc.Mesh(app.graphicsDevice);
    this.voronoiBatchMesh.clear(true, true, maxBatchVerts, maxBatchIndices);
    this.batchNormals[2] = 1;
    this.batchNormals[5] = 1;
    this.batchNormals[8] = 1;
    this.batchIndices[0] = 0;
    this.batchIndices[1] = 1;
    this.batchIndices[2] = 2;
    this.voronoiBatchMesh.setPositions(this.batchPositions, 3, 3);
    this.voronoiBatchMesh.setNormals(this.batchNormals, 3, 3);
    this.voronoiBatchMesh.setUvs(0, this.batchUvs, 2, 3);
    this.voronoiBatchMesh.setColors(this.batchColors, 4, 3);
    this.voronoiBatchMesh.setIndices(this.batchIndices, 3);
    this.voronoiBatchMesh.update(pc.PRIMITIVE_TRIANGLES, false);

    const batchMeshInstance = new pc.MeshInstance(this.voronoiBatchMesh, this.voronoiShardMaterial);
    batchMeshInstance.cull = false;
    batchMeshInstance.castShadows = false;

    this.voronoiBatchEntity = new pc.Entity('VoronoiGlassShardsBatch');
    this.voronoiBatchEntity.addComponent('render', {
      meshInstances: [batchMeshInstance],
      castShadows: false,
      receiveShadows: false,
    });
    if (this.voronoiBatchEntity.render) {
      this.voronoiBatchEntity.render.customAabb = new pc.BoundingBox(new pc.Vec3(0, 10, -20), new pc.Vec3(80, 30, 120));
    }
    this.voronoiBatchEntity.enabled = false;
    app.root.addChild(this.voronoiBatchEntity);
  }

  public get activeInstancedTriangleCount(): number {
    return this.instancedTrianglePool.activeCount;
  }

  public get activeVoronoiShardCount(): number {
    return this.voronoiShardPool.activeCount;
  }

  public get marchingWindows(): ReadonlyArray<MarchingTileGlassWindow> {
    return Array.from(this.marchingWindowMap.values());
  }

  public get voronoiWindows(): ReadonlyArray<VoronoiGlassWindow> {
    return Array.from(this.voronoiWindowMap.values());
  }

  public createMarchingWindow(options: GlassWindowCreateOptions): MarchingTileGlassWindow {
    const win = new MarchingTileGlassWindow(
      this.app,
      this.physics,
      this.marchingMaterial,
      this.instancedTrianglePool,
      this.atlasSizePx,
      options,
      this.voronoiShardPool,
    );
    this.marchingWindowMap.set(win.id, win);
    return win;
  }

  public createVoronoiWindow(options: GlassWindowCreateOptions): VoronoiGlassWindow {
    const win = new VoronoiGlassWindow(
      this.app,
      this.physics,
      this.voronoiIntactMaterial,
      this.voronoiShardPool,
      options,
    );
    this.voronoiWindowMap.set(win.id, win);
    return win;
  }

  public getWindow(id: string): MarchingTileGlassWindow | VoronoiGlassWindow | undefined {
    return this.marchingWindowMap.get(id) ?? this.voronoiWindowMap.get(id);
  }

  public isGlassOpenAtWorldPoint(
    id: string,
    material: 'GLASS_MARCHING_256' | 'GLASS_VORONOI',
    pointWorld: { x: number; y: number; z: number },
  ): boolean {
    if (this.destroyed) return true;
    if (material === 'GLASS_MARCHING_256') {
      const win = this.marchingWindowMap.get(id);
      if (!win || win.survivingChunkCount === 0) return true;
      return win.isBrokenAtWorldPoint(pointWorld);
    }
    const win = this.voronoiWindowMap.get(id);
    if (!win || (win.shattered && win.survivingFangCount === 0)) return true;
    return win.isOpenAtWorldPoint(pointWorld);
  }

  public handleRaySegment(seg: BallisticSegmentImpact): BallisticPenetrationResult | null {
    if (this.destroyed) return null;
    return handleGlassRaySegment(
      this.physics,
      this.marchingWindowMap,
      this.voronoiWindowMap,
      this.voronoiShardPool,
      () => this.uploadVoronoiBatchedMesh(),
      seg,
    );
  }

  public applyBlast(blast: BlastEvent): void {
    if (this.destroyed) return;
    applyGlassRadialBlast(
      blast,
      this.marchingWindowMap,
      this.voronoiWindowMap,
      this.voronoiShardPool,
      () => this.uploadVoronoiBatchedMesh(),
    );
  }

  public update(dt: number): void {
    if (this.destroyed) return;
    this.instancedTrianglePool.syncFromPhysics(this.physics, dt);
    this.voronoiShardPool.step(dt);
    if (this.voronoiShardPool.dirty) {
      this.uploadVoronoiBatchedMesh();
      this.voronoiShardPool.clearDirty();
    }
  }

  public reset(): void {
    if (this.destroyed) return;
    this.instancedTrianglePool.clear();
    this.voronoiShardPool.clear();
    this.voronoiBatchEntity.enabled = false;
    for (const win of this.marchingWindowMap.values()) win.reset();
    for (const win of this.voronoiWindowMap.values()) win.reset();
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    for (const win of this.marchingWindowMap.values()) win.destroy();
    this.marchingWindowMap.clear();

    for (const win of this.voronoiWindowMap.values()) win.destroy();
    this.voronoiWindowMap.clear();

    this.instancedTrianglePool.destroy();
    this.instancedTriangleMesh.destroy();
    this.voronoiBatchEntity.destroy();
    this.voronoiBatchMesh.destroy();

    this.marchingMaterial.destroy();
    this.voronoiIntactMaterial.destroy();
    this.voronoiShardMaterial.destroy();
    this.instancedTriangleMaterial.destroy();
    this.windowGlassTexture.destroy();
    this.atlasTexture.destroy();
  }

  private uploadVoronoiBatchedMesh(): void {
    if (this.voronoiShardPool.activeCount === 0) {
      this.voronoiBatchEntity.enabled = false;
      return;
    }

    const stats = this.voronoiShardPool.writeBatchedMeshBuffers(
      this.batchPositions,
      this.batchNormals,
      this.batchUvs,
      this.batchIndices,
      this.batchColors,
    );

    if (stats.vertexCount === 0 || stats.indexCount === 0) {
      this.voronoiBatchEntity.enabled = false;
      return;
    }

    this.voronoiBatchEntity.enabled = true;
    this.voronoiBatchMesh.setPositions(this.batchPositions, 3, stats.vertexCount);
    this.voronoiBatchMesh.setNormals(this.batchNormals, 3, stats.vertexCount);
    this.voronoiBatchMesh.setUvs(0, this.batchUvs, 2, stats.vertexCount);
    this.voronoiBatchMesh.setColors(this.batchColors, 4, stats.vertexCount);
    this.voronoiBatchMesh.setIndices(this.batchIndices, stats.indexCount);
    this.voronoiBatchMesh.update(pc.PRIMITIVE_TRIANGLES, false);
  }
}
