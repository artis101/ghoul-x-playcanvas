import * as pc from 'playcanvas';
import type {
  BallisticPenetrationResult,
  BallisticSegmentImpact,
  BlastEvent,
  IDestructibleSubsystem,
  QuatLike,
} from '../../contracts/destruction.ts';
import {
  createRuntimeConnectivityGraph,
  type WallTransformLike,
} from '../../core/destruction/connectivityGraph.ts';
import {
  buildVoronoiWallDataFromImportedMeshes,
  generateVoronoiWallData,
  type ImportedVoronoiChunkMesh,
  type VoronoiWallData,
} from '../../core/destruction/voronoiWallGenerator.ts';
import { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import { PomCraterDecalSystem } from './pomCraterDecals.ts';
import { ConcreteDynamicChunkPool } from './concrete/concreteDynamicPool.ts';
import {
  applyConcreteBlast,
  createStaticChunkColliders,
  handleConcreteRaySegment,
  rebuildWallMultiDraw,
  releaseWallPhysicsAndDynamicChunks,
} from './concrete/concreteImpactSolver.ts';
import { createProceduralConcreteMaterial } from './concrete/concreteMaterial.ts';
import {
  type ConcreteWallConfig,
  type ConcreteWallInstanceState,
  type ConcreteWallSystemOptions,
  IDENTITY_QUAT,
} from './concrete/concreteWallTypes.ts';

export * from './concrete/concreteWallTypes.ts';
export * from './concrete/concreteMaterial.ts';
export * from './concrete/concreteDynamicPool.ts';
export * from './concrete/concreteImpactSolver.ts';

/**
 * Voronoi MultiDraw Concrete Wall Destruction Subsystem (`IDestructibleSubsystem`).
 *
 * - Packs all Voronoi chunks of each intact concrete wall into ONE single combined `pc.Mesh`
 *   and toggles intact sub-chunks on/off in ONE draw call via PlayCanvas 2.4 `setMultiDraw`.
 * - Renders all detached dynamic convex-hull concrete chunks across all walls in ONE pooled
 *   `BUFFER_DYNAMIC` combined `pc.Mesh` transformed in-place via `rapierWorld.writeBodyMatrix4`
 *   (zero per-chunk `pc.Entity`!).
 * - Non-explosive rifle/pistol hits (`handleRaySegment`) NEVER fracture concrete chunks —
 *   instead they delegate to `PomCraterDecalSystem` + concrete spall chips and stop cleanly.
 */
export class ConcreteWallSystem implements IDestructibleSubsystem {
  public readonly id: string;
  public readonly app: pc.Application;
  public readonly rapierWorld: RapierPhysicsWorld;
  public readonly concreteMaterial: pc.StandardMaterial;
  public readonly pomDecals: PomCraterDecalSystem;

  private readonly pool: ConcreteDynamicChunkPool;
  private readonly wallsById = new Map<string, ConcreteWallInstanceState>();
  private readonly ownsMaterial: boolean;
  private readonly ownedDiffuseTexture: pc.Texture | null;
  private readonly ownsPomDecals: boolean;
  private rngState = 0x27d4eb2f;
  private destroyed = false;

  public constructor(
    app: pc.Application,
    rapierWorld: RapierPhysicsWorld,
    options: ConcreteWallSystemOptions = {}
  ) {
    this.id = options.id ?? 'concrete-wall-system';
    this.app = app;
    this.rapierWorld = rapierWorld;

    const device = app.graphicsDevice;
    if (options.material) {
      this.concreteMaterial = options.material;
      this.ownedDiffuseTexture = null;
      this.ownsMaterial = false;
    } else {
      const created = createProceduralConcreteMaterial(device);
      this.concreteMaterial = created.material;
      this.ownedDiffuseTexture = created.diffuseTexture;
      this.ownsMaterial = true;
    }

    if (options.pomDecalSystem) {
      this.pomDecals = options.pomDecalSystem;
      this.ownsPomDecals = false;
    } else {
      this.pomDecals = new PomCraterDecalSystem(app);
      this.ownsPomDecals = true;
    }

    this.pomDecals.registerConcreteMaterial(this.concreteMaterial);

    this.pool = new ConcreteDynamicChunkPool(
      app,
      rapierWorld,
      this.concreteMaterial,
      options.maxDynamicVertices,
      options.maxDynamicIndices
    );
  }

  public get dynamicEntity(): pc.Entity {
    return this.pool.dynamicEntity;
  }

  public get dynamicMesh(): pc.Mesh {
    return this.pool.dynamicMesh;
  }

  public get dynamicMeshInstance(): pc.MeshInstance {
    return this.pool.dynamicMeshInstance;
  }

  public get wallCount(): number {
    return this.wallsById.size;
  }

  public get activeDetachedChunkCount(): number {
    return this.pool.activeDetachedChunkCount;
  }

  public getWall(wallId: string): ConcreteWallInstanceState | undefined {
    return this.wallsById.get(wallId);
  }

  public addConcreteWall(config: ConcreteWallConfig): ConcreteWallInstanceState {
    if (this.destroyed) {
      throw new Error('Cannot add concrete wall to destroyed ConcreteWallSystem.');
    }
    if (this.wallsById.has(config.wallId)) {
      this.removeConcreteWall(config.wallId);
    }

    let voronoiData: VoronoiWallData;
    if (config.voronoiData) {
      voronoiData = config.voronoiData;
    } else if (config.importedChunks) {
      voronoiData = buildVoronoiWallDataFromImportedMeshes(
        config.importedChunks.meshes,
        config.importedChunks.connectivity
      );
    } else {
      voronoiData = generateVoronoiWallData(
        config.wallId,
        config.width ?? 3.2,
        config.height ?? 2.2,
        config.depth ?? 0.28,
        config.cellCount ?? 30,
        config.seed ?? 1337,
        config.bondStrengthPerSqM ?? 18000
      );
    }

    const runtimeGraph = createRuntimeConnectivityGraph(voronoiData.connectivity);
    const chunkCount = voronoiData.chunks.length;
    const rot = config.rotation ? { ...config.rotation } : { ...IDENTITY_QUAT };
    const transform: WallTransformLike = {
      position: { ...config.position },
      rotation: rot,
    };

    const combined = voronoiData.combinedBuffer;
    const intactMesh = new pc.Mesh(this.app.graphicsDevice);
    intactMesh.clear(false, false, combined.totalVertices, combined.totalIndices);
    intactMesh.setPositions(combined.positions, 3, combined.totalVertices);
    intactMesh.setNormals(combined.normals, 3, combined.totalVertices);
    intactMesh.setUvs(0, combined.uvs, 2, combined.totalVertices);
    intactMesh.setIndices(combined.indices, combined.totalIndices);
    intactMesh.update(pc.PRIMITIVE_TRIANGLES, true);

    const intactMeshInstance = new pc.MeshInstance(intactMesh, this.concreteMaterial);
    intactMeshInstance.castShadows = true;

    const drawCommands = intactMeshInstance.setMultiDraw(null, Math.max(1, chunkCount));

    const intactEntity = new pc.Entity(`ConcreteWallIntact_${config.wallId}`);
    intactEntity.setPosition(config.position.x, config.position.y, config.position.z);
    intactEntity.setRotation(rot.x, rot.y, rot.z, rot.w);
    intactEntity.addComponent('render', {
      meshInstances: [intactMeshInstance],
      castShadows: true,
      receiveShadows: true,
    });
    this.app.root.addChild(intactEntity);

    const state: ConcreteWallInstanceState = {
      wallId: config.wallId,
      transform,
      voronoiData,
      graph: runtimeGraph,
      intactEntity,
      intactMesh,
      intactMeshInstance,
      drawCommands,
      staticColliderHandles: new Float64Array(chunkCount).fill(-1),
      dynamicBodyHandles: new Float64Array(chunkCount).fill(-1),
      dynamicDebrisTtlS: config.dynamicChunkTtlS ?? 0,
      activeIntactChunkCount: 0,
      detachedChunkCount: 0,
    };

    createStaticChunkColliders(state, this.rapierWorld);
    rebuildWallMultiDraw(state);
    this.wallsById.set(config.wallId, state);
    return state;
  }

  public async loadConcreteWallFromGlb(
    config: ConcreteWallConfig & {
      glbUrl?: string;
      connectivityJsonUrl?: string;
    }
  ): Promise<ConcreteWallInstanceState> {
    const glbUrl = config.glbUrl ?? '/models/concrete_wall_fractured.glb';
    const jsonUrl =
      config.connectivityJsonUrl ?? '/models/concrete_wall_connectivity.json';

    if (typeof fetch === 'function') {
      try {
        const jsonResp = await fetch(jsonUrl);
        if (jsonResp.ok) {
          const connectivityText = await jsonResp.text();
          const containerAsset = await new Promise<pc.Asset>((resolve, reject) => {
            const asset = new pc.Asset(
              `${config.wallId}_glb`,
              'container',
              { url: glbUrl }
            );
            this.app.assets.add(asset);
            asset.once('load', () => resolve(asset));
            asset.once('error', (err: string) => reject(new Error(err)));
            this.app.assets.load(asset);
          });

          const resource = containerAsset.resource as pc.ContainerResource | null;
          const renders = resource ? resource.renders : [];
          if (renders && renders.length > 0) {
            const importedMeshes: ImportedVoronoiChunkMesh[] = [];
            for (let r = 0; r < renders.length; r++) {
              const renderRes = renders[r].resource as { meshes?: pc.Mesh[] } | null | undefined;
              const meshes = renderRes?.meshes ?? [];
              for (let m = 0; m < meshes.length; m++) {
                const pcMesh = meshes[m];
                const vCount = pcMesh.vertexBuffer.numVertices;
                const pos = new Float32Array(vCount * 3);
                const norm = new Float32Array(vCount * 3);
                const uvs = new Float32Array(vCount * 2);
                pcMesh.getPositions(pos);
                pcMesh.getNormals(norm);
                pcMesh.getUvs(0, uvs);

                const iCount = pcMesh.indexBuffer[0]?.numIndices ?? 0;
                const idx = new Uint32Array(Math.max(3, iCount));
                pcMesh.getIndices(idx);

                importedMeshes.push({
                  positions: pos,
                  normals: norm,
                  uvs,
                  indices: idx,
                  positionsAreWallLocal: false,
                });
              }
            }

            if (importedMeshes.length > 0) {
              return this.addConcreteWall({
                ...config,
                importedChunks: {
                  meshes: importedMeshes,
                  connectivity: connectivityText,
                },
              });
            }
          }
        }
      } catch {
        // Fall through cleanly to procedural 3D Voronoi fracture
      }
    }

    return this.addConcreteWall(config);
  }

  public removeConcreteWall(wallId: string): void {
    const wall = this.wallsById.get(wallId);
    if (!wall) return;
    releaseWallPhysicsAndDynamicChunks(wall, this.rapierWorld, this.pool, this.wallsById);
    wall.intactEntity.destroy();
    wall.intactMesh.destroy();
    this.wallsById.delete(wallId);
  }

  public handleRaySegment(seg: BallisticSegmentImpact): BallisticPenetrationResult | null {
    if (this.destroyed) return null;
    return handleConcreteRaySegment(seg, this.wallsById, this.rapierWorld, this.pomDecals);
  }

  public applyBlast(blast: BlastEvent): void {
    if (this.destroyed) return;
    applyConcreteBlast(blast, this.wallsById, this.pool, this.pomDecals, () => this.nextRandom());
  }

  public update(dt: number): void {
    if (this.destroyed) return;
    this.pool.syncDynamicCombinedMesh(dt, false, this.wallsById);
    this.pomDecals.update(this.rapierWorld, dt);
  }

  public reset(): void {
    if (this.destroyed) return;
    if (this.ownsPomDecals) {
      this.pomDecals.clear();
    }
    this.pool.reset();
    for (const wall of this.wallsById.values()) {
      releaseWallPhysicsAndDynamicChunks(wall, this.rapierWorld, this.pool, this.wallsById);
      wall.graph = createRuntimeConnectivityGraph(wall.voronoiData.connectivity);
      createStaticChunkColliders(wall, this.rapierWorld);
      rebuildWallMultiDraw(wall);
    }
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const wall of this.wallsById.values()) {
      releaseWallPhysicsAndDynamicChunks(wall, this.rapierWorld, this.pool, this.wallsById);
      wall.intactEntity.destroy();
      wall.intactMesh.destroy();
    }
    this.wallsById.clear();
    this.pool.destroy();

    if (this.ownsPomDecals) {
      this.pomDecals.destroy();
    }
    if (this.ownsMaterial) {
      this.concreteMaterial.destroy();
    }
    if (this.ownedDiffuseTexture) {
      this.ownedDiffuseTexture.destroy();
    }
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
