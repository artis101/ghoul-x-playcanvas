import { triggerSide } from '../../core/ghoul/anatomy/handedness.ts';
import type { TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import type { ActiveFiringHand } from './tacticalAiTypes.ts';

export function hashCombatantTargetId(targetId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < targetId.length; i++) {
    h ^= targetId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function isArmChainIntactAndFunctional(
  hs: TargetHealthState,
  hand: ActiveFiringHand
): boolean {
  if (hand === 'RIGHT') {
    return (
      hs.rightArmFunctional &&
      !hs.severedZones.has('HAND_RIGHT') &&
      !hs.severedZones.has('FOREARM_RIGHT') &&
      !hs.severedZones.has('UPPER_ARM_RIGHT') &&
      !hs.severedZones.has('SHOULDER_RIGHT')
    );
  }
  return (
    hs.leftArmFunctional &&
    !hs.severedZones.has('HAND_LEFT') &&
    !hs.severedZones.has('FOREARM_LEFT') &&
    !hs.severedZones.has('UPPER_ARM_LEFT') &&
    !hs.severedZones.has('SHOULDER_LEFT')
  );
}

export function getPreferredPrimaryHand(hs: TargetHealthState): ActiveFiringHand {
  return triggerSide(hs.isLeftHanded);
}

export function selectIntactFiringHand(
  hs: TargetHealthState,
  preferred: ActiveFiringHand
): ActiveFiringHand | null {
  const rightIntact = isArmChainIntactAndFunctional(hs, 'RIGHT');
  const leftIntact = isArmChainIntactAndFunctional(hs, 'LEFT');
  if (preferred === 'RIGHT' && rightIntact) return 'RIGHT';
  if (preferred === 'LEFT' && leftIntact) return 'LEFT';
  if (rightIntact) return 'RIGHT';
  if (leftIntact) return 'LEFT';
  return null;
}

export function wrapAngleRad(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function approachAngleRad(current: number, target: number, maxStep: number): number {
  const diff = wrapAngleRad(target - current);
  if (Math.abs(diff) <= maxStep) {
    return wrapAngleRad(target);
  }
  return wrapAngleRad(current + Math.sign(diff) * maxStep);
}

export function yawToward(from: Vec3Like, to: Vec3Like, fallbackYaw: number): number {
  const x = to.x - from.x;
  const z = to.z - from.z;
  return Math.hypot(x, z) > 1e-3 ? Math.atan2(x, z) : fallbackYaw;
}

/** One copy of the profile rule lives in archetypeTuning.ts; it is re-exported here for old callers. */
export { resolveDefaultCombatantProfile } from './archetypeTuning.ts';
