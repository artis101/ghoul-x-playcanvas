import type { ShotSimulationReport, TargetHealthState } from '../../contracts/ballistics.ts';
import { computeCombatantTriageStatus } from '../ballistics/triage/triageEvaluator.ts';

/**
 * When a hit may take an enemy's long gun away (docs/wound-movement.md).
 *
 * A fighter keeps its gun until its health bar is red (`RED_HEALTH_HP_FRACTION`, the same band the
 * world plates colour red). That gives it a fighting chance: a healthy enemy shot in the body grips
 * through it. Once the hit leaves it in the red:
 * - a close hit with real stopping power always knocks the gun out of its hands;
 * - any other hit only might, on the old odds (`WEAPON_DROP_CHANCE`) or `RED_BAND_HIT_DROP_CHANCE`.
 *
 * A lost arm, a fall or a knockdown drops the gun whatever the health, because nothing can hold it
 * then; those paths do not come through here. A drawn sidearm is never taken by a hit at all
 * (`enemyArmamentFsm.ts`): only losing the arm that holds it, or dying, loses it.
 */

/**
 * Stopping power: energy the hit left in the body (armour stops included) at close range. Measured
 * through the solver on a 1.3 m chest aim at the tough archetypes:
 * - 12G 00 buckshot deposits ~2300 J within 4 m, ~1850-2070 J at 6 m, ~1400 J at 8 m, ~160 J at 25 m;
 * - .50 AE (Silver Talon) 1300-1850 J; 5.56 M855 (M4A1) 1000-1650 J; 7.62 / .50 BMG 700-3600 J;
 * so all of them disarm inside `MAX_RANGE_M`, and nothing does at 25 m.
 */
export const STOPPING_POWER_DISARM = {
  /** Energy deposited by the whole shot (every pellet that landed). */
  MIN_DEPOSITED_J: 900,
  /** Horizontal shooter-to-target distance. */
  MAX_RANGE_M: 7,
} as const;

/** Odds that any other hit landing on a fighter already in (or now in) the red makes it let go. */
export const RED_BAND_HIT_DROP_CHANCE = 0.15;

/** The health bar is red: the same test the HUD uses to colour it. */
export function isInRedHealthBand(target: TargetHealthState): boolean {
  return computeCombatantTriageStatus(target) === 'MORTALLY_WOUNDED';
}

/** A hit can only cost the long gun while it is still in hand, the body lives, and the bar is red. */
export function canLoseWeaponToHit(target: TargetHealthState): boolean {
  return target.alive && !target.weaponDropped && isInRedHealthBand(target);
}

/** Close, and hard enough to rock the body: the hit that knocks a gun loose deterministically. */
export function isStoppingPowerHit(report: Pick<ShotSimulationReport, 'totalEnergyDepositedJ' | 'targetDistanceM'>): boolean {
  return (
    report.totalEnergyDepositedJ >= STOPPING_POWER_DISARM.MIN_DEPOSITED_J &&
    report.targetDistanceM <= STOPPING_POWER_DISARM.MAX_RANGE_M
  );
}

export type HitDisarmCause = 'STOPPING_POWER' | 'CHANCE' | null;

export interface HitDisarmInput {
  /** The bar is red after the hit and the long gun is still in hand. */
  readonly canLoseWeapon: boolean;
  readonly stoppingPower: boolean;
  /** Uniform [0, 1) from the target's seeded shot variance; null in headless runs (no chance drop). */
  readonly roll: number | null;
  readonly chance?: number;
}

/** Decides whether one surviving hit knocks the long gun loose, and why. Pure. */
export function resolveHitDisarm(input: HitDisarmInput): HitDisarmCause {
  if (!input.canLoseWeapon) return null;
  if (input.stoppingPower) return 'STOPPING_POWER';
  const chance = input.chance ?? RED_BAND_HIT_DROP_CHANCE;
  return input.roll !== null && input.roll < chance ? 'CHANCE' : null;
}
