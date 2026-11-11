import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { GoreImpactAudioKind, VocalTraumaCueKind } from '../types.ts';
import type { SynthContext } from './synthPrimitives.ts';
import { spawnNoiseBurst, spawnPitchDropOsc } from './synthPrimitives.ts';
import { computeSlowMoAudioFactors } from '../audioMath.ts';
import { synthesizeCranialPop } from './cranialPopAudioSynth.ts';
import { synthesizeBoneShatter, synthesizeLimbSever } from './boneLimbGoreSynth.ts';

export interface GoreAudioCallbacks {
  maybeTriggerAutoVocalCue(
    cue: VocalTraumaCueKind,
    worldPos: Vec3Like,
    listenerPos: Vec3Like,
    now: number,
  ): void;
}

export function playGoreImpact(
  ctx: SynthContext,
  kind: GoreImpactAudioKind,
  worldPos: Vec3Like,
  listenerPos: Vec3Like,
  listenerYawDeg: number,
  pannerModel: PanningModelType,
  reverbWetMix: number,
  callbacks?: GoreAudioCallbacks,
): void {
  const g = ctx.graph;
  const t0 = g.ctx.currentTime;
  const factors = computeSlowMoAudioFactors(ctx.timeScale);
  const pScale = factors.oscillatorPitchScale;
  const stretch = factors.envelopeStretch;

  const chain = g.createSpatialChain(
    worldPos,
    listenerPos,
    listenerYawDeg,
    pannerModel,
    reverbWetMix * 0.65,
    { refDistanceM: 1.6, maxDistanceM: 65.0, rolloffFactor: 1.1 },
  );

  switch (kind) {
    case 'FLESH_HIT': {
      spawnPitchDropOsc(
        ctx,
        chain.input,
        'sine',
        t0,
        0.11 * stretch,
        148 * pScale,
        50 * pScale,
        0.62,
        g.warmDriveCurve,
      );
      spawnNoiseBurst(
        ctx,
        chain.input,
        'PINK',
        t0,
        0.12 * stretch,
        0.56,
        'bandpass',
        1180,
        340,
        3.6,
        0.95,
        0.001,
      );
      callbacks?.maybeTriggerAutoVocalCue('PAIN_GRUNT', worldPos, listenerPos, t0);
      break;
    }

    case 'ARMOR_SPARK': {
      spawnPitchDropOsc(
        ctx,
        chain.input,
        'triangle',
        t0,
        0.085 * stretch,
        172 * pScale,
        68 * pScale,
        0.54,
      );
      spawnNoiseBurst(
        ctx,
        chain.input,
        'WHITE',
        t0,
        0.065 * stretch,
        0.48,
        'bandpass',
        3400,
        1450,
        4.2,
        1.15,
        0.0006,
      );
      spawnPitchDropOsc(
        ctx,
        chain.input,
        'sine',
        t0,
        0.075 * stretch,
        3250 * pScale,
        1380 * pScale,
        0.22,
      );
      break;
    }

    case 'BONE_SHATTER': {
      synthesizeBoneShatter(ctx, chain.input, t0);
      callbacks?.maybeTriggerAutoVocalCue('SHARP_GASP', worldPos, listenerPos, t0);
      break;
    }

    case 'CRANIAL_POP': {
      synthesizeCranialPop(ctx, chain.input, t0);
      break;
    }

    case 'LIMB_SEVER': {
      synthesizeLimbSever(ctx, chain.input, t0);
      callbacks?.maybeTriggerAutoVocalCue('SHARP_GASP', worldPos, listenerPos, t0);
      break;
    }

    case 'ARTERIAL_SPURT': {
      for (let p = 0; p < 3; p++) {
        const tp = t0 + p * 0.105 * stretch;
        spawnNoiseBurst(
          ctx,
          chain.input,
          'PINK',
          tp,
          0.085 * stretch,
          0.34 - p * 0.07,
          'bandpass',
          1850 - p * 180,
          780,
          4.8,
          1.05,
          0.006,
        );
      }
      callbacks?.maybeTriggerAutoVocalCue('WET_HEMOTHORAX_COUGH', worldPos, listenerPos, t0);
      break;
    }
  }
}
