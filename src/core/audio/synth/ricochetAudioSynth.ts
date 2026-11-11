import type { GainNodeLike } from '../contracts.ts';
import type { SynthContext } from './synthPrimitives.ts';
import { spawnPitchDropOsc } from './synthPrimitives.ts';
import { computeSlowMoAudioFactors } from '../audioMath.ts';

export function synthesizeRicochetWhine(
  ctx: SynthContext,
  destination: GainNodeLike,
  t0: number,
  eGain: number,
  startHz = 1800,
  endHz = 700,
  durationS = 0.19,
): void {
  const factors = computeSlowMoAudioFactors(ctx.timeScale);
  const pScale = factors.oscillatorPitchScale;
  const stretch = factors.envelopeStretch;

  spawnPitchDropOsc(
    ctx,
    destination,
    'sine',
    t0 + 0.006 * stretch,
    durationS * stretch,
    startHz * pScale,
    endHz * pScale,
    0.24 * eGain,
    undefined,
    0.004,
  );
}

export function synthesizeSteelZing(
  ctx: SynthContext,
  destination: GainNodeLike,
  t0: number,
  eGain: number,
): void {
  const factors = computeSlowMoAudioFactors(ctx.timeScale);
  const pScale = factors.oscillatorPitchScale;
  const stretch = factors.envelopeStretch;

  spawnPitchDropOsc(
    ctx,
    destination,
    'sawtooth',
    t0 + 0.008 * stretch,
    0.23 * stretch,
    2850 * pScale,
    920 * pScale,
    0.19 * eGain,
    undefined,
    0.003,
  );
}
