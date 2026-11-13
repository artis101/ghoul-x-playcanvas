import type {
  JaggedHoleStampOptions,
  Point2D,
  WoodStampProfile,
} from './woodClipperTypes.ts';

import { createSeededRng } from '../../random/seededRng.ts';

export { createSeededRng };

function hashStampInputs(
  u: number,
  v: number,
  caliberRadiusM: number,
  kineticEnergyJ: number,
  profile: WoodStampProfile,
  seed: number,
): number {
  const qu = Math.round(u * 10_000);
  const qv = Math.round(v * 10_000);
  const qc = Math.round(caliberRadiusM * 100_000);
  const qe = Math.round(kineticEnergyJ * 10);
  let h = 2166136261;
  h = Math.imul(h ^ qu, 16777619);
  h = Math.imul(h ^ qv, 16777619);
  h = Math.imul(h ^ qc, 16777619);
  h = Math.imul(h ^ qe, 16777619);
  h = Math.imul(h ^ Math.round(seed * 9973), 16777619);
  for (let i = 0; i < profile.length; i++) {
    h = Math.imul(h ^ profile.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

export function inferWoodStampProfile(
  caliberRadiusM: number,
  kineticEnergyJ: number,
  isArmorPiercing: boolean,
): WoodStampProfile {
  if (caliberRadiusM >= 0.0075 && kineticEnergyJ >= 2500) {
    return 'HEAVY_50AE_SLUG';
  }
  if (caliberRadiusM <= 0.0048 && kineticEnergyJ <= 350) {
    return 'BUCKSHOT_PELLET';
  }
  if (isArmorPiercing) {
    return 'RIFLE_FMJ_AP';
  }
  return 'RIFLE_JHP';
}

export function createJaggedHoleStamp(options: JaggedHoleStampOptions): Point2D[] {
  const profile =
    options.profile ??
    inferWoodStampProfile(
      options.caliberRadiusM,
      options.kineticEnergyJ,
      options.isArmorPiercing ?? false,
    );

  let vertexCount = 12;
  let baseRadiusM = 0.05;
  let grainStretchU = 1.32;
  let toothJaggedness = 0.30;

  const clampedCaliberR = Math.max(0.002, Math.min(0.12, options.caliberRadiusM));
  const energyFactor = Math.min(
    1.65,
    Math.max(0.65, Math.sqrt(Math.max(50, options.kineticEnergyJ) / 1600)),
  );

  switch (profile) {
    case 'BUCKSHOT_PELLET': {
      vertexCount = 10;
      baseRadiusM =
        Math.max(0.036, clampedCaliberR * 8.6) *
        Math.min(1.22, energyFactor + 0.38);
      grainStretchU = 1.28;
      toothJaggedness = 0.28;
      break;
    }
    case 'RIFLE_FMJ_AP': {
      vertexCount = 12;
      baseRadiusM =
        Math.max(0.046, clampedCaliberR * 12.0) * (0.86 + 0.24 * energyFactor);
      grainStretchU = 1.34;
      toothJaggedness = 0.30;
      break;
    }
    case 'RIFLE_JHP': {
      vertexCount = 12;
      baseRadiusM =
        Math.max(0.058, clampedCaliberR * 15.0) * (0.88 + 0.26 * energyFactor);
      grainStretchU = 1.36;
      toothJaggedness = 0.34;
      break;
    }
    case 'HEAVY_50AE_SLUG': {
      vertexCount = 13;
      baseRadiusM =
        Math.max(0.092, clampedCaliberR * 12.8) * (0.88 + 0.25 * energyFactor);
      grainStretchU = 1.38;
      toothJaggedness = 0.36;
      break;
    }
    case 'BUCKSHOT_CLUSTER': {
      vertexCount = 14;
      baseRadiusM =
        Math.max(0.185, clampedCaliberR * 28.0) * (0.90 + 0.22 * energyFactor);
      grainStretchU = 1.42;
      toothJaggedness = 0.36;
      break;
    }
    case 'BLAST_BREACH': {
      vertexCount = 14;
      baseRadiusM = Math.max(0.30, 0.24 * energyFactor);
      grainStretchU = 1.18;
      toothJaggedness = 0.32;
      break;
    }
  }

  if (options.overrideRadiusM !== undefined && options.overrideRadiusM > 0.005) {
    baseRadiusM = options.overrideRadiusM;
  }
  if (options.grainStretchOverride !== undefined && options.grainStretchOverride >= 1.0) {
    grainStretchU = options.grainStretchOverride;
  }

  const rng = createSeededRng(
    hashStampInputs(
      options.u,
      options.v,
      clampedCaliberR,
      options.kineticEnergyJ,
      profile,
      options.seed ?? 0,
    ),
  );

  const phaseOffset = rng() * Math.PI * 2;
  const stepAngle = (Math.PI * 2) / vertexCount;
  const stamp: Point2D[] = new Array<Point2D>(vertexCount);

  for (let i = 0; i < vertexCount; i++) {
    const angleJitter = (rng() - 0.5) * stepAngle * 0.34;
    const theta = phaseOffset + i * stepAngle + angleJitter;
    const alternatingSign = (i & 1) === 0 ? 1 : -1;
    const radialJitter = 1 + alternatingSign * toothJaggedness * (0.55 + 0.45 * rng());
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    const grainSpike = 1 + (grainStretchU - 1) * cosT * cosT;
    const r = baseRadiusM * radialJitter * grainSpike;

    stamp[i] = {
      u: options.u + cosT * r,
      v: options.v + sinT * r,
    };
  }

  return stamp;
}
