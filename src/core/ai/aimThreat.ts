import type { Vec3Like } from '../../contracts/ballistics.ts';

// Rough half-width of a standing torso, used to size the "crosshair is on me" cone.
const BODY_HALF_WIDTH_M = 0.45;
// Height of the chest above the combatant's feet.
const CHEST_HEIGHT_M = 1.3;
// The threat fades out over this many body half-widths beyond the body itself.
const FALLOFF_WIDTHS = 2.5;
// Extra slack so a distant enemy still notices a gun swinging roughly its way.
const MIN_FALLOFF_RAD = 0.05;

/**
 * How directly the player's aim covers a combatant, from 0 (looking elsewhere)
 * to 1 (crosshair on its body). Engine-agnostic: takes the player's eye, their
 * view direction and the combatant's feet position.
 */
export function computeAimThreat(
  playerEyeWorld: Vec3Like,
  playerForwardWorld: Vec3Like,
  combatantFeetWorld: Vec3Like
): number {
  const tx = combatantFeetWorld.x - playerEyeWorld.x;
  const ty = combatantFeetWorld.y + CHEST_HEIGHT_M - playerEyeWorld.y;
  const tz = combatantFeetWorld.z - playerEyeWorld.z;
  const dist = Math.hypot(tx, ty, tz);
  const fwdLen = Math.hypot(playerForwardWorld.x, playerForwardWorld.y, playerForwardWorld.z);
  if (dist < 1e-3 || fwdLen < 1e-6) return 0;

  const cos = (tx * playerForwardWorld.x + ty * playerForwardWorld.y + tz * playerForwardWorld.z) / (dist * fwdLen);
  if (cos <= 0) return 0;
  const angle = Math.acos(Math.min(1, cos));

  const bodyRad = Math.atan(BODY_HALF_WIDTH_M / dist);
  if (angle <= bodyRad) return 1;
  const falloffRad = bodyRad * FALLOFF_WIDTHS + MIN_FALLOFF_RAD;
  const t = (angle - bodyRad) / falloffRad;
  return t >= 1 ? 0 : 1 - t;
}
