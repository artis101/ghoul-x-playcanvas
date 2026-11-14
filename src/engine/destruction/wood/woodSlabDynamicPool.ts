import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { ColliderSurfaceTag, QuatLike } from '../../../contracts/destruction.ts';
import type { ExtrudedWoodSlabMesh } from '../../../core/destruction/woodPolygonClipper.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import type { WoodWallInstance } from './woodWallTypes.ts';
import { CombinedDebrisMeshWriter, isPoseWithinEpsilon, writeTransformedPieceVertices } from '../concrete/combinedDebrisMeshWriter.ts';

interface ActiveDynamicWoodSlab {
  wallId: string;
  slab: ExtrudedWoodSlabMesh;
  bodyHandle: number;
  baseVertex: number;
  vertexCount: number;
  baseIndex: number;
  indexCount: number;
  sleepingSynced: boolean;
  /** Pose matrix the slab's vertices were last written with. */
  uploadedPose: Float32Array;
  /** True when the slab's vertices must be rewritten, e.g. it is new or moved in the buffer. */
  verticesStale: boolean;
}

export class WoodSlabDynamicPool {
  public readonly dynamicEntity: pc.Entity;
  public readonly dynamicMesh: pc.Mesh;
  public readonly dynamicMeshInstance: pc.MeshInstance;

  private readonly maxVertices: number;
  private readonly maxIndices: number;
  private readonly meshWriter: CombinedDebrisMeshWriter;
  private readonly dynUvs: Float32Array;
  private readonly dynIndices: Uint32Array;
  private readonly scratchMat16 = new Float32Array(16);

  public readonly activeSlabs: ActiveDynamicWoodSlab[] = [];
  private topologyDirty = false;
  private activeVertCount = 0;
  private activeIndexCount = 0;

  public constructor(
    app: pc.Application,
    private readonly physicsWorld: RapierPhysicsWorld,
    panelMaterial: pc.Material,
    maxVertices = 16384,
    maxIndices = 49152,
  ) {
    this.maxVertices = maxVertices;
    this.maxIndices = maxIndices;

    this.dynUvs = new Float32Array(maxVertices * 2);
    this.dynIndices = new Uint32Array(maxIndices);

    this.meshWriter = new CombinedDebrisMeshWriter(app.graphicsDevice, maxVertices, maxIndices, this.dynUvs, this.dynIndices);
    this.dynamicMesh = this.meshWriter.mesh;

    this.dynamicMeshInstance = new pc.MeshInstance(this.dynamicMesh, panelMaterial);
    this.dynamicMeshInstance.castShadow = true;
    this.dynamicMeshInstance.receiveShadow = true;
    this.dynamicMeshInstance.cull = false;

    this.dynamicEntity = new pc.Entity('DynamicSawnWoodSlabsCombined');
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

  public get activeSlabCount(): number {
    return this.activeSlabs.length;
  }

  public spawnDroppedSlabs(
    wall: WoodWallInstance,
    slabs: readonly ExtrudedWoodSlabMesh[] | undefined,
    impulseDirWorld: Vec3Like,
    exitSignZ: number,
    kineticEnergyJ: number,
    nextRand: () => number,
  ): number {
    if (!slabs || slabs.length === 0) return 0;

    const halfY = wall.yawRad * 0.5;
    const rot: QuatLike = { x: 0, y: Math.sin(halfY), z: 0, w: Math.cos(halfY) };
    const exitPushZ = exitSignZ * (wall.thicknessM * 0.65 + 0.018);
    const speedFactor = Math.min(2.2, Math.max(0.75, Math.sqrt(Math.max(120, kineticEnergyJ) / 950)));
    let spawnedCount = 0;

    for (let i = 0; i < slabs.length; i++) {
      const slab = slabs[i];
      const vCount = slab.localPositions.length / 3;
      const iCount = slab.indices.length;
      if (vCount <= 0 || iCount <= 0 || vCount > this.maxVertices || iCount > this.maxIndices) {
        continue;
      }

      let evicted = 0;
      while (
        this.activeSlabs.length > 0 &&
        (this.activeVertCount + vCount > this.maxVertices ||
          this.activeIndexCount + iCount > this.maxIndices)
      ) {
        this.removeSlabAt(0, false);
        evicted++;
      }
      if (evicted > 0) this.repackSlabOffsets();

      const lx = slab.localCenter.x;
      const ly = slab.localCenter.y;
      const lz = slab.localCenter.z + exitPushZ;

      const worldCenter: Vec3Like = {
        x: wall.centerWorld.x + lx * wall.cosYaw + lz * wall.sinYaw,
        y: wall.centerWorld.y + ly,
        z: wall.centerWorld.z - lx * wall.sinYaw + lz * wall.cosYaw,
      };

      const fwdBoost = (1.6 + nextRand() * 1.9) * speedFactor;
      const linVel: Vec3Like = {
        x: impulseDirWorld.x * fwdBoost + exitSignZ * wall.sinYaw * 0.8 + (nextRand() - 0.5) * 0.6,
        y: Math.max(-0.3, impulseDirWorld.y * 0.5) + 0.45 + nextRand() * 0.55,
        z: impulseDirWorld.z * fwdBoost + exitSignZ * wall.cosYaw * 0.8 + (nextRand() - 0.5) * 0.6,
      };
      const angVel: Vec3Like = {
        x: (nextRand() - 0.5) * 5.5,
        y: (nextRand() - 0.5) * 4.5,
        z: (nextRand() - 0.5) * 5.5,
      };

      const tag: ColliderSurfaceTag = {
        material: 'WOOD_DRYWALL',
        objectId: `${wall.id}_slab_${this.activeSlabs.length}`,
        thicknessM: wall.thicknessM,
        penetrationResistanceJ: 145,
      };

      const spawned = this.physicsWorld.spawnDynamicConvexHull(
        worldCenter,
        slab.hullVertices,
        slab.massKg,
        linVel,
        angVel,
        rot,
        tag,
      );
      if (!spawned) continue;

      const entry: ActiveDynamicWoodSlab = {
        wallId: wall.id,
        slab,
        bodyHandle: spawned.bodyHandle,
        baseVertex: this.activeVertCount,
        vertexCount: vCount,
        baseIndex: this.activeIndexCount,
        indexCount: iCount,
        sleepingSynced: false,
        uploadedPose: new Float32Array(16),
        verticesStale: true,
      };

      this.writeStaticStreams(entry);
      this.activeSlabs.push(entry);
      this.activeVertCount += vCount;
      this.activeIndexCount += iCount;
      this.topologyDirty = true;
      spawnedCount++;
    }

    if (spawnedCount > 0) {
      this.syncFromPhysics(false);
    }
    return spawnedCount;
  }

  public syncFromPhysics(forceAll = false): void {
    if (this.activeSlabs.length === 0) {
      this.dynamicEntity.enabled = false;
      this.topologyDirty = false;
      return;
    }

    const mat = this.scratchMat16;
    const positions = this.meshWriter.positions;
    const normals = this.meshWriter.normals;

    for (let i = this.activeSlabs.length - 1; i >= 0; i--) {
      const entry = this.activeSlabs[i];
      const sleeping = this.physicsWorld.isBodySleeping(entry.bodyHandle);
      if (!forceAll && !entry.verticesStale && sleeping && entry.sleepingSynced) continue;

      const ok = this.physicsWorld.writeBodyMatrix4(entry.bodyHandle, mat, 0, 1, 1, 1);
      if (!ok) {
        this.removeSlabAt(i);
        continue;
      }

      if (forceAll || entry.verticesStale || !isPoseWithinEpsilon(mat, entry.uploadedPose)) {
        writeTransformedPieceVertices(mat, 1, entry.slab.localPositions, entry.slab.normals, entry.vertexCount, positions, normals, entry.baseVertex);
        entry.uploadedPose.set(mat);
        entry.verticesStale = false;
        this.meshWriter.markVerticesWritten(entry.baseVertex, entry.vertexCount);
      }
      entry.sleepingSynced = sleeping;
    }

    if (this.activeSlabs.length === 0 || this.activeVertCount === 0) {
      this.dynamicEntity.enabled = false;
      this.topologyDirty = false;
      return;
    }

    this.dynamicEntity.enabled = true;
    if (this.topologyDirty) {
      this.meshWriter.commitTopology(this.dynUvs, this.dynIndices, this.activeVertCount, this.activeIndexCount);
      this.topologyDirty = false;
    } else {
      this.meshWriter.uploadWrittenVertices();
    }
  }

  public clear(): void {
    for (let i = 0; i < this.activeSlabs.length; i++) {
      this.physicsWorld.removeBody(this.activeSlabs[i].bodyHandle);
    }
    this.activeSlabs.length = 0;
    this.activeVertCount = 0;
    this.activeIndexCount = 0;
    this.topologyDirty = true;
    this.dynamicEntity.enabled = false;
  }

  public destroy(): void {
    this.clear();
    this.dynamicEntity.destroy();
    this.meshWriter.destroy();
  }

  private writeStaticStreams(entry: ActiveDynamicWoodSlab): void {
    this.dynUvs.set(entry.slab.uvs, entry.baseVertex * 2);
    const srcIdx = entry.slab.indices;
    const baseV = entry.baseVertex;
    const baseI = entry.baseIndex;
    for (let k = 0; k < entry.indexCount; k++) {
      this.dynIndices[baseI + k] = baseV + srcIdx[k];
    }
  }

  private removeSlabAt(idx: number, repack = true): void {
    const removed = this.activeSlabs[idx];
    this.physicsWorld.removeBody(removed.bodyHandle);
    this.activeSlabs.splice(idx, 1);
    if (repack) {
      this.repackSlabOffsets();
      return;
    }
    this.activeVertCount -= removed.vertexCount;
    this.activeIndexCount -= removed.indexCount;
    this.topologyDirty = true;
  }

  private repackSlabOffsets(): void {
    let vCur = 0;
    let iCur = 0;
    for (let i = 0; i < this.activeSlabs.length; i++) {
      const e = this.activeSlabs[i];
      if (e.baseVertex !== vCur || e.baseIndex !== iCur) {
        e.baseVertex = vCur;
        e.baseIndex = iCur;
        e.sleepingSynced = false;
        e.verticesStale = true;
        this.writeStaticStreams(e);
      }
      vCur += e.vertexCount;
      iCur += e.indexCount;
    }
    this.activeVertCount = vCur;
    this.activeIndexCount = iCur;
    this.topologyDirty = true;
  }
}
