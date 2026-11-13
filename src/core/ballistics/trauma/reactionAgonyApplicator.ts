import type { ShotSimulationReport, TargetHealthState } from '../../../contracts/ballistics.ts';
import type { NewlySeveredLimbs } from './dismembermentTreeApplicator.ts';
import { startWoundReaction } from './woundReactionSelector.ts';
import { gradeZoneWound } from './woundSeverity.ts';

/**
 * A broken pelvis on a body still too healthy to be knocked flat: the hip will not carry it, so it
 * goes down the way a crippled leg does, with the leg-shot fall onto its seat. The side is the one
 * the round entered (a southpaw's left is +X in the bone frame, like everyone's).
 */
function crippleLegOnPelvisFracture(target: TargetHealthState, report: ShotSimulationReport): void {
  const pelvisWound = report.woundEvents.find((w) => w.boneFractured && w.ghoulZone === 'PELVIS_GROIN');
  if (!pelvisWound) return;
  if (pelvisWound.localEntryOffset.x > 0) target.leftLegFunctional = false;
  else target.rightLegFunctional = false;
}

/**
 * Picks the surviving body's reaction to the hit. The body is never shoved across the floor: a
 * hit makes it flinch where it stands (a living body that slid under every bullet looked like it
 * was on ice). Only a knockdown, which the ragdoll handles, moves it.
 */
export function applySurvivingReaction(
  target: TargetHealthState,
  report: ShotSimulationReport,
  severed: NewlySeveredLimbs
): void {
  const hitZone = report.ragdollPlan.primaryHitZone;
  if (report.ragdollPlan.willEnableRagdoll || !target.alive || !hitZone) return;

  crippleLegOnPelvisFracture(target, report);

  const wound = gradeZoneWound(hitZone, report.woundEvents);
  startWoundReaction(target, {
    hitZone,
    severity: wound.severity,
    newlySeveredLegSide: severed.newlySeveredRightLeg ? 'RIGHT' : severed.newlySeveredLeftLeg ? 'LEFT' : null,
    newlySeveredArmSide: severed.newlySeveredRightArm ? 'RIGHT' : severed.newlySeveredLeftArm ? 'LEFT' : null,
    energyJ: report.totalEnergyDepositedJ,
    hitDirectionWorld: report.aimDirectionWorld,
  });
}
