import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { AudioBufferLike, AudioContextLike, AudioParamLike } from './contracts.ts';

export const MIN_AUDIO_TIME_SCALE = 0.08;
export const MAX_AUDIO_TIME_SCALE = 2.0;
export const TINNITUS_PROXIMITY_RADIUS_M = 4.5;

export type ShellCasingCaliber = 'BRASS' | 'SHOTGUN_HULL';

export type GoreImpactAudioKind =
  | 'FLESH_HIT'
  | 'ARMOR_SPARK'
  | 'BONE_SHATTER'
  | 'CRANIAL_POP'
  | 'LIMB_SEVER'
  | 'ARTERIAL_SPURT';

export type VocalTraumaCueKind =
  | 'SHARP_GASP'
  | 'WET_HEMOTHORAX_COUGH'
  | 'PAIN_GRUNT';

export interface SlowMoAudioFactors {
  readonly clampedTimeScale: number;
  /** Buffer source playback rate multiplier (0.08 .. 2.0) */
  readonly playbackRate: number;
  /** Oscillator fundamental pitch multiplier preserving audible sub-bass weight */
  readonly oscillatorPitchScale: number;
  /** Envelope & delayed-foley time-stretch multiplier */
  readonly envelopeStretch: number;
  /** Subtle high-frequency air darkening multiplier during Reflex slow-mo */
  readonly lowpassScale: number;
}

export interface SpatialCalcOptions {
  listenerYawDeg?: number;
  refDistanceM?: number;
  maxDistanceM?: number;
  rolloffFactor?: number;
  baseReverbWet?: number;
  maxReverbWet?: number;
}

export interface SpatialAudioParams {
  readonly distanceM: number;
  readonly gainAttenuation: number;
  readonly stereoPan: number;
  readonly airAbsorptionCutoffHz: number;
  readonly reverbSendGain: number;
  readonly deltaWorld: Vec3Like;
}

export interface CombatAudioDiagnostics {
  readonly available: boolean;
  readonly unlocked: boolean;
  readonly timeScale: number;
  readonly slowMoActive: boolean;
  readonly pannerModel: PanningModelType;
  readonly masterVolume: number;
  readonly weaponFireCount: number;
  readonly casingBounceCount: number;
  readonly materialImpactCount: number;
  readonly goreImpactCount: number;
  readonly vocalCueCount: number;
  readonly explosionCount: number;
  readonly tinnitusTriggerCount: number;
  readonly slowMoTransitionCount: number;
  readonly lastWeaponPitchJitter: number;
}

export interface CombatAudioEngineOptions<TBuffer extends AudioBufferLike = AudioBufferLike> {
  /** Optional injected context or factory (useful for deterministic headless testing) */
  context?: AudioContextLike<TBuffer> | null;
  contextFactory?: () => AudioContextLike<TBuffer> | null;
  pannerModel?: PanningModelType;
  masterVolume?: number;
  reverbWetMix?: number;
  /** Optional deterministic RNG in [0, 1) */
  random?: () => number;
  /** Automatically attach mousedown/keydown unlock listeners when DOM is available (default true) */
  autoUnlockOnGesture?: boolean;
}

export interface TrackedBufferSource {
  readonly source: { readonly playbackRate: AudioParamLike };
  readonly baseRate: number;
  readonly endTime: number;
}

export interface TrackedOscillator {
  readonly osc: { readonly detune: AudioParamLike };
  readonly spawnPitchScale: number;
  readonly endTime: number;
}
