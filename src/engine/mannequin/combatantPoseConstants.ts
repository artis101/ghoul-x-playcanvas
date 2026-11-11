import * as pc from 'playcanvas';
import { GhoulZoneId, Vec3Like } from '../../contracts/ballistics.ts';
import { ALL_GHOUL_ZONES, createTargetHealthState } from '../../core/ghoul/anatomy.ts';
import { vec3 } from '../../core/ballistics/vec3.ts';
import type { RestRagdollBoneFrame } from './types.ts';

export const TOPOLOGICAL_GHOUL_ZONES: readonly GhoulZoneId[] = [
  'PELVIS_GROIN',
  'TORSO_LOWER_ABDOMEN',
  'TORSO_UPPER_THORAX',
  'NECK_CERVICAL',
  'HEAD_CRANIUM',
  'HEAD_FACE_JAW',
  'SHOULDER_LEFT',
  'UPPER_ARM_LEFT',
  'FOREARM_LEFT',
  'HAND_LEFT',
  'SHOULDER_RIGHT',
  'UPPER_ARM_RIGHT',
  'FOREARM_RIGHT',
  'HAND_RIGHT',
  'THIGH_LEFT',
  'KNEE_LEFT',
  'SHIN_LEFT',
  'FOOT_LEFT',
  'THIGH_RIGHT',
  'KNEE_RIGHT',
  'SHIN_RIGHT',
  'FOOT_RIGHT',
] as const;

export function basisToQuat(
  right: Vec3Like,
  up: Vec3Like,
  forward: Vec3Like,
  tmpMat: pc.Mat4,
  outQuat: pc.Quat
): pc.Quat {
  const d = tmpMat.data;
  d[0] = right.x;
  d[1] = right.y;
  d[2] = right.z;
  d[3] = 0;

  d[4] = up.x;
  d[5] = up.y;
  d[6] = up.z;
  d[7] = 0;

  d[8] = forward.x;
  d[9] = forward.y;
  d[10] = forward.z;
  d[11] = 0;

  d[12] = 0;
  d[13] = 0;
  d[14] = 0;
  d[15] = 1;

  outQuat.setFromMat4(tmpMat);
  return outQuat;
}

export const REST_RAGDOLL_FRAMES: ReadonlyMap<GhoulZoneId, RestRagdollBoneFrame> = (() => {
  const refState = createTargetHealthState('__glb_rest_ref__', 'RestRef', vec3(0, 0, 0), 0);
  const mat = new pc.Mat4();
  const map = new Map<GhoulZoneId, RestRagdollBoneFrame>();
  for (const zone of ALL_GHOUL_ZONES) {
    const b = refState.ragdollBones[zone];
    const restRot = basisToQuat(b.basisRight, b.basisUp, b.basisForward, mat, new pc.Quat());
    const restRotInv = restRot.clone().invert();
    map.set(zone, {
      restPos: new pc.Vec3(b.position.x, b.position.y, b.position.z),
      restDistalPos: new pc.Vec3(b.distalPosition.x, b.distalPosition.y, b.distalPosition.z),
      restRot,
      restRotInv,
    });
  }
  return map;
})();
