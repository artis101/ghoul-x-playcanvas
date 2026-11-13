import type { TargetHealthState } from '../../contracts/ballistics.ts';
import { isArmChainIntactAndFunctional, getPreferredPrimaryHand } from './combatantArmEvaluation.ts';
import { moveHorizontalClamped } from './tacticalLocomotion.ts';
import { isPrimaryShotDry } from './enemyWeaponMagazine.ts';
import type { EnemyAiAgentRuntime } from './tacticalAiTypes.ts';
import type { TacticalFsmContext } from './tacticalFsmContext.ts';

/** Hurried crouching dash to the gun. */
const RECOVERY_RUN_SPEED_MS = 2.4;
/** Close enough to reach down for it. */
const PICKUP_REACH_M = 0.45;
/** Bending, grabbing and standing back up: the length of the `PickupWeapon` clip at speed 1. */
export const PICKUP_WEAPON_CLIP_S = 1.37;
/** The hands close on the gun this far through the clip; from here it is held again. */
export const PICKUP_GUN_IN_HAND_PROGRESS = 0.5;
/** A gun that skidded further than this is abandoned. */
const MAX_RECOVERY_DISTANCE_M = 6.0;

/**
 * How far through the reach for the gun each body is, 0..PICKUP_GUN_IN_HAND_PROGRESS, while it
 * crouches over it. The AI writes it; the mannequin reads it to play `PickupWeapon` (the AI and
 * the mannequin do not share the agent). Keyed by the health state so it goes with the combatant.
 */
const pickupProgress = new WeakMap<TargetHealthState, number>();

/** Progress through the pickup clip while the body reaches for its gun, or null. */
export function weaponPickupProgress(hs: TargetHealthState): number | null {
  return pickupProgress.get(hs) ?? null;
}

/** Sets (or, with null, clears) how far the body is through reaching for its gun. */
export function markWeaponPickupProgress(hs: TargetHealthState, progress: number | null): void {
  if (progress === null) pickupProgress.delete(hs);
  else pickupProgress.set(hs, progress);
}

function setPickupProgress(hs: TargetHealthState, agent: EnemyAiAgentRuntime, timerS: number): void {
  agent.weaponPickupTimerS = timerS;
  markWeaponPickupProgress(hs, timerS > 0 ? timerS / PICKUP_WEAPON_CLIP_S : null);
}

/**
 * A fighter who had the gun knocked out of its hands does not stand there: if both arms still
 * work and it is not dying, it dashes to where the gun landed, snatches it up and fights on.
 * Returns true while it is busy recovering the weapon this frame.
 *
 * The gun is back in hand halfway through the pickup clip; the mannequin plays the rest of the
 * clip (standing back up) by itself, and holds the AI still until it ends.
 */
export function stepWeaponRecovery(
  dt: number,
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  ctx: TacticalFsmContext,
): boolean {
  const gun = hs.droppedWeaponWorld;
  // A gun shot empty with no rounds left to load is left where it fell.
  if (!gun || !hs.alive || hs.isRagdollActive || agent.triageStatus === 'MORTALLY_WOUNDED' || isPrimaryShotDry(agent)) {
    setPickupProgress(hs, agent, 0);
    return false;
  }
  const armsAndLegsWork = isArmChainIntactAndFunctional(hs, 'RIGHT') && isArmChainIntactAndFunctional(hs, 'LEFT') &&
    hs.rightLegFunctional && hs.leftLegFunctional;
  const dx = gun.x - hs.worldPosition.x;
  const dz = gun.z - hs.worldPosition.z;
  const dist = Math.hypot(dx, dz);
  if (!armsAndLegsWork || dist > MAX_RECOVERY_DISTANCE_M) {
    setPickupProgress(hs, agent, 0);
    return false;
  }

  agent.isPeekingOut = false;
  hs.yawRad = Math.atan2(dx, dz);

  if (dist > PICKUP_REACH_M) {
    setPickupProgress(hs, agent, 0);
    moveHorizontalClamped(hs, gun.x, gun.z, RECOVERY_RUN_SPEED_MS * dt, ctx.rapierWorld);
    return true;
  }

  // Timed against the clip so the hands meet the gun on the frame the clip shows it.
  const timerS = (agent.weaponPickupTimerS ?? 0) + dt;
  if (timerS < PICKUP_WEAPON_CLIP_S * PICKUP_GUN_IN_HAND_PROGRESS) {
    setPickupProgress(hs, agent, Math.max(timerS, 1e-4));
    return true;
  }

  // Back in hand: the weapon mount sees weaponDropped clear, reattaches the gun and hides the prop.
  setPickupProgress(hs, agent, 0);
  hs.weaponDropped = false;
  hs.primaryArmDisarmed = false;
  hs.posture = 'COMBAT_READY';
  if (hs.combatantStatusTag === 'DISARMED') hs.combatantStatusTag = null;
  agent.armamentState = { kind: 'PRIMARY_ARMED', hand: getPreferredPrimaryHand(hs) };
  return false;
}
