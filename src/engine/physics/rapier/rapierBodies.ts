import * as RAPIER from '@dimforge/rapier3d-compat';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { ColliderSurfaceTag, QuatLike } from '../../../contracts/destruction.ts';
import {
  CCD_SPEED_THRESHOLD_SQ,
  DEFAULT_ANGULAR_DAMPING,
  DEFAULT_FRICTION,
  DEFAULT_LINEAR_DAMPING,
  DEFAULT_RESTITUTION,
} from './rapierMath.ts';

export function createConfiguredDynamicBodyDesc(
  center: Vec3Like,
  linVel?: Vec3Like,
  angVel?: Vec3Like,
  rotationQuat?: QuatLike
): RAPIER.RigidBodyDesc {
  const desc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(center.x, center.y, center.z)
    .setCanSleep(true)
    .setLinearDamping(DEFAULT_LINEAR_DAMPING)
    .setAngularDamping(DEFAULT_ANGULAR_DAMPING)
    .setSoftCcdPrediction(0.15);

  if (rotationQuat) desc.setRotation(rotationQuat);
  if (linVel) {
    desc.setLinvel(linVel.x, linVel.y, linVel.z);
    const speedSq = linVel.x * linVel.x + linVel.y * linVel.y + linVel.z * linVel.z;
    if (speedSq >= CCD_SPEED_THRESHOLD_SQ) desc.setCcdEnabled(true);
  }
  if (angVel) {
    desc.setAngvel({ x: angVel.x, y: angVel.y, z: angVel.z });
  }
  return desc;
}

export function createStaticBoxCollider(
  world: RAPIER.World,
  center: Vec3Like,
  halfExtents: Vec3Like,
  rotationQuat?: QuatLike
): RAPIER.Collider {
  const hx = Math.max(1e-4, halfExtents.x);
  const hy = Math.max(1e-4, halfExtents.y);
  const hz = Math.max(1e-4, halfExtents.z);
  const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
    .setTranslation(center.x, center.y, center.z)
    .setRestitution(0.15)
    .setFriction(0.7);
  if (rotationQuat) desc.setRotation(rotationQuat);
  return world.createCollider(desc);
}

export function spawnDynamicBoxBody(
  world: RAPIER.World,
  center: Vec3Like,
  halfExtents: Vec3Like,
  massKg: number,
  linVel?: Vec3Like,
  angVel?: Vec3Like,
  rotationQuat?: QuatLike
): { body: RAPIER.RigidBody; collider: RAPIER.Collider } {
  const bodyDesc = createConfiguredDynamicBodyDesc(center, linVel, angVel, rotationQuat);
  const body = world.createRigidBody(bodyDesc);
  const colDesc = RAPIER.ColliderDesc.cuboid(
    Math.max(1e-4, halfExtents.x),
    Math.max(1e-4, halfExtents.y),
    Math.max(1e-4, halfExtents.z)
  )
    .setMass(Math.max(0.005, massKg))
    .setRestitution(DEFAULT_RESTITUTION)
    .setFriction(DEFAULT_FRICTION);
  const collider = world.createCollider(colDesc, body);
  return { body, collider };
}

export function spawnDynamicConvexHullBody(
  world: RAPIER.World,
  center: Vec3Like,
  verticesFlat: Float32Array,
  massKg: number,
  linVel?: Vec3Like,
  angVel?: Vec3Like,
  rotationQuat?: QuatLike
): { body: RAPIER.RigidBody; collider: RAPIER.Collider } {
  const bodyDesc = createConfiguredDynamicBodyDesc(center, linVel, angVel, rotationQuat);
  const body = world.createRigidBody(bodyDesc);
  let colDesc = RAPIER.ColliderDesc.convexHull(verticesFlat);
  if (!colDesc) {
    let minX = Infinity; let minY = Infinity; let minZ = Infinity;
    let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
    for (let i = 0; i < verticesFlat.length; i += 3) {
      const x = verticesFlat[i]; const y = verticesFlat[i + 1]; const z = verticesFlat[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const hx = Math.max(0.02, (maxX - minX) * 0.5);
    const hy = Math.max(0.02, (maxY - minY) * 0.5);
    const hz = Math.max(0.02, (maxZ - minZ) * 0.5);
    colDesc = RAPIER.ColliderDesc.cuboid(hx, hy, hz);
  }
  colDesc.setMass(Math.max(0.005, massKg)).setRestitution(DEFAULT_RESTITUTION).setFriction(DEFAULT_FRICTION);
  const collider = world.createCollider(colDesc, body);
  return { body, collider };
}

export function removeRigidBodyFromWorld(
  world: RAPIER.World,
  surfaceTags: Map<number, ColliderSurfaceTag>,
  dynamicBodyHandles: Set<number>,
  bodySettleTimers: Map<number, number>,
  bodyHandle: number
): void {
  const body = world.getRigidBody(bodyHandle) as RAPIER.RigidBody | undefined;
  if (!body) return;
  for (let i = 0; i < body.numColliders(); i++) {
    surfaceTags.delete(body.collider(i).handle);
  }
  world.removeRigidBody(body);
  dynamicBodyHandles.delete(bodyHandle);
  bodySettleTimers.delete(bodyHandle);
}

export function removeColliderFromWorld(
  world: RAPIER.World,
  surfaceTags: Map<number, ColliderSurfaceTag>,
  colliderHandle: number
): void {
  const col = world.getCollider(colliderHandle) as RAPIER.Collider | undefined;
  if (!col) return;
  surfaceTags.delete(colliderHandle);
  world.removeCollider(col, false);
}
