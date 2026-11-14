import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { ColliderSurfaceTag } from '../../../contracts/destruction.ts';
import { localToWorldPoint } from '../../../core/destruction/connectivityGraph.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import {
  type ActiveDynamicConcreteChunk,
  ConcreteChunkPhase,
  type ConcreteWallInstanceState,
  IDENTITY_QUAT,
} from './concreteWallTypes.ts';
import { CombinedDebrisMeshWriter, isPoseWithinEpsilon, writeTransformedPieceVertices } from './combinedDebrisMeshWriter.ts';

export class ConcreteDynamicChunkPool {
  public readonly dynamicEntity: pc.Entity;
  public readonly dynamicMesh: pc.Mesh;
  public readonly dynamicMeshInstance: pc.MeshInstance;

  public readonly maxDynamicVertices: number;
  public readonly maxDynamicIndices: number;
  private readonly meshWriter: CombinedDebrisMeshWriter;
  private readonly dynUvs: Float32Array;
  private readonly dynIndices: Uint32Array;
  private readonly scratchMat16 = new Float32Array(16);

  public readonly activeDynamicChunks: ActiveDynamicConcreteChunk[] = [];
  public dynamicTopologyDirty = false;
  public activeDynVertCount = 0;
  public activeDynIndexCount = 0;

  constructor(
    private readonly app: pc.Application,
    public readonly rapierWorld: RapierPhysicsWorld,
    concreteMaterial: pc.StandardMaterial,
    maxDynamicVertices = 16384,
    maxDynamicIndices = 49152
  ) {
    this.maxDynamicVertices = maxDynamicVertices;
    this.maxDynamicIndices = maxDynamicIndices;

    this.dynUvs = new Float32Array(maxDynamicVertices * 2);
    this.dynIndices = new Uint32Array(maxDynamicIndices);

    this.meshWriter = new CombinedDebrisMeshWriter(app.graphicsDevice, maxDynamicVertices, maxDynamicIndices, this.dynUvs, this.dynIndices);
    this.dynamicMesh = this.meshWriter.mesh;

    this.dynamicMeshInstance = new pc.MeshInstance(this.dynamicMesh, concreteMaterial);
    this.dynamicMeshInstance.castShadow = true;
    this.dynamicMeshInstance.receiveShadow = true;
    this.dynamicMeshInstance.cull = false;

    this.dynamicEntity = new pc.Entity('DynamicConcreteChunksCombined');
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

  public get activeDetachedChunkCount(): number {
    return this.activeDynamicChunks.length;
  }

  public detachChunkToDynamicPool(
    wall: ConcreteWallInstanceState,
    chunkIndex: number,
    linVel: Vec3Like,
    angVel: Vec3Like,
    wallsById: Map<string, ConcreteWallInstanceState>,
    spawnOffsetWorld?: Vec3Like,
    onOverflowEvicted?: (worldCenter: Vec3Like, linVel: Vec3Like) => void
  ): void {
    const chunk = wall.voronoiData.chunks[chunkIndex];
    if (!chunk) return;
    const vCount = chunk.localPositions.length / 3;
    const iCount = chunk.indices.length;

    const staticCol = wall.staticColliderHandles[chunkIndex];
    if (staticCol >= 0) {
      this.rapierWorld.removeCollider(staticCol);
      wall.staticColliderHandles[chunkIndex] = -1;
    }

    if (wall.dynamicBodyHandles[chunkIndex] >= 0) return;

    const rot = wall.transform.rotation ?? IDENTITY_QUAT;
    const baseWorldCenter = localToWorldPoint(chunk.localCenter, wall.transform);
    const worldCenter: Vec3Like = spawnOffsetWorld
      ? {
          x: baseWorldCenter.x + spawnOffsetWorld.x,
          y: baseWorldCenter.y + spawnOffsetWorld.y,
          z: baseWorldCenter.z + spawnOffsetWorld.z,
        }
      : baseWorldCenter;

    if (vCount === 0 || iCount === 0) {
      wall.chunkPhase[chunkIndex] = ConcreteChunkPhase.EVICTED_DESTROYED;
      return;
    }

    let evicted = 0;
    while (
      this.activeDynamicChunks.length > 0 &&
      (this.activeDynVertCount + vCount > this.maxDynamicVertices ||
        this.activeDynIndexCount + iCount > this.maxDynamicIndices)
    ) {
      this.removeDynamicChunkEntryAt(0, wallsById, false);
      evicted++;
    }
    if (evicted > 0) this.repackAllDynamicChunkOffsets();

    if (
      this.activeDynVertCount + vCount > this.maxDynamicVertices ||
      this.activeDynIndexCount + iCount > this.maxDynamicIndices
    ) {
      wall.chunkPhase[chunkIndex] = ConcreteChunkPhase.EVICTED_DESTROYED;
      onOverflowEvicted?.(worldCenter, linVel);
      return;
    }

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
      rot,
      dynamicTag
    );
    if (!spawned) {
      wall.chunkPhase[chunkIndex] = ConcreteChunkPhase.EVICTED_DESTROYED;
      return;
    }

    wall.dynamicBodyHandles[chunkIndex] = spawned.bodyHandle;
    wall.chunkPhase[chunkIndex] = ConcreteChunkPhase.DYNAMIC_ACTIVE;

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
      phase: ConcreteChunkPhase.DYNAMIC_ACTIVE,
      uploadedPose: new Float32Array(16),
      verticesStale: true,
    };

    this.writeChunkStaticStreams(entry);
    this.activeDynamicChunks.push(entry);
    this.activeDynVertCount += vCount;
    this.activeDynIndexCount += iCount;
    this.dynamicTopologyDirty = true;
  }

  public writeChunkStaticStreams(entry: ActiveDynamicConcreteChunk): void {
    this.dynUvs.set(entry.chunk.uvs, entry.baseVertex * 2);
    const srcIdx = entry.chunk.indices;
    const baseV = entry.baseVertex;
    const baseI = entry.baseIndex;
    for (let k = 0; k < entry.indexCount; k++) {
      this.dynIndices[baseI + k] = baseV + srcIdx[k];
    }
  }

  /** With repack=false the caller must call repackAllDynamicChunkOffsets before the next mesh write. */
  public removeDynamicChunkEntryAt(idx: number, wallsById?: Map<string, ConcreteWallInstanceState>, repack = true): void {
    const removed = this.activeDynamicChunks[idx];
    this.rapierWorld.removeBody(removed.bodyHandle);
    removed.phase = ConcreteChunkPhase.EVICTED_DESTROYED;
    if (wallsById) {
      const ownerWall = wallsById.get(removed.wallId);
      if (ownerWall) {
        if (ownerWall.dynamicBodyHandles[removed.chunkIndex] === removed.bodyHandle) {
          ownerWall.dynamicBodyHandles[removed.chunkIndex] = -1;
        }
        ownerWall.chunkPhase[removed.chunkIndex] = ConcreteChunkPhase.EVICTED_DESTROYED;
      }
    }

    this.activeDynamicChunks.splice(idx, 1);
    if (repack) {
      this.repackAllDynamicChunkOffsets();
    } else {
      this.activeDynVertCount -= removed.vertexCount;
      this.activeDynIndexCount -= removed.indexCount;
      this.dynamicTopologyDirty = true;
    }
  }

  public repackAllDynamicChunkOffsets(): void {
    let vCursor = 0;
    let iCursor = 0;
    for (let i = 0; i < this.activeDynamicChunks.length; i++) {
      const entry = this.activeDynamicChunks[i];
      if (entry.baseVertex !== vCursor || entry.baseIndex !== iCursor) {
        entry.baseVertex = vCursor;
        entry.baseIndex = iCursor;
        entry.sleepingSynced = false;
        entry.verticesStale = true;
        this.writeChunkStaticStreams(entry);
      }
      vCursor += entry.vertexCount;
      iCursor += entry.indexCount;
    }
    this.activeDynVertCount = vCursor;
    this.activeDynIndexCount = iCursor;
    this.dynamicTopologyDirty = true;
  }

  public syncDynamicCombinedMesh(dt: number, forceTransformAll: boolean, wallsById?: Map<string, ConcreteWallInstanceState>): void {
    const stepDt = dt > 0 && Number.isFinite(dt) ? Math.min(dt, 0.1) : 0;

    if (stepDt > 0) {
      let removedByTtl = false;
      for (let i = this.activeDynamicChunks.length - 1; i >= 0; i--) {
        const entry = this.activeDynamicChunks[i];
        if (entry.ttlS > 0) {
          entry.ageS += stepDt;
          if (entry.ageS >= entry.ttlS) {
            this.removeDynamicChunkEntryAt(i, wallsById, false);
            removedByTtl = true;
          }
        }
      }
      if (removedByTtl) this.repackAllDynamicChunkOffsets();
    }

    if (this.activeDynamicChunks.length === 0) {
      this.dynamicEntity.enabled = false;
      this.dynamicTopologyDirty = false;
      return;
    }

    const mat = this.scratchMat16;

    const positions = this.meshWriter.positions;
    const normals = this.meshWriter.normals;

    for (let i = this.activeDynamicChunks.length - 1; i >= 0; i--) {
      const entry = this.activeDynamicChunks[i];
      const isSleeping = this.rapierWorld.isBodySleeping(entry.bodyHandle);

      if (!forceTransformAll && !entry.verticesStale && isSleeping && entry.sleepingSynced) {
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

      const ok = this.rapierWorld.writeBodyMatrix4(entry.bodyHandle, mat, 0, shrink, shrink, shrink);
      if (!ok) {
        this.removeDynamicChunkEntryAt(i, wallsById);
        continue;
      }

      if (forceTransformAll || entry.verticesStale || !isPoseWithinEpsilon(mat, entry.uploadedPose)) {
        writeTransformedPieceVertices(
          mat,
          shrink > 1e-4 ? 1 / shrink : 1,
          entry.chunk.localPositions,
          entry.chunk.normals,
          entry.vertexCount,
          positions,
          normals,
          entry.baseVertex,
        );
        entry.uploadedPose.set(mat);
        entry.verticesStale = false;
        this.meshWriter.markVerticesWritten(entry.baseVertex, entry.vertexCount);
      }

      entry.sleepingSynced = isSleeping && shrink >= 1;
      entry.phase =
        shrink < 1
          ? ConcreteChunkPhase.DYNAMIC_SHRINKING
          : entry.sleepingSynced
            ? ConcreteChunkPhase.DYNAMIC_SLEEPING_SYNCED
            : ConcreteChunkPhase.DYNAMIC_ACTIVE;
      if (wallsById) {
        const ownerWall = wallsById.get(entry.wallId);
        if (ownerWall) {
          ownerWall.chunkPhase[entry.chunkIndex] = entry.phase;
        }
      }
    }

    if (this.activeDynamicChunks.length === 0 || this.activeDynVertCount === 0) {
      this.dynamicEntity.enabled = false;
      this.dynamicTopologyDirty = false;
      return;
    }

    this.dynamicEntity.enabled = true;

    if (this.dynamicTopologyDirty) {
      this.meshWriter.commitTopology(this.dynUvs, this.dynIndices, this.activeDynVertCount, this.activeDynIndexCount);
      this.dynamicTopologyDirty = false;
    } else {
      this.meshWriter.uploadWrittenVertices();
    }
  }

  public reset(): void {
    for (let i = 0; i < this.activeDynamicChunks.length; i++) {
      this.rapierWorld.removeBody(this.activeDynamicChunks[i].bodyHandle);
    }
    this.activeDynamicChunks.length = 0;
    this.activeDynVertCount = 0;
    this.activeDynIndexCount = 0;
    this.dynamicTopologyDirty = true;
    this.dynamicEntity.enabled = false;
  }

  public destroy(): void {
    this.reset();
    this.dynamicEntity.destroy();
    this.meshWriter.destroy();
  }
}
