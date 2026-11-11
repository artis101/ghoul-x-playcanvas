export function hash2D(ix: number, iy: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export function valueNoise2D(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);

  const n00 = hash2D(ix, iy);
  const n10 = hash2D(ix + 1, iy);
  const n01 = hash2D(ix, iy + 1);
  const n11 = hash2D(ix + 1, iy + 1);

  const nx0 = n00 + (n10 - n00) * ux;
  const nx1 = n01 + (n11 - n01) * ux;
  return nx0 + (nx1 - nx0) * uy;
}

export function fbmNoise2D(x: number, y: number): number {
  const o1 = valueNoise2D(x, y) * 0.55;
  const o2 = valueNoise2D(x * 2.13 + 17.7, y * 2.13 - 9.3) * 0.3;
  const o3 = valueNoise2D(x * 4.41 - 5.2, y * 4.41 + 23.1) * 0.15;
  return o1 + o2 + o3;
}

export interface CraterSurfaceSample {
  readonly height: number;
  readonly crackIntensity: number;
  readonly spallRimMask: number;
  readonly bulletSmearMask: number;
  readonly aggregateContrast: number;
  readonly outerEdgeNoise: number;
}

export function sampleCraterMorphology(u: number, v: number): CraterSurfaceSample {
  const dx = (u - 0.5) * 2;
  const dy = (v - 0.5) * 2;
  const r = Math.hypot(dx, dy);
  const theta = Math.atan2(dy, dx);

  const angularLobes =
    0.075 * Math.cos(theta * 5 + 0.62) +
    0.052 * Math.sin(theta * 9 - 1.14) +
    0.032 * Math.cos(theta * 14 + 2.35) +
    0.018 * Math.sin(theta * 21 + 0.4);
  const facetNoise = (fbmNoise2D(u * 18, v * 18) - 0.5) * 0.1;
  const coarseAggregate = Math.abs(valueNoise2D(u * 38 + 4.2, v * 38 - 6.8) - 0.5) * 0.11;
  const microGrit = (valueNoise2D(u * 84 + 11.3, v * 84 - 7.1) - 0.5) * 0.048;

  const warpedR = Math.max(0, r + (angularLobes + facetNoise * 0.55) * Math.min(1, r * 1.65));
  const basePlane = 0.82;

  const jitteredTheta =
    theta +
    (valueNoise2D(u * 11.5 + 3.1, v * 11.5 - 2.7) - 0.5) * 0.42 +
    (valueNoise2D(u * 27.0, v * 27.0) - 0.5) * 0.16;
  const primaryWave = Math.abs(Math.sin(jitteredTheta * 5.5 + 0.35));
  const secondaryWave = Math.abs(Math.sin(jitteredTheta * 11.0 - 1.2));

  let crackIntensity = 0;
  if (warpedR > 0.12 && warpedR < 0.89) {
    const radialReach = Math.max(0, 1 - (warpedR - 0.12) / 0.77);
    const c1 = primaryWave < 0.105 ? ((0.105 - primaryWave) / 0.105) * radialReach : 0;
    const c2 = secondaryWave < 0.075 && warpedR < 0.74 ? ((0.075 - secondaryWave) / 0.075) * radialReach * 0.72 : 0;
    crackIntensity = Math.min(1, Math.max(c1, c2));
  }

  let height = basePlane;
  if (warpedR < 0.18) {
    const boreT = warpedR / 0.18;
    height = 0.035 + 0.145 * (boreT * boreT);
  } else if (warpedR < 0.53) {
    const coneT = (warpedR - 0.18) / (0.53 - 0.18);
    const steppedCone = coneT * coneT * (3 - 2 * coneT) * 0.82 + coneT * 0.18;
    const shelfStep = Math.floor(coneT * 3.4) * 0.025;
    height = 0.18 + (0.935 - 0.18) * steppedCone + shelfStep * 0.35;
  } else if (warpedR < 0.93) {
    const rimT = Math.min(1, (warpedR - 0.53) / (0.93 - 0.53));
    const smoothRim = rimT * rimT * (3 - 2 * rimT);
    height = 0.935 + (basePlane - 0.935) * smoothRim;
  }

  const edgeFade = Math.max(0, 1 - Math.max(0, (r - 0.72) / 0.24));
  const crackCarve = crackIntensity * 0.34;
  const aggregateRelief = warpedR > 0.14 && warpedR < 0.62 ? (coarseAggregate - 0.025) * 0.85 : facetNoise * 0.25;
  const combined = height + (aggregateRelief + microGrit - crackCarve) * edgeFade;

  return {
    height: Math.max(0.02, Math.min(0.98, combined)),
    crackIntensity,
    spallRimMask: warpedR > 0.38 && warpedR < 0.78 ? Math.pow(Math.sin(((warpedR - 0.38) / 0.4) * Math.PI), 0.75) : 0,
    bulletSmearMask: warpedR < 0.165 ? Math.max(0, 1 - Math.pow(warpedR / 0.165, 1.8)) : 0,
    aggregateContrast: coarseAggregate * 9.0,
    outerEdgeNoise: angularLobes * 0.65 + facetNoise * 0.85,
  };
}
