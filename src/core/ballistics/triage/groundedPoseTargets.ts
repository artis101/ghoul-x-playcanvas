import {
  GhoulZoneId,
  TargetHealthState,
  Vec3Like,
} from '../../../contracts/ballistics.ts';
import { add, normalize, scale, vec3 } from '../vec3.ts';

/**
 * Builds Active Ragdoll Muscle-Tone target positions for a LIVING downed combatant on the ground.
 */
export function buildLivingGroundedPoseTargets(
  target: TargetHealthState,
  floorY: number,
  agonyTimeS: number
): Partial<Record<GhoulZoneId, Vec3Like>> | null {
  if (!target.alive || !target.isRagdollActive) return null;

  const pelvis = target.ragdollBones.PELVIS_GROIN;
  if (pelvis.componentId !== 'BODY' || pelvis.position.y > floorY + 0.44) {
    return null;
  }

  const cosY = Math.cos(target.yawRad);
  const sinY = Math.sin(target.yawRad);
  const rightW = vec3(cosY, 0, -sinY);
  const fwdW = vec3(sinY, 0, cosY);

  const leftHurt = !target.leftLegFunctional;
  const rightHurt = !target.rightLegFunctional;
  const leanSide = leftHurt && !rightHurt ? 0.16 : rightHurt && !leftHurt ? -0.16 : 0;
  const rock = Math.sin(agonyTimeS * 2.8) * 0.05;

  const anchorP = vec3(pelvis.position.x, floorY + pelvis.radiusM + 0.015, pelvis.position.z);
  const spineDir = normalize(
    vec3(
      -fwdW.x * (0.62 - rock) + rightW.x * leanSide,
      0.77 + rock * 0.3,
      -fwdW.z * (0.62 - rock) + rightW.z * leanSide
    )
  );

  const abdomenPos = add(anchorP, scale(spineDir, 0.17));
  const thoraxPos = add(anchorP, scale(spineDir, 0.37));
  const neckPos = add(anchorP, scale(spineDir, 0.59));
  const headLookDir = normalize(vec3(fwdW.x * 0.34, 0.94, fwdW.z * 0.34));
  const headPos = add(neckPos, scale(headLookDir, 0.15));
  const jawPos = add(headPos, add(scale(fwdW, 0.085), vec3(0, -0.045, 0)));

  const shLeftPos = add(add(thoraxPos, scale(spineDir, 0.09)), scale(rightW, -0.19));
  const shRightPos = add(add(thoraxPos, scale(spineDir, 0.09)), scale(rightW, 0.19));

  const targets: Partial<Record<GhoulZoneId, Vec3Like>> = {
    TORSO_LOWER_ABDOMEN: abdomenPos,
    TORSO_UPPER_THORAX: thoraxPos,
    SHOULDER_LEFT: shLeftPos,
    SHOULDER_RIGHT: shRightPos,
    NECK_CERVICAL: neckPos,
    HEAD_CRANIUM: headPos,
    HEAD_FACE_JAW: jawPos,
  };

  const clutchLeftLeg = leftHurt || (!leftHurt && !rightHurt);
  const tremor = Math.sin(agonyTimeS * 5.8) * 0.018;

  if (clutchLeftLeg) {
    if (target.rightArmFunctional && target.ragdollBones.HAND_RIGHT.componentId === 'BODY') {
      targets.HAND_RIGHT = add(
        add(vec3(anchorP.x, floorY + 0.045, anchorP.z), scale(fwdW, -0.20)),
        scale(rightW, 0.30)
      );
    }
    if (target.leftArmFunctional && target.ragdollBones.HAND_LEFT.componentId === 'BODY') {
      const woundFocus =
        target.ragdollBones.KNEE_LEFT.componentId === 'BODY'
          ? scale(
              add(target.ragdollBones.THIGH_LEFT.position, target.ragdollBones.KNEE_LEFT.position),
              0.5
            )
          : target.ragdollBones.THIGH_LEFT.position;
      targets.HAND_LEFT = add(woundFocus, vec3(0, 0.075 + tremor, 0));
    }
  } else {
    if (target.leftArmFunctional && target.ragdollBones.HAND_LEFT.componentId === 'BODY') {
      targets.HAND_LEFT = add(
        add(vec3(anchorP.x, floorY + 0.045, anchorP.z), scale(fwdW, -0.20)),
        scale(rightW, -0.30)
      );
    }
    if (target.rightArmFunctional && target.ragdollBones.HAND_RIGHT.componentId === 'BODY') {
      const woundFocus =
        target.ragdollBones.KNEE_RIGHT.componentId === 'BODY'
          ? scale(
              add(target.ragdollBones.THIGH_RIGHT.position, target.ragdollBones.KNEE_RIGHT.position),
              0.5
            )
          : target.ragdollBones.THIGH_RIGHT.position;
      targets.HAND_RIGHT = add(woundFocus, vec3(0, 0.075 + tremor, 0));
    }
  }

  if (target.rightLegFunctional && target.ragdollBones.KNEE_RIGHT.componentId === 'BODY') {
    targets.KNEE_RIGHT = add(
      add(vec3(anchorP.x, floorY + 0.25, anchorP.z), scale(fwdW, 0.30)),
      scale(rightW, 0.14)
    );
    targets.FOOT_RIGHT = add(
      add(vec3(anchorP.x, floorY + 0.065, anchorP.z), scale(fwdW, 0.64)),
      scale(rightW, 0.15)
    );
  }
  if (target.leftLegFunctional && target.ragdollBones.KNEE_LEFT.componentId === 'BODY') {
    targets.KNEE_LEFT = add(
      add(vec3(anchorP.x, floorY + 0.25, anchorP.z), scale(fwdW, 0.30)),
      scale(rightW, -0.14)
    );
    targets.FOOT_LEFT = add(
      add(vec3(anchorP.x, floorY + 0.065, anchorP.z), scale(fwdW, 0.64)),
      scale(rightW, -0.15)
    );
  }

  return targets;
}
