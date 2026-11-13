import type { GainNodeLike } from '../contracts.ts';
import type { SynthContext } from './synthPrimitives.ts';
import { spawnNoiseBurst, spawnPitchDropOsc } from './synthPrimitives.ts';
import { clampNumber } from '../audioMath.ts';

export function synthesizeConcreteThud(
  ctx: SynthContext,
  destination: GainNodeLike,
  t0: number,
  eGain: number,
): void {

  spawnPitchDropOsc(
    ctx,
    destination,
    'sine',
    t0,
    0.12,
    118,
    44,
    0.56 * eGain,
    ctx.graph.warmDriveCurve,
  );
  spawnNoiseBurst(
    ctx,
    destination,
    'PINK',
    t0,
    0.15,
    0.52 * eGain,
    'bandpass',
    1250,
    420,
    1.5,
    0.95,
    0.001,
  );
}

export function synthesizeRubbleScatter(
  ctx: SynthContext,
  destination: GainNodeLike,
  t0: number,
  eGain: number,
): void {

  for (let r = 0; r < 3; r++) {
    const tr = t0 + (0.075 + r * 0.078);
    const rubbleFreq = (320 - r * 45 + ctx.rng() * 70);
    spawnPitchDropOsc(
      ctx,
      destination,
      'triangle',
      tr,
      0.055,
      rubbleFreq,
      rubbleFreq * 0.55,
      (0.20 - r * 0.045) * eGain,
    );
    spawnNoiseBurst(
      ctx,
      destination,
      'CRACKLE',
      tr,
      0.048,
      (0.16 - r * 0.035) * eGain,
      'bandpass',
      920,
      480,
      2.2,
      0.9,
    );
  }
}

export function synthesizeSteelClang(
  ctx: SynthContext,
  destination: GainNodeLike,
  t0: number,
  eGain: number,
): void {

  const steelPartials = [880, 1765, 2940, 4780];
  const steelWeights = [0.34, 0.28, 0.22, 0.15];
  for (let i = 0; i < steelPartials.length; i++) {
    const f = clampNumber(steelPartials[i], 120, 19500);
    spawnPitchDropOsc(
      ctx,
      destination,
      i === 0 ? 'triangle' : 'sine',
      t0,
      0.28,
      f,
      f * 0.985,
      steelWeights[i] * eGain,
      undefined,
      0.0006,
    );
  }
  spawnNoiseBurst(
    ctx,
    destination,
    'WHITE',
    t0,
    0.045,
    0.46 * eGain,
    'highpass',
    2400,
    1800,
    2.0,
    1.2,
    0.0005,
  );
}
