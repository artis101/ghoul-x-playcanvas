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

/** How long a fresh drop waits for the weapon mount to publish where the gun landed. */
const DROP_LANDING_GRACE_S = 0.3;

function limbsCanRecover(hs: TargetHealthState): boolean {
  return (
    isArmChainIntactAndFunctional(hs, 'RIGHT') &&
    isArmChainIntactAndFunctional(hs, 'LEFT') &&
    hs.rightLegFunctional &&
    hs.leftLegFunctional
  );
}

/**
 * Whether this fighter can go and get its dropped long gun: it is on its feet with both arms and
 * legs working, not in a wounded sequence, the gun still has rounds, and it lies close enough.
 * A gun just dropped counts for a moment before its landing spot is known, so the fighter does not
 * start drawing its handgun only to put it straight back.
 */
export function canRecoverDroppedWeapon(hs: TargetHealthState, agent: EnemyAiAgentRuntime): boolean {
  if (!hs.weaponDropped || !hs.alive || hs.isRagdollActive || isPrimaryShotDry(agent)) return false;
  if ((hs.woundedPhase ?? 'NONE') !== 'NONE' || !limbsCanRecover(hs)) return false;
  const gun = hs.droppedWeaponWorld;
  if (!gun) return (agent.droppedGunWaitS ?? 0) < DROP_LANDING_GRACE_S;
  return Math.hypot(gun.x - hs.worldPosition.x, gun.z - hs.worldPosition.z) <= MAX_RECOVERY_DISTANCE_M;
}

/** Ticks the wait for a fresh drop's landing spot (see `canRecoverDroppedWeapon`). */
export function tickDroppedGunWait(dt: number, hs: TargetHealthState, agent: EnemyAiAgentRuntime): void {
  agent.droppedGunWaitS = hs.weaponDropped && !hs.droppedWeaponWorld ? (agent.droppedGunWaitS ?? 0) + dt : 0;
}

/**
 * A fighter who had the gun knocked out of its hands does not stand there: if it can (see
 * `canRecoverDroppedWeapon`), it dashes to where the gun landed, snatches it up and fights on.
 * It does not draw the handgun first. Returns true while it is busy recovering the weapon.
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
  if (!gun || !canRecoverDroppedWeapon(hs, agent)) {
    setPickupProgress(hs, agent, 0);
    // Still waiting to see where it landed: hold still rather than run off.
    return canRecoverDroppedWeapon(hs, agent);
  }
  const dx = gun.x - hs.worldPosition.x;
  const dz = gun.z - hs.worldPosition.z;
  const dist = Math.hypot(dx, dz);

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
