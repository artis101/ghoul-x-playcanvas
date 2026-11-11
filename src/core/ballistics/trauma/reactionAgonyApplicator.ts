import {
  PainReactionType,
  ShotSimulationReport,
  TargetHealthState,
} from '../../../contracts/ballistics.ts';
import { ALL_AUX_PARTICLES, ALL_GHOUL_ZONES } from '../../ghoul/anatomy.ts';
import { add, copyVec3, length, normalize, scale, vec3 } from '../vec3.ts';

export function applySurvivingReaction(
  target: TargetHealthState,
  report: ShotSimulationReport,
  newlySeveredLeftLeg: boolean,
  newlySeveredRightLeg: boolean
): void {
  const hitZone = report.ragdollPlan.primaryHitZone;
  if (report.ragdollPlan.willEnableRagdoll || !target.alive || !hitZone) return;

  const imp = report.ragdollPlan.netRootImpulseWorld;
  const hImpMag = length(vec3(imp.x, 0, imp.z));
  if (hImpMag > 32.0) {
    const pushDist = Math.min(0.55, (hImpMag - 32.0) / 280.0);
    const pushDir = normalize(vec3(imp.x, 0, imp.z));
    const shift = scale(pushDir, pushDist);
    target.worldPosition = add(target.worldPosition, shift);
    target.worldPosition.x = Math.max(-9.4, Math.min(9.4, target.worldPosition.x));
    for (const z of ALL_GHOUL_ZONES) {
      const b = target.ragdollBones[z];
      if (!b.severed) {
        b.position = add(b.position, shift);
        b.prevPosition = copyVec3(b.position);
      }
    }
    for (const aId of ALL_AUX_PARTICLES) {
      const a = target.auxParticles[aId];
      if (a.componentId === 'BODY') {
        a.position = add(a.position, shift);
        a.prevPosition = copyVec3(a.position);
      }
    }
  }

  let rxType: PainReactionType = 'CHEST_STAGGER';
  let rxDurationS = 0.65;

  if (!target.leftLegFunctional || !target.rightLegFunctional) {
    rxType = !target.leftLegFunctional ? 'LEG_BUCKLE_LEFT' : 'LEG_BUCKLE_RIGHT';
    rxDurationS = newlySeveredLeftLeg || newlySeveredRightLeg ? 0.68 : 0.46;
    target.posture = 'LEG_BUCKLED';
  } else if (hitZone === 'NECK_CERVICAL') {
    rxType = 'THROAT_CLUTCH';
    target.posture = 'THROAT_CLUTCH';
  } else if (hitZone === 'TORSO_LOWER_ABDOMEN') {
    rxType = 'GUT_FOLD';
    target.posture = 'GUT_HURT';
  } else if (hitZone === 'HEAD_CRANIUM' || hitZone === 'HEAD_FACE_JAW') {
    rxType = 'HEAD_SNAP';
    target.posture = 'STAGGERED';
  } else if (hitZone === 'SHOULDER_LEFT' || hitZone === 'UPPER_ARM_LEFT' || hitZone === 'FOREARM_LEFT' || hitZone === 'HAND_LEFT') {
    rxType = 'ARM_WRENCH_LEFT';
    if (target.weaponDropped) target.posture = 'DISARMED';
  } else if (hitZone === 'SHOULDER_RIGHT' || hitZone === 'UPPER_ARM_RIGHT' || hitZone === 'FOREARM_RIGHT' || hitZone === 'HAND_RIGHT') {
    rxType = 'ARM_WRENCH_RIGHT';
    if (target.weaponDropped) target.posture = 'DISARMED';
  }

  target.activeReaction = {
    type: rxType,
    timerS: 0,
    durationS: rxDurationS,
    intensity: Math.min(1.3, 0.60 + report.totalEnergyDepositedJ / 450),
    hitDirectionWorld: copyVec3(report.aimDirectionWorld),
  };
}
