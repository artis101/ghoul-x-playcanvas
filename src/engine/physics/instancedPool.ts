import * as pc from 'playcanvas';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { QuatLike } from '../../contracts/destruction.ts';
import {
  RapierPhysicsWorld,
  writeColumnMajorTrsMatrix4,
} from './rapierWorld.ts';

const SLOT_MODE_STATIC = 0;
const SLOT_MODE_RAPIER = 1;
const SLOT_MODE_KINEMATIC = 2;

const KINEMATIC_FLOOR_Y = 0.015;
const IDENTITY_QUAT: Readonly<QuatLike> = { x: 0, y: 0, z: 0, w: 1 };
const UNIT_SCALE: Readonly<Vec3Like> = { x: 1, y: 1, z: 1 };

/**
 * Pure zero-allocation dense column-major instance buffer & slot allocator.
 *
 * Keeps active 4x4 world matrices tightly packed in `matrixData[0 .. activeCount * 16)`
 * via O(1) swap-with-last removal while supporting:
 *  - Static/manual TRS slots (e.g. intact bricks in a wall)
 *  - Rapier3D dynamic rigid-body synced slots (e.g. dislodged masonry & concrete chunks)
 *  - Pure-JS ballistic/kinematic floor-bouncing debris particles (e.g. wood splinters, concrete chips, glass shards)
 */
export class DenseInstancePacker {
  public readonly maxInstances: number;
  public readonly matrixData: Float32Array;

  private count = 0;
  private freeCount: number;
  private isDirty = false;

  private readonly freeStack: Int32Array;
  private readonly slotToDense: Int32Array;
  private readonly denseToSlot: Int32Array;

  // Parallel per-dense-slot state arrays (swapped together in O(1) on freeSlot)
  private readonly denseMode: Uint8Array;
  private readonly denseBodyHandle: Int32Array;
  private readonly denseSleepingSynced: Uint8Array;

  private readonly denseScaleX: Float32Array;
  private readonly denseScaleY: Float32Array;
  private readonly denseScaleZ: Float32Array;

  private readonly densePosX: Float32Array;
  private readonly densePosY: Float32Array;
  private readonly densePosZ: Float32Array;

  private readonly denseVelX: Float32Array;
  private readonly denseVelY: Float32Array;
  private readonly denseVelZ: Float32Array;

  private readonly denseQuatX: Float32Array;
  private readonly denseQuatY: Float32Array;
  private readonly denseQuatZ: Float32Array;
  private readonly denseQuatW: Float32Array;

  private readonly denseAngVelX: Float32Array;
  private readonly denseAngVelY: Float32Array;
  private readonly denseAngVelZ: Float32Array;

  private readonly denseGravityY: Float32Array;
  private readonly denseRestitution: Float32Array;
  private readonly denseAgeS: Float32Array;
  private readonly denseTtlS: Float32Array;

  public constructor(maxInstances: number) {
    const cap = Math.max(1, Math.floor(maxInstances));
    this.maxInstances = cap;
    this.matrixData = new Float32Array(cap * 16);

    this.freeStack = new Int32Array(cap);
    this.slotToDense = new Int32Array(cap);
    this.denseToSlot = new Int32Array(cap);
    this.freeCount = cap;

    for (let i = 0; i < cap; i++) {
      // Push in reverse so allocSlot() hands out 0, 1, 2... deterministically
      this.freeStack[i] = cap - 1 - i;
      this.slotToDense[i] = -1;
      this.denseToSlot[i] = -1;
    }

    this.denseMode = new Uint8Array(cap);
    this.denseBodyHandle = new Int32Array(cap);
    this.denseSleepingSynced = new Uint8Array(cap);

    this.denseScaleX = new Float32Array(cap);
    this.denseScaleY = new Float32Array(cap);
    this.denseScaleZ = new Float32Array(cap);

    this.densePosX = new Float32Array(cap);
    this.densePosY = new Float32Array(cap);
    this.densePosZ = new Float32Array(cap);

    this.denseVelX = new Float32Array(cap);
    this.denseVelY = new Float32Array(cap);
    this.denseVelZ = new Float32Array(cap);

    this.denseQuatX = new Float32Array(cap);
    this.denseQuatY = new Float32Array(cap);
    this.denseQuatZ = new Float32Array(cap);
    this.denseQuatW = new Float32Array(cap);

    this.denseAngVelX = new Float32Array(cap);
    this.denseAngVelY = new Float32Array(cap);
    this.denseAngVelZ = new Float32Array(cap);

    this.denseGravityY = new Float32Array(cap);
    this.denseRestitution = new Float32Array(cap);
    this.denseAgeS = new Float32Array(cap);
    this.denseTtlS = new Float32Array(cap);
  }

  public get activeCount(): number {
    return this.count;
  }

  public get freeSlotCount(): number {
    return this.freeCount;
  }

  public get dirty(): boolean {
    return this.isDirty;
  }

  public clearDirty(): void {
    this.isDirty = false;
  }

  public isSlotActive(slotId: number): boolean {
    if (slotId < 0 || slotId >= this.maxInstances) {
      return false;
    }
    return this.slotToDense[slotId] >= 0;
  }

  public getDenseIndex(slotId: number): number {
    if (slotId < 0 || slotId >= this.maxInstances) {
      return -1;
    }
    return this.slotToDense[slotId];
  }

  public allocSlot(): number {
    if (this.freeCount <= 0) {
      return -1;
    }

    const slotId = this.freeStack[--this.freeCount];
    const denseIndex = this.count++;

    this.slotToDense[slotId] = denseIndex;
    this.denseToSlot[denseIndex] = slotId;

    this.denseMode[denseIndex] = SLOT_MODE_STATIC;
    this.denseBodyHandle[denseIndex] = -1;
    this.denseSleepingSynced[denseIndex] = 0;
    this.denseScaleX[denseIndex] = 1;
    this.denseScaleY[denseIndex] = 1;
    this.denseScaleZ[denseIndex] = 1;
    this.denseAgeS[denseIndex] = 0;
    this.denseTtlS[denseIndex] = 0;

    writeColumnMajorTrsMatrix4(
      this.matrixData,
      denseIndex * 16,
      0,
      0,
      0,
      0,
      0,
      0,
      1,
      1,
      1,
      1,
    );
    this.isDirty = true;
    return slotId;
  }

  public freeSlot(slotId: number): boolean {
    if (slotId < 0 || slotId >= this.maxInstances) {
      return false;
    }
    const denseIndex = this.slotToDense[slotId];
    if (denseIndex < 0) {
      return false;
    }

    const lastDense = this.count - 1;
    if (denseIndex !== lastDense) {
      const dstMatOffset = denseIndex * 16;
      const srcMatOffset = lastDense * 16;
      this.matrixData.copyWithin(dstMatOffset, srcMatOffset, srcMatOffset + 16);

      this.denseMode[denseIndex] = this.denseMode[lastDense];
      this.denseBodyHandle[denseIndex] = this.denseBodyHandle[lastDense];
      this.denseSleepingSynced[denseIndex] = this.denseSleepingSynced[lastDense];

      this.denseScaleX[denseIndex] = this.denseScaleX[lastDense];
      this.denseScaleY[denseIndex] = this.denseScaleY[lastDense];
      this.denseScaleZ[denseIndex] = this.denseScaleZ[lastDense];

      this.densePosX[denseIndex] = this.densePosX[lastDense];
      this.densePosY[denseIndex] = this.densePosY[lastDense];
      this.densePosZ[denseIndex] = this.densePosZ[lastDense];

      this.denseVelX[denseIndex] = this.denseVelX[lastDense];
      this.denseVelY[denseIndex] = this.denseVelY[lastDense];
      this.denseVelZ[denseIndex] = this.denseVelZ[lastDense];

      this.denseQuatX[denseIndex] = this.denseQuatX[lastDense];
      this.denseQuatY[denseIndex] = this.denseQuatY[lastDense];
      this.denseQuatZ[denseIndex] = this.denseQuatZ[lastDense];
      this.denseQuatW[denseIndex] = this.denseQuatW[lastDense];

      this.denseAngVelX[denseIndex] = this.denseAngVelX[lastDense];
      this.denseAngVelY[denseIndex] = this.denseAngVelY[lastDense];
      this.denseAngVelZ[denseIndex] = this.denseAngVelZ[lastDense];

      this.denseGravityY[denseIndex] = this.denseGravityY[lastDense];
      this.denseRestitution[denseIndex] = this.denseRestitution[lastDense];
      this.denseAgeS[denseIndex] = this.denseAgeS[lastDense];
      this.denseTtlS[denseIndex] = this.denseTtlS[lastDense];

      const movedSlotId = this.denseToSlot[lastDense];
      this.denseToSlot[denseIndex] = movedSlotId;
      this.slotToDense[movedSlotId] = denseIndex;
    }

    this.slotToDense[slotId] = -1;
    this.denseToSlot[lastDense] = -1;
    this.count = lastDense;
    this.freeStack[this.freeCount++] = slotId;
    this.isDirty = true;
    return true;
  }

  public setSlotMatrix(
    slotId: number,
    matrix16: ArrayLike<number>,
    srcOffset = 0,
  ): boolean {
    if (slotId < 0 || slotId >= this.maxInstances) {
      return false;
    }
    const denseIndex = this.slotToDense[slotId];
    if (denseIndex < 0 || matrix16.length < srcOffset + 16) {
      return false;
    }

    this.denseMode[denseIndex] = SLOT_MODE_STATIC;
    this.denseBodyHandle[denseIndex] = -1;
    this.denseSleepingSynced[denseIndex] = 0;

    const dstOffset = denseIndex * 16;
    for (let i = 0; i < 16; i++) {
      this.matrixData[dstOffset + i] = matrix16[srcOffset + i];
    }
    this.isDirty = true;
    return true;
  }

  public setSlotTRS(
    slotId: number,
    pos: Vec3Like,
    quat: QuatLike = IDENTITY_QUAT,
    scale: Vec3Like = UNIT_SCALE,
  ): boolean {
    if (slotId < 0 || slotId >= this.maxInstances) {
      return false;
    }
    const denseIndex = this.slotToDense[slotId];
    if (denseIndex < 0) {
      return false;
    }

    this.denseMode[denseIndex] = SLOT_MODE_STATIC;
    this.denseBodyHandle[denseIndex] = -1;
    this.denseSleepingSynced[denseIndex] = 0;
    this.denseScaleX[denseIndex] = scale.x;
    this.denseScaleY[denseIndex] = scale.y;
    this.denseScaleZ[denseIndex] = scale.z;

    writeColumnMajorTrsMatrix4(
      this.matrixData,
      denseIndex * 16,
      pos.x,
      pos.y,
      pos.z,
      quat.x,
      quat.y,
      quat.z,
      quat.w,
      scale.x,
      scale.y,
      scale.z,
    );
    this.isDirty = true;
    return true;
  }

  public bindSlotToRapierBody(
    slotId: number,
    bodyHandle: number,
    scale: Vec3Like = UNIT_SCALE,
    ttlSeconds = 0,
  ): boolean {
    if (slotId < 0 || slotId >= this.maxInstances) {
      return false;
    }
    const denseIndex = this.slotToDense[slotId];
    if (denseIndex < 0) {
      return false;
    }

    this.denseMode[denseIndex] = SLOT_MODE_RAPIER;
    this.denseBodyHandle[denseIndex] = bodyHandle;
    this.denseSleepingSynced[denseIndex] = 0;
    this.denseScaleX[denseIndex] = scale.x;
    this.denseScaleY[denseIndex] = scale.y;
    this.denseScaleZ[denseIndex] = scale.z;
    this.denseAgeS[denseIndex] = 0;
    this.denseTtlS[denseIndex] = ttlSeconds > 0 ? ttlSeconds : 0;
    this.isDirty = true;
    return true;
  }

  public spawnKinematicParticle(
    pos: Vec3Like,
    vel: Vec3Like,
    angVel: Vec3Like,
    scale: Vec3Like,
    gravityY = -9.81,
    floorBounceRestitution = 0.3,
    ttlSeconds = 2.5,
    quat: QuatLike = IDENTITY_QUAT,
  ): number {
    let slotId = this.allocSlot();
    if (slotId < 0) {
      // Pool at capacity: recycle the oldest existing kinematic particle if one exists
      slotId = this.findOldestKinematicSlot();
      if (slotId < 0) {
        return -1;
      }
    }

    const d = this.slotToDense[slotId];
    this.denseMode[d] = SLOT_MODE_KINEMATIC;
    this.denseBodyHandle[d] = -1;
    this.denseSleepingSynced[d] = 0;

    this.denseScaleX[d] = scale.x;
    this.denseScaleY[d] = scale.y;
    this.denseScaleZ[d] = scale.z;

    this.densePosX[d] = pos.x;
    this.densePosY[d] = pos.y;
    this.densePosZ[d] = pos.z;

    this.denseVelX[d] = vel.x;
    this.denseVelY[d] = vel.y;
    this.denseVelZ[d] = vel.z;

    let qx = quat.x;
    let qy = quat.y;
    let qz = quat.z;
    let qw = quat.w;
    const qLen = Math.hypot(qx, qy, qz, qw);
    if (qLen > 1e-6) {
      const invQ = 1 / qLen;
      qx *= invQ;
      qy *= invQ;
      qz *= invQ;
      qw *= invQ;
    } else {
      qx = 0;
      qy = 0;
      qz = 0;
      qw = 1;
    }

    this.denseQuatX[d] = qx;
    this.denseQuatY[d] = qy;
    this.denseQuatZ[d] = qz;
    this.denseQuatW[d] = qw;

    this.denseAngVelX[d] = angVel.x;
    this.denseAngVelY[d] = angVel.y;
    this.denseAngVelZ[d] = angVel.z;

    this.denseGravityY[d] = gravityY;
    this.denseRestitution[d] = Math.max(0, Math.min(0.95, floorBounceRestitution));
    this.denseAgeS[d] = 0;
    this.denseTtlS[d] = Math.max(0.05, ttlSeconds);
    this.denseSleepingSynced[d] = 0;

    writeColumnMajorTrsMatrix4(
      this.matrixData,
      d * 16,
      pos.x,
      pos.y,
      pos.z,
      qx,
      qy,
      qz,
      qw,
      scale.x,
      scale.y,
      scale.z,
    );
    this.isDirty = true;
    return slotId;
  }

  public syncFromPhysics(
    rapierWorld: RapierPhysicsWorld | null,
    dt: number,
  ): void {
    const stepDt = dt > 0 && Number.isFinite(dt) ? Math.min(dt, 0.1) : 0;

    // Iterate backwards so swap-with-last removal on expiry never skips or double-steps a slot
    for (let d = this.count - 1; d >= 0; d--) {
      const mode = this.denseMode[d];
      if (mode === SLOT_MODE_STATIC) {
        continue;
      }

      if (mode === SLOT_MODE_RAPIER) {
        if (!rapierWorld) {
          continue;
        }
        const bodyHandle = this.denseBodyHandle[d];
        const ttl = this.denseTtlS[d];
        let shrink = 1;

        if (ttl > 0 && stepDt > 0) {
          const nextAge = this.denseAgeS[d] + stepDt;
          this.denseAgeS[d] = nextAge;
          if (nextAge >= ttl) {
            const expiredSlot = this.denseToSlot[d];
            rapierWorld.removeBody(bodyHandle);
            this.freeSlot(expiredSlot);
            continue;
          }
          const fadeWindow = Math.min(0.4, ttl * 0.2);
          const remaining = ttl - nextAge;
          if (fadeWindow > 1e-4 && remaining < fadeWindow) {
            shrink = Math.max(0, remaining / fadeWindow);
          }
        }

        const isSleeping = rapierWorld.isBodySleeping(bodyHandle);
        if (isSleeping && this.denseSleepingSynced[d] === 1 && shrink >= 1) {
          continue;
        }

        const ok = rapierWorld.writeBodyMatrix4(
          bodyHandle,
          this.matrixData,
          d * 16,
          this.denseScaleX[d] * shrink,
          this.denseScaleY[d] * shrink,
          this.denseScaleZ[d] * shrink,
        );
        if (!ok) {
          this.freeSlot(this.denseToSlot[d]);
          continue;
        }

        this.denseSleepingSynced[d] = isSleeping ? 1 : 0;
        this.isDirty = true;
        continue;
      }

      if (mode === SLOT_MODE_KINEMATIC && stepDt > 0) {
        const ttl = this.denseTtlS[d];
        const nextAge = this.denseAgeS[d] + stepDt;
        this.denseAgeS[d] = nextAge;

        if (ttl > 0 && nextAge >= ttl) {
          this.freeSlot(this.denseToSlot[d]);
          continue;
        }

        let shrink = 1;
        if (ttl > 0) {
          const fadeWindow = Math.min(0.35, ttl * 0.2);
          const remaining = ttl - nextAge;
          if (fadeWindow > 1e-4 && remaining < fadeWindow) {
            shrink = Math.max(0, remaining / fadeWindow);
          }
        }

        if (this.denseSleepingSynced[d] === 1 && shrink >= 1) {
          continue;
        }

        let vx = this.denseVelX[d];
        let vy = this.denseVelY[d] + this.denseGravityY[d] * stepDt;
        let vz = this.denseVelZ[d];

        let px = this.densePosX[d] + vx * stepDt;
        let py = this.densePosY[d] + vy * stepDt;
        let pz = this.densePosZ[d] + vz * stepDt;

        let wx = this.denseAngVelX[d];
        let wy = this.denseAngVelY[d];
        let wz = this.denseAngVelZ[d];

        if (py <= KINEMATIC_FLOOR_Y) {
          py = KINEMATIC_FLOOR_Y;
          if (vy < 0) {
            const bouncedVy = -vy * this.denseRestitution[d];
            vy = bouncedVy < 0.15 ? 0 : bouncedVy;
            vx *= 0.72;
            vz *= 0.72;
            wx *= 0.65;
            wy *= 0.65;
            wz *= 0.65;
          } else {
            vy = 0;
            const groundDrag = Math.max(0, 1 - 6.0 * stepDt);
            vx *= groundDrag;
            vz *= groundDrag;
            wx *= groundDrag;
            wy *= groundDrag;
            wz *= groundDrag;
          }
        }

        let qx = this.denseQuatX[d];
        let qy = this.denseQuatY[d];
        let qz = this.denseQuatZ[d];
        let qw = this.denseQuatW[d];

        const spinSq = wx * wx + wy * wy + wz * wz;
        if (spinSq > 1e-8) {
          const halfDt = 0.5 * stepDt;
          const dqx = (wx * qw + wy * qz - wz * qy) * halfDt;
          const dqy = (wy * qw + wz * qx - wx * qz) * halfDt;
          const dqz = (wz * qw + wx * qy - wy * qx) * halfDt;
          const dqw = (-wx * qx - wy * qy - wz * qz) * halfDt;

          qx += dqx;
          qy += dqy;
          qz += dqz;
          qw += dqw;

          const invLen = 1 / Math.hypot(qx, qy, qz, qw);
          qx *= invLen;
          qy *= invLen;
          qz *= invLen;
          qw *= invLen;

          this.denseQuatX[d] = qx;
          this.denseQuatY[d] = qy;
          this.denseQuatZ[d] = qz;
          this.denseQuatW[d] = qw;
        }

        if (
          py <= KINEMATIC_FLOOR_Y + 1e-5 &&
          vy === 0 &&
          vx * vx + vz * vz < 1e-4 &&
          spinSq < 1e-4
        ) {
          vx = 0;
          vz = 0;
          wx = 0;
          wy = 0;
          wz = 0;
          this.denseSleepingSynced[d] = 1;
        } else {
          this.denseSleepingSynced[d] = 0;
        }

        this.densePosX[d] = px;
        this.densePosY[d] = py;
        this.densePosZ[d] = pz;

        this.denseVelX[d] = vx;
        this.denseVelY[d] = vy;
        this.denseVelZ[d] = vz;

        this.denseAngVelX[d] = wx;
        this.denseAngVelY[d] = wy;
        this.denseAngVelZ[d] = wz;

        writeColumnMajorTrsMatrix4(
          this.matrixData,
          d * 16,
          px,
          py,
          pz,
          qx,
          qy,
          qz,
          qw,
          this.denseScaleX[d] * shrink,
          this.denseScaleY[d] * shrink,
          this.denseScaleZ[d] * shrink,
        );
        this.isDirty = true;
      }
    }
  }

  public clear(): void {
    this.count = 0;
    this.freeCount = this.maxInstances;
    for (let i = 0; i < this.maxInstances; i++) {
      this.freeStack[i] = this.maxInstances - 1 - i;
      this.slotToDense[i] = -1;
      this.denseToSlot[i] = -1;
    }
    this.isDirty = true;
  }

  private findOldestKinematicSlot(): number {
    let bestSlot = -1;
    let smallestRemaining = Infinity;
    for (let d = 0; d < this.count; d++) {
      if (this.denseMode[d] !== SLOT_MODE_KINEMATIC) {
        continue;
      }
      const rem = this.denseTtlS[d] - this.denseAgeS[d];
      if (rem < smallestRemaining) {
        smallestRemaining = rem;
        bestSlot = this.denseToSlot[d];
      }
    }
    return bestSlot;
  }
}

/**
 * Hardware-instanced `pc.VertexBuffer` pool rendering up to `maxInstances` transforms
 * through ONE `pc.Entity` and ONE `pc.MeshInstance` in a single WebGL2 draw call.
 *
 * Architecture Rule: Never spawn a `pc.Entity` with `rigidbody` + `render` component per
 * brick, concrete chunk, wood splinter, or glass shard.
 */
export class HardwareInstancedPool {
  public readonly app: pc.Application;
  public readonly entity: pc.Entity;
  public readonly meshInstance: pc.MeshInstance;
  public readonly vertexBuffer: pc.VertexBuffer;
  public readonly maxInstances: number;
  public readonly matrixData: Float32Array;

  private readonly packer: DenseInstancePacker;
  private destroyed = false;

  public constructor(
    app: pc.Application,
    mesh: pc.Mesh,
    material: pc.Material,
    maxInstances: number,
    name = 'HardwareInstancedPool',
    castShadows = true,
  ) {
    this.app = app;
    this.packer = new DenseInstancePacker(maxInstances);
    this.maxInstances = this.packer.maxInstances;
    this.matrixData = this.packer.matrixData;

    const instancingFormat = pc.VertexFormat.getDefaultInstancingFormat(
      app.graphicsDevice,
    );
    this.vertexBuffer = new pc.VertexBuffer(
      app.graphicsDevice,
      instancingFormat,
      this.maxInstances,
      {
        usage: pc.BUFFER_DYNAMIC,
        data: this.matrixData,
      },
    );

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
        new pc.Vec3(80, 30, 120),
      );
    }

    this.entity.enabled = false;
    app.root.addChild(this.entity);
  }

  public get activeCount(): number {
    return this.packer.activeCount;
  }

  public get freeSlotCount(): number {
    return this.packer.freeSlotCount;
  }

  public get dirty(): boolean {
    return this.packer.dirty;
  }

  public isSlotActive(slotId: number): boolean {
    return this.packer.isSlotActive(slotId);
  }

  public getDenseIndex(slotId: number): number {
    return this.packer.getDenseIndex(slotId);
  }

  public allocSlot(): number {
    const slotId = this.packer.allocSlot();
    this.syncVisibilityCount();
    return slotId;
  }

  public freeSlot(slotId: number): boolean {
    const freed = this.packer.freeSlot(slotId);
    if (freed) {
      this.syncVisibilityCount();
    }
    return freed;
  }

  public setSlotMatrix(
    slotId: number,
    matrix16: ArrayLike<number>,
    srcOffset = 0,
  ): boolean {
    return this.packer.setSlotMatrix(slotId, matrix16, srcOffset);
  }

  public setSlotTRS(
    slotId: number,
    pos: Vec3Like,
    quat?: QuatLike,
    scale?: Vec3Like,
  ): boolean {
    return this.packer.setSlotTRS(slotId, pos, quat, scale);
  }

  public bindSlotToRapierBody(
    slotId: number,
    bodyHandle: number,
    scale?: Vec3Like,
    ttlSeconds = 0,
  ): boolean {
    return this.packer.bindSlotToRapierBody(
      slotId,
      bodyHandle,
      scale,
      ttlSeconds,
    );
  }

  public spawnKinematicParticle(
    pos: Vec3Like,
    vel: Vec3Like,
    angVel: Vec3Like,
    scale: Vec3Like,
    gravityY = -9.81,
    floorBounceRestitution = 0.3,
    ttlSeconds = 2.5,
    quat?: QuatLike,
  ): number {
    const slotId = this.packer.spawnKinematicParticle(
      pos,
      vel,
      angVel,
      scale,
      gravityY,
      floorBounceRestitution,
      ttlSeconds,
      quat,
    );
    this.syncVisibilityCount();
    return slotId;
  }

  public syncFromPhysics(
    rapierWorld: RapierPhysicsWorld | null,
    dt: number,
  ): void {
    if (this.destroyed) {
      return;
    }
    this.packer.syncFromPhysics(rapierWorld, dt);
    this.upload();
  }

  public upload(): void {
    if (this.destroyed) {
      return;
    }
    const count = this.packer.activeCount;
    this.entity.enabled = count > 0;
    this.meshInstance.instancingCount = count;

    if (this.packer.dirty) {
      if (count > 0) {
        this.vertexBuffer.setData(this.matrixData.buffer as ArrayBuffer);
      }
      this.packer.clearDirty();
    }
  }

  public clear(): void {
    if (this.destroyed) {
      return;
    }
    this.packer.clear();
    this.syncVisibilityCount();
    this.packer.clearDirty();
  }

  public destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.packer.clear();
    this.meshInstance.setInstancing(null);
    this.vertexBuffer.destroy();
    this.entity.destroy();
  }

  private syncVisibilityCount(): void {
    if (this.destroyed) {
      return;
    }
    const count = this.packer.activeCount;
    this.entity.enabled = count > 0;
    this.meshInstance.instancingCount = count;
  }
}
