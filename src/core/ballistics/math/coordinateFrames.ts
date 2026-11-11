import {
  GhoulZoneId,
  TargetHealthState,
  Vec3Like,
} from '../../../contracts/ballistics.ts';
import { dot, normalize, sub } from '../vec3.ts';
import { REST_BONE_BASES } from './restBoneBases.ts';

export function worldToTargetLocal(worldPt: Vec3Like, targetPos: Vec3Like, yawRad: number): Vec3Like {
  const rel = sub(worldPt, targetPos);
  const cosY = Math.cos(-yawRad);
  const sinY = Math.sin(-yawRad);
  return {
    x: rel.x * cosY + rel.z * sinY,
    y: rel.y,
    z: -rel.x * sinY + rel.z * cosY,
  };
}

export function targetLocalToWorld(localPt: Vec3Like, targetPos: Vec3Like, yawRad: number): Vec3Like {
  const cosY = Math.cos(yawRad);
  const sinY = Math.sin(yawRad);
  return {
    x: targetPos.x + (localPt.x * cosY + localPt.z * sinY),
    y: targetPos.y + localPt.y,
    z: targetPos.z + (-localPt.x * sinY + localPt.z * cosY),
  };
}

export function targetLocalDirToWorld(localDir: Vec3Like, yawRad: number): Vec3Like {
  const cosY = Math.cos(yawRad);
  const sinY = Math.sin(yawRad);
  return {
    x: localDir.x * cosY + localDir.z * sinY,
    y: localDir.y,
    z: -localDir.x * sinY + localDir.z * cosY,
  };
}

export function worldToBoneColliderSpace(
  worldPt: Vec3Like,
  target: TargetHealthState,
  zone: GhoulZoneId
): { colliderSpacePt: Vec3Like; boneLocalOffset: Vec3Like } {
  const bone = target.ragdollBones[zone];
  const rest = REST_BONE_BASES[zone];
  const rel = sub(worldPt, bone.position);
  const bx = dot(rel, bone.basisRight);
  const by = dot(rel, bone.basisUp);
  const bz = dot(rel, bone.basisForward);

  const colliderSpacePt = {
    x: rest.jointPos.x + rest.right.x * bx + rest.up.x * by + rest.forward.x * bz,
    y: rest.jointPos.y + rest.right.y * bx + rest.up.y * by + rest.forward.y * bz,
    z: rest.jointPos.z + rest.right.z * bx + rest.up.z * by + rest.forward.z * bz,
  };

  return {
    colliderSpacePt,
    boneLocalOffset: { x: bx, y: by, z: bz },
  };
}

export function boneColliderDirToWorld(
  colliderDir: Vec3Like,
  target: TargetHealthState,
  zone: GhoulZoneId
): Vec3Like {
  const bone = target.ragdollBones[zone];
  const rest = REST_BONE_BASES[zone];
  const bx = dot(colliderDir, rest.right);
  const by = dot(colliderDir, rest.up);
  const bz = dot(colliderDir, rest.forward);
  return normalize({
    x: bone.basisRight.x * bx + bone.basisUp.x * by + bone.basisForward.x * bz,
    y: bone.basisRight.y * bx + bone.basisUp.y * by + bone.basisForward.y * bz,
    z: bone.basisRight.z * bx + bone.basisUp.z * by + bone.basisForward.z * bz,
  });
}
