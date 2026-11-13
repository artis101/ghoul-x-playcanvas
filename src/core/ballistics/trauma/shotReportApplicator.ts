import {
  ShotSimulationReport,
  TargetHealthState,
} from '../../../contracts/ballistics.ts';
import {
  syncTargetLifecycleDerivedState,
  transitionTargetLifecycle,
} from '../lifecycle/targetLifecycleFsm.ts';
import { stabilizeRagdollPoseForTransition } from '../ragdoll/ragdollPoseStabilizer.ts';
import { legGivesWay } from './legGivesWay.ts';
import { applyWoundsAndDecals } from './woundDecalApplicator.ts';
import { mixSeed } from '../../random/seededRng.ts';
import { applyDismembermentTree } from './dismembermentTreeApplicator.ts';
import { applySurvivingReaction } from './reactionAgonyApplicator.ts';
import { applyHitDisarmRules } from './hitDisarmPass.ts';
import { applyRagdollActivationAndImpulses } from './ragdollImpulseApplicator.ts';
import {
  isDyingAnimated,
  isKnockdownBlow,
  joltDyingBody,
  planShotDeath,
  startDeathAnimation,
} from '../lifecycle/deathAnimation.ts';

/**
 * Applies the shot simulation report to TargetHealthState:
 * updates vitals, armor, surface wounds, pain reactions, GHOUL dismemberment components,
 * and injects realistic 3D velocities into the PBD ragdoll skeleton.
 */
export function applyShotReportToTarget(
  target: TargetHealthState,
  report: ShotSimulationReport
): void {
  if (!report.hitTarget) return;
  // The next trigger pull rolls fresh terminal behaviour; re-simulations of this one already agreed.
  if (target.shotVarianceSeed !== undefined) {
    target.shotVarianceSeed = mixSeed(target.shotVarianceSeed, 0x5eed);
  }

  const wasAlreadyRagdoll = target.isRagdollActive;
  const wasDying = isDyingAnimated(target);
  // A body killed on its feet plays a death clip instead of dropping into the ragdoll; decided from
  // the state before the shot (deathAnimation.ts).
  const deathClip = target.alive ? planShotDeath(target, report) : null;
  // The plan's ragdoll, unless the body is dying on its feet (checked again once the shot is applied).
  const plannedRagdoll = report.ragdollPlan.willEnableRagdoll && !wasDying;

  const { rightLegShotEnergyJ, leftLegShotEnergyJ, shatteredArmSides } = applyWoundsAndDecals(target, report);

  // A wounded leg does not always put the fighter on the floor: it may hold, and then it neither
  // falls nor drops its gun. Only a fall disarms (the lifecycle drops the gun as it goes down).
  if (rightLegShotEnergyJ >= 85.0 && legGivesWay(target, 'R')) target.rightLegFunctional = false;
  if (leftLegShotEnergyJ >= 85.0 && legGivesWay(target, 'L')) target.leftLegFunctional = false;

  if (target.alive) {
    target.painShock = Math.min(1.0, target.painShock + 0.65);
    target.heartRateBpm = Math.min(168, target.heartRateBpm + 32);
  } else {
    transitionTargetLifecycle(target, { kind: 'LETHAL_DEATH' });
    settleFreshCorpse(target, deathClip, wasDying, plannedRagdoll);
  }

  const newlySevered = applyDismembermentTree(target, report);
  // Killed by the limbs it lost: it goes down rather than standing on as a corpse.
  if (!target.alive) settleFreshCorpse(target, deathClip, wasDying, plannedRagdoll);

  if (target.alive) {
    // Before the reaction, so an arm flinch that loses the gun plays as DISARMED.
    applyHitDisarmRules(target, report, shatteredArmSides);
    applySurvivingReaction(target, report, newlySevered);
  }

  if (wasDying && isDyingAnimated(target)) {
    // A hit during the death clip only jolts it; a blast or a heavy blow throws the body at once.
    if (isKnockdownBlow(report)) {
      applyRagdollActivationAndImpulses(target, report, false, report.ragdollPlan.primaryHitZone, true);
    } else {
      joltDyingBody(target, report.aimDirectionWorld, report.totalEnergyDepositedJ);
    }
  } else if (plannedRagdoll && !isDyingAnimated(target)) {
    applyRagdollActivationAndImpulses(target, report, wasAlreadyRagdoll, report.ragdollPlan.primaryHitZone);
  }

  const hasDismemberment = report.dismembermentEvents.length > 0;
  const hasBoneShatter =
    report.shatteredBones.length > 0 ||
    report.woundEvents.some((w) => w.boneShattered || w.boneFractured);
  const hasHighArmorStop = report.woundEvents.some(
    (w) => w.armorStopped && w.entryEnergyJ >= 380
  );
  const isHeavyCaliber = report.totalEnergyDepositedJ >= 450;

  if (hasDismemberment || hasBoneShatter || isHeavyCaliber || hasHighArmorStop) {
    const durationS = hasDismemberment
      ? 0.05
      : hasBoneShatter || isHeavyCaliber
        ? 0.042
        : 0.035;
    transitionTargetLifecycle(target, { kind: 'APPLY_HITSTOP', durationS });
  } else {
    syncTargetLifecycleDerivedState(target);
  }
}

/**
 * A body that has just died and is not yet in the ragdoll: it starts its death clip, or, when the
 * plan has no clip for it and no ragdoll impulse is coming, drops into the ragdoll as it is.
 */
function settleFreshCorpse(
  target: TargetHealthState,
  deathClip: ReturnType<typeof planShotDeath>,
  wasDying: boolean,
  plannedRagdoll: boolean
): void {
  if (target.isRagdollActive || wasDying || isDyingAnimated(target)) return;
  if (deathClip) {
    startDeathAnimation(target, deathClip);
    return;
  }
  if (plannedRagdoll) return;
  transitionTargetLifecycle(target, { kind: 'ACTIVATE_RAGDOLL', isOverkillCorpseHit: false });
  stabilizeRagdollPoseForTransition(target, 0.0);
}
