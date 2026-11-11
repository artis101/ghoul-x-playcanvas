import {
  GhoulZoneId,
  ShotSimulationReport,
  TargetHealthState,
} from '../../../contracts/ballistics.ts';
import { ALL_AUX_PARTICLES, ALL_GHOUL_ZONES } from '../../ghoul/anatomy.ts';
import {
  add,
  copyVec3,
  length,
  normalize,
  scale,
  vec3,
} from '../vec3.ts';
import { stabilizeRagdollPoseForTransition } from '../ragdoll/ragdollPoseStabilizer.ts';

export function applyRagdollActivationAndImpulses(
  target: TargetHealthState,
  report: ShotSimulationReport,
  wasAlreadyRagdoll: boolean,
  hitZone: GhoulZoneId | null
): void {
  if (!report.ragdollPlan.willEnableRagdoll) return;

  target.isRagdollActive = true;
  target.weaponDropped = true;
  target.posture = 'AIRBORNE_RAGDOLL';

  if (!wasAlreadyRagdoll) {
    stabilizeRagdollPoseForTransition(target, 0.0);
  }

  const bodyMassKg = 82.0;
  const impulse = report.ragdollPlan.netRootImpulseWorld;
  const liftY = wasAlreadyRagdoll
    ? Math.min(0.32, report.ragdollPlan.launchLiftVelocityMs * 0.4)
    : report.ragdollPlan.launchLiftVelocityMs;

  const isStomachHit = hitZone === 'TORSO_LOWER_ABDOMEN';
  const horizImp = vec3(impulse.x, 0, impulse.z);
  const horizImpMag = length(horizImp);
  const horizDir =
    horizImpMag > 1e-3
      ? scale(horizImp, 1 / horizImpMag)
      : normalize(vec3(report.aimDirectionWorld.x, 0, report.aimDirectionWorld.z));

  const targetHorizSpeed = Math.min(5.6, horizImpMag / bodyMassKg);

  const baseVel = vec3(
    horizDir.x * targetHorizSpeed,
    Math.max(-0.4, Math.min(1.25, impulse.y / bodyMassKg + liftY)),
    horizDir.z * targetHorizSpeed
  );

  if (!wasAlreadyRagdoll) {
    target.ragdollRootVelocity = copyVec3(baseVel);
  } else {
    target.ragdollRootVelocity = add(target.ragdollRootVelocity, scale(baseVel, 0.55));
  }

  target.ragdollAngularVelocity = scale(report.ragdollPlan.netTorqueWorld, 1 / 65.0);

  const facingFwd = vec3(Math.sin(target.yawRad), 0, Math.cos(target.yawRad));
  const isLowImpulseCollapse = !wasAlreadyRagdoll && targetHorizSpeed < 1.0;

  for (const z of ALL_GHOUL_ZONES) {
    const bone = target.ragdollBones[z];
    if (bone.componentId !== 'BODY') continue;

    const isExtremity =
      z === 'HAND_LEFT' || z === 'HAND_RIGHT' ||
      z === 'FOOT_LEFT' || z === 'FOOT_RIGHT' ||
      z === 'SHIN_LEFT' || z === 'SHIN_RIGHT';
    const isMidsection =
      z === 'TORSO_LOWER_ABDOMEN' || z === 'PELVIS_GROIN' || z === 'TORSO_UPPER_THORAX';

    let weight = 0.96;
    if (isStomachHit && targetHorizSpeed > 0.8) {
      if (z === 'TORSO_LOWER_ABDOMEN') weight = 1.28;
      else if (z === 'PELVIS_GROIN') weight = 1.15;
      else if (z === 'TORSO_UPPER_THORAX') weight = 1.04;
      else if (isExtremity) weight = 0.62;
    } else if (isExtremity) {
      weight = 0.72;
    } else if (isMidsection) {
      weight = 1.04;
    }

    const zImp = report.ragdollPlan.zoneImpulses[z];
    const rawKick = zImp ? scale(zImp, 1 / (bone.massKg * 3.2 + 12.0)) : vec3(0, 0, 0);
    const kickMag = length(rawKick);
    const localKick = kickMag > 2.6 ? scale(rawKick, 2.6 / kickMag) : rawKick;

    let nextVel = !wasAlreadyRagdoll
      ? add(scale(baseVel, weight), localKick)
      : add(bone.velocity, add(scale(baseVel, weight * 0.45), localKick));

    if (isLowImpulseCollapse && (z === 'KNEE_LEFT' || z === 'KNEE_RIGHT')) {
      nextVel = add(nextVel, add(scale(facingFwd, 0.85), vec3(0, -0.35, 0)));
    } else if (isLowImpulseCollapse && z === 'PELVIS_GROIN') {
      nextVel = add(nextVel, vec3(0, -0.45, 0));
    }

    bone.velocity = nextVel;
  }

  for (const auxId of ALL_AUX_PARTICLES) {
    const aux = target.auxParticles[auxId];
    if (aux.componentId !== 'BODY') continue;
    const parentVel = target.ragdollBones[aux.parentZone].velocity;
    aux.velocity = scale(parentVel, 0.90);
  }
}
