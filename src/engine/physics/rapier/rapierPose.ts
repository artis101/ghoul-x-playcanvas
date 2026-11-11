import type * as RAPIER from '@dimforge/rapier3d-compat';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { QuatLike } from '../../../contracts/destruction.ts';
import { writeColumnMajorTrsMatrix4 } from './rapierMath.ts';

export function writeRigidBodyMatrix4(
  body: RAPIER.RigidBody,
  out: Float32Array,
  offset16: number,
  scratchPos: RAPIER.Vector,
  scratchRot: RAPIER.Rotation,
  scaleX = 1,
  scaleY = 1,
  scaleZ = 1
): boolean {
  const pos = body.translation(scratchPos);
  const rot = body.rotation(scratchRot);
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
    scaleZ
  );
  return true;
}

export function extractRigidBodyPose(
  body: RAPIER.RigidBody,
  scratchPos: RAPIER.Vector,
  scratchRot: RAPIER.Rotation,
  outPos?: Vec3Like,
  outRot?: QuatLike
): { position: Vec3Like; rotation: QuatLike } | boolean {
  const t = body.translation(scratchPos);
  const r = body.rotation(scratchRot);
  if (outPos && outRot) {
    outPos.x = t.x;
    outPos.y = t.y;
    outPos.z = t.z;
    outRot.x = r.x;
    outRot.y = r.y;
    outRot.z = r.z;
    outRot.w = r.w;
    return true;
  }
  return {
    position: { x: t.x, y: t.y, z: t.z },
    rotation: { x: r.x, y: r.y, z: r.z, w: r.w },
  };
}
