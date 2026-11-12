import type { AudioNodeLike, AudioParamLike } from '../contracts.ts';
import type { InternalAudioGraph } from '../audioGraph.ts';
import { clampNumber, computeSlowMoAudioFactors } from '../audioMath.ts';

export interface SynthContext {
  readonly graph: InternalAudioGraph;
  readonly timeScale: number;
  readonly rng: () => number;
  registerScaledSource(source: { readonly playbackRate: AudioParamLike }, baseRate: number, endTime: number): void;
  registerScaledOscillator(osc: { readonly detune: AudioParamLike }, spawnPitchScale: number, endTime: number): void;
  registerTransientNodes(nodes: readonly AudioNodeLike[], endTime: number): void;
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
  const maxFreqHz = Math.max(2000, Math.min(20000, (g.ctx.sampleRate || 44100) * 0.48));
  const factors = computeSlowMoAudioFactors(ctx.timeScale);
  const effectiveRate = Math.max(0.05, basePlaybackRate * factors.playbackRate);
  const slice = g.createNoiseSlice(kind, effectiveRate, true);
  const offset = slice.bufferDuration > 0 ? ctx.rng() * slice.bufferDuration : 0;

  const filter = g.createBiquadFilter();
  filter.type = filterType;
  const f0 = clampNumber(freqStartHz * factors.lowpassScale, 24, maxFreqHz);
  const f1 = clampNumber(freqEndHz * factors.lowpassScale, 24, maxFreqHz);
  filter.frequency.setValueAtTime(f0, startTime);
  if (Math.abs(f0 - f1) > 1) {
    filter.frequency.exponentialRampToValueAtTime(f1, startTime + durationS);
  }
  filter.Q.setValueAtTime(clampNumber(qValue, 0.1, 12.0), startTime);

  const env = g.createGain();
  const safePeak = Math.max(0.0002, peakGain);
  env.gain.value = 0;
  env.gain.setValueAtTime(0.0001, startTime);
  env.gain.linearRampToValueAtTime(safePeak, startTime + Math.min(attackS, durationS * 0.35));
  env.gain.exponentialRampToValueAtTime(0.0001, startTime + durationS);
  env.gain.linearRampToValueAtTime(0, startTime + durationS + 0.006);

  slice.source.connect(filter);
  filter.connect(env);
  env.connect(destination);

  const stopAt = startTime + durationS + 0.015;
  slice.source.start(startTime, offset);
  slice.source.stop(stopAt);
  ctx.registerScaledSource(slice.source, basePlaybackRate, stopAt);
  ctx.registerTransientNodes([slice.source, filter, env], stopAt + 0.05);
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
  const maxFreqHz = Math.max(2000, Math.min(20000, (g.ctx.sampleRate || 44100) * 0.49));
  const osc = g.createOscillator();
  osc.type = oscType;
  const f0 = clampNumber(freqStartHz, 16, maxFreqHz);
  const f1 = clampNumber(freqEndHz, 16, maxFreqHz);
  osc.frequency.setValueAtTime(f0, startTime);
  if (Math.abs(f0 - f1) > 0.5) {
    osc.frequency.exponentialRampToValueAtTime(f1, startTime + durationS);
  }

  const env = g.createGain();
  env.gain.value = 0;
  env.gain.setValueAtTime(0.0001, startTime);
  env.gain.linearRampToValueAtTime(
    Math.max(0.0002, peakGain),
    startTime + Math.min(attackS, durationS * 0.3),
  );
  env.gain.exponentialRampToValueAtTime(0.0001, startTime + durationS);
  env.gain.linearRampToValueAtTime(0, startTime + durationS + 0.006);

  const stopAt = startTime + durationS + 0.012;

  if (driveCurve) {
    const shaper = g.createWaveShaper();
    shaper.curve = driveCurve;
    shaper.oversample = f0 > 1200 ? '2x' : 'none';
    osc.connect(env);
    env.connect(shaper);
    shaper.connect(destination);
    ctx.registerTransientNodes([osc, env, shaper], stopAt + 0.05);
  } else {
    osc.connect(env);
    env.connect(destination);
    ctx.registerTransientNodes([osc, env], stopAt + 0.05);
  }

  osc.start(startTime);
  osc.stop(stopAt);
  const currentPitchScale = computeSlowMoAudioFactors(ctx.timeScale).oscillatorPitchScale;
  ctx.registerScaledOscillator(osc, currentPitchScale, stopAt);
}
