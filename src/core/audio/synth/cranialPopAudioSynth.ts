import type { GainNodeLike } from '../contracts.ts';
import type { SynthContext } from './synthPrimitives.ts';
import { spawnNoiseBurst, spawnPitchDropOsc } from './synthPrimitives.ts';
import { computeSlowMoAudioFactors } from '../audioMath.ts';

export function synthesizeCranialPop(
  ctx: SynthContext,
  destination: GainNodeLike,
  t0: number,
): void {
  const g = ctx.graph;
  const factors = computeSlowMoAudioFactors(ctx.timeScale);
  const pScale = factors.oscillatorPitchScale;
  const stretch = factors.envelopeStretch;

  // Explosive wet cranial pop: hollow skull crack + pressurized wet rupture + splatter droplets
  spawnPitchDropOsc(
    ctx,
    destination,
    'sine',
    t0,
    0.14 * stretch,
    112 * pScale,
    36 * pScale,
    0.74,
    g.heavyDriveCurve,
  );
  // Brittle skull snap
  spawnNoiseBurst(
    ctx,
    destination,
    'CRACKLE',
    t0,
    0.05 * stretch,
    0.65,
    'bandpass',
    2350,
    1200,
    3.8,
    1.15,
    0.0005,
  );
  // Pressurized wet melon pop sweep
  spawnPitchDropOsc(
    ctx,
    destination,
    'sine',
    t0 + 0.008 * stretch,
    0.11 * stretch,
    560 * pScale,
    1850 * pScale,
    0.36,
    undefined,
    0.004,
  );
  spawnNoiseBurst(
    ctx,
    destination,
    'PINK',
    t0 + 0.01 * stretch,
    0.20 * stretch,
    0.62,
    'bandpass',
    1450,
    310,
    3.2,
    0.9,
    0.003,
  );
  // Cascading wet splatter droplets
  for (let d = 0; d < 4; d++) {
    const td = t0 + (0.055 + d * 0.048) * stretch;
    spawnNoiseBurst(
      ctx,
      destination,
      'PINK',
      td,
      0.038 * stretch,
      0.22 - d * 0.04,
      'bandpass',
      980 + d * 240,
      440,
      5.0,
      1.05,
      0.002,
    );
  }
}
