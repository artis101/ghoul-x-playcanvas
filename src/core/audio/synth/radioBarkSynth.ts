import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { RadioBarkCueAudioParams, VocalTraumaCueKind } from '../types.ts';
import type { SynthContext } from './synthPrimitives.ts';
import { spawnNoiseBurst, spawnPitchDropOsc } from './synthPrimitives.ts';
import { computeSlowMoAudioFactors } from '../audioMath.ts';
import { playVocalTraumaCue } from './vocalTraumaSynth.ts';

function isKnownVocalCue(cue?: string): cue is VocalTraumaCueKind {
  return (
    cue === 'SHARP_GASP' ||
    cue === 'WET_HEMOTHORAX_COUGH' ||
    cue === 'PAIN_GRUNT'
  );
}

/**
 * Synthesizes F.E.A.R.-style tactical PTT radio squelch clicks, bandpass comms carrier bursts,
 * and delegates anatomical vocal trauma cues (`SHARP_GASP`, `WET_HEMOTHORAX_COUGH`, `PAIN_GRUNT`, `AGUNAL_WHEEZE`).
 */
export function playRadioBarkCue(
  ctx: SynthContext,
  params: RadioBarkCueAudioParams,
  listenerPos: Vec3Like,
  listenerYawDeg: number,
  pannerModel: PanningModelType,
  reverbWetMix: number,
): void {
  const g = ctx.graph;
  const t0 = g.ctx.currentTime;
  const factors = computeSlowMoAudioFactors(ctx.timeScale);
  const pScale = factors.oscillatorPitchScale;
  const stretch = factors.envelopeStretch;

  const lPos = params.listenerPos ?? listenerPos;
  const wPos = params.worldPos;

  if (params.isRadio) {
    const radioBus = g.createGain();
    radioBus.gain.setValueAtTime(0.85, t0);
    radioBus.connect(g.dryBus);

    // 1. Opening PTT key-click + military two-tone squelch chirp
    spawnNoiseBurst(
      ctx,
      radioBus,
      'WHITE',
      t0,
      0.014 * stretch,
      0.26,
      'bandpass',
      2450,
      2100,
      5.5,
      1.1,
      0.0006,
    );
    spawnPitchDropOsc(
      ctx,
      radioBus,
      'sine',
      t0 + 0.004 * stretch,
      0.022 * stretch,
      1880 * pScale,
      2360 * pScale,
      0.14,
      undefined,
      0.001,
    );

    // 2. Bandpass-filtered comms carrier + formant syllable modulation
    const carrierDur = 0.16 * stretch;
    const tCarrier = t0 + 0.024 * stretch;
    spawnNoiseBurst(
      ctx,
      radioBus,
      'PINK',
      tCarrier,
      carrierDur,
      0.16,
      'bandpass',
      1420,
      1180,
      3.4,
      0.96,
      0.004,
    );
    spawnPitchDropOsc(
      ctx,
      radioBus,
      'sawtooth',
      tCarrier,
      0.072 * stretch,
      152 * pScale,
      128 * pScale,
      0.095,
      g.warmDriveCurve,
      0.004,
    );
    spawnPitchDropOsc(
      ctx,
      radioBus,
      'sawtooth',
      tCarrier + 0.082 * stretch,
      0.068 * stretch,
      164 * pScale,
      116 * pScale,
      0.088,
      g.warmDriveCurve,
      0.004,
    );

    // 3. Closing PTT release squelch tail
    const tTail = tCarrier + carrierDur + 0.006 * stretch;
    spawnNoiseBurst(
      ctx,
      radioBus,
      'WHITE',
      tTail,
      0.026 * stretch,
      0.22,
      'bandpass',
      1950,
      1520,
      4.8,
      1.05,
      0.0008,
    );
  }

  if (params.vocalCue) {
    if (isKnownVocalCue(params.vocalCue)) {
      playVocalTraumaCue(ctx, params.vocalCue, wPos, lPos, listenerYawDeg, pannerModel, reverbWetMix);
    } else if (params.vocalCue === 'AGUNAL_WHEEZE') {
      const targetBus =
        wPos && lPos
          ? g.createSpatialChain(
              wPos,
              lPos,
              listenerYawDeg,
              pannerModel,
              reverbWetMix * 0.6,
              { refDistanceM: 1.8, maxDistanceM: 45.0, rolloffFactor: 1.2 },
            ).input
          : g.dryBus;
      spawnNoiseBurst(
        ctx,
        targetBus,
        'CRACKLE',
        t0 + 0.015 * stretch,
        0.24 * stretch,
        0.16,
        'bandpass',
        880,
        540,
        4.6,
        0.82,
        0.012,
      );
      spawnPitchDropOsc(
        ctx,
        targetBus,
        'sawtooth',
        t0 + 0.02 * stretch,
        0.22 * stretch,
        118 * pScale,
        74 * pScale,
        0.075,
        undefined,
        0.01,
      );
    }
  }
}
