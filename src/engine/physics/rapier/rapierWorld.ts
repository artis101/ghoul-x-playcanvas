import * as RAPIER from '@dimforge/rapier3d-compat';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { BlastEvent, ColliderSurfaceTag, PenetrationRayHit, QuatLike } from '../../../contracts/destruction.ts';
import { executeRadialBlastImpulse } from './rapierBlast.ts';
import {
  createStaticBoxCollider,
  spawnDynamicBoxBody,
  spawnDynamicConvexHullBody,
  removeRigidBodyFromWorld,
  removeColliderFromWorld,
} from './rapierBodies.ts';
import { isRapierInitialized } from './rapierInit.ts';
import { DEFAULT_RESTITUTION, MAX_STEP_DT, MAX_SUBSTEPS, TARGET_SUBSTEP_DT } from './rapierMath.ts';
import { extractRigidBodyPose, writeRigidBodyMatrix4 } from './rapierPose.ts';
import { executePenetrationRay, testAnyBlockingHit } from './rapierRaycast.ts';
import { updateDebrisSleepStates } from './rapierSleep.ts';

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
  private readonly scratchHitPoint: Vec3Like = { x: 0, y: 0, z: 0 };
  private scratchRay: RAPIER.Ray | null = null;
  private queryPipelineDirty = true;
  private destroyed = false;

  public constructor() {
    if (!isRapierInitialized()) {
      throw new Error('RapierPhysicsWorld requires await initRapierPhysics() before construction.');
    }
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const groundDesc = RAPIER.ColliderDesc.cuboid(40, 0.1, 100)
      .setTranslation(0, -0.1, 0)
      .setRestitution(DEFAULT_RESTITUTION)
      .setFriction(0.75);
    this.groundColliderHandle = this.world.createCollider(groundDesc).handle;
  }

  public get activeDynamicBodyCount(): number { return this.dynamicBodyHandles.size; }

  public createStaticBox(
    center: Vec3Like, halfExtents: Vec3Like, rotationQuat?: QuatLike, tag?: ColliderSurfaceTag
  ): number {
    const col = createStaticBoxCollider(this.world, center, halfExtents, rotationQuat);
    this.queryPipelineDirty = true;
    if (tag) this.surfaceTags.set(col.handle, tag);
    return col.handle;
  }

  public spawnDynamicBox(
    center: Vec3Like, halfExtents: Vec3Like, massKg: number,
    linVel?: Vec3Like, angVel?: Vec3Like, rotationQuat?: QuatLike, tag?: ColliderSurfaceTag
  ): { bodyHandle: number; colliderHandle: number } {
    const { body, collider } = spawnDynamicBoxBody(this.world, center, halfExtents, massKg, linVel, angVel, rotationQuat);
    this.queryPipelineDirty = true;
    this.dynamicBodyHandles.add(body.handle);
    this.bodySettleTimers.set(body.handle, 0);
    if (tag) this.surfaceTags.set(collider.handle, tag);
    return { bodyHandle: body.handle, colliderHandle: collider.handle };
  }

  public spawnDynamicConvexHull(
    center: Vec3Like, verticesFlat: Float32Array, massKg: number,
    linVel?: Vec3Like, angVel?: Vec3Like,
    rotationQuatOrTag?: QuatLike | ColliderSurfaceTag, maybeTag?: ColliderSurfaceTag
  ): { bodyHandle: number; colliderHandle: number } {
    let rotationQuat: QuatLike | undefined;
    let tag: ColliderSurfaceTag | undefined;
    if (rotationQuatOrTag && 'material' in rotationQuatOrTag) {
      tag = rotationQuatOrTag as ColliderSurfaceTag;
    } else {
      rotationQuat = rotationQuatOrTag as QuatLike | undefined;
      tag = maybeTag;
    }
    const { body, collider } = spawnDynamicConvexHullBody(this.world, center, verticesFlat, massKg, linVel, angVel, rotationQuat);
    this.queryPipelineDirty = true;
    this.dynamicBodyHandles.add(body.handle);
    this.bodySettleTimers.set(body.handle, 0);
    if (tag) this.surfaceTags.set(collider.handle, tag);
    return { bodyHandle: body.handle, colliderHandle: collider.handle };
  }

  public removeBody(bodyHandle: number): void {
    if (this.destroyed) return;
    removeRigidBodyFromWorld(this.world, this.surfaceTags, this.dynamicBodyHandles, this.bodySettleTimers, bodyHandle);
    this.queryPipelineDirty = true;
  }

  public removeCollider(colliderHandle: number): void {
    if (this.destroyed) return;
    removeColliderFromWorld(this.world, this.surfaceTags, colliderHandle);
    this.queryPipelineDirty = true;
  }

  public getSurfaceTag(colliderHandle: number): ColliderSurfaceTag | undefined {
    return this.surfaceTags.get(colliderHandle);
  }

  public setSurfaceTag(colliderHandle: number, tag: ColliderSurfaceTag): void {
    this.surfaceTags.set(colliderHandle, tag);
  }

  public flushQueryPipeline(): void {
    if (this.destroyed || !this.queryPipelineDirty) return;
    const prevDt = this.world.timestep;
    this.world.timestep = 0;
    this.world.step();
    this.world.timestep = prevDt;
    this.queryPipelineDirty = false;
  }

  public castPenetrationRay(
    origin: Vec3Like, dir: Vec3Like, maxDistM: number, outHits?: PenetrationRayHit[]
  ): PenetrationRayHit[] {
    if (this.destroyed || maxDistM <= 0) return [];
    if (this.queryPipelineDirty) this.flushQueryPipeline();
    const { hits, ray } = executePenetrationRay(this.world, this.surfaceTags, origin, dir, maxDistM, this.scratchRay);
    this.scratchRay = ray;
    if (outHits) {
      outHits.length = 0;
      for (const h of hits) outHits.push(h);
    }
    return hits;
  }

  public hasAnyBlockingHit(
    origin: Vec3Like, dir: Vec3Like, maxDistM: number,
    isBlocking: (surface: ColliderSurfaceTag, pointWorld: Vec3Like, distanceM: number) => boolean
  ): boolean {
    if (this.destroyed || maxDistM <= 0) return false;
    if (this.queryPipelineDirty) this.flushQueryPipeline();
    const { blocked, ray } = testAnyBlockingHit(
      this.world, this.surfaceTags, origin, dir, maxDistM, isBlocking, this.scratchRay, this.scratchHitPoint
    );
    this.scratchRay = ray;
    return blocked;
  }

  public applyRadialBlastImpulse(blast: BlastEvent): number {
    if (this.destroyed) return 0;
    return executeRadialBlastImpulse(
      this.world, this.dynamicBodyHandles, this.bodySettleTimers, blast,
      this.scratchTranslation, this.scratchImpulse, this.scratchTorque
    );
  }

  public writeBodyMatrix4(
    bodyHandle: number, out: Float32Array, offset16: number,
    scaleX = 1, scaleY = 1, scaleZ = 1
  ): boolean {
    if (this.destroyed) return false;
    const body = this.world.getRigidBody(bodyHandle) as RAPIER.RigidBody | undefined;
    if (!body) return false;
    return writeRigidBodyMatrix4(
      body, out, offset16, this.scratchTranslation, this.scratchRotation, scaleX, scaleY, scaleZ
    );
  }

  public isBodySleeping(bodyHandle: number): boolean {
    if (this.destroyed) return true;
    const body = this.world.getRigidBody(bodyHandle) as RAPIER.RigidBody | undefined;
    return !body || body.isSleeping();
  }

  public getBodyPose(bodyHandle: number): { position: Vec3Like; rotation: QuatLike } | null;
  public getBodyPose(bodyHandle: number, outPos: Vec3Like, outRot: QuatLike): boolean;
  public getBodyPose(
    bodyHandle: number, outPos?: Vec3Like, outRot?: QuatLike
  ): { position: Vec3Like; rotation: QuatLike } | null | boolean {
    if (this.destroyed) return outPos ? false : null;
    const body = this.world.getRigidBody(bodyHandle) as RAPIER.RigidBody | undefined;
    if (!body) return outPos ? false : null;
    return extractRigidBodyPose(body, this.scratchTranslation, this.scratchRotation, outPos, outRot);
  }

  public step(dt: number): void {
    if (this.destroyed || dt <= 0 || !Number.isFinite(dt)) return;
    const clampedDt = Math.min(dt, MAX_STEP_DT);
    const numSubsteps = Math.max(1, Math.min(MAX_SUBSTEPS, Math.ceil(clampedDt / TARGET_SUBSTEP_DT - 1e-6)));
    const substepDt = clampedDt / numSubsteps;
    this.world.timestep = substepDt;
    for (let i = 0; i < numSubsteps; i++) this.world.step();
    this.queryPipelineDirty = false;
    updateDebrisSleepStates(
      this.world, this.dynamicBodyHandles, this.bodySettleTimers, this.scratchLinvel, this.scratchAngvel, clampedDt
    );
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.surfaceTags.clear();
    this.dynamicBodyHandles.clear();
    this.bodySettleTimers.clear();
    this.world.free();
  }
}
