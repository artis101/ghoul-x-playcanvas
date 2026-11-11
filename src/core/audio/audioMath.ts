import {
  MIN_AUDIO_TIME_SCALE,
  MAX_AUDIO_TIME_SCALE,
  type SlowMoAudioFactors,
} from './types.ts';

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

export function clampTimeScale(scale: number): number {
  if (!Number.isFinite(scale)) {
    return 1.0;
  }
  return Math.min(MAX_AUDIO_TIME_SCALE, Math.max(MIN_AUDIO_TIME_SCALE, scale));
}

/**
 * Computes pitch, playback-rate, envelope stretch, and filter darkening curves
 * for F.E.A.R.-style Reflex slow-motion (`0.2x` -> deep cinematic pitch drop).
 */
export function computeSlowMoAudioFactors(timeScale: number): SlowMoAudioFactors {
  const clamped = clampTimeScale(timeScale);
  const playbackRate = clamped;
  const oscillatorPitchScale =
    clamped < 1.0
      ? Math.max(0.22, Math.pow(clamped, 0.78))
      : Math.min(1.85, Math.pow(clamped, 0.85));
  const envelopeStretch =
    clamped < 1.0
      ? Math.min(4.25, Math.pow(1.0 / clamped, 0.85))
      : Math.max(0.55, 1.0 / clamped);
  const lowpassScale =
    clamped < 1.0 ? 0.36 + 0.64 * Math.pow(clamped, 0.62) : 1.0;

  return {
    clampedTimeScale: clamped,
    playbackRate,
    oscillatorPitchScale,
    envelopeStretch,
    lowpassScale,
  };
}

export function computeImpactEnergyGain(energyJ: number): number {
  if (!Number.isFinite(energyJ) || energyJ <= 0) {
    return 0.25;
  }
  const normalized = Math.log10(Math.max(10, energyJ)) / 3.05;
  return clampNumber(normalized, 0.25, 1.35);
}
