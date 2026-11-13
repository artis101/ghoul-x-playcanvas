import type { ShotSimulationReport, TargetHealthState } from '../../../contracts/ballistics.ts';
import { ALL_AUX_PARTICLES, ALL_GHOUL_ZONES } from '../../ghoul/anatomy.ts';
import { add, copyVec3, length, normalize, scale, vec3 } from '../vec3.ts';
import type { NewlySeveredLimbs } from './dismembermentTreeApplicator.ts';
import { isCommittedWoundReaction } from './woundReactionTimings.ts';
import { startWoundReaction } from './woundReactionSelector.ts';
import { gradeZoneWound } from './woundSeverity.ts';

export function applySurvivingReaction(
  target: TargetHealthState,
  report: ShotSimulationReport,
  severed: NewlySeveredLimbs
): void {
  const hitZone = report.ragdollPlan.primaryHitZone;
  if (report.ragdollPlan.willEnableRagdoll || !target.alive || !hitZone) return;

  // While a fall, loss or collapse clip plays it owns where the body is; sliding the root under it
  // would make the clip skate. The hit still jolts it through the reaction selector.
  const clipOwnsBody = isCommittedWoundReaction(target.activeReaction.type);
  const imp = report.ragdollPlan.netRootImpulseWorld;
  const hImpMag = length(vec3(imp.x, 0, imp.z));
  if (hImpMag > 32.0 && !clipOwnsBody) {
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
  startWoundReaction(target, {
    hitZone,
    severity: wound.severity,
    newlySeveredLegSide: severed.newlySeveredRightLeg ? 'RIGHT' : severed.newlySeveredLeftLeg ? 'LEFT' : null,
    newlySeveredArmSide: severed.newlySeveredRightArm ? 'RIGHT' : severed.newlySeveredLeftArm ? 'LEFT' : null,
    energyJ: report.totalEnergyDepositedJ,
    hitDirectionWorld: report.aimDirectionWorld,
  });
}
