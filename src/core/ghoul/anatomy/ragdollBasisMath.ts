import { GhoulZoneId } from '../../../contracts/ballistics/ghoulZoneContracts';
import {
  AuxParticleId,
  TargetHealthState,
} from '../../../contracts/ballistics/targetHealthContracts';
import { Vec3Like, vec3, normalize, cross, length } from '../../ballistics/vec3';

export function getParticlePos(target: TargetHealthState, id: GhoulZoneId | AuxParticleId): Vec3Like {
  if (id in target.ragdollBones) {
    return target.ragdollBones[id as GhoulZoneId].position;
  }
  return target.auxParticles[id as AuxParticleId].position;
}

export function getParticleComp(target: TargetHealthState, id: GhoulZoneId | AuxParticleId): string {
  if (id in target.ragdollBones) {
    return target.ragdollBones[id as GhoulZoneId].componentId;
  }
  return target.auxParticles[id as AuxParticleId].componentId;
}

export function safeOrthonormalBasis(
  upDir: Vec3Like,
  forwardHint: Vec3Like,
  fallbackRight: Vec3Like
): { right: Vec3Like; up: Vec3Like; forward: Vec3Like } {
  let up = normalize(upDir);
  if (length(up) < 1e-4) up = vec3(0, 1, 0);

  let right = cross(up, forwardHint);
  if (length(right) < 1e-4) {
    right = cross(up, fallbackRight);
    if (length(right) < 1e-4) {
      right = Math.abs(up.x) < 0.9 ? cross(up, vec3(1, 0, 0)) : cross(up, vec3(0, 0, 1));
    }
  }
  right = normalize(right);
  const forward = normalize(cross(right, up));
  return { right, up, forward };
}

export function basisFromRightAndUp(
  rightHint: Vec3Like,
  upDir: Vec3Like,
  fallbackForward: Vec3Like
): { right: Vec3Like; up: Vec3Like; forward: Vec3Like } {
  let up = normalize(upDir);
  if (length(up) < 1e-4) up = vec3(0, 1, 0);

  let forward = cross(rightHint, up);
  if (length(forward) < 1e-4) {
    return safeOrthonormalBasis(up, fallbackForward, vec3(1, 0, 0));
  }
  forward = normalize(forward);
  const right = normalize(cross(up, forward));
  return { right, up, forward };
}
