import {
  ShotSimulationReport,
  TargetHealthState,
} from '../../../contracts/ballistics.ts';
import { ALL_AUX_PARTICLES } from '../../ghoul/anatomy.ts';
import { add, copyVec3, cross, scale, sub } from '../vec3.ts';

export function applyDismembermentTree(
  target: TargetHealthState,
  report: ShotSimulationReport
): { newlySeveredLeftLeg: boolean; newlySeveredRightLeg: boolean } {
  let newlySeveredLeftLeg = false;
  let newlySeveredRightLeg = false;

  for (const dism of report.dismembermentEvents) {
    target.zoneGoreMode[dism.zone] = dism.goreMode;
    target.zoneIntegrity[dism.zone] = 0;

    if (dism.goreMode === 'EVISCERATED') {
      target.bloodLossRateMlPerSec += 110;
      continue;
    }

    const severCompId = `SEVERED_${dism.zone}`;
    target.severedZones.add(dism.zone);

    if (dism.zone === 'HAND_LEFT' || dism.zone === 'HAND_RIGHT' || dism.zone === 'FOOT_LEFT' || dism.zone === 'FOOT_RIGHT') {
      target.bloodLossRateMlPerSec += 16;
    } else if (
      dism.zone === 'FOREARM_LEFT' || dism.zone === 'FOREARM_RIGHT' ||
      dism.zone === 'KNEE_LEFT' || dism.zone === 'KNEE_RIGHT' ||
      dism.zone === 'SHIN_LEFT' || dism.zone === 'SHIN_RIGHT'
    ) {
      target.bloodLossRateMlPerSec += 26;
    } else if (dism.zone === 'UPPER_ARM_LEFT' || dism.zone === 'UPPER_ARM_RIGHT') {
      target.bloodLossRateMlPerSec += 38;
    } else if (dism.zone === 'THIGH_LEFT' || dism.zone === 'THIGH_RIGHT') {
      target.bloodLossRateMlPerSec += 58;
    }

    const rootBone = target.ragdollBones[dism.zone];
    if (rootBone) {
      rootBone.severed = true;
      rootBone.goreMode = dism.goreMode;
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

    if (dism.zone === 'THIGH_LEFT' || dism.zone === 'KNEE_LEFT' || dism.zone === 'SHIN_LEFT' || dism.zone === 'FOOT_LEFT') {
      target.leftLegFunctional = false;
      newlySeveredLeftLeg = true;
    }
    if (dism.zone === 'THIGH_RIGHT' || dism.zone === 'KNEE_RIGHT' || dism.zone === 'SHIN_RIGHT' || dism.zone === 'FOOT_RIGHT') {
      target.rightLegFunctional = false;
      newlySeveredRightLeg = true;
    }
    if (dism.zone === 'UPPER_ARM_LEFT' || dism.zone === 'FOREARM_LEFT' || dism.zone === 'HAND_LEFT') {
      target.leftArmFunctional = false;
      target.weaponDropped = true;
      target.primaryArmDisarmed = true;
    }
    if (dism.zone === 'UPPER_ARM_RIGHT' || dism.zone === 'FOREARM_RIGHT' || dism.zone === 'HAND_RIGHT') {
      target.rightArmFunctional = false;
      target.weaponDropped = true;
      target.primaryArmDisarmed = true;
    }
  }

  return { newlySeveredLeftLeg, newlySeveredRightLeg };
}
