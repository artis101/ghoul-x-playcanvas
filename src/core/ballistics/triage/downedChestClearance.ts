import type { TargetHealthState, Vec3Like } from '../../../contracts/ballistics.ts';
import { sideSignX } from '../../ghoul/anatomy/handedness.ts';
import { computeChestFrame } from '../../ghoul/anatomy/ragdollBodyFrames.ts';
import { add, dot, length, normalize, scale } from '../vec3.ts';
import { resolveDownedGunSide } from './downedGunSide.ts';

const DEG = Math.PI / 180;
// A straight arm swung across the body clears the ribcage only while it also reaches out in
// front of it: the shoulder sits about 0.18 m off the midline and the chest wall about 0.1 m
// ahead of it, so the arm may cross no more steeply than this from the chest's forward line.
const MAX_CROSS_RAD = 40 * DEG;
const CROSS_COS = Math.cos(MAX_CROSS_RAD);
const CROSS_SIN = Math.sin(MAX_CROSS_RAD);

/**
 * Turns a downed gun arm's direction so it never passes through its own chest. Reaching out to
 * the gun side, up, or down along the flank is left alone; reaching across the body is held to
 * the steepest crossing that stays in front of the ribcage.
 */
export function keepAimClearOfChest(target: TargetHealthState, direction: Vec3Like): Vec3Like {
  const wanted = normalize(direction);
  const chest = computeChestFrame(target);
  const gunSide = resolveDownedGunSide(target);
  if (!chest || !gunSide) return wanted;
  const outward = scale(chest.right, sideSignX(gunSide));
  const f = dot(wanted, chest.forward);
  const o = dot(wanted, outward);
  if (o >= 0 || -o <= (CROSS_SIN / CROSS_COS) * f) return wanted;
  // Project the chest-plane part onto the steepest allowed crossing, keeping the rise or fall
  // along the spine.
  const u = dot(wanted, chest.up);
  const t = Math.max(0, f * CROSS_COS - o * CROSS_SIN);
  const allowed = add(
    add(scale(chest.forward, t * CROSS_COS), scale(outward, -t * CROSS_SIN)),
    scale(chest.up, u)
  );
  return length(allowed) < 1e-4 ? chest.forward : normalize(allowed);
}

/** True when the direction already passes in front of the chest rather than through it. */
export function isAimClearOfChest(target: TargetHealthState, direction: Vec3Like): boolean {
  const kept = keepAimClearOfChest(target, direction);
  return dot(kept, normalize(direction)) > 0.999;
}
