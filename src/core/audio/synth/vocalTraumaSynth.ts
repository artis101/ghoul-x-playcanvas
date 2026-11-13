import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { AudioNodeLike } from '../contracts.ts';
import type { VocalTraumaCueKind } from '../types.ts';
import type { SynthContext } from './synthPrimitives.ts';
import { spawnNoiseBurst, spawnPitchDropOsc } from './synthPrimitives.ts';
import { clampNumber } from '../audioMath.ts';

export function playVocalTraumaCue(
  ctx: SynthContext,
  cue: VocalTraumaCueKind,
  worldPos: Vec3Like | undefined,
  listenerPos: Vec3Like | undefined,
  listenerYawDeg: number,
  pannerModel: PanningModelType,
  reverbWetMix: number,
): void {
  const g = ctx.graph;
  const t0 = g.ctx.currentTime;

  const targetBus: AudioNodeLike =
    worldPos && listenerPos
      ? g.createSpatialChain(
          worldPos,
          listenerPos,
          listenerYawDeg,
          pannerModel,
          reverbWetMix * 0.6,
          { refDistanceM: 1.8, maxDistanceM: 45.0, rolloffFactor: 1.2 },
        ).input
      : g.dryBus;

  if (cue === 'SHARP_GASP') {
    spawnNoiseBurst(
      ctx,
      targetBus,
      'WHITE',
      t0 + 0.015,
      0.16,
      0.16,
      'bandpass',
      720,
      840,
      5.5,
      0.95,
      0.018,
    );
    spawnNoiseBurst(
      ctx,
      targetBus,
      'WHITE',
      t0 + 0.015,
      0.15,
      0.11,
      'bandpass',
      1580,
      1760,
      6.5,
      0.95,
      0.018,
    );
    spawnPitchDropOsc(
      ctx,
      targetBus,
      'sawtooth',
      t0 + 0.02,
      0.12,
      145,
      192,
      0.065,
      undefined,
      0.02,
    );
    return;
  }

  if (cue === 'WET_HEMOTHORAX_COUGH') {
    for (let c = 0; c < 2; c++) {
      const tc = t0 + (0.02 + c * 0.135);
      const dur = (0.11 - c * 0.015);
      spawnNoiseBurst(
        ctx,
        targetBus,
        'CRACKLE',
        tc,
        dur,
        0.18 - c * 0.03,
        'bandpass',
        610,
        460,
        4.2,
        0.85,
        0.006,
      );
      spawnNoiseBurst(
        ctx,
        targetBus,
        'PINK',
        tc,
        dur,
        0.14,
        'bandpass',
        1320,
        980,
        5.0,
        0.9,
        0.008,
      );
      spawnPitchDropOsc(
        ctx,
        targetBus,
        'sawtooth',
        tc,
        dur * 0.85,
        122,
        86,
        0.08,
        undefined,
        0.005,
      );
    }
    return;
  }

  // PAIN_GRUNT
  const maxFreqHz = Math.max(2000, Math.min(20000, (g.ctx.sampleRate || 44100) * 0.48));
  const glottal = g.createOscillator();
  glottal.type = 'sawtooth';
  glottal.frequency.setValueAtTime(142, t0 + 0.015);
  glottal.frequency.exponentialRampToValueAtTime(96, t0 + 0.19);

  const formant1 = g.createBiquadFilter();
  formant1.type = 'bandpass';
  formant1.frequency.setValueAtTime(clampNumber(590, 80, maxFreqHz), t0);
  formant1.Q.setValueAtTime(4.8, t0);

  const gruntEnv = g.createGain();
  gruntEnv.gain.value = 0;
  gruntEnv.gain.setValueAtTime(0.0001, t0);
  gruntEnv.gain.setValueAtTime(0.0001, t0 + 0.015);
  gruntEnv.gain.linearRampToValueAtTime(0.14, t0 + 0.038);
  gruntEnv.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.20);
  gruntEnv.gain.linearRampToValueAtTime(0, t0 + 0.208);

  const stopAt = t0 + 0.218;
  glottal.connect(formant1);
  formant1.connect(gruntEnv);
  gruntEnv.connect(targetBus);

  glottal.start(t0 + 0.015);
  glottal.stop(stopAt);
  ctx.registerTransientNodes([glottal, formant1, gruntEnv], stopAt + 0.05);
}
