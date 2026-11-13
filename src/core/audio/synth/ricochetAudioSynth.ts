import type { GainNodeLike } from '../contracts.ts';
import type { SynthContext } from './synthPrimitives.ts';
import { spawnPitchDropOsc } from './synthPrimitives.ts';

export function synthesizeRicochetWhine(
  ctx: SynthContext,
  destination: GainNodeLike,
  t0: number,
  eGain: number,
  startHz = 1800,
  endHz = 700,
  durationS = 0.19,
): void {

  spawnPitchDropOsc(
    ctx,
    destination,
    'sine',
    t0 + 0.006,
    durationS,
    startHz,
    endHz,
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

  spawnPitchDropOsc(
    ctx,
    destination,
    'sawtooth',
    t0 + 0.008,
    0.23,
    2850,
    920,
    0.19 * eGain,
    undefined,
    0.003,
  );
}
