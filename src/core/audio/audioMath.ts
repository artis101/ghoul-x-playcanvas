import type { Vec3Like } from '../../contracts/ballistics.ts';

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

export function computeImpactEnergyGain(energyJ: number): number {
  if (!Number.isFinite(energyJ) || energyJ <= 0) {
    return 0.25;
  }
  const normalized = Math.log10(Math.max(10, energyJ)) / 3.05;
  return clampNumber(normalized, 0.25, 1.35);
}

export function distanceToSegmentM(p: Vec3Like, a: Vec3Like, b: Vec3Like): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const apz = p.z - a.z;
  const lenSq = abx * abx + aby * aby + abz * abz;
  if (lenSq < 1e-12) {
    return Math.hypot(apx, apy, apz);
  }
  const t = clampNumber((apx * abx + apy * aby + apz * abz) / lenSq, 0, 1);
  return Math.hypot(apx - abx * t, apy - aby * t, apz - abz * t);
}
