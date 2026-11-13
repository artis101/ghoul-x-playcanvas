import {
  PainReactionType,
  ShotSimulationReport,
  StandingCombatPosture,
  TargetHealthState,
} from '../../../contracts/ballistics.ts';
import { ALL_AUX_PARTICLES, ALL_GHOUL_ZONES } from '../../ghoul/anatomy.ts';
import { transitionTargetLifecycle } from '../lifecycle/targetLifecycleFsm.ts';
import { add, copyVec3, length, normalize, scale, vec3 } from '../vec3.ts';
import { gradeZoneWound } from './woundSeverity.ts';

export function applySurvivingReaction(
  target: TargetHealthState,
  report: ShotSimulationReport,
  newlySeveredRightLeg: boolean,
  newlySeveredLeftLeg: boolean
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

  const wound = gradeZoneWound(hitZone, report.woundEvents);
  let rxType: PainReactionType = 'CHEST_STAGGER';
  let rxDurationS = 0.65;
  let postureOverride: StandingCombatPosture | undefined;

  if (!target.rightLegFunctional || !target.leftLegFunctional) {
    rxType = !target.rightLegFunctional ? 'LEG_BUCKLE_RIGHT' : 'LEG_BUCKLE_LEFT';
    rxDurationS = newlySeveredRightLeg || newlySeveredLeftLeg ? 0.68 : 0.46;
    postureOverride = 'LEG_BUCKLED';
  } else if (hitZone === 'NECK_CERVICAL' && wound.severity === 'CRITICAL') {
    // An opened artery or airway: they grab at the throat, on their feet, while it pumps out.
    rxType = 'THROAT_CLUTCH';
    postureOverride = 'STAGGERED';
  } else if (hitZone === 'TORSO_LOWER_ABDOMEN' && wound.severity === 'CRITICAL') {
    // A burst gut makes them hunch and clutch it, but adrenaline keeps them standing.
    rxType = 'GUT_FOLD';
    postureOverride = 'STAGGERED';
  } else if (hitZone === 'HEAD_CRANIUM' || hitZone === 'HEAD_FACE_JAW') {
    rxType = 'HEAD_SNAP';
    postureOverride = 'STAGGERED';
  } else if (hitZone === 'SHOULDER_RIGHT' || hitZone === 'UPPER_ARM_RIGHT' || hitZone === 'FOREARM_RIGHT' || hitZone === 'HAND_RIGHT') {
    rxType = 'ARM_WRENCH_RIGHT';
    if (target.weaponDropped) postureOverride = 'DISARMED';
  } else if (hitZone === 'SHOULDER_LEFT' || hitZone === 'UPPER_ARM_LEFT' || hitZone === 'FOREARM_LEFT' || hitZone === 'HAND_LEFT') {
    rxType = 'ARM_WRENCH_LEFT';
    if (target.weaponDropped) postureOverride = 'DISARMED';
  }

  // How long the reaction lasts follows the wound, not the body part: a pellet graze is a twitch,
  // a deep channel a real stagger, a cut artery or burst organ a long clutch.
  const isLegReaction = rxType === 'LEG_BUCKLE_RIGHT' || rxType === 'LEG_BUCKLE_LEFT';
  if (!isLegReaction) {
    if (wound.severity === 'GRAZE') {
      rxDurationS = 0.22;
      if (postureOverride === 'STAGGERED') postureOverride = undefined;
    } else if (wound.severity === 'CRITICAL') {
      rxDurationS = rxType === 'THROAT_CLUTCH' || rxType === 'GUT_FOLD' ? 1.1 : 0.8;
    }
  }
  const severityScale = wound.severity === 'GRAZE' ? 0.45 : wound.severity === 'CRITICAL' ? 1.15 : 0.85;

  transitionTargetLifecycle(target, {
    kind: 'START_PAIN_REACTION',
    reactionType: rxType,
    durationS: rxDurationS,
    intensity: Math.min(1.3, (0.6 + report.totalEnergyDepositedJ / 450) * severityScale),
    hitDirectionWorld: report.aimDirectionWorld,
    postureOverride,
  });
}
