import type { GainNodeLike } from '../contracts.ts';
import type { SynthContext } from './synthPrimitives.ts';
import { spawnNoiseBurst, spawnPitchDropOsc } from './synthPrimitives.ts';

export function synthesizeBoneShatter(
  ctx: SynthContext,
  destination: GainNodeLike,
  t0: number,
): void {

  spawnPitchDropOsc(
    ctx,
    destination,
    'sine',
    t0,
    0.10,
    135,
    46,
    0.58,
    ctx.graph.warmDriveCurve,
  );
  const crackFreqs = [1780, 2680, 3550];
  for (let c = 0; c < crackFreqs.length; c++) {
    const tc = t0 + c * 0.017;
    spawnNoiseBurst(
      ctx,
      destination,
      'CRACKLE',
      tc,
      0.042,
      0.52 - c * 0.1,
      'bandpass',
      crackFreqs[c],
      crackFreqs[c] * 0.65,
      4.5,
      1.1,
      0.0005,
    );
    spawnPitchDropOsc(
      ctx,
      destination,
      'triangle',
      tc,
      0.028,
      crackFreqs[c],
      crackFreqs[c] * 0.55,
      0.24,
    );
  }
}

export function synthesizeLimbSever(
  ctx: SynthContext,
  destination: GainNodeLike,
  t0: number,
): void {

  spawnPitchDropOsc(
    ctx,
    destination,
    'triangle',
    t0,
    0.15,
    128,
    40,
    0.68,
    ctx.graph.heavyDriveCurve,
  );
  spawnNoiseBurst(
    ctx,
    destination,
    'CRACKLE',
    t0,
    0.18,
    0.60,
    'bandpass',
    1950,
    520,
    2.8,
    0.92,
    0.001,
  );
  spawnNoiseBurst(
    ctx,
    destination,
    'PINK',
    t0 + 0.03,
    0.22,
    0.46,
    'bandpass',
    1350,
    380,
    4.0,
    0.88,
    0.004,
  );
}
