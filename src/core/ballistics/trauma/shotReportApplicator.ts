import {
  ShotSimulationReport,
  TargetHealthState,
} from '../../../contracts/ballistics.ts';
import {
  syncTargetLifecycleDerivedState,
  transitionTargetLifecycle,
} from '../lifecycle/targetLifecycleFsm.ts';
import { stabilizeRagdollPoseForTransition } from '../ragdoll/ragdollPoseStabilizer.ts';
import { applyWoundsAndDecals } from './woundDecalApplicator.ts';
import { mixSeed } from '../../random/seededRng.ts';
import { applyDismembermentTree } from './dismembermentTreeApplicator.ts';
import { applySurvivingReaction } from './reactionAgonyApplicator.ts';
import { applyRagdollActivationAndImpulses } from './ragdollImpulseApplicator.ts';

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

  const { rightLegShotEnergyJ, leftLegShotEnergyJ } = applyWoundsAndDecals(target, report);

  if (rightLegShotEnergyJ >= 85.0) target.rightLegFunctional = false;
  if (leftLegShotEnergyJ >= 85.0) target.leftLegFunctional = false;

  if (target.alive) {
    target.painShock = Math.min(1.0, target.painShock + 0.65);
    target.heartRateBpm = Math.min(168, target.heartRateBpm + 32);
  } else {
    transitionTargetLifecycle(target, { kind: 'LETHAL_DEATH' });
    if (!target.isRagdollActive && !report.ragdollPlan.willEnableRagdoll) {
      transitionTargetLifecycle(target, {
        kind: 'ACTIVATE_RAGDOLL',
        isOverkillCorpseHit: false,
      });
      stabilizeRagdollPoseForTransition(target, 0.0);
    }
  }

  const { newlySeveredRightLeg, newlySeveredLeftLeg } = applyDismembermentTree(target, report);
  if (!target.alive && !target.isRagdollActive && !report.ragdollPlan.willEnableRagdoll) {
    // Killed by the limbs it lost: it falls rather than standing on as a corpse.
    transitionTargetLifecycle(target, { kind: 'ACTIVATE_RAGDOLL', isOverkillCorpseHit: false });
    stabilizeRagdollPoseForTransition(target, 0.0);
  }

  if (target.alive) {
    applySurvivingReaction(target, report, newlySeveredRightLeg, newlySeveredLeftLeg);
  }

  applyRagdollActivationAndImpulses(target, report, wasAlreadyRagdoll, report.ragdollPlan.primaryHitZone);

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
