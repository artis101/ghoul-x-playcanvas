import type { TargetHealthState } from '../../contracts/ballistics.ts';
import { isArmChainIntactAndFunctional, getPreferredPrimaryHand } from './combatantArmEvaluation.ts';
import { moveHorizontalClamped } from './tacticalLocomotion.ts';
import type { EnemyAiAgentRuntime } from './tacticalAiTypes.ts';
import type { TacticalFsmContext } from './tacticalFsmContext.ts';

/** Hurried crouching dash to the gun. */
const RECOVERY_RUN_SPEED_MS = 2.4;
/** Close enough to reach down for it. */
const PICKUP_REACH_M = 0.45;
/** Bending, grabbing and bringing it back up. */
const PICKUP_DURATION_S = 0.7;
/** A gun that skidded further than this is abandoned. */
const MAX_RECOVERY_DISTANCE_M = 6.0;

/**
 * A fighter who had the gun knocked out of its hands does not stand there: if both arms still
 * work and it is not dying, it dashes to where the gun landed, snatches it up and fights on.
 * Returns true while it is busy recovering the weapon this frame.
 */
export function stepWeaponRecovery(
  dt: number,
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  ctx: TacticalFsmContext,
): boolean {
  const gun = hs.droppedWeaponWorld;
  if (!gun || !hs.alive || hs.isRagdollActive || agent.triageStatus === 'MORTALLY_WOUNDED') {
    agent.weaponPickupTimerS = 0;
    return false;
  }
  if (!isArmChainIntactAndFunctional(hs, 'RIGHT') || !isArmChainIntactAndFunctional(hs, 'LEFT')) return false;
  if (!hs.rightLegFunctional || !hs.leftLegFunctional) return false;

  const dx = gun.x - hs.worldPosition.x;
  const dz = gun.z - hs.worldPosition.z;
  const dist = Math.hypot(dx, dz);
  if (dist > MAX_RECOVERY_DISTANCE_M) return false;

  agent.isPeekingOut = false;
  hs.yawRad = Math.atan2(dx, dz);

  if (dist > PICKUP_REACH_M) {
    agent.weaponPickupTimerS = 0;
    moveHorizontalClamped(hs, gun.x, gun.z, RECOVERY_RUN_SPEED_MS * dt, ctx.rapierWorld);
    return true;
  }

  agent.weaponPickupTimerS = (agent.weaponPickupTimerS ?? 0) + dt;
  if (agent.weaponPickupTimerS < PICKUP_DURATION_S) return true;

  // Back in hand: the weapon mount sees weaponDropped clear, reattaches the gun and hides the prop.
  agent.weaponPickupTimerS = 0;
  hs.weaponDropped = false;
  hs.primaryArmDisarmed = false;
  hs.posture = 'COMBAT_READY';
  if (hs.combatantStatusTag === 'DISARMED') hs.combatantStatusTag = null;
  agent.armamentState = { kind: 'PRIMARY_ARMED', hand: getPreferredPrimaryHand(hs) };
  return false;
}
