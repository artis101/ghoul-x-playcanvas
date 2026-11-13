import type { TargetHealthState } from '../../../contracts/ballistics.ts';
import { type BodySide, oppositeSide, triggerSide } from '../../ghoul/anatomy/handedness.ts';

/** True while the arm still works and its forearm and hand are on the body. */
export function isDownedArmUsable(target: TargetHealthState, side: BodySide): boolean {
  const functional = side === 'RIGHT' ? target.rightArmFunctional : target.leftArmFunctional;
  return (
    functional &&
    target.ragdollBones[`FOREARM_${side}`].componentId === 'BODY' &&
    target.ragdollBones[`HAND_${side}`].componentId === 'BODY'
  );
}

/**
 * The arm a body on the ground holds its weapon out in: the trigger arm while it works, else the
 * other one, else none.
 */
export function resolveDownedGunSide(target: TargetHealthState): BodySide | null {
  const preferred = triggerSide(target.isLeftHanded);
  if (isDownedArmUsable(target, preferred)) return preferred;
  const other = oppositeSide(preferred);
  return isDownedArmUsable(target, other) ? other : null;
}
