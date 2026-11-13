import type { ShotSimulationReport, TargetHealthState } from '../../../contracts/ballistics.ts';
import { transitionTargetLifecycle } from '../lifecycle/targetLifecycleFsm.ts';
import { WEAPON_DROP_CHANCE, rollsWeaponDrop } from '../../combatant/weaponDropRoll.ts';
import {
  canLoseWeaponToHit,
  isStoppingPowerHit,
  resolveHitDisarm,
} from '../../combatant/hitDisarmPolicy.ts';
import { createSeededRng, mixSeed } from '../../random/seededRng.ts';

/** Salt so the arm-out roll does not reuse the shot's other draws. */
const ARM_OUT_SALT = 0xa4a0;
/** Salt for the red-band let-go roll. */
const RED_DROP_SALT = 0xd209;

/**
 * Whether this surviving hit costs the fighter its long gun (hitDisarmPolicy.ts). Runs once the
 * shot's wounds, bleeding and lost limbs are on the target, so the red test sees the bar the player
 * sees. Above the red band nothing here happens: a shattered arm is fought through, a grip-hand
 * hit is gripped through and the body keeps its gun. In the red:
 * 1. a shattered gun arm may give out (the old odds); an arm that stops working drops the gun;
 * 2. a round into the grip hand may knock the gun loose (the old odds, rolled by the shot);
 * 3. a close hit with stopping power knocks it loose for certain, any other hit only might.
 */
export function applyHitDisarmRules(
  target: TargetHealthState,
  report: ShotSimulationReport,
  shatteredArmSides: readonly ('RIGHT' | 'LEFT')[]
): void {
  if (!canLoseWeaponToHit(target)) return;

  const seed = target.shotVarianceSeed;
  const armRng = seed !== undefined ? createSeededRng(mixSeed(seed, ARM_OUT_SALT)) : null;
  for (const side of shatteredArmSides) {
    if (!rollsWeaponDrop(armRng ? armRng() : null, WEAPON_DROP_CHANCE.SHATTERED_GRIP_ARM)) continue;
    if (side === 'RIGHT') target.rightArmFunctional = false;
    else target.leftArmFunctional = false;
    // The armament state machine sees the arm gone and lets the long gun fall.
    target.weaponDropped = true;
  }
  if (target.weaponDropped) return;

  if (report.weaponDisarmed) {
    transitionTargetLifecycle(target, { kind: 'PRIMARY_ARM_DISARM' });
    return;
  }

  // A knockdown drops the gun on its own; the flesh must actually have been reached.
  if (report.ragdollPlan.willEnableRagdoll) return;
  if (!report.woundEvents.some((w) => !w.armorStopped) && !isStoppingPowerHit(report)) return;
  const dropRng = seed !== undefined ? createSeededRng(mixSeed(seed, RED_DROP_SALT)) : null;
  const cause = resolveHitDisarm({
    canLoseWeapon: true,
    stoppingPower: isStoppingPowerHit(report),
    roll: dropRng ? dropRng() : null,
  });
  if (cause !== null) {
    // A plain drop, as from a knockdown: the arms still work, so the fighter may pick it back up.
    target.weaponDropped = true;
  }
}
