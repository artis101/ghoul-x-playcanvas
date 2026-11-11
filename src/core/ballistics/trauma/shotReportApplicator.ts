import {
  ShotSimulationReport,
  TargetHealthState,
} from '../../../contracts/ballistics.ts';
import { applyWoundsAndDecals } from './woundDecalApplicator.ts';
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

  const wasAlreadyRagdoll = target.isRagdollActive;

  const { leftLegShotEnergyJ, rightLegShotEnergyJ } = applyWoundsAndDecals(target, report);

  if (leftLegShotEnergyJ >= 85.0) target.leftLegFunctional = false;
  if (rightLegShotEnergyJ >= 85.0) target.rightLegFunctional = false;

  if (target.alive) {
    target.painShock = Math.min(1.0, target.painShock + 0.65);
    target.heartRateBpm = Math.min(168, target.heartRateBpm + 32);
  }

  const { newlySeveredLeftLeg, newlySeveredRightLeg } = applyDismembermentTree(target, report);

  applySurvivingReaction(target, report, newlySeveredLeftLeg, newlySeveredRightLeg);

  applyRagdollActivationAndImpulses(target, report, wasAlreadyRagdoll, report.ragdollPlan.primaryHitZone);
}
