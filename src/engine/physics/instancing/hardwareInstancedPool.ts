import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { QuatLike } from '../../../contracts/destruction.ts';
import type { RapierPhysicsWorld } from '../rapierWorld.ts';
import { DenseInstancePacker } from './denseInstancePacker.ts';
import type { OnInstanceSlotExpired, SlotLifecyclePhase } from './instancePackerTypes.ts';

export class HardwareInstancedPool {
  public readonly app: pc.Application;
  public readonly entity: pc.Entity;
  public readonly meshInstance: pc.MeshInstance;
  public readonly vertexBuffer: pc.VertexBuffer;
  public readonly maxInstances: number;
  public readonly matrixData: Float32Array;
  public onSlotExpired?: OnInstanceSlotExpired;

  private readonly packer: DenseInstancePacker;
  private readonly uploadsInPlace: boolean;
  private readonly instanceStrideBytes: number;
  private destroyed = false;

  public constructor(
    app: pc.Application,
    mesh: pc.Mesh,
    material: pc.Material,
    maxInstances: number,
    name = 'HardwareInstancedPool',
    castShadows = true
  ) {
    this.app = app;
    this.packer = new DenseInstancePacker(maxInstances);
    this.maxInstances = this.packer.maxInstances;
    this.matrixData = this.packer.matrixData;

    const instancingFormat = pc.VertexFormat.getDefaultInstancingFormat(app.graphicsDevice);
    this.vertexBuffer = new pc.VertexBuffer(app.graphicsDevice, instancingFormat, this.maxInstances, {
      usage: pc.BUFFER_DYNAMIC,
      data: this.matrixData,
    });
    this.instanceStrideBytes = instancingFormat.size;
    // The buffer keeps matrixData itself as its storage, so a ranged unlock uploads the packed matrices directly.
    const storage = this.vertexBuffer.lock();
    this.uploadsInPlace = ArrayBuffer.isView(storage)
      ? storage.buffer === this.matrixData.buffer && storage.byteOffset === this.matrixData.byteOffset
      : storage === this.matrixData.buffer;

    this.entity = new pc.Entity(name);
    this.meshInstance = new pc.MeshInstance(mesh, material);
    this.meshInstance.setInstancing(this.vertexBuffer);
    this.meshInstance.instancingCount = 0;
    this.meshInstance.cull = false;
    this.meshInstance.castShadows = castShadows;

    this.entity.addComponent('render', {
      meshInstances: [this.meshInstance],
      castShadows,
      receiveShadows: true,
    });

    if (this.entity.render) {
      this.entity.render.customAabb = new pc.BoundingBox(
        new pc.Vec3(0, 10, -20),
        new pc.Vec3(80, 30, 120)
      );
    }

    this.entity.enabled = false;
    app.root.addChild(this.entity);
  }

  public get activeCount(): number { return this.packer.activeCount; }
  public get freeSlotCount(): number { return this.packer.freeSlotCount; }
  public get dirty(): boolean { return this.packer.dirty; }
  public isSlotActive(slotId: number): boolean { return this.packer.isSlotActive(slotId); }
  public getDenseIndex(slotId: number): number { return this.packer.getDenseIndex(slotId); }
  public getSlotPhase(slotId: number): SlotLifecyclePhase { return this.packer.getSlotPhase(slotId); }

  public allocSlot(): number {
    const slotId = this.packer.allocSlot();
    this.syncVisibilityCount();
    return slotId;
  }

  public freeSlot(slotId: number): boolean {
    const freed = this.packer.freeSlot(slotId);
    if (freed) this.syncVisibilityCount();
    return freed;
  }

  public setSlotMatrix(slotId: number, matrix16: ArrayLike<number>, srcOffset = 0): boolean {
    return this.packer.setSlotMatrix(slotId, matrix16, srcOffset);
  }

  public setSlotTRS(slotId: number, pos: Vec3Like, quat?: QuatLike, scale?: Vec3Like): boolean {
    return this.packer.setSlotTRS(slotId, pos, quat, scale);
  }

  public bindSlotToRapierBody(
    slotId: number,
    bodyHandle: number,
    scale?: Vec3Like,
    ttlSeconds = 0,
    localOffset?: Vec3Like
  ): boolean {
    return this.packer.bindSlotToRapierBody(slotId, bodyHandle, scale, ttlSeconds, localOffset);
  }

  public spawnKinematicParticle(
    pos: Vec3Like,
    vel: Vec3Like,
    angVel: Vec3Like,
    scale: Vec3Like,
    gravityY = -9.81,
    floorBounceRestitution = 0.3,
    ttlSeconds = 2.5,
    quat?: QuatLike
  ): number {
    const slotId = this.packer.spawnKinematicParticle(
      pos, vel, angVel, scale, gravityY, floorBounceRestitution, ttlSeconds, quat
    );
    this.syncVisibilityCount();
    return slotId;
  }

  public syncFromPhysics(
    rapierWorld: RapierPhysicsWorld | null,
    dt: number,
    onSlotExpired?: OnInstanceSlotExpired
  ): void {
    if (this.destroyed) return;
    this.packer.syncFromPhysics(rapierWorld, dt, onSlotExpired ?? this.onSlotExpired);
    this.upload();
  }

  public upload(): void {
    if (this.destroyed) return;
    const count = this.packer.activeCount;
    this.entity.enabled = count > 0;
    this.meshInstance.instancingCount = count;

    if (this.packer.dirty) {
      if (count > 0) {
        if (this.uploadsInPlace) {
          this.vertexBuffer.unlock(0, count * this.instanceStrideBytes);
        } else {
          this.vertexBuffer.setData(this.matrixData.buffer as ArrayBuffer);
        }
      }
      this.packer.clearDirty();
    }
  }

  public clear(rapierWorld?: RapierPhysicsWorld | null): void {
    if (this.destroyed) return;
    this.packer.clear(rapierWorld);
    this.syncVisibilityCount();
    this.packer.clearDirty();
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.packer.clear();
    this.meshInstance.setInstancing(null);
    this.vertexBuffer.destroy();
    this.entity.destroy();
  }

  private syncVisibilityCount(): void {
    if (this.destroyed) return;
    const count = this.packer.activeCount;
    this.entity.enabled = count > 0;
    this.meshInstance.instancingCount = count;
  }
}
