import type {
  AmmoSpec,
  GhoulZoneId,
  TargetHealthState,
  Vec3Like,
} from '../../../contracts/ballistics.ts';
import { add, dot, length, normalize, scale, sub } from '../vec3.ts';

const MAGNETISM_PRIORITY_ZONES: readonly {
  readonly zone: GhoulZoneId;
  readonly coreRadiusM: number;
  readonly priorityWeight: number;
}[] = [
  { zone: 'HEAD_CRANIUM', coreRadiusM: 0.095, priorityWeight: 0.82 },
  { zone: 'HEAD_FACE_JAW', coreRadiusM: 0.075, priorityWeight: 0.85 },
  { zone: 'NECK_CERVICAL', coreRadiusM: 0.068, priorityWeight: 0.86 },
  { zone: 'TORSO_UPPER_THORAX', coreRadiusM: 0.16, priorityWeight: 1.0 },
  { zone: 'SHOULDER_LEFT', coreRadiusM: 0.075, priorityWeight: 0.92 },
  { zone: 'SHOULDER_RIGHT', coreRadiusM: 0.075, priorityWeight: 0.92 },
  { zone: 'UPPER_ARM_LEFT', coreRadiusM: 0.06, priorityWeight: 0.9 },
  { zone: 'UPPER_ARM_RIGHT', coreRadiusM: 0.06, priorityWeight: 0.9 },
  { zone: 'FOREARM_LEFT', coreRadiusM: 0.052, priorityWeight: 0.92 },
  { zone: 'FOREARM_RIGHT', coreRadiusM: 0.052, priorityWeight: 0.92 },
  { zone: 'THIGH_LEFT', coreRadiusM: 0.085, priorityWeight: 0.95 },
  { zone: 'THIGH_RIGHT', coreRadiusM: 0.085, priorityWeight: 0.95 },
  { zone: 'KNEE_LEFT', coreRadiusM: 0.065, priorityWeight: 0.92 },
  { zone: 'KNEE_RIGHT', coreRadiusM: 0.065, priorityWeight: 0.92 },
];

/**
 * Subtle M&K angular bullet magnetism pre-pass (0.28 deg default cone, <= 4.5cm snap cap).
 * Disabled for multi-pellet buckshot. Only nudges `normAim` when the raw ray narrowly misses
 * an exposed live bone (especially during pain-reaction staggers), preserving exact tissue/armor
 * penetration path lengths inside `simulateShot`.
 */
export function resolveMagnetizedAimDirection(
  origin: Vec3Like,
  normAim: Vec3Like,
  targets: readonly TargetHealthState[],
  ammo?: AmmoSpec,
  maxConeDeg = 0.28,
  maxSnapMeters = 0.045
): Vec3Like {
  if (targets.length === 0) return normAim;
  if (ammo && ammo.pelletCount > 1) return normAim;

  const dir = normalize(normAim);
  const baseConeRad = (Math.max(0.05, maxConeDeg) * Math.PI) / 180;

  // 1. If the raw ray already passes cleanly through any live bone core, never perturb it.
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (!t.alive && !t.isRagdollActive) continue;
    for (let zIdx = 0; zIdx < MAGNETISM_PRIORITY_ZONES.length; zIdx++) {
      const spec = MAGNETISM_PRIORITY_ZONES[zIdx];
      const bone = t.ragdollBones[spec.zone];
      if (!bone || bone.severed || bone.goreMode === 'CRANIAL_POP') continue;

      const toBone = sub(bone.position, origin);
      const along = dot(toBone, dir);
      if (along < 0.6 || along > 140) continue;

      const closestPt = add(origin, scale(dir, along));
      const perpDist = length(sub(bone.position, closestPt));
      if (perpDist <= spec.coreRadiusM * 0.72) {
        return normAim;
      }
    }
  }

  // 2. Search for the closest near-miss bone within the angular forgiveness cone and snap cap.
  let bestScore = Infinity;
  let bestAimDir: Vec3Like | null = null;

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (!t.alive && !t.isRagdollActive) continue;

    const isStaggering = t.activeReaction.type !== 'NONE';
    const effectiveConeRad = isStaggering ? baseConeRad * 1.28 : baseConeRad;
    const effectiveSnapCapM = isStaggering ? maxSnapMeters * 1.2 : maxSnapMeters;

    for (let zIdx = 0; zIdx < MAGNETISM_PRIORITY_ZONES.length; zIdx++) {
      const spec = MAGNETISM_PRIORITY_ZONES[zIdx];
      const bone = t.ragdollBones[spec.zone];
      if (!bone || bone.severed || bone.goreMode === 'CRANIAL_POP') continue;

      const toBone = sub(bone.position, origin);
      const along = dot(toBone, dir);
      if (along < 0.8 || along > 130) continue;

      const closestPt = add(origin, scale(dir, along));
      const missVec = sub(bone.position, closestPt);
      const perpDist = length(missVec);

      const outerRadius = spec.coreRadiusM + effectiveSnapCapM;
      if (perpDist > outerRadius) continue;

      const gapPastCore = Math.max(0, perpDist - spec.coreRadiusM * 0.65);
      const neededAngleRad = Math.atan2(gapPastCore, along);
      if (neededAngleRad > effectiveConeRad) continue;

      const score = neededAngleRad * spec.priorityWeight;
      if (score < bestScore) {
        bestScore = score;
        // Snap gently inside the bone's anatomical core so narrowphase hits cleanly
        const targetOffsetFromCenter = Math.min(perpDist * 0.35, spec.coreRadiusM * 0.45);
        const pullFraction =
          perpDist > 1e-5 ? Math.max(0, (perpDist - targetOffsetFromCenter) / perpDist) : 1.0;
        const nudgedTarget = add(closestPt, scale(missVec, pullFraction));
        bestAimDir = normalize(sub(nudgedTarget, origin));
      }
    }
  }

  return bestAimDir ?? normAim;
}
