import type { AudioNodeLike, AudioParamLike } from '../contracts.ts';
import type { InternalAudioGraph } from '../audioGraph.ts';
import { clampNumber, computeSlowMoAudioFactors } from '../audioMath.ts';

export interface SynthContext {
  readonly graph: InternalAudioGraph;
  readonly timeScale: number;
  readonly rng: () => number;
  registerScaledSource(source: { readonly playbackRate: AudioParamLike }, baseRate: number, endTime: number): void;
  registerScaledOscillator(osc: { readonly detune: AudioParamLike }, spawnPitchScale: number, endTime: number): void;
}

export function spawnNoiseBurst(
  ctx: SynthContext,
  destination: AudioNodeLike,
  kind: 'WHITE' | 'PINK' | 'CRACKLE',
  startTime: number,
  durationS: number,
  peakGain: number,
  filterType: BiquadFilterType,
  freqStartHz: number,
  freqEndHz: number,
  qValue: number,
  basePlaybackRate = 1.0,
  attackS = 0.0015,
): void {
  const g = ctx.graph;
  const factors = computeSlowMoAudioFactors(ctx.timeScale);
  const effectiveRate = Math.max(0.05, basePlaybackRate * factors.playbackRate);
  const slice = g.createNoiseSlice(kind, effectiveRate, true);
  const offset = slice.bufferDuration > 0 ? ctx.rng() * slice.bufferDuration : 0;

  const filter = g.createBiquadFilter();
  filter.type = filterType;
  const f0 = clampNumber(freqStartHz * factors.lowpassScale, 24, 20000);
  const f1 = clampNumber(freqEndHz * factors.lowpassScale, 24, 20000);
  filter.frequency.setValueAtTime(f0, startTime);
  if (Math.abs(f0 - f1) > 1) {
    filter.frequency.exponentialRampToValueAtTime(f1, startTime + durationS);
  }
  filter.Q.setValueAtTime(qValue, startTime);

  const env = g.createGain();
  const safePeak = Math.max(0.0002, peakGain);
  env.gain.setValueAtTime(0.0001, startTime);
  env.gain.linearRampToValueAtTime(safePeak, startTime + Math.min(attackS, durationS * 0.35));
  env.gain.exponentialRampToValueAtTime(0.0001, startTime + durationS);

  slice.source.connect(filter);
  filter.connect(env);
  env.connect(destination);

  const stopAt = startTime + durationS + 0.015;
  slice.source.start(startTime, offset);
  slice.source.stop(stopAt);
  ctx.registerScaledSource(slice.source, basePlaybackRate, stopAt);
}

export function spawnPitchDropOsc(
  ctx: SynthContext,
  destination: AudioNodeLike,
  oscType: OscillatorType,
  startTime: number,
  durationS: number,
  freqStartHz: number,
  freqEndHz: number,
  peakGain: number,
  driveCurve?: Float32Array,
  attackS = 0.0015,
): void {
  const g = ctx.graph;
  const osc = g.createOscillator();
  osc.type = oscType;
  const f0 = clampNumber(freqStartHz, 16, 20000);
  const f1 = clampNumber(freqEndHz, 16, 20000);
  osc.frequency.setValueAtTime(f0, startTime);
  if (Math.abs(f0 - f1) > 0.5) {
    osc.frequency.exponentialRampToValueAtTime(f1, startTime + durationS);
  }

  const env = g.createGain();
  env.gain.setValueAtTime(0.0001, startTime);
  env.gain.linearRampToValueAtTime(
    Math.max(0.0002, peakGain),
    startTime + Math.min(attackS, durationS * 0.3),
  );
  env.gain.exponentialRampToValueAtTime(0.0001, startTime + durationS);

  if (driveCurve) {
    const shaper = g.createWaveShaper();
    shaper.curve = driveCurve;
    shaper.oversample = '2x';
    osc.connect(shaper);
    shaper.connect(env);
  } else {
    osc.connect(env);
  }

  env.connect(destination);
  const stopAt = startTime + durationS + 0.01;
  osc.start(startTime);
  osc.stop(stopAt);
  const currentPitchScale = computeSlowMoAudioFactors(ctx.timeScale).oscillatorPitchScale;
  ctx.registerScaledOscillator(osc, currentPitchScale, stopAt);
}
