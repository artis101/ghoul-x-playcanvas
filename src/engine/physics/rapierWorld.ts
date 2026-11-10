import * as RAPIER from '@dimforge/rapier3d-compat';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import type {
  BlastEvent,
  ColliderSurfaceTag,
  PenetrationRayHit,
  QuatLike,
} from '../../contracts/destruction.ts';

let rapierInitPromise: Promise<typeof RAPIER> | null = null;
let rapierInitialized = false;

/**
 * Idempotently initializes the embedded Rapier3D WASM physics backend.
 */
export async function initRapierPhysics(): Promise<typeof RAPIER> {
  if (rapierInitialized) {
    return RAPIER;
  }
  if (!rapierInitPromise) {
    rapierInitPromise = RAPIER.init().then(() => {
      rapierInitialized = true;
      return RAPIER;
    });
  }
  return rapierInitPromise;
}

/**
 * Writes a column-major 4x4 TRS world matrix directly into `out[offset16 .. offset16 + 15]`
 * matching PlayCanvas `pc.Mat4.setTRS` and `pc.VertexFormat.getDefaultInstancingFormat`
 * with zero temporary heap allocations.
 */
export function writeColumnMajorTrsMatrix4(
  out: Float32Array,
  offset16: number,
  tx: number,
  ty: number,
  tz: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  sx = 1,
  sy = 1,
  sz = 1,
): void {
  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;

  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;

  out[offset16 + 0] = (1 - (yy + zz)) * sx;
  out[offset16 + 1] = (xy + wz) * sx;
  out[offset16 + 2] = (xz - wy) * sx;
  out[offset16 + 3] = 0;

  out[offset16 + 4] = (xy - wz) * sy;
  out[offset16 + 5] = (1 - (xx + zz)) * sy;
  out[offset16 + 6] = (yz + wx) * sy;
  out[offset16 + 7] = 0;

  out[offset16 + 8] = (xz + wy) * sz;
  out[offset16 + 9] = (yz - wx) * sz;
  out[offset16 + 10] = (1 - (xx + yy)) * sz;
  out[offset16 + 11] = 0;

  out[offset16 + 12] = tx;
  out[offset16 + 13] = ty;
  out[offset16 + 14] = tz;
  out[offset16 + 15] = 1;
}

const DEFAULT_RESTITUTION = 0.2;
const DEFAULT_FRICTION = 0.65;
const DEFAULT_LINEAR_DAMPING = 0.24;
const DEFAULT_ANGULAR_DAMPING = 0.36;
const CCD_SPEED_THRESHOLD_SQ = 12 * 12;
const SLEEP_LINEAR_SPEED_SQ = 0.08 * 0.08;
const SLEEP_ANGULAR_SPEED_SQ = 0.18 * 0.18;
const SLEEP_SETTLE_DURATION_S = 0.45;
const MAX_STEP_DT = 1 / 20;
const TARGET_SUBSTEP_DT = 1 / 60;
const MAX_SUBSTEPS = 4;

/**
 * Rapier3D WASM physics world managing arena static surfaces, dynamic debris rigid bodies,
 * ballistic multi-surface penetration raycasts, radial blast impulses, and zero-allocation
 * column-major matrix extraction for GPU hardware instancing.
 */
export class RapierPhysicsWorld {
  public readonly world: RAPIER.World;
  public readonly groundColliderHandle: number;

  private readonly surfaceTags = new Map<number, ColliderSurfaceTag>();
  private readonly dynamicBodyHandles = new Set<number>();
  private readonly bodySettleTimers = new Map<number, number>();

  private readonly scratchTranslation: RAPIER.Vector = { x: 0, y: 0, z: 0 };
  private readonly scratchRotation: RAPIER.Rotation = { x: 0, y: 0, z: 0, w: 1 };
  private readonly scratchLinvel: RAPIER.Vector = { x: 0, y: 0, z: 0 };
  private readonly scratchAngvel: RAPIER.Vector = { x: 0, y: 0, z: 0 };
  private readonly scratchImpulse: RAPIER.Vector = { x: 0, y: 0, z: 0 };
  private readonly scratchTorque: RAPIER.Vector = { x: 0, y: 0, z: 0 };

  private queryPipelineDirty = true;
  private destroyed = false;

  public constructor() {
    if (!rapierInitialized) {
      throw new Error(
        'RapierPhysicsWorld requires await initRapierPhysics() before construction.',
      );
    }

    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

    const groundDesc = RAPIER.ColliderDesc.cuboid(40, 0.1, 100)
      .setTranslation(0, -0.1, 0)
      .setRestitution(DEFAULT_RESTITUTION)
      .setFriction(0.75);
    const groundCollider = this.world.createCollider(groundDesc);
    this.groundColliderHandle = groundCollider.handle;
  }

  public get activeDynamicBodyCount(): number {
    return this.dynamicBodyHandles.size;
  }

  public createStaticBox(
    center: Vec3Like,
    halfExtents: Vec3Like,
    rotationQuat?: QuatLike,
    tag?: ColliderSurfaceTag,
  ): number {
    const hx = Math.max(1e-4, halfExtents.x);
    const hy = Math.max(1e-4, halfExtents.y);
    const hz = Math.max(1e-4, halfExtents.z);

    const colliderDesc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(center.x, center.y, center.z)
      .setRestitution(0.15)
      .setFriction(0.7);

    if (rotationQuat) {
      colliderDesc.setRotation(rotationQuat);
    }

    const collider = this.world.createCollider(colliderDesc);
    this.queryPipelineDirty = true;
    if (tag) {
      this.surfaceTags.set(collider.handle, tag);
    }
    return collider.handle;
  }

  public spawnDynamicBox(
    center: Vec3Like,
    halfExtents: Vec3Like,
    massKg: number,
    linVel?: Vec3Like,
    angVel?: Vec3Like,
    rotationQuat?: QuatLike,
    tag?: ColliderSurfaceTag,
  ): { bodyHandle: number; colliderHandle: number } {
    const hx = Math.max(1e-4, halfExtents.x);
    const hy = Math.max(1e-4, halfExtents.y);
    const hz = Math.max(1e-4, halfExtents.z);

    const bodyDesc = this.createConfiguredDynamicBodyDesc(
      center,
      linVel,
      angVel,
      rotationQuat,
    );
    const body = this.world.createRigidBody(bodyDesc);

    const colliderDesc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setMass(Math.max(0.005, massKg))
      .setRestitution(DEFAULT_RESTITUTION)
      .setFriction(DEFAULT_FRICTION);

    const collider = this.world.createCollider(colliderDesc, body);
    this.queryPipelineDirty = true;

    this.dynamicBodyHandles.add(body.handle);
    this.bodySettleTimers.set(body.handle, 0);
    if (tag) {
      this.surfaceTags.set(collider.handle, tag);
    }

    return {
      bodyHandle: body.handle,
      colliderHandle: collider.handle,
    };
  }

  public spawnDynamicConvexHull(
    center: Vec3Like,
    localVertices: Float32Array,
    massKg: number,
    linVel?: Vec3Like,
    angVel?: Vec3Like,
    tag?: ColliderSurfaceTag,
    rotationQuat?: QuatLike,
  ): { bodyHandle: number; colliderHandle: number } | null {
    if (localVertices.length < 9) {
      return null;
    }

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    const vertCount3 = localVertices.length - (localVertices.length % 3);
    for (let i = 0; i < vertCount3; i += 3) {
      const vx = localVertices[i];
      const vy = localVertices[i + 1];
      const vz = localVertices[i + 2];
      if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)) {
        return null;
      }
      if (vx < minX) minX = vx;
      if (vy < minY) minY = vy;
      if (vz < minZ) minZ = vz;
      if (vx > maxX) maxX = vx;
      if (vy > maxY) maxY = vy;
      if (vz > maxZ) maxZ = vz;
    }

    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
      return null;
    }

    const hullInput =
      vertCount3 === localVertices.length
        ? localVertices
        : localVertices.subarray(0, vertCount3);

    let colliderDesc = RAPIER.ColliderDesc.convexHull(hullInput);
    if (colliderDesc === null) {
      const hx = Math.max(0.005, (maxX - minX) * 0.5);
      const hy = Math.max(0.005, (maxY - minY) * 0.5);
      const hz = Math.max(0.005, (maxZ - minZ) * 0.5);
      const cx = (minX + maxX) * 0.5;
      const cy = (minY + maxY) * 0.5;
      const cz = (minZ + maxZ) * 0.5;
      colliderDesc = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(
        cx,
        cy,
        cz,
      );
    }

    colliderDesc
      .setMass(Math.max(0.005, massKg))
      .setRestitution(DEFAULT_RESTITUTION)
      .setFriction(DEFAULT_FRICTION);

    const bodyDesc = this.createConfiguredDynamicBodyDesc(
      center,
      linVel,
      angVel,
      rotationQuat,
    );
    const body = this.world.createRigidBody(bodyDesc);
    const collider = this.world.createCollider(colliderDesc, body);
    this.queryPipelineDirty = true;

    this.dynamicBodyHandles.add(body.handle);
    this.bodySettleTimers.set(body.handle, 0);
    if (tag) {
      this.surfaceTags.set(collider.handle, tag);
    }

    return {
      bodyHandle: body.handle,
      colliderHandle: collider.handle,
    };
  }

  public removeCollider(colliderHandle: number): void {
    this.surfaceTags.delete(colliderHandle);
    if (this.destroyed) return;
    const collider = this.world.getCollider(colliderHandle) as
      | RAPIER.Collider
      | undefined;
    if (collider) {
      this.world.removeCollider(collider, true);
      this.queryPipelineDirty = true;
    }
  }

  public removeBody(bodyHandle: number): void {
    this.dynamicBodyHandles.delete(bodyHandle);
    this.bodySettleTimers.delete(bodyHandle);
    if (this.destroyed) return;
    const body = this.world.getRigidBody(bodyHandle) as
      | RAPIER.RigidBody
      | undefined;
    if (!body) {
      return;
    }
    const numCols = body.numColliders();
    for (let i = 0; i < numCols; i++) {
      const col = body.collider(i);
      this.surfaceTags.delete(col.handle);
    }
    this.world.removeRigidBody(body);
    this.queryPipelineDirty = true;
  }

  public getSurfaceTag(colliderHandle: number): ColliderSurfaceTag | undefined {
    return this.surfaceTags.get(colliderHandle);
  }

  public setSurfaceTag(colliderHandle: number, tag: ColliderSurfaceTag): void {
    this.surfaceTags.set(colliderHandle, tag);
  }

  public flushQueryPipeline(): void {
    if (this.destroyed || !this.queryPipelineDirty) {
      return;
    }
    const prevDt = this.world.timestep;
    this.world.timestep = 0;
    this.world.step();
    this.world.timestep = prevDt;
    this.queryPipelineDirty = false;
  }

  public castPenetrationRay(
    origin: Vec3Like,
    dirNormalized: Vec3Like,
    maxDistM: number,
  ): PenetrationRayHit[] {
    if (this.destroyed || maxDistM <= 0) {
      return [];
    }

    if (this.queryPipelineDirty) {
      this.flushQueryPipeline();
    }

    const dirLenSq =
      dirNormalized.x * dirNormalized.x +
      dirNormalized.y * dirNormalized.y +
      dirNormalized.z * dirNormalized.z;
    if (dirLenSq < 1e-12) {
      return [];
    }

    const invLen = 1 / Math.sqrt(dirLenSq);
    const dx = dirNormalized.x * invLen;
    const dy = dirNormalized.y * invLen;
    const dz = dirNormalized.z * invLen;

    const ray = new RAPIER.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: dx, y: dy, z: dz },
    );

    const hits: PenetrationRayHit[] = [];

    this.world.intersectionsWithRay(ray, maxDistM, true, (intersection) => {
      const handle = intersection.collider.handle;
      const surface = this.surfaceTags.get(handle);
      if (surface) {
        const toi = Math.max(0, intersection.timeOfImpact);
        const rawNormal = intersection.normal;
        const nLenSq =
          rawNormal.x * rawNormal.x +
          rawNormal.y * rawNormal.y +
          rawNormal.z * rawNormal.z;

        let nx = -dx;
        let ny = -dy;
        let nz = -dz;
        if (nLenSq > 1e-10) {
          const invN = 1 / Math.sqrt(nLenSq);
          nx = rawNormal.x * invN;
          ny = rawNormal.y * invN;
          nz = rawNormal.z * invN;
        }

        hits.push({
          colliderHandle: handle,
          pointWorld: {
            x: origin.x + dx * toi,
            y: origin.y + dy * toi,
            z: origin.z + dz * toi,
          },
          normalWorld: { x: nx, y: ny, z: nz },
          distanceM: toi,
          surface,
        });
      }
      return true;
    });

    hits.sort((a, b) =>
      a.distanceM !== b.distanceM
        ? a.distanceM - b.distanceM
        : a.colliderHandle - b.colliderHandle,
    );
    return hits;
  }

  public applyRadialBlastImpulse(blast: BlastEvent): number {
    if (this.destroyed || blast.radiusM <= 0 || blast.peakImpulseNs <= 0) {
      return 0;
    }

    const radiusSq = blast.radiusM * blast.radiusM;
    const cx = blast.centerWorld.x;
    const cy = blast.centerWorld.y;
    const cz = blast.centerWorld.z;
    let affectedCount = 0;

    for (const bodyHandle of this.dynamicBodyHandles) {
      const body = this.world.getRigidBody(bodyHandle) as
        | RAPIER.RigidBody
        | undefined;
      if (!body) {
        this.dynamicBodyHandles.delete(bodyHandle);
        this.bodySettleTimers.delete(bodyHandle);
        continue;
      }

      const pos = body.translation(this.scratchTranslation);
      const dx = pos.x - cx;
      const dy = pos.y - cy;
      const dz = pos.z - cz;
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq > radiusSq) {
        continue;
      }

      const dist = Math.sqrt(distSq);
      const linearFalloff = Math.max(0, 1 - dist / blast.radiusM);
      const attenuation = linearFalloff * (0.35 + 0.65 * linearFalloff);
      const impulseMag = blast.peakImpulseNs * attenuation;
      if (impulseMag <= 1e-6) {
        continue;
      }

      let rx = 0;
      let ry = 1;
      let rz = 0;
      if (dist > 1e-4) {
        const invDist = 1 / dist;
        rx = dx * invDist;
        ry = dy * invDist;
        rz = dz * invDist;
      }

      // Blend radial outward vector with upward blast lift so rubble launches convincingly
      let lx = rx;
      let ly = ry + 0.42;
      let lz = rz;
      const lLen = Math.hypot(lx, ly, lz);
      if (lLen > 1e-5) {
        lx /= lLen;
        ly /= lLen;
        lz /= lLen;
      }

      this.scratchImpulse.x = lx * impulseMag;
      this.scratchImpulse.y = ly * impulseMag;
      this.scratchImpulse.z = lz * impulseMag;

      body.wakeUp();
      this.bodySettleTimers.set(bodyHandle, 0);
      body.applyImpulse(this.scratchImpulse, true);

      // Deterministic off-center tumble torque proportional to impulse
      const spinPhase = ((bodyHandle * 2654435761) >>> 0) * 1.462918079e-9;
      const torqueScale = impulseMag * 0.14;
      this.scratchTorque.x = (-rz + Math.sin(spinPhase) * 0.35) * torqueScale;
      this.scratchTorque.y = Math.cos(spinPhase * 1.7) * 0.45 * torqueScale;
      this.scratchTorque.z = (rx + Math.cos(spinPhase) * 0.35) * torqueScale;
      body.applyTorqueImpulse(this.scratchTorque, true);

      affectedCount++;
    }

    return affectedCount;
  }

  public writeBodyMatrix4(
    bodyHandle: number,
    out: Float32Array,
    offset16: number,
    scaleX = 1,
    scaleY = 1,
    scaleZ = 1,
  ): boolean {
    if (this.destroyed) {
      return false;
    }
    const body = this.world.getRigidBody(bodyHandle) as
      | RAPIER.RigidBody
      | undefined;
    if (!body) {
      return false;
    }

    const pos = body.translation(this.scratchTranslation);
    const rot = body.rotation(this.scratchRotation);

    writeColumnMajorTrsMatrix4(
      out,
      offset16,
      pos.x,
      pos.y,
      pos.z,
      rot.x,
      rot.y,
      rot.z,
      rot.w,
      scaleX,
      scaleY,
      scaleZ,
    );
    return true;
  }

  public isBodySleeping(bodyHandle: number): boolean {
    if (this.destroyed) {
      return true;
    }
    const body = this.world.getRigidBody(bodyHandle) as
      | RAPIER.RigidBody
      | undefined;
    if (!body) {
      return true;
    }
    return body.isSleeping();
  }

  public getBodyPose(
    bodyHandle: number,
  ): { position: Vec3Like; rotation: QuatLike } | null {
    if (this.destroyed) {
      return null;
    }
    const body = this.world.getRigidBody(bodyHandle) as
      | RAPIER.RigidBody
      | undefined;
    if (!body) {
      return null;
    }
    const pos = body.translation(this.scratchTranslation);
    const rot = body.rotation(this.scratchRotation);
    return {
      position: { x: pos.x, y: pos.y, z: pos.z },
      rotation: { x: rot.x, y: rot.y, z: rot.z, w: rot.w },
    };
  }

  public step(dt: number): void {
    if (this.destroyed || dt <= 0 || !Number.isFinite(dt)) {
      return;
    }

    const clampedDt = Math.min(dt, MAX_STEP_DT);
    const substeps = Math.max(
      1,
      Math.min(MAX_SUBSTEPS, Math.ceil(clampedDt / TARGET_SUBSTEP_DT - 1e-6)),
    );
    const subDt = clampedDt / substeps;

    this.world.timestep = subDt;
    for (let i = 0; i < substeps; i++) {
      this.world.step();
    }
    this.queryPipelineDirty = false;

    this.updateDebrisSleepThresholds(clampedDt);
  }

  public destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.surfaceTags.clear();
    this.dynamicBodyHandles.clear();
    this.bodySettleTimers.clear();
    this.world.free();
  }

  private createConfiguredDynamicBodyDesc(
    center: Vec3Like,
    linVel?: Vec3Like,
    angVel?: Vec3Like,
    rotationQuat?: QuatLike,
  ): RAPIER.RigidBodyDesc {
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(center.x, center.y, center.z)
      .setCanSleep(true)
      .setLinearDamping(DEFAULT_LINEAR_DAMPING)
      .setAngularDamping(DEFAULT_ANGULAR_DAMPING)
      .setSoftCcdPrediction(0.15);

    if (rotationQuat) {
      desc.setRotation(rotationQuat);
    }

    if (linVel) {
      desc.setLinvel(linVel.x, linVel.y, linVel.z);
      const speedSq =
        linVel.x * linVel.x + linVel.y * linVel.y + linVel.z * linVel.z;
      if (speedSq >= CCD_SPEED_THRESHOLD_SQ) {
        desc.setCcdEnabled(true);
      }
    }

    if (angVel) {
      desc.setAngvel({ x: angVel.x, y: angVel.y, z: angVel.z });
    }

    return desc;
  }

  private updateDebrisSleepThresholds(dt: number): void {
    for (const bodyHandle of this.dynamicBodyHandles) {
      const body = this.world.getRigidBody(bodyHandle) as
        | RAPIER.RigidBody
        | undefined;
      if (!body) {
        this.dynamicBodyHandles.delete(bodyHandle);
        this.bodySettleTimers.delete(bodyHandle);
        continue;
      }
      if (body.isSleeping()) {
        continue;
      }

      const lv = body.linvel(this.scratchLinvel);
      const av = body.angvel(this.scratchAngvel);
      const linSpeedSq = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z;
      const angSpeedSq = av.x * av.x + av.y * av.y + av.z * av.z;

      if (
        linSpeedSq <= SLEEP_LINEAR_SPEED_SQ &&
        angSpeedSq <= SLEEP_ANGULAR_SPEED_SQ
      ) {
        const accumulated = (this.bodySettleTimers.get(bodyHandle) ?? 0) + dt;
        if (accumulated >= SLEEP_SETTLE_DURATION_S) {
          body.sleep();
          this.bodySettleTimers.set(bodyHandle, 0);
        } else {
          this.bodySettleTimers.set(bodyHandle, accumulated);
        }
      } else {
        this.bodySettleTimers.set(bodyHandle, 0);
      }
    }
  }
}
