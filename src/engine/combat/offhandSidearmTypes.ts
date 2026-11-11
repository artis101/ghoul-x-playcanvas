import * as pc from 'playcanvas';
import type { GhoulZoneId, Vec3Like } from '../../contracts/ballistics.ts';
import { ALL_GHOUL_ZONES, createTargetHealthState } from '../../core/ghoul/anatomy.ts';
import { vec3 } from '../../core/ballistics/vec3.ts';
import type { WeaponGlbInstance } from '../assets/glbLoader.ts';
import type { ActiveFiringHand } from '../ai/tacticalCombatAi.ts';

export interface OffhandSidearmRig {
  targetId: string;
  holderEntity: pc.Entity;
  glbInstance: WeaponGlbInstance | null;
  isGlbModel: boolean;
  wasHeldLastFrame: boolean;
  lastHand: ActiveFiringHand | null;
  clonedMaterials: pc.StandardMaterial[];
  cachedBoneEntities: Map<GhoulZoneId, pc.Entity | null>;
  cachedZoneEntities: Map<GhoulZoneId, pc.Entity | null>;
}

export interface RestArmBoneFrame {
  restPos: pc.Vec3;
  restRot: pc.Quat;
  restRotInv: pc.Quat;
}

export function basisVectorsToQuat(
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

export const REST_ARM_BONE_FRAMES: ReadonlyMap<GhoulZoneId, RestArmBoneFrame> = (() => {
  const refState = createTargetHealthState('__sidearm_rest_ref__', 'RestRef', vec3(0, 0, 0), 0);
  const mat = new pc.Mat4();
  const map = new Map<GhoulZoneId, RestArmBoneFrame>();
  for (const zone of ALL_GHOUL_ZONES) {
    const b = refState.ragdollBones[zone];
    const restRot = basisVectorsToQuat(b.basisRight, b.basisUp, b.basisForward, mat, new pc.Quat());
    const restRotInv = restRot.clone().invert();
    map.set(zone, {
      restPos: new pc.Vec3(b.position.x, b.position.y, b.position.z),
      restRot,
      restRotInv,
    });
  }
  return map;
})();
