import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { AudioBufferLike, AudioContextLike } from './contracts.ts';

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

export type NearMissGrazeAudioKind = 'HELMET_POP' | 'ARTERIAL_GRAZE';

export interface EnemyBallisticShotAudioParams {
  readonly muzzleOrigin: Vec3Like;
  readonly impactPoint: Vec3Like;
  readonly listenerPos?: Vec3Like;
  readonly weaponId?: string;
  readonly projectileSpeedMs?: number;
  readonly isSupersonic?: boolean;
}

export interface RadioBarkCueAudioParams {
  readonly isRadio: boolean;
  readonly vocalCue?: VocalTraumaCueKind | string;
  readonly worldPos?: Vec3Like;
  readonly listenerPos?: Vec3Like;
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
  readonly pannerModel: PanningModelType;
  readonly masterVolume: number;
  readonly weaponFireCount: number;
  readonly casingBounceCount: number;
  readonly materialImpactCount: number;
  readonly goreImpactCount: number;
  readonly vocalCueCount: number;
  readonly explosionCount: number;
  readonly tinnitusTriggerCount: number;
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
