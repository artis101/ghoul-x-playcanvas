import type { TargetHealthState } from '../../../contracts/ballistics/targetHealthContracts.ts';
import { listLostLimbs } from '../trauma/limbLossDeathRule.ts';
import { computeCombatantTriageStatus } from './triageEvaluator.ts';
import { isSeatedPhase } from './seatedLastStand.ts';

/** Seconds a merely wounded fighter lies downed before it gets back up. */
export const DOWNED_RECOVERY_S = 14;

/** A living body lying (or sitting, or crawling) on the floor, not still tumbling through the air. */
function isDownedOnFloor(hs: TargetHealthState): boolean {
  if (!hs.alive) return false;
  if (hs.isRagdollActive) return hs.posture === 'RAGDOLL_GROUNDED';
  return isSeatedPhase(hs.woundedPhase) || hs.woundedPhase === 'DOWNED_CRAWL';
}

/**
 * Only a wounded fighter gets up. One that is mortally wounded (red health bar, heavy bleeding, a
 * vital organ hit or a major amputation) stays down until it dies. The clock restarts whenever the
 * body is not downed or has turned mortal, so it counts only uninterrupted time as merely wounded.
 * Returns true on the frame the body stands back up.
 */
export function stepDownedRecovery(hs: TargetHealthState, dt: number): boolean {
  if (!isDownedOnFloor(hs) || computeCombatantTriageStatus(hs) === 'MORTALLY_WOUNDED') {
    hs.downedTimerS = 0;
    return false;
  }
  hs.downedTimerS = (hs.downedTimerS ?? 0) + dt;
  if (hs.downedTimerS < DOWNED_RECOVERY_S) return false;
  standBackUp(hs);
  return true;
}

function standBackUp(hs: TargetHealthState): void {
  const lost = listLostLimbs(hs.severedZones);
  // A leg that was only knocked out works again; a severed one does not.
  if (!lost.includes('LEG_RIGHT')) hs.rightLegFunctional = true;
  if (!lost.includes('LEG_LEFT')) hs.leftLegFunctional = true;
  if (hs.isRagdollActive) {
    hs.worldPosition = { x: hs.ragdollRootPosition.x, y: hs.worldPosition.y, z: hs.ragdollRootPosition.z };
  }
  hs.isRagdollActive = false;
  hs.ragdollPhase = { kind: 'INACTIVE' };
  hs.dying = null;
  hs.posture = 'COMBAT_READY';
  hs.woundedPhase = 'NONE';
  hs.woundedPhaseTimerS = 0;
  hs.plannedDownedPhase = undefined;
  hs.downedFacingWorld = undefined;
  hs.faceDownSettleS = undefined;
  hs.downedTimerS = 0;
  hs.activeReaction.type = 'NONE';
  hs.activeReaction.timerS = 0;
  hs.combatantStatusTag = null;
}
