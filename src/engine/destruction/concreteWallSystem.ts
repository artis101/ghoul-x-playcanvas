import * as RAPIER from '@dimforge/rapier3d-compat';
import * as pc from 'playcanvas';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import type {
  BallisticPenetrationResult,
  BallisticSegmentImpact,
  BlastEvent,
  ChunkConnectivityGraphJson,
  ColliderSurfaceTag,
  IDestructibleSubsystem,
  QuatLike,
} from '../../contracts/destruction.ts';
import {
  createRuntimeConnectivityGraph,
  findDetachedChunkIndices,
  localToWorldPoint,
  severEdgesFromBlast,
  type RuntimeConnectivityGraph,
  type WallTransformLike,
} from '../../core/destruction/connectivityGraph.ts';
import {
  buildVoronoiWallDataFromImportedMeshes,
  generateVoronoiWallData,
  type ImportedVoronoiChunkMesh,
  type VoronoiChunkData,
  type VoronoiWallData,
} from '../../core/destruction/voronoiWallGenerator.ts';
import { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import { PomCraterDecalSystem } from './pomCraterDecals.ts';

const IDENTITY_QUAT: Readonly<QuatLike> = { x: 0, y: 0, z: 0, w: 1 };

export interface ConcreteWallConfig {
  wallId: string;
  position: Vec3Like;
  rotation?: QuatLike;
  width?: number;
  height?: number;
  depth?: number;
  cellCount?: number;
  seed?: number;
  bondStrengthPerSqM?: number;
  /** Optional pre-generated or imported Voronoi wall data. */
  voronoiData?: VoronoiWallData;
  /** Optional imported Blender chunk meshes + connectivity JSON. */
  importedChunks?: {
    meshes: readonly ImportedVoronoiChunkMesh[];
    connectivity: string | ChunkConnectivityGraphJson;
  };
  /** Optional TTL in seconds for detached dynamic chunks (0 = persist indefinitely). */
  dynamicChunkTtlS?: number;
}

export interface ConcreteWallInstanceState {
  readonly wallId: string;
  readonly transform: WallTransformLike;
  readonly voronoiData: VoronoiWallData;
  graph: RuntimeConnectivityGraph;
  readonly intactEntity: pc.Entity;
  readonly intactMesh: pc.Mesh;
  readonly intactMeshInstance: pc.MeshInstance;
  readonly drawCommands: pc.DrawCommands | undefined;
  readonly staticColliderHandles: Int32Array;
  readonly dynamicBodyHandles: Int32Array;
  readonly dynamicDebrisTtlS: number;
  activeIntactChunkCount: number;
  detachedChunkCount: number;
}

interface ActiveDynamicConcreteChunk {
  wallId: string;
  chunkIndex: number;
  chunk: VoronoiChunkData;
  bodyHandle: number;
  baseVertex: number;
  vertexCount: number;
  baseIndex: number;
  indexCount: number;
  ageS: number;
  ttlS: number;
  sleepingSynced: boolean;
}

export interface ConcreteWallSystemOptions {
  id?: string;
  material?: pc.StandardMaterial;
  pomDecalSystem?: PomCraterDecalSystem;
  maxDynamicVertices?: number;
  maxDynamicIndices?: number;
}

function createProceduralConcreteMaterial(device: pc.GraphicsDevice): {
  material: pc.StandardMaterial;
  diffuseTexture: pc.Texture;
} {
  const size = 128;
  const pixels = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let h1 = (Math.imul(x + 17, 374761393) + Math.imul(y + 31, 668265263)) >>> 0;
      h1 = Math.imul(h1 ^ (h1 >>> 13), 1274126177) >>> 0;
      const fine = ((h1 ^ (h1 >>> 16)) >>> 0) / 4294967295;

      let h2 =
        (Math.imul((x >> 2) + 5, 2246822519) + Math.imul((y >> 2) + 9, 3266489917)) >>> 0;
      h2 = Math.imul(h2 ^ (h2 >>> 15), 668265263) >>> 0;
      const coarse = ((h2 ^ (h2 >>> 13)) >>> 0) / 4294967295;

      // Subtle poured-formwork horizontal tie seam every 32 texels
      const seam = y % 32 === 0 ? -12 : 0;
      const base = Math.round(148 + (coarse - 0.5) * 24 + (fine - 0.5) * 16 + seam);
      const r = Math.max(60, Math.min(220, base));
      const g = Math.max(60, Math.min(220, base - 2));
      const b = Math.max(58, Math.min(218, base - 5));

      const p4 = (y * size + x) * 4;
      pixels[p4] = r;
      pixels[p4 + 1] = g;
      pixels[p4 + 2] = b;
      pixels[p4 + 3] = 255;
    }
  }

  const tex = new pc.Texture(device, {
    name: 'PouredConcreteAlbedo',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: pc.FILTER_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_REPEAT,
  });
  tex.lock().set(pixels);
  tex.unlock();

  const material = new pc.StandardMaterial();
  material.name = 'MultiDrawVoronoiConcreteMaterial';
  material.diffuse = new pc.Color(0.92, 0.91, 0.89);
  material.diffuseMap = tex;
  material.gloss = 0.2;
  material.update();

  return { material, diffuseTexture: tex };
}

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

  public readonly dynamicEntity: pc.Entity;
  public readonly dynamicMesh: pc.Mesh;
  public readonly dynamicMeshInstance: pc.MeshInstance;

  private readonly maxDynamicVertices: number;
  private readonly maxDynamicIndices: number;
  private readonly dynPositions: Float32Array;
  private readonly dynNormals: Float32Array;
  private readonly dynUvs: Float32Array;
  private readonly dynIndices: Uint32Array;
  private readonly scratchMat16 = new Float32Array(16);

  private readonly activeDynamicChunks: ActiveDynamicConcreteChunk[] = [];
  private dynamicTopologyDirty = false;
  private activeDynVertCount = 0;
  private activeDynIndexCount = 0;

  private readonly wallsById = new Map<string, ConcreteWallInstanceState>();
  private readonly ownsMaterial: boolean;
  private readonly ownedDiffuseTexture: pc.Texture | null;
  private readonly ownsPomDecals: boolean;
  private rngState = 0x27d4eb2f;
  private destroyed = false;

  public constructor(
    app: pc.Application,
    rapierWorld: RapierPhysicsWorld,
    options: ConcreteWallSystemOptions = {},
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

    this.maxDynamicVertices = Math.max(1024, options.maxDynamicVertices ?? 16384);
    this.maxDynamicIndices = Math.max(2048, options.maxDynamicIndices ?? 49152);

    this.dynPositions = new Float32Array(this.maxDynamicVertices * 3);
    this.dynNormals = new Float32Array(0 + this.maxDynamicVertices * 3);
    this.dynUvs = new Float32Array(this.maxDynamicVertices * 2);
    this.dynIndices = new Uint32Array(this.maxDynamicIndices);

    // Pre-allocate dynamic combined mesh streams (POSITION + NORMAL + UV0) at full capacity
    this.dynamicMesh = new pc.Mesh(device);
    this.dynamicMesh.clear(true, true, this.maxDynamicVertices, this.maxDynamicIndices);
    this.dynNormals[1] = 1;
    this.dynNormals[4] = 1;
    this.dynNormals[7] = 1;
    this.dynIndices[0] = 0;
    this.dynIndices[1] = 1;
    this.dynIndices[2] = 2;
    this.dynamicMesh.setPositions(this.dynPositions, 3, 3);
    this.dynamicMesh.setNormals(this.dynNormals, 3, 3);
    this.dynamicMesh.setUvs(0, this.dynUvs, 2, 3);
    this.dynamicMesh.setIndices(this.dynIndices, 3);
    this.dynamicMesh.update(pc.PRIMITIVE_TRIANGLES, false);

    this.dynamicMeshInstance = new pc.MeshInstance(
      this.dynamicMesh,
      this.concreteMaterial,
    );
    this.dynamicMeshInstance.cull = false;
    this.dynamicMeshInstance.castShadows = true;

    this.dynamicEntity = new pc.Entity('ConcreteDynamicCombinedChunks');
    this.dynamicEntity.addComponent('render', {
      meshInstances: [this.dynamicMeshInstance],
      castShadows: true,
      receiveShadows: true,
    });
    if (this.dynamicEntity.render) {
      this.dynamicEntity.render.customAabb = new pc.BoundingBox(
        new pc.Vec3(0, 10, -20),
        new pc.Vec3(80, 30, 120),
      );
    }
    this.dynamicEntity.enabled = false;
    app.root.addChild(this.dynamicEntity);
  }

  public get wallCount(): number {
    return this.wallsById.size;
  }

  public get activeDetachedChunkCount(): number {
    return this.activeDynamicChunks.length;
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
        config.importedChunks.connectivity,
      );
    } else {
      voronoiData = generateVoronoiWallData(
        config.wallId,
        config.width ?? 3.2,
        config.height ?? 2.2,
        config.depth ?? 0.28,
        config.cellCount ?? 30,
        config.seed ?? 1337,
        config.bondStrengthPerSqM ?? 18000,
      );
    }

    const runtimeGraph = createRuntimeConnectivityGraph(voronoiData.connectivity);
    const chunkCount = voronoiData.chunks.length;
    const rot = config.rotation ? { ...config.rotation } : { ...IDENTITY_QUAT };
    const transform: WallTransformLike = {
      position: { ...config.position },
      rotation: rot,
    };

    // Build ONE single combined static intact pc.Mesh for all Voronoi chunks of this wall
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

    // Allocate persistent MultiDraw command buffer covering all sub-chunks in 1 draw call
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
      staticColliderHandles: new Int32Array(chunkCount).fill(-1),
      dynamicBodyHandles: new Int32Array(chunkCount).fill(-1),
      dynamicDebrisTtlS: config.dynamicChunkTtlS ?? 0,
      activeIntactChunkCount: 0,
      detachedChunkCount: 0,
    };

    this.createStaticChunkColliders(state);
    this.rebuildWallMultiDraw(state);
    this.wallsById.set(config.wallId, state);
    return state;
  }

  /**
   * Loads an external Blender Voronoi-fractured `.glb` + `.json` connectivity graph
   * (e.g. `/models/concrete_wall_fractured.glb`), gracefully falling back to deterministic
   * procedural 3D Voronoi fracture if the external asset URLs are unavailable.
   */
  public async loadConcreteWallFromGlb(
    config: ConcreteWallConfig & {
      glbUrl?: string;
      connectivityJsonUrl?: string;
    },
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
              { url: glbUrl },
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
    if (!wall) {
      return;
    }
    this.releaseWallPhysicsAndDynamicChunks(wall);
    wall.intactEntity.destroy();
    wall.intactMesh.destroy();
    this.wallsById.delete(wallId);
  }

  /**
   * Non-explosive ballistic ray impacts (`handleRaySegment`) NEVER fracture or detach concrete
   * Voronoi chunks — they delegate to `PomCraterDecalSystem` + concrete spall chips and stop cleanly!
   */
  public handleRaySegment(seg: BallisticSegmentImpact): BallisticPenetrationResult | null {
    if (this.destroyed || this.wallsById.size === 0) {
      return null;
    }

    const hits = this.rapierWorld.castPenetrationRay(
      seg.originWorld,
      seg.directionWorld,
      seg.maxDistanceM,
    );

    let matchedHit: (typeof hits)[number] | null = null;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (
        (h.surface.material === 'CONCRETE_INTACT' ||
          h.surface.material === 'CONCRETE_CHUNKS') &&
        this.wallsById.has(h.surface.objectId)
      ) {
        matchedHit = h;
        break;
      }
    }

    if (!matchedHit) {
      return null;
    }

    // Delegate strictly to POM crater decal + instanced concrete spall burst (zero Voronoi fracture!)
    this.pomDecals.spawnCraterImpact(
      matchedHit.pointWorld,
      matchedHit.normalWorld,
      seg.directionWorld,
      seg.kineticEnergyJ,
      seg.caliberRadiusM,
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

  public applyBlast(blast: BlastEvent): void {
    if (this.destroyed || blast.radiusM <= 0 || blast.peakEnergyJ <= 0) {
      return;
    }

    for (const wall of this.wallsById.values()) {
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
            (blast.peakImpulseNs / Math.max(1.5, chunk.massKg)) * falloff,
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
            x: (-rz + (this.nextRandom() - 0.5)) * speed * 0.65,
            y: (this.nextRandom() - 0.5) * speed * 0.7,
            z: (rx + (this.nextRandom() - 0.5)) * speed * 0.65,
          };
        } else {
          // Unsupported upper concrete island outside blast sphere collapses under gravity
          linVel = {
            x: (this.nextRandom() - 0.5) * 0.35,
            y: -0.25,
            z: (this.nextRandom() - 0.5) * 0.35,
          };
          angVel = {
            x: (this.nextRandom() - 0.5) * 1.4,
            y: (this.nextRandom() - 0.5) * 1.1,
            z: (this.nextRandom() - 0.5) * 1.4,
          };
        }

        this.detachChunkToDynamicPool(wall, chunkIdx, linVel, angVel);
      }

      // Rebuild single-draw-call MultiDraw sub-draw list to omit detached chunks!
      this.rebuildWallMultiDraw(wall);

      this.pomDecals.spawnSpallChipBurst(
        blast.centerWorld,
        { x: 0, y: 1, z: 0 },
        { x: 0, y: -1, z: 0 },
        2.1,
        Math.min(24, newlyDetached.length * 3),
      );
    }

    if (this.dynamicTopologyDirty) {
      this.syncDynamicCombinedMesh(0, true);
    }
  }

  public update(dt: number): void {
    if (this.destroyed) {
      return;
    }
    this.syncDynamicCombinedMesh(dt, false);
    this.pomDecals.update(this.rapierWorld, dt);
  }

  public reset(): void {
    if (this.destroyed) {
      return;
    }
    if (this.ownsPomDecals) {
      this.pomDecals.clear();
    }
    for (const wall of this.wallsById.values()) {
      this.releaseWallPhysicsAndDynamicChunks(wall);
      wall.graph = createRuntimeConnectivityGraph(wall.voronoiData.connectivity);
      this.createStaticChunkColliders(wall);
      this.rebuildWallMultiDraw(wall);
    }
    this.dynamicEntity.enabled = false;
  }

  public destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    for (const wall of this.wallsById.values()) {
      this.releaseWallPhysicsAndDynamicChunks(wall);
      wall.intactEntity.destroy();
      wall.intactMesh.destroy();
    }
    this.wallsById.clear();

    this.dynamicEntity.destroy();
    this.dynamicMesh.destroy();

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

  private createStaticChunkColliders(wall: ConcreteWallInstanceState): void {
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
        const collider = this.rapierWorld.world.createCollider(hullDesc);
        this.rapierWorld.setSurfaceTag(collider.handle, tag);
        handle = collider.handle;
      } else {
        handle = this.rapierWorld.createStaticBox(
          worldCenter,
          chunk.halfExtents,
          rot,
          tag,
        );
      }

      wall.staticColliderHandles[i] = handle;
      wall.dynamicBodyHandles[i] = -1;
    }
  }

  private rebuildWallMultiDraw(wall: ConcreteWallInstanceState): void {
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

  private detachChunkToDynamicPool(
    wall: ConcreteWallInstanceState,
    chunkIndex: number,
    linVel: Vec3Like,
    angVel: Vec3Like,
  ): void {
    const staticCol = wall.staticColliderHandles[chunkIndex];
    if (staticCol >= 0) {
      this.rapierWorld.removeCollider(staticCol);
      wall.staticColliderHandles[chunkIndex] = -1;
    }

    if (wall.dynamicBodyHandles[chunkIndex] >= 0) {
      return;
    }

    const chunk = wall.voronoiData.chunks[chunkIndex];
    const vCount = chunk.localPositions.length / 3;
    const iCount = chunk.indices.length;
    if (vCount === 0 || iCount === 0) {
      return;
    }

    // Recycle oldest settled chunk if dynamic combined buffer nears capacity
    while (
      this.activeDynamicChunks.length > 0 &&
      (this.activeDynVertCount + vCount > this.maxDynamicVertices ||
        this.activeDynIndexCount + iCount > this.maxDynamicIndices)
    ) {
      this.removeDynamicChunkEntryAt(0);
    }

    if (
      this.activeDynVertCount + vCount > this.maxDynamicVertices ||
      this.activeDynIndexCount + iCount > this.maxDynamicIndices
    ) {
      return;
    }

    const rot = wall.transform.rotation ?? IDENTITY_QUAT;
    const worldCenter = localToWorldPoint(chunk.localCenter, wall.transform);

    // Scale physics convex hull to 97% so newly fractured neighboring Voronoi faces separate smoothly
    const scaledHull = new Float32Array(chunk.hullVertices.length);
    for (let k = 0; k < chunk.hullVertices.length; k++) {
      scaledHull[k] = chunk.hullVertices[k] * 0.97;
    }

    const dynamicTag: ColliderSurfaceTag = {
      material: 'CONCRETE_CHUNKS',
      objectId: wall.wallId,
      chunkIndex,
      thicknessM: chunk.halfExtents.z * 2,
      penetrationResistanceJ: 9000,
    };

    const spawned = this.rapierWorld.spawnDynamicConvexHull(
      worldCenter,
      scaledHull,
      chunk.massKg,
      linVel,
      angVel,
      dynamicTag,
      rot,
    );
    if (!spawned) {
      return;
    }

    wall.dynamicBodyHandles[chunkIndex] = spawned.bodyHandle;

    const entry: ActiveDynamicConcreteChunk = {
      wallId: wall.wallId,
      chunkIndex,
      chunk,
      bodyHandle: spawned.bodyHandle,
      baseVertex: this.activeDynVertCount,
      vertexCount: vCount,
      baseIndex: this.activeDynIndexCount,
      indexCount: iCount,
      ageS: 0,
      ttlS: wall.dynamicDebrisTtlS,
      sleepingSynced: false,
    };

    this.writeChunkStaticStreams(entry);
    this.activeDynamicChunks.push(entry);
    this.activeDynVertCount += vCount;
    this.activeDynIndexCount += iCount;
    this.dynamicTopologyDirty = true;
  }

  private writeChunkStaticStreams(entry: ActiveDynamicConcreteChunk): void {
    this.dynUvs.set(entry.chunk.uvs, entry.baseVertex * 2);
    const srcIdx = entry.chunk.indices;
    const baseV = entry.baseVertex;
    const baseI = entry.baseIndex;
    for (let k = 0; k < entry.indexCount; k++) {
      this.dynIndices[baseI + k] = baseV + srcIdx[k];
    }
  }

  private removeDynamicChunkEntryAt(idx: number): void {
    const removed = this.activeDynamicChunks[idx];
    this.rapierWorld.removeBody(removed.bodyHandle);
    const ownerWall = this.wallsById.get(removed.wallId);
    if (ownerWall && ownerWall.dynamicBodyHandles[removed.chunkIndex] === removed.bodyHandle) {
      ownerWall.dynamicBodyHandles[removed.chunkIndex] = -1;
    }

    this.activeDynamicChunks.splice(idx, 1);
    this.repackAllDynamicChunkOffsets();
  }

  private repackAllDynamicChunkOffsets(): void {
    let vCursor = 0;
    let iCursor = 0;
    for (let i = 0; i < this.activeDynamicChunks.length; i++) {
      const entry = this.activeDynamicChunks[i];
      entry.baseVertex = vCursor;
      entry.baseIndex = iCursor;
      entry.sleepingSynced = false;
      this.writeChunkStaticStreams(entry);
      vCursor += entry.vertexCount;
      iCursor += entry.indexCount;
    }
    this.activeDynVertCount = vCursor;
    this.activeDynIndexCount = iCursor;
    this.dynamicTopologyDirty = true;
  }

  private syncDynamicCombinedMesh(dt: number, forceTransformAll: boolean): void {
    const stepDt = dt > 0 && Number.isFinite(dt) ? Math.min(dt, 0.1) : 0;

    // Check TTL expirations first
    if (stepDt > 0) {
      for (let i = this.activeDynamicChunks.length - 1; i >= 0; i--) {
        const entry = this.activeDynamicChunks[i];
        if (entry.ttlS > 0) {
          entry.ageS += stepDt;
          if (entry.ageS >= entry.ttlS) {
            this.removeDynamicChunkEntryAt(i);
          }
        }
      }
    }

    if (this.activeDynamicChunks.length === 0) {
      this.dynamicEntity.enabled = false;
      this.dynamicTopologyDirty = false;
      return;
    }

    let anyTransformUpdated = this.dynamicTopologyDirty || forceTransformAll;
    const mat = this.scratchMat16;

    for (let i = this.activeDynamicChunks.length - 1; i >= 0; i--) {
      const entry = this.activeDynamicChunks[i];
      const isSleeping = this.rapierWorld.isBodySleeping(entry.bodyHandle);

      if (!forceTransformAll && !this.dynamicTopologyDirty && isSleeping && entry.sleepingSynced) {
        continue;
      }

      let shrink = 1;
      if (entry.ttlS > 0) {
        const fadeWin = Math.min(0.4, entry.ttlS * 0.2);
        const rem = entry.ttlS - entry.ageS;
        if (fadeWin > 1e-4 && rem < fadeWin) {
          shrink = Math.max(0, rem / fadeWin);
        }
      }

      const ok = this.rapierWorld.writeBodyMatrix4(
        entry.bodyHandle,
        mat,
        0,
        shrink,
        shrink,
        shrink,
      );
      if (!ok) {
        this.removeDynamicChunkEntryAt(i);
        anyTransformUpdated = true;
        continue;
      }

      const m00 = mat[0];
      const m01 = mat[1];
      const m02 = mat[2];
      const m10 = mat[4];
      const m11 = mat[5];
      const m12 = mat[6];
      const m20 = mat[8];
      const m21 = mat[9];
      const m22 = mat[10];
      const tx = mat[12];
      const ty = mat[13];
      const tz = mat[14];

      // Pure rotation normalization factor for normals if shrinking
      const invShrink = shrink > 1e-4 ? 1 / shrink : 1;
      const r00 = m00 * invShrink;
      const r01 = m01 * invShrink;
      const r02 = m02 * invShrink;
      const r10 = m10 * invShrink;
      const r11 = m11 * invShrink;
      const r12 = m12 * invShrink;
      const r20 = m20 * invShrink;
      const r21 = m21 * invShrink;
      const r22 = m22 * invShrink;

      const srcPos = entry.chunk.localPositions;
      const srcNorm = entry.chunk.normals;
      const dstOffset = entry.baseVertex * 3;
      const vLen3 = entry.vertexCount * 3;

      for (let k = 0; k < vLen3; k += 3) {
        const lx = srcPos[k];
        const ly = srcPos[k + 1];
        const lz = srcPos[k + 2];

        const d = dstOffset + k;
        this.dynPositions[d] = m00 * lx + m10 * ly + m20 * lz + tx;
        this.dynPositions[d + 1] = m01 * lx + m11 * ly + m21 * lz + ty;
        this.dynPositions[d + 2] = m02 * lx + m12 * ly + m22 * lz + tz;

        const nx = srcNorm[k];
        const ny = srcNorm[k + 1];
        const nz = srcNorm[k + 2];

        this.dynNormals[d] = r00 * nx + r10 * ny + r20 * nz;
        this.dynNormals[d + 1] = r01 * nx + r11 * ny + r21 * nz;
        this.dynNormals[d + 2] = r02 * nx + r12 * ny + r22 * nz;
      }

      entry.sleepingSynced = isSleeping && shrink >= 1;
      anyTransformUpdated = true;
    }

    if (this.activeDynamicChunks.length === 0 || this.activeDynVertCount === 0) {
      this.dynamicEntity.enabled = false;
      this.dynamicTopologyDirty = false;
      return;
    }

    this.dynamicEntity.enabled = true;

    if (anyTransformUpdated) {
      this.dynamicMesh.setPositions(this.dynPositions, 3, this.activeDynVertCount);
      this.dynamicMesh.setNormals(this.dynNormals, 3, this.activeDynVertCount);
      if (this.dynamicTopologyDirty) {
        this.dynamicMesh.setUvs(0, this.dynUvs, 2, this.activeDynVertCount);
        this.dynamicMesh.setIndices(this.dynIndices, this.activeDynIndexCount);
        this.dynamicTopologyDirty = false;
      }
      this.dynamicMesh.update(pc.PRIMITIVE_TRIANGLES, false);
    }
  }

  private releaseWallPhysicsAndDynamicChunks(wall: ConcreteWallInstanceState): void {
    for (let i = 0; i < wall.staticColliderHandles.length; i++) {
      const staticCol = wall.staticColliderHandles[i];
      if (staticCol >= 0) {
        this.rapierWorld.removeCollider(staticCol);
        wall.staticColliderHandles[i] = -1;
      }
      wall.dynamicBodyHandles[i] = -1;
    }

    let removedAny = false;
    for (let i = this.activeDynamicChunks.length - 1; i >= 0; i--) {
      if (this.activeDynamicChunks[i].wallId === wall.wallId) {
        this.rapierWorld.removeBody(this.activeDynamicChunks[i].bodyHandle);
        this.activeDynamicChunks.splice(i, 1);
        removedAny = true;
      }
    }
    if (removedAny) {
      this.repackAllDynamicChunkOffsets();
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
