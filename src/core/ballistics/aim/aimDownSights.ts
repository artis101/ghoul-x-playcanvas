import type { Vec3Like, WeaponAdsProfile } from '../../../contracts/ballistics.ts';
import { add, cross, lengthSq, normalize, scale } from '../vec3.ts';

const DEG_TO_RAD = Math.PI / 180;

/** Advances the 0..1 aim progress at the weapon's own aim-in / aim-out speed. */
export function stepAdsProgress(
  progress: number,
  aiming: boolean,
  dt: number,
  profile: WeaponAdsProfile
): number {
  const durationS = Math.max(0.01, aiming ? profile.aimInTimeS : profile.aimOutTimeS);
  const next = progress + (aiming ? dt : -dt) / durationS;
  return Math.max(0, Math.min(1, next));
}

/** Smootherstep: the weapon leaves the hip and settles on the eye with no velocity jump. */
export function easeAdsBlend(progress: number): number {
  const t = Math.max(0, Math.min(1, progress));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Vertical field of view for a given blend, interpolated in screen scale so zoom speed looks even. */
export function adsFovDeg(hipFovDeg: number, zoom: number, blend: number): number {
  const hipTan = Math.tan(hipFovDeg * 0.5 * DEG_TO_RAD);
  const aimedTan = hipTan / Math.max(1, zoom);
  return (2 * Math.atan(hipTan + (aimedTan - hipTan) * blend)) / DEG_TO_RAD;
}

/** Look-speed multiplier that keeps the same on-screen motion per mouse count at any zoom. */
export function adsSensitivityScale(hipFovDeg: number, currentFovDeg: number): number {
  return Math.tan(currentFovDeg * 0.5 * DEG_TO_RAD) / Math.tan(hipFovDeg * 0.5 * DEG_TO_RAD);
}

/**
 * Aim-error cone half-angle. Fully aimed shots go exactly where the sights point; the cone
 * opens as the weapon comes off the eye, while walking, and while recoil has not settled.
 */
export function aimSpreadRad(
  profile: WeaponAdsProfile,
  blend: number,
  moveBlend: number,
  recoilPitchDeg: number
): number {
  const hip = 1 - Math.max(0, Math.min(1, blend));
  const move = Math.max(0, Math.min(1, moveBlend));
  const heat = Math.min(1.5, Math.max(0, recoilPitchDeg) * 0.14);
  return hip * (profile.hipSpreadRad * (1 + heat) + profile.hipMoveSpreadRad * move);
}

/** Deflects `dir` inside a cone of half-angle `spreadRad`; u1 and u2 are uniform in [0, 1). */
export function deflectWithinCone(dir: Vec3Like, spreadRad: number, u1: number, u2: number): Vec3Like {
  if (spreadRad <= 0) return normalize(dir);
  const forward = normalize(dir);
  const rightRaw = cross(forward, { x: 0, y: 1, z: 0 });
  const right = lengthSq(rightRaw) > 1e-8 ? normalize(rightRaw) : { x: 1, y: 0, z: 0 };
  const up = cross(right, forward);
  const radius = Math.tan(spreadRad) * Math.sqrt(u1);
  const angle = u2 * Math.PI * 2;
  return normalize(
    add(forward, add(scale(right, Math.cos(angle) * radius), scale(up, Math.sin(angle) * radius)))
  );
}
