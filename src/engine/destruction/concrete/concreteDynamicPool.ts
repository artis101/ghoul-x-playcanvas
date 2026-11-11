import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { ColliderSurfaceTag } from '../../../contracts/destruction.ts';
import { localToWorldPoint } from '../../../core/destruction/connectivityGraph.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import {
  type ActiveDynamicConcreteChunk,
  type ConcreteWallInstanceState,
  IDENTITY_QUAT,
} from './concreteWallTypes.ts';

export class ConcreteDynamicChunkPool {
  public readonly dynamicEntity: pc.Entity;
  public readonly dynamicMesh: pc.Mesh;
  public readonly dynamicMeshInstance: pc.MeshInstance;

  public readonly maxDynamicVertices: number;
  public readonly maxDynamicIndices: number;
  private readonly dynPositions: Float32Array;
  private readonly dynNormals: Float32Array;
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

    this.dynPositions = new Float32Array(maxDynamicVertices * 3);
    this.dynNormals = new Float32Array(maxDynamicVertices * 3);
    this.dynUvs = new Float32Array(maxDynamicVertices * 2);
    this.dynIndices = new Uint32Array(maxDynamicIndices);

    this.dynamicMesh = new pc.Mesh(app.graphicsDevice);
    this.dynamicMesh.setPositions(this.dynPositions, 3, 0);
    this.dynamicMesh.setNormals(this.dynNormals, 3, 0);
    this.dynamicMesh.setUvs(0, this.dynUvs, 2, 0);
    this.dynamicMesh.setIndices(this.dynIndices, 0);
    this.dynamicMesh.update(pc.PRIMITIVE_TRIANGLES, false);

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
    spawnOffsetWorld?: Vec3Like
  ): void {
    const staticCol = wall.staticColliderHandles[chunkIndex];
    if (staticCol >= 0) {
      this.rapierWorld.removeCollider(staticCol);
      wall.staticColliderHandles[chunkIndex] = -1;
    }

    if (wall.dynamicBodyHandles[chunkIndex] >= 0) return;

    const chunk = wall.voronoiData.chunks[chunkIndex];
    const vCount = chunk.localPositions.length / 3;
    const iCount = chunk.indices.length;
    if (vCount === 0 || iCount === 0) return;

    while (
      this.activeDynamicChunks.length > 0 &&
      (this.activeDynVertCount + vCount > this.maxDynamicVertices ||
        this.activeDynIndexCount + iCount > this.maxDynamicIndices)
    ) {
      this.removeDynamicChunkEntryAt(0, wallsById);
    }

    if (
      this.activeDynVertCount + vCount > this.maxDynamicVertices ||
      this.activeDynIndexCount + iCount > this.maxDynamicIndices
    ) {
      return;
    }

    const rot = wall.transform.rotation ?? IDENTITY_QUAT;
    const baseWorldCenter = localToWorldPoint(chunk.localCenter, wall.transform);
    const worldCenter: Vec3Like = spawnOffsetWorld
      ? {
          x: baseWorldCenter.x + spawnOffsetWorld.x,
          y: baseWorldCenter.y + spawnOffsetWorld.y,
          z: baseWorldCenter.z + spawnOffsetWorld.z,
        }
      : baseWorldCenter;

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
    if (!spawned) return;

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

  public writeChunkStaticStreams(entry: ActiveDynamicConcreteChunk): void {
    this.dynUvs.set(entry.chunk.uvs, entry.baseVertex * 2);
    const srcIdx = entry.chunk.indices;
    const baseV = entry.baseVertex;
    const baseI = entry.baseIndex;
    for (let k = 0; k < entry.indexCount; k++) {
      this.dynIndices[baseI + k] = baseV + srcIdx[k];
    }
  }

  public removeDynamicChunkEntryAt(idx: number, wallsById?: Map<string, ConcreteWallInstanceState>): void {
    const removed = this.activeDynamicChunks[idx];
    this.rapierWorld.removeBody(removed.bodyHandle);
    if (wallsById) {
      const ownerWall = wallsById.get(removed.wallId);
      if (ownerWall && ownerWall.dynamicBodyHandles[removed.chunkIndex] === removed.bodyHandle) {
        ownerWall.dynamicBodyHandles[removed.chunkIndex] = -1;
      }
    }

    this.activeDynamicChunks.splice(idx, 1);
    this.repackAllDynamicChunkOffsets();
  }

  public repackAllDynamicChunkOffsets(): void {
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

  public syncDynamicCombinedMesh(dt: number, forceTransformAll: boolean, wallsById?: Map<string, ConcreteWallInstanceState>): void {
    const stepDt = dt > 0 && Number.isFinite(dt) ? Math.min(dt, 0.1) : 0;

    if (stepDt > 0) {
      for (let i = this.activeDynamicChunks.length - 1; i >= 0; i--) {
        const entry = this.activeDynamicChunks[i];
        if (entry.ttlS > 0) {
          entry.ageS += stepDt;
          if (entry.ageS >= entry.ttlS) {
            this.removeDynamicChunkEntryAt(i, wallsById);
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

      const ok = this.rapierWorld.writeBodyMatrix4(entry.bodyHandle, mat, 0, shrink, shrink, shrink);
      if (!ok) {
        this.removeDynamicChunkEntryAt(i, wallsById);
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
    this.dynamicMesh.destroy();
  }
}
