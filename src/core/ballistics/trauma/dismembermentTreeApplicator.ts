import {
  ShotSimulationReport,
  TargetHealthState,
} from '../../../contracts/ballistics.ts';
import { ALL_AUX_PARTICLES } from '../../ghoul/anatomy.ts';
import { transitionTargetLifecycle } from '../lifecycle/targetLifecycleFsm.ts';
import { isLimbLossFatal, losesSidearmArm } from './limbLossDeathRule.ts';
import { add, copyVec3, cross, scale, sub } from '../vec3.ts';

/** Which limbs this shot newly took off. An arm counts when its hand, forearm or upper arm goes. */
export interface NewlySeveredLimbs {
  newlySeveredRightLeg: boolean;
  newlySeveredLeftLeg: boolean;
  newlySeveredRightArm: boolean;
  newlySeveredLeftArm: boolean;
}

export function applyDismembermentTree(
  target: TargetHealthState,
  report: ShotSimulationReport
): NewlySeveredLimbs {
  let newlySeveredRightLeg = false;
  let newlySeveredLeftLeg = false;
  let newlySeveredRightArm = false;
  let newlySeveredLeftArm = false;

  for (const dism of report.dismembermentEvents) {
    target.zoneGoreMode[dism.zone] = dism.goreMode;
    target.zoneIntegrity[dism.zone] = 0;

    if (dism.goreMode === 'EVISCERATED') {
      const evisceratedBone = target.ragdollBones[dism.zone];
      if (evisceratedBone) {
        evisceratedBone.goreMode = 'EVISCERATED';
        evisceratedBone.attachmentState = 'ATTACHED';
      }
      target.bloodLossRateMlPerSec += 110;
      continue;
    }

    const severCompId = `SEVERED_${dism.zone}`;
    const nextAttachment =
      dism.goreMode === 'CRANIAL_POP' ? 'OBLITERATED_HIDDEN' : 'DETACHED_LIMB';
    target.severedZones.add(dism.zone);
    if (dism.cut) {
      target.severCuts ??= {};
      target.severCuts[dism.zone] = dism.cut;
    }

    if (dism.zone === 'HAND_RIGHT' || dism.zone === 'HAND_LEFT' || dism.zone === 'FOOT_RIGHT' || dism.zone === 'FOOT_LEFT') {
      target.bloodLossRateMlPerSec += 16;
    } else if (
      dism.zone === 'FOREARM_RIGHT' || dism.zone === 'FOREARM_LEFT' ||
      dism.zone === 'KNEE_RIGHT' || dism.zone === 'KNEE_LEFT' ||
      dism.zone === 'SHIN_RIGHT' || dism.zone === 'SHIN_LEFT'
    ) {
      target.bloodLossRateMlPerSec += 26;
    } else if (dism.zone === 'UPPER_ARM_RIGHT' || dism.zone === 'UPPER_ARM_LEFT') {
      target.bloodLossRateMlPerSec += 38;
    } else if (dism.zone === 'THIGH_RIGHT' || dism.zone === 'THIGH_LEFT') {
      target.bloodLossRateMlPerSec += 58;
    }

    const rootBone = target.ragdollBones[dism.zone];
    if (rootBone) {
      rootBone.severed = true;
      rootBone.goreMode = dism.goreMode;
      rootBone.attachmentState = nextAttachment;
      rootBone.componentId = severCompId;
      rootBone.prevPosition = copyVec3(rootBone.position);
      rootBone.velocity = copyVec3(dism.severedLimbVelocity);
    }

    for (const child of dism.detachedSubtree) {
      target.severedZones.add(child);
      target.zoneIntegrity[child] = 0;
      const childBone = target.ragdollBones[child];
      if (childBone) {
        childBone.severed = true;
        if (dism.goreMode === 'CRANIAL_POP') childBone.goreMode = 'CRANIAL_POP';
        childBone.attachmentState = nextAttachment;
        childBone.componentId = severCompId;
        childBone.prevPosition = copyVec3(childBone.position);
        const offset = sub(childBone.position, rootBone.position);
        const rotVel = cross(dism.severedLimbAngularVelocity, offset);
        childBone.velocity = add(dism.severedLimbVelocity, scale(rotVel, 0.35));
      }
    }

    for (const auxId of ALL_AUX_PARTICLES) {
      const aux = target.auxParticles[auxId];
      if (dism.detachedSubtree.includes(aux.parentZone)) {
        aux.componentId = severCompId;
        aux.prevPosition = copyVec3(aux.position);
        const offset = sub(aux.position, rootBone.position);
        const rotVel = cross(dism.severedLimbAngularVelocity, offset);
        aux.velocity = add(dism.severedLimbVelocity, scale(rotVel, 0.35));
      }
    }

    if (dism.zone === 'THIGH_RIGHT' || dism.zone === 'KNEE_RIGHT' || dism.zone === 'SHIN_RIGHT' || dism.zone === 'FOOT_RIGHT') {
      target.rightLegFunctional = false;
      newlySeveredRightLeg = true;
    }
    if (dism.zone === 'THIGH_LEFT' || dism.zone === 'KNEE_LEFT' || dism.zone === 'SHIN_LEFT' || dism.zone === 'FOOT_LEFT') {
      target.leftLegFunctional = false;
      newlySeveredLeftLeg = true;
    }
    if (dism.zone === 'UPPER_ARM_RIGHT' || dism.zone === 'FOREARM_RIGHT' || dism.zone === 'HAND_RIGHT') {
      target.rightArmFunctional = false;
      newlySeveredRightArm = true;
      transitionTargetLifecycle(target, { kind: 'PRIMARY_ARM_DISARM' });
    }
    if (dism.zone === 'UPPER_ARM_LEFT' || dism.zone === 'FOREARM_LEFT' || dism.zone === 'HAND_LEFT') {
      target.leftArmFunctional = false;
      newlySeveredLeftArm = true;
      transitionTargetLifecycle(target, { kind: 'PRIMARY_ARM_DISARM' });
    }
  }

  // Two lost limbs kill, except one arm with one leg, and so does the arm holding the drawn
  // handgun (the shot pass usually got here first).
  const sidearmArmLost = losesSidearmArm(target.sidearmHand, report.dismembermentEvents.map((d) => d.zone));
  if (target.alive && report.dismembermentEvents.length > 0 && (isLimbLossFatal(target.severedZones) || sidearmArmLost)) {
    transitionTargetLifecycle(target, { kind: 'LETHAL_DEATH' });
  }

  return { newlySeveredRightLeg, newlySeveredLeftLeg, newlySeveredRightArm, newlySeveredLeftArm };
}
