import {
  GhoulZoneId,
  ShotSimulationReport,
  TargetHealthState,
} from '../../../contracts/ballistics.ts';
import { ALL_AUX_PARTICLES, ALL_GHOUL_ZONES } from '../../ghoul/anatomy.ts';
import { transitionTargetLifecycle } from '../lifecycle/targetLifecycleFsm.ts';
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

  const isOverkillCorpseHit = wasAlreadyRagdoll && !target.alive;
  transitionTargetLifecycle(target, {
    kind: 'ACTIVATE_RAGDOLL',
    isOverkillCorpseHit,
  });

  if (!wasAlreadyRagdoll) {
    stabilizeRagdollPoseForTransition(target, 0.0);
  }

  const bodyMassKg = 82.0;
  const impulse = report.ragdollPlan.netRootImpulseWorld;
  const liftY = isOverkillCorpseHit
    ? 0.0
    : wasAlreadyRagdoll
      ? Math.min(0.18, report.ragdollPlan.launchLiftVelocityMs * 0.25)
      : Math.min(0.42, report.ragdollPlan.launchLiftVelocityMs * 0.45);

  const isStomachHit = hitZone === 'TORSO_LOWER_ABDOMEN';
  const horizImp = vec3(impulse.x, 0, impulse.z);
  const horizImpMag = length(horizImp);
  const horizDir =
    horizImpMag > 1e-3
      ? scale(horizImp, 1 / horizImpMag)
      : normalize(vec3(report.aimDirectionWorld.x, 0, report.aimDirectionWorld.z));

  const maxRootHorizSpeed = isOverkillCorpseHit ? 1.35 : 3.6;
  const targetHorizSpeed = Math.min(maxRootHorizSpeed, horizImpMag / bodyMassKg);

  const baseVel = vec3(
    horizDir.x * targetHorizSpeed,
    isOverkillCorpseHit
      ? Math.max(-0.25, Math.min(0.08, impulse.y / bodyMassKg))
      : Math.max(-0.4, Math.min(0.45, impulse.y / bodyMassKg + liftY)),
    horizDir.z * targetHorizSpeed
  );

  if (!wasAlreadyRagdoll) {
    target.ragdollRootVelocity = copyVec3(baseVel);
  } else {
    const blend = isOverkillCorpseHit ? 0.25 : 0.45;
    target.ragdollRootVelocity = add(target.ragdollRootVelocity, scale(baseVel, blend));
    const rootSpd = length(target.ragdollRootVelocity);
    if (rootSpd > 3.8) {
      target.ragdollRootVelocity = scale(target.ragdollRootVelocity, 3.8 / rootSpd);
    }
  }

  target.ragdollAngularVelocity = scale(report.ragdollPlan.netTorqueWorld, 1 / 65.0);

  const facingFwd = vec3(Math.sin(target.yawRad), 0, Math.cos(target.yawRad));
  const isLowImpulseCollapse = !wasAlreadyRagdoll && targetHorizSpeed < 1.0;
  const maxBoneSpeedMs = isOverkillCorpseHit ? 2.6 : 4.2;
  const maxLocalKickMs = isOverkillCorpseHit ? 1.15 : 2.1;

  for (const z of ALL_GHOUL_ZONES) {
    const bone = target.ragdollBones[z];
    if (bone.componentId !== 'BODY') continue;

    const isExtremity =
      z === 'HAND_RIGHT' || z === 'HAND_LEFT' ||
      z === 'FOOT_RIGHT' || z === 'FOOT_LEFT' ||
      z === 'SHIN_RIGHT' || z === 'SHIN_LEFT';
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
    const localKick = kickMag > maxLocalKickMs ? scale(rawKick, maxLocalKickMs / kickMag) : rawKick;

    let nextVel = !wasAlreadyRagdoll
      ? add(scale(baseVel, weight), localKick)
      : add(bone.velocity, add(scale(baseVel, weight * (isOverkillCorpseHit ? 0.22 : 0.4)), localKick));

    if (isLowImpulseCollapse && (z === 'KNEE_RIGHT' || z === 'KNEE_LEFT')) {
      nextVel = add(nextVel, add(scale(facingFwd, 0.85), vec3(0, -0.35, 0)));
    } else if (isLowImpulseCollapse && z === 'PELVIS_GROIN') {
      nextVel = add(nextVel, vec3(0, -0.45, 0));
    }

    nextVel.y = Math.min(isOverkillCorpseHit ? 0.12 : 0.48, nextVel.y);
    const nextMag = length(nextVel);
    if (nextMag > maxBoneSpeedMs) {
      nextVel = scale(nextVel, maxBoneSpeedMs / nextMag);
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
