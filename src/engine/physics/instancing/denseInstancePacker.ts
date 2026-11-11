import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { QuatLike } from '../../../contracts/destruction.ts';
import { RapierPhysicsWorld, writeColumnMajorTrsMatrix4 } from '../rapierWorld.ts';
import {
  IDENTITY_QUAT,
  KINEMATIC_FLOOR_Y,
  SLOT_MODE_KINEMATIC,
  SLOT_MODE_RAPIER,
  SLOT_MODE_STATIC,
  UNIT_SCALE,
} from './instancePackerTypes.ts';
import { InstanceStorageSoa } from './instanceStorageSoa.ts';

export class DenseInstancePacker {
  public readonly maxInstances: number;
  public readonly matrixData: Float32Array;
  private readonly soa: InstanceStorageSoa;

  public constructor(maxInstances: number) {
    this.soa = new InstanceStorageSoa(maxInstances);
    this.maxInstances = this.soa.maxInstances;
    this.matrixData = this.soa.matrixData;
  }

  public get activeCount(): number { return this.soa.count; }
  public get freeSlotCount(): number { return this.soa.freeCount; }
  public get dirty(): boolean { return this.soa.isDirty; }
  public clearDirty(): void { this.soa.isDirty = false; }
  public isSlotActive(slotId: number): boolean {
    return slotId >= 0 && slotId < this.maxInstances && this.soa.slotToDense[slotId] >= 0;
  }
  public getDenseIndex(slotId: number): number {
    return slotId >= 0 && slotId < this.maxInstances ? this.soa.slotToDense[slotId] : -1;
  }
  public allocSlot(): number { return this.soa.allocSlot(); }
  public freeSlot(slotId: number): boolean { return this.soa.freeSlot(slotId); }

  public setSlotMatrix(slotId: number, matrix16: ArrayLike<number>, srcOffset = 0): boolean {
    if (slotId < 0 || slotId >= this.maxInstances) return false;
    const denseIndex = this.soa.slotToDense[slotId];
    if (denseIndex < 0 || matrix16.length < srcOffset + 16) return false;

    this.soa.denseMode[denseIndex] = SLOT_MODE_STATIC;
    this.soa.denseBodyHandle[denseIndex] = -1;
    this.soa.denseSleepingSynced[denseIndex] = 0;

    const dstOffset = denseIndex * 16;
    for (let i = 0; i < 16; i++) this.matrixData[dstOffset + i] = matrix16[srcOffset + i];
    this.soa.isDirty = true;
    return true;
  }

  public setSlotTRS(
    slotId: number,
    pos: Vec3Like,
    quat: QuatLike = IDENTITY_QUAT,
    scale: Vec3Like = UNIT_SCALE
  ): boolean {
    if (slotId < 0 || slotId >= this.maxInstances) return false;
    const denseIndex = this.soa.slotToDense[slotId];
    if (denseIndex < 0) return false;

    this.soa.denseMode[denseIndex] = SLOT_MODE_STATIC;
    this.soa.denseBodyHandle[denseIndex] = -1;
    this.soa.denseSleepingSynced[denseIndex] = 0;
    this.soa.denseScaleX[denseIndex] = scale.x;
    this.soa.denseScaleY[denseIndex] = scale.y;
    this.soa.denseScaleZ[denseIndex] = scale.z;

    writeColumnMajorTrsMatrix4(
      this.matrixData,
      denseIndex * 16,
      pos.x, pos.y, pos.z,
      quat.x, quat.y, quat.z, quat.w,
      scale.x, scale.y, scale.z
    );
    this.soa.isDirty = true;
    return true;
  }

  public bindSlotToRapierBody(
    slotId: number,
    bodyHandle: number,
    scale: Vec3Like = UNIT_SCALE,
    ttlSeconds = 0,
    localOffset?: Vec3Like
  ): boolean {
    if (slotId < 0 || slotId >= this.maxInstances) return false;
    const denseIndex = this.soa.slotToDense[slotId];
    if (denseIndex < 0) return false;

    this.soa.denseMode[denseIndex] = SLOT_MODE_RAPIER;
    this.soa.denseBodyHandle[denseIndex] = bodyHandle;
    this.soa.denseSleepingSynced[denseIndex] = 0;
    this.soa.denseScaleX[denseIndex] = scale.x;
    this.soa.denseScaleY[denseIndex] = scale.y;
    this.soa.denseScaleZ[denseIndex] = scale.z;
    this.soa.densePosX[denseIndex] = localOffset ? localOffset.x : 0;
    this.soa.densePosY[denseIndex] = localOffset ? localOffset.y : 0;
    this.soa.densePosZ[denseIndex] = localOffset ? localOffset.z : 0;
    this.soa.denseAgeS[denseIndex] = 0;
    this.soa.denseTtlS[denseIndex] = ttlSeconds > 0 ? ttlSeconds : 0;
    this.soa.isDirty = true;
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
    quat: QuatLike = IDENTITY_QUAT
  ): number {
    let slotId = this.allocSlot();
    if (slotId < 0) {
      slotId = this.findOldestKinematicSlot();
      if (slotId < 0) return -1;
    }

    const d = this.soa.slotToDense[slotId];
    this.soa.denseMode[d] = SLOT_MODE_KINEMATIC;
    this.soa.denseBodyHandle[d] = -1;
    this.soa.denseSleepingSynced[d] = 0;
    this.soa.denseScaleX[d] = scale.x;
    this.soa.denseScaleY[d] = scale.y;
    this.soa.denseScaleZ[d] = scale.z;
    this.soa.densePosX[d] = pos.x;
    this.soa.densePosY[d] = pos.y;
    this.soa.densePosZ[d] = pos.z;
    this.soa.denseVelX[d] = vel.x;
    this.soa.denseVelY[d] = vel.y;
    this.soa.denseVelZ[d] = vel.z;

    let qx = quat.x, qy = quat.y, qz = quat.z, qw = quat.w;
    const qLen = Math.hypot(qx, qy, qz, qw);
    if (qLen > 1e-6) {
      const invQ = 1 / qLen;
      qx *= invQ; qy *= invQ; qz *= invQ; qw *= invQ;
    } else {
      qx = 0; qy = 0; qz = 0; qw = 1;
    }

    this.soa.denseQuatX[d] = qx;
    this.soa.denseQuatY[d] = qy;
    this.soa.denseQuatZ[d] = qz;
    this.soa.denseQuatW[d] = qw;
    this.soa.denseAngVelX[d] = angVel.x;
    this.soa.denseAngVelY[d] = angVel.y;
    this.soa.denseAngVelZ[d] = angVel.z;
    this.soa.denseGravityY[d] = gravityY;
    this.soa.denseRestitution[d] = Math.max(0, Math.min(0.95, floorBounceRestitution));
    this.soa.denseAgeS[d] = 0;
    this.soa.denseTtlS[d] = ttlSeconds <= 0 ? 0 : Math.max(0.05, ttlSeconds);

    writeColumnMajorTrsMatrix4(this.matrixData, d * 16, pos.x, pos.y, pos.z, qx, qy, qz, qw, scale.x, scale.y, scale.z);
    this.soa.isDirty = true;
    return slotId;
  }

  public syncFromPhysics(rapierWorld: RapierPhysicsWorld | null, dt: number): void {
    const stepDt = dt > 0 && Number.isFinite(dt) ? Math.min(dt, 0.1) : 0;
    for (let d = this.soa.count - 1; d >= 0; d--) {
      const mode = this.soa.denseMode[d];
      if (mode === SLOT_MODE_STATIC) continue;

      if (mode === SLOT_MODE_RAPIER) {
        if (!rapierWorld) continue;
        const bodyHandle = this.soa.denseBodyHandle[d];
        const ttl = this.soa.denseTtlS[d];
        let shrink = 1;
        if (ttl > 0 && stepDt > 0) {
          const nextAge = this.soa.denseAgeS[d] + stepDt;
          this.soa.denseAgeS[d] = nextAge;
          if (nextAge >= ttl) {
            rapierWorld.removeBody(bodyHandle);
            this.freeSlot(this.soa.denseToSlot[d]);
            continue;
          }
          const fadeWindow = Math.min(0.4, ttl * 0.2);
          const remaining = ttl - nextAge;
          if (fadeWindow > 1e-4 && remaining < fadeWindow) shrink = Math.max(0, remaining / fadeWindow);
        }

        const isSleeping = rapierWorld.isBodySleeping(bodyHandle);
        if (isSleeping && this.soa.denseSleepingSynced[d] === 1 && shrink >= 1) continue;

        const sx = this.soa.denseScaleX[d] * shrink;
        const sy = this.soa.denseScaleY[d] * shrink;
        const sz = this.soa.denseScaleZ[d] * shrink;
        const base = d * 16;
        const ok = rapierWorld.writeBodyMatrix4(bodyHandle, this.matrixData, base, sx, sy, sz);
        if (!ok) {
          this.freeSlot(this.soa.denseToSlot[d]);
          continue;
        }
        const ox = this.soa.densePosX[d] * shrink;
        const oy = this.soa.densePosY[d] * shrink;
        const oz = this.soa.densePosZ[d] * shrink;
        if (ox !== 0 || oy !== 0 || oz !== 0) {
          const ux = sx > 1e-6 ? ox / sx : 0;
          const uy = sy > 1e-6 ? oy / sy : 0;
          const uz = sz > 1e-6 ? oz / sz : 0;
          this.matrixData[base + 12] += this.matrixData[base] * ux + this.matrixData[base + 4] * uy + this.matrixData[base + 8] * uz;
          this.matrixData[base + 13] += this.matrixData[base + 1] * ux + this.matrixData[base + 5] * uy + this.matrixData[base + 9] * uz;
          this.matrixData[base + 14] += this.matrixData[base + 2] * ux + this.matrixData[base + 6] * uy + this.matrixData[base + 10] * uz;
        }
        this.soa.denseSleepingSynced[d] = isSleeping ? 1 : 0;
        this.soa.isDirty = true;
        continue;
      }

      if (mode === SLOT_MODE_KINEMATIC && stepDt > 0) {
        const ttl = this.soa.denseTtlS[d];
        const nextAge = this.soa.denseAgeS[d] + stepDt;
        this.soa.denseAgeS[d] = nextAge;
        if (ttl > 0 && nextAge >= ttl) {
          this.freeSlot(this.soa.denseToSlot[d]);
          continue;
        }
        let shrink = 1;
        if (ttl > 0) {
          const fadeWindow = Math.min(0.35, ttl * 0.2);
          const rem = ttl - nextAge;
          if (fadeWindow > 1e-4 && rem < fadeWindow) shrink = Math.max(0, rem / fadeWindow);
        }
        if (this.soa.denseSleepingSynced[d] === 1 && shrink >= 1) continue;

        let vx = this.soa.denseVelX[d];
        let vy = this.soa.denseVelY[d] + this.soa.denseGravityY[d] * stepDt;
        let vz = this.soa.denseVelZ[d];
        let px = this.soa.densePosX[d] + vx * stepDt;
        let py = this.soa.densePosY[d] + vy * stepDt;
        let pz = this.soa.densePosZ[d] + vz * stepDt;
        let wx = this.soa.denseAngVelX[d], wy = this.soa.denseAngVelY[d], wz = this.soa.denseAngVelZ[d];

        if (py <= KINEMATIC_FLOOR_Y) {
          py = KINEMATIC_FLOOR_Y;
          if (vy < 0) {
            const bVy = -vy * this.soa.denseRestitution[d];
            vy = bVy < 0.15 ? 0 : bVy;
            vx *= 0.72; vz *= 0.72; wx *= 0.65; wy *= 0.65; wz *= 0.65;
          } else {
            vy = 0;
            const drag = Math.max(0, 1 - 6.0 * stepDt);
            vx *= drag; vz *= drag; wx *= drag; wy *= drag; wz *= drag;
          }
        }

        let qx = this.soa.denseQuatX[d], qy = this.soa.denseQuatY[d], qz = this.soa.denseQuatZ[d], qw = this.soa.denseQuatW[d];
        const spinSq = wx * wx + wy * wy + wz * wz;
        if (spinSq > 1e-8) {
          const hDt = 0.5 * stepDt;
          const dqx = (wx * qw + wy * qz - wz * qy) * hDt;
          const dqy = (wy * qw + wz * qx - wx * qz) * hDt;
          const dqz = (wz * qw + wx * qy - wy * qx) * hDt;
          const dqw = (-wx * qx - wy * qy - wz * qz) * hDt;
          qx += dqx; qy += dqy; qz += dqz; qw += dqw;
          const invLen = 1 / Math.hypot(qx, qy, qz, qw);
          qx *= invLen; qy *= invLen; qz *= invLen; qw *= invLen;
          this.soa.denseQuatX[d] = qx; this.soa.denseQuatY[d] = qy; this.soa.denseQuatZ[d] = qz; this.soa.denseQuatW[d] = qw;
        }

        if (py <= KINEMATIC_FLOOR_Y + 1e-5 && vy === 0 && vx * vx + vz * vz < 1e-4 && spinSq < 1e-4) {
          vx = 0; vz = 0; wx = 0; wy = 0; wz = 0;
          this.soa.denseSleepingSynced[d] = 1;
        } else {
          this.soa.denseSleepingSynced[d] = 0;
        }

        this.soa.densePosX[d] = px; this.soa.densePosY[d] = py; this.soa.densePosZ[d] = pz;
        this.soa.denseVelX[d] = vx; this.soa.denseVelY[d] = vy; this.soa.denseVelZ[d] = vz;
        this.soa.denseAngVelX[d] = wx; this.soa.denseAngVelY[d] = wy; this.soa.denseAngVelZ[d] = wz;

        writeColumnMajorTrsMatrix4(
          this.matrixData, d * 16, px, py, pz, qx, qy, qz, qw,
          this.soa.denseScaleX[d] * shrink, this.soa.denseScaleY[d] * shrink, this.soa.denseScaleZ[d] * shrink
        );
        this.soa.isDirty = true;
      }
    }
  }

  public clear(): void {
    this.soa.count = 0;
    this.soa.freeCount = this.maxInstances;
    for (let i = 0; i < this.maxInstances; i++) {
      this.soa.freeStack[i] = this.maxInstances - 1 - i;
      this.soa.slotToDense[i] = -1;
      this.soa.denseToSlot[i] = -1;
    }
    this.soa.isDirty = true;
  }

  private findOldestKinematicSlot(): number {
    let bestSettledSlot = -1;
    let oldestSettledAge = -1;
    let bestSlot = -1;
    let smallestRemaining = Infinity;
    for (let d = 0; d < this.soa.count; d++) {
      if (this.soa.denseMode[d] !== SLOT_MODE_KINEMATIC) continue;
      const age = this.soa.denseAgeS[d];
      const ttl = this.soa.denseTtlS[d];
      if (this.soa.denseSleepingSynced[d] === 1 || ttl <= 0) {
        if (age > oldestSettledAge) {
          oldestSettledAge = age;
          bestSettledSlot = this.soa.denseToSlot[d];
        }
      }
      const rem = ttl > 0 ? ttl - age : 1e6 - age;
      if (rem < smallestRemaining) {
        smallestRemaining = rem;
        bestSlot = this.soa.denseToSlot[d];
      }
    }
    return bestSettledSlot >= 0 ? bestSettledSlot : bestSlot;
  }
}
