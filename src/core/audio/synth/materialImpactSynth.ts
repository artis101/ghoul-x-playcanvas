import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { DestructibleMaterialKind } from '../../../contracts/destruction.ts';
import type { SynthContext } from './synthPrimitives.ts';
import { spawnNoiseBurst, spawnPitchDropOsc } from './synthPrimitives.ts';
import { clampNumber, computeImpactEnergyGain } from '../audioMath.ts';
import { synthesizeConcreteThud, synthesizeRubbleScatter, synthesizeSteelClang } from './surfaceThudSynth.ts';
import { synthesizeRicochetWhine, synthesizeSteelZing } from './ricochetAudioSynth.ts';

export function playMaterialImpact(
  ctx: SynthContext,
  material: DestructibleMaterialKind,
  worldPos: Vec3Like,
  energyJ: number,
  listenerPos: Vec3Like,
  listenerYawDeg: number,
  pannerModel: PanningModelType,
  reverbWetMix: number,
  startOffsetS = 0,
  gainMultiplier = 1.0,
): void {
  const g = ctx.graph;
  const t0 = g.ctx.currentTime + Math.max(0, startOffsetS);
  const eGain = computeImpactEnergyGain(energyJ) * clampNumber(gainMultiplier, 0.15, 1.5);

  const chain = g.createSpatialChain(
    worldPos,
    listenerPos,
    listenerYawDeg,
    pannerModel,
    reverbWetMix,
    { refDistanceM: 1.8, maxDistanceM: 75.0, rolloffFactor: 1.1 },
  );

  if (material === 'GLASS_MARCHING_256' || material === 'GLASS_VORONOI') {
    const isPlateVoronoi = material === 'GLASS_VORONOI';
    spawnNoiseBurst(
      ctx,
      chain.input,
      'CRACKLE',
      t0,
      0.16,
      0.52 * eGain,
      'highpass',
      isPlateVoronoi ? 2800 : 3600,
      4800,
      1.8,
      1.15,
      0.0008,
    );

    const crystalModes = isPlateVoronoi
      ? [2750, 4450, 6350, 8900]
      : [4250, 5900, 7850, 10400];
    for (let i = 0; i < crystalModes.length; i++) {
      const f = clampNumber(crystalModes[i] * (0.97 + ctx.rng() * 0.06), 180, 19500);
      spawnPitchDropOsc(
        ctx,
        chain.input,
        'sine',
        t0 + i * 0.004,
        0.095,
        f,
        f * 0.96,
        0.16 * eGain,
        undefined,
        0.0006,
      );
    }

    const shardCount = 5;
    for (let s = 0; s < shardCount; s++) {
      const delayS = (0.055 + s * 0.064 + ctx.rng() * 0.025);
      const shardFreq = clampNumber((5100 + s * 920 + ctx.rng() * 750), 250, 19500);
      const shardAmp = (0.13 - s * 0.018) * eGain;
      spawnPitchDropOsc(
        ctx,
        chain.input,
        'sine',
        t0 + delayS,
        0.048,
        shardFreq,
        shardFreq * 1.02,
        Math.max(0.02, shardAmp),
        undefined,
        0.0005,
      );
    }
    return;
  }

  if (material === 'WOOD_DRYWALL' || material === 'WOOD_STUD') {
    const isStud = material === 'WOOD_STUD';
    spawnPitchDropOsc(
      ctx,
      chain.input,
      'triangle',
      t0,
      0.09,
      (isStud ? 390 : 215),
      (isStud ? 95 : 68),
      0.48 * eGain,
      g.warmDriveCurve,
    );
    spawnNoiseBurst(
      ctx,
      chain.input,
      'CRACKLE',
      t0,
      0.13,
      0.54 * eGain,
      'bandpass',
      isStud ? 1680 : 1150,
      isStud ? 740 : 520,
      2.4,
      1.0,
      0.001,
    );

    for (let s = 0; s < 3; s++) {
      const ts = t0 + (0.042 + s * 0.052);
      spawnNoiseBurst(
        ctx,
        chain.input,
        'CRACKLE',
        ts,
        0.036,
        (0.18 - s * 0.04) * eGain,
        'bandpass',
        2450 + s * 380,
        1800,
        3.8,
        1.12,
        0.001,
      );
    }
    return;
  }

  if (
    material === 'BRICK_MASONRY' ||
    material === 'CONCRETE_CHUNKS' ||
    material === 'CONCRETE_INTACT'
  ) {
    synthesizeConcreteThud(ctx, chain.input, t0, eGain);
    const ricochetAmp = material === 'CONCRETE_INTACT' ? 0.24 * eGain : 0.16 * eGain;
    synthesizeRicochetWhine(ctx, chain.input, t0, ricochetAmp);
    if (material === 'BRICK_MASONRY' || material === 'CONCRETE_CHUNKS' || energyJ >= 400) {
      synthesizeRubbleScatter(ctx, chain.input, t0, eGain);
    }
    return;
  }

  // STEEL
  synthesizeSteelClang(ctx, chain.input, t0, eGain);
  synthesizeSteelZing(ctx, chain.input, t0, eGain);
}
