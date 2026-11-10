import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { DestructibleMaterialKind } from '../../contracts/destruction.ts';

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

/**
 * Minimal strictly-typed WebAudio structural contracts.
 * Compatible with both browser DOM `AudioContext` (via generic `TBuffer`) and
 * lightweight headless test mocks without using `any`.
 */
export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): AudioParamLike;
  linearRampToValueAtTime(value: number, endTime: number): AudioParamLike;
  exponentialRampToValueAtTime(value: number, endTime: number): AudioParamLike;
  setTargetAtTime(target: number, startTime: number, timeConstant: number): AudioParamLike;
  cancelScheduledValues(startTime: number): AudioParamLike;
}

export interface AudioNodeLike {
  connect(destinationNode: AudioNodeLike): unknown;
  disconnect(): void;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

export interface OscillatorNodeLike extends AudioNodeLike {
  type: OscillatorType;
  readonly frequency: AudioParamLike;
  readonly detune: AudioParamLike;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface BiquadFilterNodeLike extends AudioNodeLike {
  type: BiquadFilterType;
  readonly frequency: AudioParamLike;
  readonly Q: AudioParamLike;
  readonly gain: AudioParamLike;
}

export interface AudioBufferLike {
  readonly sampleRate: number;
  readonly length: number;
  readonly duration: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

export interface AudioBufferSourceNodeLike<TBuffer extends AudioBufferLike = AudioBufferLike>
  extends AudioNodeLike {
  buffer: TBuffer | null;
  loop: boolean;
  readonly playbackRate: AudioParamLike;
  start(when?: number, offset?: number, duration?: number): void;
  stop(when?: number): void;
}

export interface ConvolverNodeLike<TBuffer extends AudioBufferLike = AudioBufferLike>
  extends AudioNodeLike {
  buffer: TBuffer | null;
  normalize: boolean;
}

export interface DynamicsCompressorNodeLike extends AudioNodeLike {
  readonly threshold: AudioParamLike;
  readonly knee: AudioParamLike;
  readonly ratio: AudioParamLike;
  readonly attack: AudioParamLike;
  readonly release: AudioParamLike;
}

export interface PannerNodeLike extends AudioNodeLike {
  panningModel: PanningModelType;
  distanceModel: DistanceModelType;
  refDistance: number;
  maxDistance: number;
  rolloffFactor: number;
  coneInnerAngle: number;
  coneOuterAngle: number;
  coneOuterGain: number;
  readonly positionX?: AudioParamLike;
  readonly positionY?: AudioParamLike;
  readonly positionZ?: AudioParamLike;
  readonly orientationX?: AudioParamLike;
  readonly orientationY?: AudioParamLike;
  readonly orientationZ?: AudioParamLike;
  setPosition?(x: number, y: number, z: number): void;
}

export interface StereoPannerNodeLike extends AudioNodeLike {
  readonly pan: AudioParamLike;
}

export interface WaveShaperNodeLike extends AudioNodeLike {
  curve: Float32Array | null;
  oversample: OverSampleType;
}

export interface AudioListenerLike {
  readonly positionX?: AudioParamLike;
  readonly positionY?: AudioParamLike;
  readonly positionZ?: AudioParamLike;
  readonly forwardX?: AudioParamLike;
  readonly forwardY?: AudioParamLike;
  readonly forwardZ?: AudioParamLike;
  readonly upX?: AudioParamLike;
  readonly upY?: AudioParamLike;
  readonly upZ?: AudioParamLike;
  setPosition?(x: number, y: number, z: number): void;
  setOrientation?(
    fx: number,
    fy: number,
    fz: number,
    ux: number,
    uy: number,
    uz: number,
  ): void;
}

export interface AudioContextLike<TBuffer extends AudioBufferLike = AudioBufferLike> {
  readonly state: AudioContextState;
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: AudioNodeLike;
  readonly listener: AudioListenerLike;
  resume(): Promise<void>;
  close(): Promise<void>;
  createGain(): GainNodeLike;
  createOscillator(): OscillatorNodeLike;
  createBiquadFilter(): BiquadFilterNodeLike;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): TBuffer;
  createBufferSource(): AudioBufferSourceNodeLike<TBuffer>;
  createConvolver(): ConvolverNodeLike<TBuffer>;
  createDynamicsCompressor(): DynamicsCompressorNodeLike;
  createPanner(): PannerNodeLike;
  createStereoPanner?(): StereoPannerNodeLike;
  createWaveShaper(): WaveShaperNodeLike;
}

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

interface WindowWithWebkitAudio {
  AudioContext?: new () => AudioContext;
  webkitAudioContext?: new () => AudioContext;
}

interface TrackedBufferSource {
  readonly source: { readonly playbackRate: AudioParamLike };
  readonly baseRate: number;
  readonly endTime: number;
}

interface TrackedOscillator {
  readonly osc: { readonly detune: AudioParamLike };
  readonly spawnPitchScale: number;
  readonly endTime: number;
}

// ============================================================================
// Pure Mathematical & Procedural Curve Helpers (Exported for Unit Tests)
// ============================================================================

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

/**
 * Computes 3D Euclidean distance, inverse-distance + horizon attenuation,
 * listener-relative stereo pan (`-1` left .. `+1` right), high-frequency air
 * absorption lowpass cutoff, and warehouse convolution reverb wet send level.
 */
export function computeSpatialAudioParams(
  worldPos: Vec3Like,
  listenerPos: Vec3Like,
  options: SpatialCalcOptions = {},
): SpatialAudioParams {
  const refDistanceM = Math.max(0.1, options.refDistanceM ?? 1.5);
  const maxDistanceM = Math.max(refDistanceM + 1.0, options.maxDistanceM ?? 85.0);
  const rolloffFactor = Math.max(0.05, options.rolloffFactor ?? 1.15);
  const listenerYawDeg = options.listenerYawDeg ?? 0;
  const baseReverbWet = clampNumber(options.baseReverbWet ?? 0.14, 0, 1);
  const maxReverbWet = clampNumber(options.maxReverbWet ?? 0.58, baseReverbWet, 1);

  const dx = worldPos.x - listenerPos.x;
  const dy = worldPos.y - listenerPos.y;
  const dz = worldPos.z - listenerPos.z;
  const distanceM = Math.hypot(dx, dy, dz);

  let gainAttenuation = 1.0;
  if (distanceM > refDistanceM) {
    const inverseTerm =
      refDistanceM / (refDistanceM + rolloffFactor * (distanceM - refDistanceM));
    const horizonRatio = clampNumber(
      (distanceM - refDistanceM) / (maxDistanceM - refDistanceM),
      0,
      1,
    );
    const horizonFade = 1.0 - horizonRatio * horizonRatio * 0.85;
    gainAttenuation = clampNumber(inverseTerm * horizonFade, 0, 1);
  }

  // PlayCanvas camera convention: yaw = 0 faces -Z, right vector is (+cos(yaw), 0, -sin(yaw))
  const yawRad = (listenerYawDeg * Math.PI) / 180;
  const rightX = Math.cos(yawRad);
  const rightZ = -Math.sin(yawRad);
  const horizDist = Math.hypot(dx, dz);
  let stereoPan = 0;
  if (horizDist > 1e-4) {
    const rightProj = dx * rightX + dz * rightZ;
    // Soft near-field width normalization so very close sounds don't hard-snap +/-1 on 1cm offsets
    const normDenom = Math.max(0.65, horizDist);
    stereoPan = clampNumber(rightProj / normDenom, -1, 1);
  }

  const airAbsorptionCutoffHz = clampNumber(
    2200 + 17800 * Math.exp(-distanceM / 28.0),
    1800,
    20000,
  );

  const distanceWetFactor = 1.0 - Math.exp(-distanceM / 10.0);
  const rawWet = baseReverbWet + (maxReverbWet - baseReverbWet) * distanceWetFactor;
  const horizonRatio =
    distanceM > refDistanceM
      ? clampNumber((distanceM - refDistanceM) / (maxDistanceM - refDistanceM), 0, 1)
      : 0;
  const roomHorizonFade = 1.0 - horizonRatio * horizonRatio * 0.75;
  const roomEnvelope = (1.0 / (1.0 + distanceM / 48.0)) * roomHorizonFade;
  const reverbSendGain = clampNumber(rawWet * roomEnvelope, 0, 1);

  return {
    distanceM,
    gainAttenuation,
    stereoPan,
    airAbsorptionCutoffHz,
    reverbSendGain,
    deltaWorld: { x: dx, y: dy, z: dz },
  };
}

/**
 * Generates a smooth symmetric soft-clipping `tanh` waveshaper transfer curve
 * so heavy 28Hz-90Hz shockwaves and .50 AE blasts saturate warmly without harsh digital clipping.
 */
export function createSoftClipCurve(drive: number, samples = 512): Float32Array {
  const count = Math.max(8, Math.floor(samples));
  const curve = new Float32Array(count);
  const effectiveDrive = Math.max(0.1, drive);
  const norm = Math.tanh(effectiveDrive);
  for (let i = 0; i < count; i++) {
    const x = (i * 2) / (count - 1) - 1;
    curve[i] = Math.tanh(x * effectiveDrive) / norm;
  }
  return curve;
}

/**
 * Synthesizes a realistic stereo Indoor Shooting-Range / Concrete Warehouse
 * Impulse Response (`ConvolverNode` buffer):
 * - Discrete early reflections off concrete floor, side walls, steel ceiling trusses, and 45m backstop
 * - Decorrelated stereo exponentially-decaying diffuse tail with progressive air-absorption damping
 */
export function synthesizeWarehouseImpulseResponse(
  leftOut: Float32Array,
  rightOut: Float32Array,
  sampleRate: number,
  decaySeconds = 1.55,
  seed = 0x9e3779b9,
): void {
  const length = Math.min(leftOut.length, rightOut.length);
  if (length === 0 || sampleRate <= 0) {
    return;
  }

  leftOut.fill(0);
  rightOut.fill(0);

  // Early concrete & steel truss slapback reflections (timeMs, gainL, gainR)
  const earlyTaps: ReadonlyArray< readonly [number, number, number] > = [
    [4.2, 0.42, 0.39],   // Concrete floor bounce
    [13.6, 0.54, 0.18],  // Left bay wall
    [17.4, 0.19, 0.52],  // Right bay wall
    [26.8, 0.34, 0.36],  // Overhead steel roof truss
    [41.5, 0.31, 0.16],  // Mid-range concrete baffle L
    [46.9, 0.15, 0.30],  // Mid-range concrete baffle R
    [74.0, 0.23, 0.25],  // Downrange shooting stall echo
    [118.5, 0.17, 0.16], // 42m concrete backstop slapback
  ];

  for (const [ms, gL, gR] of earlyTaps) {
    const idx = Math.floor((ms * 0.001) * sampleRate);
    if (idx >= 0 && idx < length) {
      leftOut[idx] += gL;
      rightOut[idx] += gR;
    }
  }

  let state = (seed >>> 0) || 0x12345678;
  const nextSigned = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 0xffffffff) * 2 - 1;
  };

  const tau = Math.max(0.15, decaySeconds / 4.2);
  let lpL = 0;
  let lpR = 0;

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    // Slight pre-delay fade-in over first 6ms into exponentially decaying warehouse tail
    const preDelayEnv = Math.min(1.0, t / 0.006);
    const decayEnv = Math.exp(-t / tau) * preDelayEnv;

    // Progressive high-frequency air damping as reverberation bounces downrange
    const dampAlpha = clampNumber(0.58 - 0.44 * Math.min(1.0, t / decaySeconds), 0.10, 0.65);

    const rawL = nextSigned();
    const rawR = nextSigned();
    lpL += dampAlpha * (rawL - lpL);
    lpR += dampAlpha * (rawR - lpR);

    leftOut[i] += lpL * decayEnv * 0.34;
    rightOut[i] += lpR * decayEnv * 0.34;
  }
}

/**
 * Maps ballistic kinetic energy (Joules) to a well-behaved perceptual loudness
 * multiplier `[0.25 .. 1.35]` for material fracture & impact synthesis.
 */
export function computeImpactEnergyGain(energyJ: number): number {
  if (!Number.isFinite(energyJ) || energyJ <= 0) {
    return 0.25;
  }
  const normalized = Math.log10(Math.max(10, energyJ)) / 3.05;
  return clampNumber(normalized, 0.25, 1.35);
}

// ============================================================================
// Internal Generic Runtime Binding (Avoids DOM AudioBuffer Invariance Casts)
// ============================================================================

interface SpatialChain {
  readonly input: GainNodeLike;
  readonly spatialParams: SpatialAudioParams;
}

interface InternalAudioGraph {
  readonly ctx: {
    readonly state: AudioContextState;
    readonly currentTime: number;
    readonly sampleRate: number;
    resume(): Promise<void>;
    close(): Promise<void>;
  };
  readonly dryBus: GainNodeLike;
  readonly reverbSendBus: GainNodeLike;
  readonly masterGain: GainNodeLike;
  readonly compressor: DynamicsCompressorNodeLike;
  readonly warmDriveCurve: Float32Array;
  readonly heavyDriveCurve: Float32Array;
  createGain(): GainNodeLike;
  createOscillator(): OscillatorNodeLike;
  createBiquadFilter(): BiquadFilterNodeLike;
  createWaveShaper(): WaveShaperNodeLike;
  createNoiseSlice(
    kind: 'WHITE' | 'PINK' | 'CRACKLE',
    playbackRate: number,
    loop?: boolean,
  ): {
    readonly source: AudioNodeLike & {
      readonly playbackRate: AudioParamLike;
      start(when?: number, offset?: number, duration?: number): void;
      stop(when?: number): void;
    };
    readonly bufferDuration: number;
  };
  updateListener(pos: Vec3Like, yawDeg: number, pitchDeg: number): void;
  createSpatialChain(
    worldPos: Vec3Like,
    listenerPos: Vec3Like,
    listenerYawDeg: number,
    pannerModel: PanningModelType,
    reverbWetMix: number,
    options?: SpatialCalcOptions,
  ): SpatialChain;
}

function createInternalAudioGraph<TBuffer extends AudioBufferLike>(
  ctx: AudioContextLike<TBuffer>,
  initialMasterVolume: number,
  initialReverbWetMix: number,
  rng: () => number,
): InternalAudioGraph {
  const sr = Math.max(8000, ctx.sampleRate || 44100);

  // Master limiter/compressor so chaotic multi-barrel chain detonations NEVER clip
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -8.0;
  compressor.knee.value = 10.0;
  compressor.ratio.value = 12.0;
  compressor.attack.value = 0.002;
  compressor.release.value = 0.14;

  const masterGain = ctx.createGain();
  masterGain.gain.value = clampNumber(initialMasterVolume, 0, 2.0);

  const dryBus = ctx.createGain();
  dryBus.gain.value = 0.92;

  const reverbSendBus = ctx.createGain();
  reverbSendBus.gain.value = 1.0;

  const reverbReturnGain = ctx.createGain();
  reverbReturnGain.gain.value = clampNumber(initialReverbWetMix, 0, 1.2);

  // Stereo Warehouse / Indoor Shooting-Range Convolver
  const convolver = ctx.createConvolver();
  convolver.normalize = true;
  const irLength = Math.max(64, Math.floor(sr * 1.55));
  const irBuffer = ctx.createBuffer(2, irLength, sr);
  synthesizeWarehouseImpulseResponse(
    irBuffer.getChannelData(0),
    irBuffer.getChannelData(1),
    sr,
    1.55,
  );
  convolver.buffer = irBuffer;

  dryBus.connect(compressor);
  reverbSendBus.connect(convolver);
  convolver.connect(reverbReturnGain);
  reverbReturnGain.connect(compressor);
  compressor.connect(masterGain);
  masterGain.connect(ctx.destination);

  // Pre-bake reusable procedural noise buffers (zero per-shot Float32Array GC churn!)
  const whiteLen = Math.max(64, Math.floor(sr * 1.5));
  const whiteBuf = ctx.createBuffer(1, whiteLen, sr);
  const whiteData = whiteBuf.getChannelData(0);

  const pinkLen = Math.max(64, Math.floor(sr * 2.0));
  const pinkBuf = ctx.createBuffer(1, pinkLen, sr);
  const pinkData = pinkBuf.getChannelData(0);

  const crackleLen = Math.max(64, Math.floor(sr * 1.5));
  const crackleBuf = ctx.createBuffer(1, crackleLen, sr);
  const crackleData = crackleBuf.getChannelData(0);

  let prng = 0x6d2b79f5;
  const fastSigned = (): number => {
    prng ^= prng << 13;
    prng ^= prng >>> 17;
    prng ^= prng << 5;
    return ((prng >>> 0) / 0xffffffff) * 2 - 1;
  };

  for (let i = 0; i < whiteLen; i++) {
    whiteData[i] = fastSigned();
  }

  // Paul Kellet 1/f pink noise filter for warm low-mid blast & muzzle body
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < pinkLen; i++) {
    const w = fastSigned();
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.18;
    b6 = w * 0.115926;
    pinkData[i] = clampNumber(pink, -1, 1);
  }

  // High-crest impulsive crackle buffer for wood splinters, debris, and bone crunch
  for (let i = 0; i < crackleLen; i++) {
    const r = fastSigned();
    const gate = Math.abs(r) > 0.72 ? Math.sign(r) * Math.pow(Math.abs(r), 0.45) : r * 0.08;
    crackleData[i] = gate;
  }

  const warmDriveCurve = createSoftClipCurve(2.2, 512);
  const heavyDriveCurve = createSoftClipCurve(4.6, 512);

  const setListenerCoords = (pos: Vec3Like, yawDeg: number, pitchDeg: number): void => {
    const listener = ctx.listener;
    const t = ctx.currentTime;
    const yawRad = (yawDeg * Math.PI) / 180;
    const pitchRad = (pitchDeg * Math.PI) / 180;
    const cosPitch = Math.cos(pitchRad);

    const fx = -Math.sin(yawRad) * cosPitch;
    const fy = Math.sin(pitchRad);
    const fz = -Math.cos(yawRad) * cosPitch;

    if (listener.positionX && listener.positionY && listener.positionZ) {
      listener.positionX.setValueAtTime(pos.x, t);
      listener.positionY.setValueAtTime(pos.y, t);
      listener.positionZ.setValueAtTime(pos.z, t);
    } else if (listener.setPosition) {
      listener.setPosition(pos.x, pos.y, pos.z);
    }

    if (
      listener.forwardX &&
      listener.forwardY &&
      listener.forwardZ &&
      listener.upX &&
      listener.upY &&
      listener.upZ
    ) {
      listener.forwardX.setValueAtTime(fx, t);
      listener.forwardY.setValueAtTime(fy, t);
      listener.forwardZ.setValueAtTime(fz, t);
      listener.upX.setValueAtTime(0, t);
      listener.upY.setValueAtTime(1, t);
      listener.upZ.setValueAtTime(0, t);
    } else if (listener.setOrientation) {
      listener.setOrientation(fx, fy, fz, 0, 1, 0);
    }
  };

  return {
    ctx,
    dryBus,
    reverbSendBus,
    masterGain,
    compressor,
    warmDriveCurve,
    heavyDriveCurve,
    createGain: () => ctx.createGain(),
    createOscillator: () => ctx.createOscillator(),
    createBiquadFilter: () => ctx.createBiquadFilter(),
    createWaveShaper: () => ctx.createWaveShaper(),
    createNoiseSlice(kind, playbackRate, loop = false) {
      const buf =
        kind === 'WHITE' ? whiteBuf : kind === 'PINK' ? pinkBuf : crackleBuf;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = loop;
      src.playbackRate.value = Math.max(0.04, playbackRate);
      return {
        source: src,
        bufferDuration: buf.duration,
      };
    },
    updateListener: setListenerCoords,
    createSpatialChain(
      worldPos,
      listenerPos,
      listenerYawDeg,
      pannerModel,
      reverbWetMix,
      options = {},
    ): SpatialChain {
      const t = ctx.currentTime;
      setListenerCoords(listenerPos, listenerYawDeg, 0);

      const spatialParams = computeSpatialAudioParams(worldPos, listenerPos, {
        ...options,
        listenerYawDeg,
      });

      const input = ctx.createGain();
      input.gain.setValueAtTime(1.0, t);

      const airFilter = ctx.createBiquadFilter();
      airFilter.type = 'lowpass';
      airFilter.frequency.setValueAtTime(spatialParams.airAbsorptionCutoffHz, t);
      airFilter.Q.setValueAtTime(0.5, t);

      const panner = ctx.createPanner();
      try {
        panner.panningModel = pannerModel;
      } catch {
        panner.panningModel = 'equalpower';
      }
      panner.distanceModel = 'inverse';
      panner.refDistance = Math.max(0.1, options.refDistanceM ?? 1.5);
      panner.maxDistance = Math.max(panner.refDistance + 1.0, options.maxDistanceM ?? 85.0);
      panner.rolloffFactor = Math.max(0.05, options.rolloffFactor ?? 1.15);
      panner.coneInnerAngle = 360;
      panner.coneOuterAngle = 360;
      panner.coneOuterGain = 1.0;

      if (panner.positionX && panner.positionY && panner.positionZ) {
        panner.positionX.setValueAtTime(worldPos.x, t);
        panner.positionY.setValueAtTime(worldPos.y, t);
        panner.positionZ.setValueAtTime(worldPos.z, t);
      } else if (panner.setPosition) {
        panner.setPosition(worldPos.x, worldPos.y, worldPos.z);
      }

      const wetSend = ctx.createGain();
      wetSend.gain.setValueAtTime(
        spatialParams.reverbSendGain * clampNumber(reverbWetMix * 2.2, 0, 1.8),
        t,
      );

      input.connect(airFilter);
      airFilter.connect(panner);
      panner.connect(dryBus);

      airFilter.connect(wetSend);
      wetSend.connect(reverbSendBus);

      // Keep rng referenced cleanly for future micro-decorrelation if needed
      void rng;

      return { input, spatialParams };
    },
  };
}

// ============================================================================
// AAA 3D Spatial Combat, Destruction & Gore WebAudio Engine
// ============================================================================

export class CombatAudioEngine {
  private graph: InternalAudioGraph | null = null;
  private readonly contextFactory: (() => InternalAudioGraph | null) | null;
  private readonly rng: () => number;
  private pannerModel: PanningModelType;
  private masterVolume: number;
  private readonly reverbWetMix: number;

  private timeScale = 1.0;
  private slowMoActive = false;
  private listenerPos: Vec3Like = { x: 0, y: 1.62, z: 0 };
  private listenerYawDeg = 0;
  private listenerPitchDeg = 0;

  private heartbeatBus: GainNodeLike | null = null;
  private heartbeatNextScheduleTime = 0;
  private lastVocalCueTime = -10;
  private m4ShotCounter = 0;
  private lastWeaponPitchJitter = 1.0;

  private readonly activeSources: TrackedBufferSource[] = [];
  private readonly activeOscillators: TrackedOscillator[] = [];
  private gestureCleanup: (() => void) | null = null;
  private destroyed = false;

  // Diagnostics counters
  private weaponFireCount = 0;
  private casingBounceCount = 0;
  private materialImpactCount = 0;
  private goreImpactCount = 0;
  private vocalCueCount = 0;
  private explosionCount = 0;
  private tinnitusTriggerCount = 0;
  private slowMoTransitionCount = 0;

  constructor(options: CombatAudioEngineOptions = {}) {
    this.pannerModel = options.pannerModel ?? 'HRTF';
    this.masterVolume = clampNumber(options.masterVolume ?? 0.9, 0, 2.0);
    this.reverbWetMix = clampNumber(options.reverbWetMix ?? 0.34, 0, 1.0);
    this.rng = options.random ?? Math.random;

    if (options.context !== undefined) {
      const provided = options.context;
      this.contextFactory = provided
        ? () =>
            createInternalAudioGraph(
              provided,
              this.masterVolume,
              this.reverbWetMix,
              this.rng,
            )
        : null;
      if (provided) {
        this.graph = this.contextFactory ? this.contextFactory() : null;
      }
    } else if (options.contextFactory) {
      const factory = options.contextFactory;
      this.contextFactory = () => {
        const created = factory();
        return created
          ? createInternalAudioGraph(
              created,
              this.masterVolume,
              this.reverbWetMix,
              this.rng,
            )
          : null;
      };
    } else {
      this.contextFactory = () => {
        const Ctor = CombatAudioEngine.resolveBrowserAudioContextCtor();
        if (!Ctor) {
          return null;
        }
        try {
          const domCtx = new Ctor();
          return createInternalAudioGraph<AudioBuffer>(
            domCtx,
            this.masterVolume,
            this.reverbWetMix,
            this.rng,
          );
        } catch {
          return null;
        }
      };
    }

    if (options.autoUnlockOnGesture !== false) {
      this.bindAutoUnlockListeners();
    }
  }

  private static resolveBrowserAudioContextCtor(): (new () => AudioContext) | null {
    const scope = globalThis as unknown as WindowWithWebkitAudio;
    if (typeof scope.AudioContext === 'function') {
      return scope.AudioContext;
    }
    if (typeof scope.webkitAudioContext === 'function') {
      return scope.webkitAudioContext;
    }
    if (typeof window !== 'undefined') {
      const win = window as unknown as WindowWithWebkitAudio;
      if (typeof win.AudioContext === 'function') {
        return win.AudioContext;
      }
      if (typeof win.webkitAudioContext === 'function') {
        return win.webkitAudioContext;
      }
    }
    return null;
  }

  private bindAutoUnlockListeners(): void {
    const target: Pick< Window, 'addEventListener' | 'removeEventListener' > | null =
      typeof window !== 'undefined' && typeof window.addEventListener === 'function'
        ? window
        : typeof document !== 'undefined' && typeof document.addEventListener === 'function'
          ? document
          : null;

    if (!target) {
      return;
    }

    const onUserGesture = (): void => {
      if (this.destroyed) {
        return;
      }
      void this.unlock();
    };

    target.addEventListener('mousedown', onUserGesture, { passive: true });
    target.addEventListener('keydown', onUserGesture, { passive: true });

    this.gestureCleanup = (): void => {
      target.removeEventListener('mousedown', onUserGesture);
      target.removeEventListener('keydown', onUserGesture);
    };
  }

  private ensureGraph(): InternalAudioGraph | null {
    if (this.destroyed) {
      return null;
    }
    if (!this.graph && this.contextFactory) {
      this.graph = this.contextFactory();
    }
    if (this.graph && this.graph.ctx.state === 'suspended') {
      void this.graph.ctx.resume().catch(() => {
        // Ignore browser autoplay rejection before first user gesture
      });
    }
    if (this.graph) {
      this.pruneFinishedSources(this.graph.ctx.currentTime);
    }
    return this.graph;
  }

  public async unlock(): Promise<boolean> {
    if (this.destroyed) {
      return false;
    }
    if (!this.graph && this.contextFactory) {
      this.graph = this.contextFactory();
    }
    if (!this.graph) {
      return false;
    }
    if (this.graph.ctx.state === 'suspended') {
      try {
        await this.graph.ctx.resume();
      } catch {
        return false;
      }
    }
    return this.graph.ctx.state === 'running';
  }

  public isAvailable(): boolean {
    if (this.destroyed) {
      return false;
    }
    if (this.graph) {
      return true;
    }
    return CombatAudioEngine.resolveBrowserAudioContextCtor() !== null || this.contextFactory !== null;
  }

  public isUnlocked(): boolean {
    return Boolean(this.graph && this.graph.ctx.state === 'running');
  }

  public getDiagnostics(): CombatAudioDiagnostics {
    return {
      available: this.graph !== null || CombatAudioEngine.resolveBrowserAudioContextCtor() !== null,
      unlocked: this.isUnlocked(),
      timeScale: this.timeScale,
      slowMoActive: this.slowMoActive,
      pannerModel: this.pannerModel,
      masterVolume: this.masterVolume,
      weaponFireCount: this.weaponFireCount,
      casingBounceCount: this.casingBounceCount,
      materialImpactCount: this.materialImpactCount,
      goreImpactCount: this.goreImpactCount,
      vocalCueCount: this.vocalCueCount,
      explosionCount: this.explosionCount,
      tinnitusTriggerCount: this.tinnitusTriggerCount,
      slowMoTransitionCount: this.slowMoTransitionCount,
      lastWeaponPitchJitter: this.lastWeaponPitchJitter,
    };
  }

  public setMasterVolume(volume: number): void {
    this.masterVolume = clampNumber(volume, 0, 2.0);
    if (this.graph) {
      this.graph.masterGain.gain.setValueAtTime(
        this.masterVolume,
        this.graph.ctx.currentTime,
      );
    }
  }

  public getMasterVolume(): number {
    return this.masterVolume;
  }

  public setPannerModel(model: PanningModelType): void {
    this.pannerModel = model;
  }

  public getPannerModel(): PanningModelType {
    return this.pannerModel;
  }

  public updateListener(pos: Vec3Like, yawDeg = 0, pitchDeg = 0): void {
    this.listenerPos = { x: pos.x, y: pos.y, z: pos.z };
    this.listenerYawDeg = yawDeg;
    this.listenerPitchDeg = pitchDeg;
    if (this.graph) {
      this.graph.updateListener(this.listenerPos, yawDeg, pitchDeg);
    }
  }

  /**
   * Sets global simulation time-dilation scale (`0.08 .. 2.0`, e.g. `0.2x` in F.E.A.R. Reflex mode).
   * Dynamically pitches active buffer sources in real time and scales all newly triggered sounds!
   */
  public setTimeScale(scale: number): void {
    const clamped = clampTimeScale(scale);
    this.timeScale = clamped;

    if (!this.graph) {
      return;
    }

    const now = this.graph.ctx.currentTime;
    this.pruneFinishedSources(now);
    const factors = computeSlowMoAudioFactors(clamped);

    for (const tracked of this.activeSources) {
      const targetRate = Math.max(0.04, tracked.baseRate * factors.playbackRate);
      tracked.source.playbackRate.setTargetAtTime(targetRate, now, 0.025);
    }

    for (const trackedOsc of this.activeOscillators) {
      const ratio = Math.max(
        0.05,
        factors.oscillatorPitchScale / Math.max(0.05, trackedOsc.spawnPitchScale),
      );
      const detuneCents = 1200 * Math.log2(ratio);
      trackedOsc.osc.detune.setTargetAtTime(detuneCents, now, 0.025);
    }
  }

  public getTimeScale(): number {
    return this.timeScale;
  }

  /**
   * Optional frame update to keep Reflex slow-motion cardiac heartbeat pulsing seamlessly
   * during extended slow-mo sequences.
   */
  public update(_rawDt: number): void {
    if (!this.slowMoActive || !this.graph || !this.heartbeatBus) {
      return;
    }
    const now = this.graph.ctx.currentTime;
    if (now + 0.35 >= this.heartbeatNextScheduleTime) {
      this.scheduleHeartbeatPair(this.graph, this.heartbeatBus, Math.max(now + 0.05, this.heartbeatNextScheduleTime));
      this.heartbeatNextScheduleTime = Math.max(now + 0.05, this.heartbeatNextScheduleTime) + 0.92;
    }
  }

  private registerScaledSource(
    source: { readonly playbackRate: AudioParamLike },
    baseRate: number,
    endTime: number,
  ): void {
    this.activeSources.push({ source, baseRate, endTime });
  }

  private registerScaledOscillator(
    osc: { readonly detune: AudioParamLike },
    spawnPitchScale: number,
    endTime: number,
  ): void {
    this.activeOscillators.push({ osc, spawnPitchScale, endTime });
  }

  private pruneFinishedSources(now: number): void {
    let writeIdx = 0;
    for (let i = 0; i < this.activeSources.length; i++) {
      const item = this.activeSources[i];
      if (item.endTime > now) {
        this.activeSources[writeIdx++] = item;
      }
    }
    this.activeSources.length = writeIdx;

    let oscWriteIdx = 0;
    for (let i = 0; i < this.activeOscillators.length; i++) {
      const item = this.activeOscillators[i];
      if (item.endTime > now) {
        this.activeOscillators[oscWriteIdx++] = item;
      }
    }
    this.activeOscillators.length = oscWriteIdx;
  }

  private spawnNoiseBurst(
    g: InternalAudioGraph,
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
    const factors = computeSlowMoAudioFactors(this.timeScale);
    const effectiveRate = Math.max(0.05, basePlaybackRate * factors.playbackRate);
    const slice = g.createNoiseSlice(kind, effectiveRate, true);
    const offset = slice.bufferDuration > 0 ? this.rng() * slice.bufferDuration : 0;

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
    this.registerScaledSource(slice.source, basePlaybackRate, stopAt);
  }

  private spawnPitchDropOsc(
    g: InternalAudioGraph,
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
    const currentPitchScale = computeSlowMoAudioFactors(this.timeScale).oscillatorPitchScale;
    this.registerScaledOscillator(osc, currentPitchScale, stopAt);
  }

  // ==========================================================================
  // 1. Multi-Layered First-Person Weapon Gunfire & Mechanical Foley
  // ==========================================================================

  public playWeaponFire(weaponId: string, ammoType: string, isAds: boolean): void {
    this.weaponFireCount += 1;
    const g = this.ensureGraph();
    if (!g) {
      return;
    }

    const t0 = g.ctx.currentTime;
    const factors = computeSlowMoAudioFactors(this.timeScale);
    const pScale = factors.oscillatorPitchScale;
    const stretch = factors.envelopeStretch;

    // Weapon output bus feeding dry + warehouse shooting-range convolver send
    const shotBus = g.createGain();
    shotBus.gain.setValueAtTime(isAds ? 1.05 : 1.0, t0);
    shotBus.connect(g.dryBus);

    const warehouseSend = g.createGain();
    const isAp = ammoType === 'AP';
    const isJhp = ammoType === 'JHP';

    if (weaponId === 'm590_shotgun') {
      this.lastWeaponPitchJitter = 1.0;
      warehouseSend.gain.setValueAtTime(isAds ? 0.44 : 0.54, t0);
      shotBus.connect(warehouseSend);
      warehouseSend.connect(g.reverbSendBus);

      // Layer 1: Chest-thumping 55Hz sub-punch (sustained 55Hz core dropping to 33Hz)
      const subOsc = g.createOscillator();
      subOsc.type = 'sine';
      subOsc.frequency.setValueAtTime(92 * pScale, t0);
      subOsc.frequency.exponentialRampToValueAtTime(55 * pScale, t0 + 0.032 * stretch);
      subOsc.frequency.exponentialRampToValueAtTime(33 * pScale, t0 + 0.22 * stretch);

      const subShaper = g.createWaveShaper();
      subShaper.curve = g.warmDriveCurve;
      subShaper.oversample = '2x';

      const subGain = g.createGain();
      subGain.gain.setValueAtTime(0.0001, t0);
      subGain.gain.linearRampToValueAtTime(0.88, t0 + 0.003);
      subGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.24 * stretch);

      subOsc.connect(subShaper);
      subShaper.connect(subGain);
      subGain.connect(shotBus);
      subOsc.start(t0);
      subOsc.stop(t0 + 0.25 * stretch);

      // Layer 2: Crisp wide-band 12-gauge transient blast (Sabot AP slug adds sharper crack)
      this.spawnNoiseBurst(
        g,
        shotBus,
        'WHITE',
        t0,
        0.25 * stretch,
        isAp ? 0.78 : 0.85,
        'lowpass',
        isAp ? 6400 : 5200,
        520,
        1.2,
        1.0,
        0.001,
      );
      this.spawnNoiseBurst(
        g,
        shotBus,
        'PINK',
        t0,
        0.34 * stretch,
        0.62,
        'bandpass',
        420,
        150,
        0.85,
        0.92,
        0.002,
      );

      // Layer 3: Iconic metallic pump-action rack ("ch-chk!") 220ms later!
      const tRackBack = t0 + 0.22 * stretch;
      const tRackFwd = t0 + 0.305 * stretch;

      // "ch-" (forend slide back + chamber extraction friction)
      this.spawnNoiseBurst(
        g,
        g.dryBus,
        'CRACKLE',
        tRackBack,
        0.068 * stretch,
        0.28,
        'bandpass',
        2150,
        1480,
        4.2,
        1.1,
        0.004,
      );
      this.spawnPitchDropOsc(
        g,
        g.dryBus,
        'triangle',
        tRackBack,
        0.045 * stretch,
        1860 * pScale,
        1320 * pScale,
        0.14,
      );

      // "-chk!" (forend slide forward + twin steel locking lugs snapping into battery)
      this.spawnNoiseBurst(
        g,
        g.dryBus,
        'WHITE',
        tRackFwd,
        0.055 * stretch,
        0.32,
        'bandpass',
        1650,
        3100,
        5.0,
        1.18,
        0.002,
      );
      this.spawnPitchDropOsc(
        g,
        g.dryBus,
        'sine',
        tRackFwd + 0.012 * stretch,
        0.042 * stretch,
        3350 * pScale,
        2850 * pScale,
        0.19,
      );
      this.spawnPitchDropOsc(
        g,
        g.dryBus,
        'sine',
        tRackFwd + 0.016 * stretch,
        0.036 * stretch,
        4920 * pScale,
        4400 * pScale,
        0.13,
      );
      return;
    }

    if (weaponId === 'silver_talon_50ae') {
      this.lastWeaponPitchJitter = 1.0;
      // Deep indoor warehouse hand-cannon tail
      warehouseSend.gain.setValueAtTime(isAds ? 0.62 : 0.74, t0);
      shotBus.connect(warehouseSend);
      warehouseSend.connect(g.reverbSendBus);

      // Layer 1: Massive .50 AE desert-cannon chest crack
      this.spawnPitchDropOsc(
        g,
        shotBus,
        'triangle',
        t0,
        0.21 * stretch,
        185 * pScale,
        46 * pScale,
        0.84,
        g.heavyDriveCurve,
        0.001,
      );
      this.spawnNoiseBurst(
        g,
        shotBus,
        'WHITE',
        t0,
        0.22 * stretch,
        0.82,
        'lowpass',
        isJhp ? 5800 : 7200,
        680,
        1.5,
        1.05,
        0.0008,
      );
      // Long warehouse thunder body
      this.spawnNoiseBurst(
        g,
        warehouseSend,
        'PINK',
        t0 + 0.008,
        0.44 * stretch,
        0.55,
        'lowpass',
        1800,
        260,
        0.8,
        0.85,
        0.005,
      );

      // Layer 2: Heavy gas-operated steel slide metallic ring
      this.spawnPitchDropOsc(
        g,
        g.dryBus,
        'sine',
        t0 + 0.018 * stretch,
        0.16 * stretch,
        2780 * pScale,
        2690 * pScale,
        0.18,
      );
      this.spawnPitchDropOsc(
        g,
        g.dryBus,
        'sine',
        t0 + 0.024 * stretch,
        0.13 * stretch,
        4380 * pScale,
        4240 * pScale,
        0.12,
      );
      return;
    }

    if (weaponId === 'msg90_sniper') {
      this.lastWeaponPitchJitter = 1.0;
      warehouseSend.gain.setValueAtTime(isAds ? 0.58 : 0.68, t0);
      shotBus.connect(warehouseSend);
      warehouseSend.connect(g.reverbSendBus);

      // Layer 1: Supersonic 7.62mm N-wave whip crack
      this.spawnPitchDropOsc(
        g,
        shotBus,
        'sawtooth',
        t0,
        0.042 * stretch,
        (isAp ? 4200 : 3650) * pScale,
        1050 * pScale,
        0.46,
        g.warmDriveCurve,
        0.0006,
      );
      this.spawnNoiseBurst(
        g,
        shotBus,
        'WHITE',
        t0,
        0.065 * stretch,
        0.76,
        'highpass',
        2100,
        950,
        1.3,
        1.25,
        0.0006,
      );

      // Layer 2: High-pressure 7.62x51mm muzzle bark + shoulder punch
      this.spawnPitchDropOsc(
        g,
        shotBus,
        'sine',
        t0,
        0.18 * stretch,
        142 * pScale,
        48 * pScale,
        0.72,
        g.warmDriveCurve,
        0.0012,
      );
      this.spawnNoiseBurst(
        g,
        shotBus,
        'PINK',
        t0,
        0.32 * stretch,
        0.68,
        'lowpass',
        3400,
        310,
        1.0,
        0.95,
        0.0015,
      );

      // Layer 3: Roller-delayed mechanical bolt & buffer spring resonance
      const tBolt = t0 + 0.034 * stretch;
      this.spawnPitchDropOsc(
        g,
        g.dryBus,
        'sine',
        tBolt,
        0.20 * stretch,
        1440 * pScale,
        1390 * pScale,
        0.15,
      );
      this.spawnPitchDropOsc(
        g,
        g.dryBus,
        'triangle',
        tBolt + 0.012 * stretch,
        0.15 * stretch,
        3080 * pScale,
        2920 * pScale,
        0.11,
      );
      return;
    }

    // Default / `m4a1_carbine`: Tight punchy 5.56mm tactical carbine with organic full-auto pitch jitter!
    this.m4ShotCounter += 1;
    // Combine RNG jitter + subtle deterministic golden-ratio offset so consecutive 750 RPM rounds never match
    const cycOffset = (((this.m4ShotCounter * 0.6180339887) % 1) - 0.5) * 0.036;
    const randOffset = (this.rng() * 2 - 1) * 0.032;
    const jitter = clampNumber(1.0 + cycOffset + randOffset, 0.92, 1.08);
    this.lastWeaponPitchJitter = jitter;

    warehouseSend.gain.setValueAtTime(isAds ? 0.30 : 0.38, t0);
    shotBus.connect(warehouseSend);
    warehouseSend.connect(g.reverbSendBus);

    // Tight punchy 5.56mm chest/buffer thump
    this.spawnPitchDropOsc(
      g,
      shotBus,
      'triangle',
      t0,
      0.095 * stretch,
      162 * pScale * jitter,
      60 * pScale * jitter,
      0.66,
      g.warmDriveCurve,
      0.001,
    );

    // Ferocious crisp 5.56mm muzzle bark
    this.spawnNoiseBurst(
      g,
      shotBus,
      'WHITE',
      t0,
      0.115 * stretch,
      0.72,
      'lowpass',
      (isJhp ? 4400 : 5300) * jitter,
      780 * jitter,
      1.35,
      jitter,
      0.0008,
    );

    // Direct-impingement bolt carrier group & buffer spring tick
    this.spawnPitchDropOsc(
      g,
      g.dryBus,
      'sine',
      t0 + 0.016 * stretch,
      0.052 * stretch,
      4850 * pScale * jitter,
      4420 * pScale * jitter,
      0.11,
    );
  }

  // ==========================================================================
  // 2. 3D Ejected Brass Shell Casing & 12G Shotgun Hull Bounces
  // ==========================================================================

  public playShellCasingBounce(
    caliber: ShellCasingCaliber,
    worldPos: Vec3Like,
    listenerPos: Vec3Like,
  ): void {
    this.casingBounceCount += 1;
    const g = this.ensureGraph();
    if (!g) {
      return;
    }

    const t0 = g.ctx.currentTime;
    const factors = computeSlowMoAudioFactors(this.timeScale);
    const pScale = factors.oscillatorPitchScale;
    const stretch = factors.envelopeStretch;

    const chain = g.createSpatialChain(
      worldPos,
      listenerPos,
      this.listenerYawDeg,
      this.pannerModel,
      this.reverbWetMix * 0.55,
      { refDistanceM: 1.0, maxDistanceM: 22.0, rolloffFactor: 1.35 },
    );

    const microVar = 0.975 + this.rng() * 0.05;

    if (caliber === 'BRASS') {
      // Crisp multi-harmonic metallic brass "ting-ting-tink" (3.8kHz + 6.2kHz + 9.1kHz damped sines)
      const bounceOffsets = [0, 0.062 * stretch, 0.118 * stretch];
      const bounceGains = [0.22, 0.13, 0.075];
      const spinSettlePitch = [1.0, 1.035, 1.075];
      const partialsHz = [3800, 6200, 9100];
      const partialWeights = [1.0, 0.68, 0.42];

      for (let b = 0; b < bounceOffsets.length; b++) {
        const tb = t0 + bounceOffsets[b];
        const bGain = bounceGains[b];
        const bPitch = spinSettlePitch[b] * microVar * pScale;
        const dur = (0.058 - b * 0.011) * stretch;

        for (let p = 0; p < partialsHz.length; p++) {
          const freq = clampNumber(partialsHz[p] * bPitch, 120, 19500);
          this.spawnPitchDropOsc(
            g,
            chain.input,
            'sine',
            tb,
            dur,
            freq,
            freq * 0.992,
            bGain * partialWeights[p],
            undefined,
            0.0006,
          );
        }
      }
      return;
    }

    // `SHOTGUN_HULL`: Hollow plastic PVC tube body bounce + subtle brass-rim clink
    const hullOffsets = [0, 0.082 * stretch];
    const hullGains = [0.26, 0.14];
    for (let b = 0; b < hullOffsets.length; b++) {
      const tb = t0 + hullOffsets[b];
      const amp = hullGains[b];
      // Hollow plastic hull tube resonance
      this.spawnNoiseBurst(
        g,
        chain.input,
        'WHITE',
        tb,
        0.044 * stretch,
        amp,
        'bandpass',
        710 * microVar,
        590 * microVar,
        6.2,
        1.0,
        0.001,
      );
      this.spawnPitchDropOsc(
        g,
        chain.input,
        'triangle',
        tb,
        0.038 * stretch,
        1160 * microVar * pScale,
        920 * microVar * pScale,
        amp * 0.48,
      );
      // Subtle brass base-cup clink
      this.spawnPitchDropOsc(
        g,
        chain.input,
        'sine',
        tb + 0.003,
        0.032 * stretch,
        4450 * microVar * pScale,
        4380 * microVar * pScale,
        amp * 0.25,
      );
    }
  }

  // ==========================================================================
  // 3. 3D Destructible Material Impacts, Shatters, Ricochets & Rubble Foley
  // ==========================================================================

  public playMaterialImpact(
    material: DestructibleMaterialKind,
    worldPos: Vec3Like,
    energyJ: number,
    listenerPos: Vec3Like,
  ): void {
    this.materialImpactCount += 1;
    const g = this.ensureGraph();
    if (!g) {
      return;
    }

    const t0 = g.ctx.currentTime;
    const factors = computeSlowMoAudioFactors(this.timeScale);
    const pScale = factors.oscillatorPitchScale;
    const stretch = factors.envelopeStretch;
    const eGain = computeImpactEnergyGain(energyJ);

    const chain = g.createSpatialChain(
      worldPos,
      listenerPos,
      this.listenerYawDeg,
      this.pannerModel,
      this.reverbWetMix,
      { refDistanceM: 1.8, maxDistanceM: 75.0, rolloffFactor: 1.1 },
    );

    if (material === 'GLASS_MARCHING_256' || material === 'GLASS_VORONOI') {
      // Shimmering multi-grain high-frequency crystalline shatter + cascading falling glass tinkles!
      const isPlateVoronoi = material === 'GLASS_VORONOI';
      this.spawnNoiseBurst(
        g,
        chain.input,
        'CRACKLE',
        t0,
        0.16 * stretch,
        0.52 * eGain,
        'highpass',
        isPlateVoronoi ? 2800 : 3600,
        4800,
        1.8,
        1.15,
        0.0008,
      );

      const crystalModes = isPlateVoronoi
        ? [2750, 4450, 6350, 8900]
        : [4250, 5900, 7850, 10400];
      for (let i = 0; i < crystalModes.length; i++) {
        const f = clampNumber(crystalModes[i] * pScale * (0.97 + this.rng() * 0.06), 180, 19500);
        this.spawnPitchDropOsc(
          g,
          chain.input,
          'sine',
          t0 + i * 0.004 * stretch,
          0.095 * stretch,
          f,
          f * 0.96,
          0.16 * eGain,
          undefined,
          0.0006,
        );
      }

      // Cascading falling glass shard tinkles on floor
      const shardCount = 5;
      for (let s = 0; s < shardCount; s++) {
        const delayS = (0.055 + s * 0.064 + this.rng() * 0.025) * stretch;
        const shardFreq = clampNumber(
          (5100 + s * 920 + this.rng() * 750) * pScale,
          250,
          19500,
        );
        const shardAmp = (0.13 - s * 0.018) * eGain;
        this.spawnPitchDropOsc(
          g,
          chain.input,
          'sine',
          t0 + delayS,
          0.048 * stretch,
          shardFreq,
          shardFreq * 1.02,
          Math.max(0.02, shardAmp),
          undefined,
          0.0005,
        );
      }
      return;
    }

    if (material === 'WOOD_DRYWALL' || material === 'WOOD_STUD') {
      // Dry fibrous wood crack/rip + splinter scatter
      const isStud = material === 'WOOD_STUD';
      this.spawnPitchDropOsc(
        g,
        chain.input,
        'triangle',
        t0,
        0.09 * stretch,
        (isStud ? 390 : 215) * pScale,
        (isStud ? 95 : 68) * pScale,
        0.48 * eGain,
        g.warmDriveCurve,
      );
      this.spawnNoiseBurst(
        g,
        chain.input,
        'CRACKLE',
        t0,
        0.13 * stretch,
        0.54 * eGain,
        'bandpass',
        isStud ? 1680 : 1150,
        isStud ? 740 : 520,
        2.4,
        1.0,
        0.001,
      );

      // Staccato splinter scatter
      for (let s = 0; s < 3; s++) {
        const ts = t0 + (0.042 + s * 0.052) * stretch;
        this.spawnNoiseBurst(
          g,
          chain.input,
          'CRACKLE',
          ts,
          0.036 * stretch,
          (0.18 - s * 0.04) * eGain,
          'bandpass',
          2450 + s * 380,
          1800,
          3.8,
          1.12,
          0.001,
        );
      }
      return;
    }

    if (
      material === 'BRICK_MASONRY' ||
      material === 'CONCRETE_CHUNKS' ||
      material === 'CONCRETE_INTACT'
    ) {
      // Gritty rock/concrete thud + supersonic ricochet whine (1.8kHz -> 700Hz) + tumbling rubble clatter!
      this.spawnPitchDropOsc(
        g,
        chain.input,
        'sine',
        t0,
        0.12 * stretch,
        118 * pScale,
        44 * pScale,
        0.56 * eGain,
        g.warmDriveCurve,
      );
      this.spawnNoiseBurst(
        g,
        chain.input,
        'PINK',
        t0,
        0.15 * stretch,
        0.52 * eGain,
        'bandpass',
        1250,
        420,
        1.5,
        0.95,
        0.001,
      );

      // Supersonic ricochet whine: 1.8kHz -> 700Hz pitch sweep
      const ricochetAmp =
        material === 'CONCRETE_INTACT' ? 0.24 * eGain : 0.16 * eGain;
      this.spawnPitchDropOsc(
        g,
        chain.input,
        'sine',
        t0 + 0.006 * stretch,
        0.19 * stretch,
        1800 * pScale,
        700 * pScale,
        ricochetAmp,
        undefined,
        0.004,
      );

      // Tumbling rubble clatter when chunks/bricks detach
      if (
        material === 'BRICK_MASONRY' ||
        material === 'CONCRETE_CHUNKS' ||
        energyJ >= 400
      ) {
        for (let r = 0; r < 3; r++) {
          const tr = t0 + (0.075 + r * 0.078) * stretch;
          const rubbleFreq = (320 - r * 45 + this.rng() * 70) * pScale;
          this.spawnPitchDropOsc(
            g,
            chain.input,
            'triangle',
            tr,
            0.055 * stretch,
            rubbleFreq,
            rubbleFreq * 0.55,
            (0.20 - r * 0.045) * eGain,
          );
          this.spawnNoiseBurst(
            g,
            chain.input,
            'CRACKLE',
            tr,
            0.048 * stretch,
            (0.16 - r * 0.035) * eGain,
            'bandpass',
            920,
            480,
            2.2,
            0.9,
          );
        }
      }
      return;
    }

    // `STEEL`: Sharp metallic CLANG + ricochet zing!
    const steelPartials = [880, 1765, 2940, 4780];
    const steelWeights = [0.34, 0.28, 0.22, 0.15];
    for (let i = 0; i < steelPartials.length; i++) {
      const f = clampNumber(steelPartials[i] * pScale, 120, 19500);
      this.spawnPitchDropOsc(
        g,
        chain.input,
        i === 0 ? 'triangle' : 'sine',
        t0,
        0.28 * stretch,
        f,
        f * 0.985,
        steelWeights[i] * eGain,
        undefined,
        0.0006,
      );
    }
    this.spawnNoiseBurst(
      g,
      chain.input,
      'WHITE',
      t0,
      0.045 * stretch,
      0.46 * eGain,
      'highpass',
      2400,
      1800,
      2.0,
      1.2,
      0.0005,
    );
    // High-velocity steel ricochet zing
    this.spawnPitchDropOsc(
      g,
      chain.input,
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

  // ==========================================================================
  // 4. Visceral GHOUL / Sniper Elite Gore Foley & Formant Vocal Trauma Cues
  // ==========================================================================

  public playGoreImpact(
    kind: GoreImpactAudioKind,
    worldPos: Vec3Like,
    listenerPos: Vec3Like,
  ): void {
    this.goreImpactCount += 1;
    const g = this.ensureGraph();
    if (!g) {
      return;
    }

    const t0 = g.ctx.currentTime;
    const factors = computeSlowMoAudioFactors(this.timeScale);
    const pScale = factors.oscillatorPitchScale;
    const stretch = factors.envelopeStretch;

    const chain = g.createSpatialChain(
      worldPos,
      listenerPos,
      this.listenerYawDeg,
      this.pannerModel,
      this.reverbWetMix * 0.65,
      { refDistanceM: 1.6, maxDistanceM: 65.0, rolloffFactor: 1.1 },
    );

    switch (kind) {
      case 'FLESH_HIT': {
        // Wet meaty Soldier of Fortune thwack
        this.spawnPitchDropOsc(
          g,
          chain.input,
          'sine',
          t0,
          0.11 * stretch,
          148 * pScale,
          50 * pScale,
          0.62,
          g.warmDriveCurve,
        );
        this.spawnNoiseBurst(
          g,
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
        this.maybeTriggerAutoVocalCue('PAIN_GRUNT', worldPos, listenerPos, t0);
        break;
      }

      case 'ARMOR_SPARK': {
        // Kevlar/ceramic blunt plate thud + metallic spark zip
        this.spawnPitchDropOsc(
          g,
          chain.input,
          'triangle',
          t0,
          0.085 * stretch,
          172 * pScale,
          68 * pScale,
          0.54,
        );
        this.spawnNoiseBurst(
          g,
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
        this.spawnPitchDropOsc(
          g,
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
        // Meaty impact + crisp Sniper Elite cortical bone snap/crunch!
        this.spawnPitchDropOsc(
          g,
          chain.input,
          'sine',
          t0,
          0.10 * stretch,
          135 * pScale,
          46 * pScale,
          0.58,
          g.warmDriveCurve,
        );
        const crackFreqs = [1780, 2680, 3550];
        for (let c = 0; c < crackFreqs.length; c++) {
          const tc = t0 + c * 0.017 * stretch;
          this.spawnNoiseBurst(
            g,
            chain.input,
            'CRACKLE',
            tc,
            0.042 * stretch,
            0.52 - c * 0.1,
            'bandpass',
            crackFreqs[c],
            crackFreqs[c] * 0.65,
            4.5,
            1.1,
            0.0005,
          );
          this.spawnPitchDropOsc(
            g,
            chain.input,
            'triangle',
            tc,
            0.028 * stretch,
            crackFreqs[c] * pScale,
            crackFreqs[c] * 0.55 * pScale,
            0.24,
          );
        }
        this.maybeTriggerAutoVocalCue('SHARP_GASP', worldPos, listenerPos, t0);
        break;
      }

      case 'CRANIAL_POP': {
        // Explosive wet cranial pop: hollow skull crack + pressurized wet rupture + splatter droplets
        this.spawnPitchDropOsc(
          g,
          chain.input,
          'sine',
          t0,
          0.14 * stretch,
          112 * pScale,
          36 * pScale,
          0.74,
          g.heavyDriveCurve,
        );
        // Brittle skull snap
        this.spawnNoiseBurst(
          g,
          chain.input,
          'CRACKLE',
          t0,
          0.05 * stretch,
          0.65,
          'bandpass',
          2350,
          1200,
          3.8,
          1.15,
          0.0005,
        );
        // Pressurized wet melon pop sweep
        this.spawnPitchDropOsc(
          g,
          chain.input,
          'sine',
          t0 + 0.008 * stretch,
          0.11 * stretch,
          560 * pScale,
          1850 * pScale,
          0.36,
          undefined,
          0.004,
        );
        this.spawnNoiseBurst(
          g,
          chain.input,
          'PINK',
          t0 + 0.01 * stretch,
          0.20 * stretch,
          0.62,
          'bandpass',
          1450,
          310,
          3.2,
          0.9,
          0.003,
        );
        // Cascading wet splatter droplets
        for (let d = 0; d < 4; d++) {
          const td = t0 + (0.055 + d * 0.048) * stretch;
          this.spawnNoiseBurst(
            g,
            chain.input,
            'PINK',
            td,
            0.038 * stretch,
            0.22 - d * 0.04,
            'bandpass',
            980 + d * 240,
            440,
            5.0,
            1.05,
            0.002,
          );
        }
        break;
      }

      case 'LIMB_SEVER': {
        // Heavy tendon/bone cleaving rip + wet separation
        this.spawnPitchDropOsc(
          g,
          chain.input,
          'triangle',
          t0,
          0.15 * stretch,
          128 * pScale,
          40 * pScale,
          0.68,
          g.heavyDriveCurve,
        );
        this.spawnNoiseBurst(
          g,
          chain.input,
          'CRACKLE',
          t0,
          0.18 * stretch,
          0.60,
          'bandpass',
          1950,
          520,
          2.8,
          0.92,
          0.001,
        );
        this.spawnNoiseBurst(
          g,
          chain.input,
          'PINK',
          t0 + 0.03 * stretch,
          0.22 * stretch,
          0.46,
          'bandpass',
          1350,
          380,
          4.0,
          0.88,
          0.004,
        );
        this.maybeTriggerAutoVocalCue('SHARP_GASP', worldPos, listenerPos, t0);
        break;
      }

      case 'ARTERIAL_SPURT': {
        // Pulsatile pressurized wet arterial fluid squirt bursts
        for (let p = 0; p < 3; p++) {
          const tp = t0 + p * 0.105 * stretch;
          this.spawnNoiseBurst(
            g,
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
        this.maybeTriggerAutoVocalCue(
          'WET_HEMOTHORAX_COUGH',
          worldPos,
          listenerPos,
          t0,
        );
        break;
      }
    }
  }

  private maybeTriggerAutoVocalCue(
    cue: VocalTraumaCueKind,
    worldPos: Vec3Like,
    listenerPos: Vec3Like,
    now: number,
  ): void {
    // Throttle automatic layered vocal cues so full-auto bursts stay punchy & realistic
    if (now - this.lastVocalCueTime < 0.28) {
      return;
    }
    this.playVocalTraumaCue(cue, worldPos, listenerPos);
  }

  /**
   * Synthesizes subtle formant-filtered vocal pain, sharp inspiratory gasp,
   * or wet hemothorax cough cues (`F1` & `F2` vocal tract bandpass resonances).
   */
  public playVocalTraumaCue(
    cue: VocalTraumaCueKind,
    worldPos?: Vec3Like,
    listenerPos?: Vec3Like,
  ): void {
    this.vocalCueCount += 1;
    const g = this.ensureGraph();
    if (!g) {
      return;
    }

    const t0 = g.ctx.currentTime;
    this.lastVocalCueTime = t0;
    const factors = computeSlowMoAudioFactors(this.timeScale);
    const pScale = factors.oscillatorPitchScale;
    const stretch = factors.envelopeStretch;

    const targetBus: AudioNodeLike =
      worldPos && listenerPos
        ? g.createSpatialChain(
            worldPos,
            listenerPos,
            this.listenerYawDeg,
            this.pannerModel,
            this.reverbWetMix * 0.6,
            { refDistanceM: 1.8, maxDistanceM: 45.0, rolloffFactor: 1.2 },
          ).input
        : g.dryBus;

    if (cue === 'SHARP_GASP') {
      // Sudden inspiratory vocal-tract intake (F1 ~720Hz, F2 ~1580Hz)
      this.spawnNoiseBurst(
        g,
        targetBus,
        'WHITE',
        t0 + 0.015 * stretch,
        0.16 * stretch,
        0.16,
        'bandpass',
        720,
        840,
        5.5,
        0.95,
        0.018,
      );
      this.spawnNoiseBurst(
        g,
        targetBus,
        'WHITE',
        t0 + 0.015 * stretch,
        0.15 * stretch,
        0.11,
        'bandpass',
        1580,
        1760,
        6.5,
        0.95,
        0.018,
      );
      this.spawnPitchDropOsc(
        g,
        targetBus,
        'sawtooth',
        t0 + 0.02 * stretch,
        0.12 * stretch,
        145 * pScale,
        192 * pScale,
        0.065,
        undefined,
        0.02,
      );
      return;
    }

    if (cue === 'WET_HEMOTHORAX_COUGH') {
      // Double ragged chesty formant bark + bubbling wet noise
      for (let c = 0; c < 2; c++) {
        const tc = t0 + (0.02 + c * 0.135) * stretch;
        const dur = (0.11 - c * 0.015) * stretch;
        this.spawnNoiseBurst(
          g,
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
        this.spawnNoiseBurst(
          g,
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
        this.spawnPitchDropOsc(
          g,
          targetBus,
          'sawtooth',
          tc,
          dur * 0.85,
          122 * pScale,
          86 * pScale,
          0.08,
          undefined,
          0.005,
        );
      }
      return;
    }

    // `PAIN_GRUNT`: Tense low glottal pitch drop through pharyngeal formant filter
    const glottal = g.createOscillator();
    glottal.type = 'sawtooth';
    glottal.frequency.setValueAtTime(142 * pScale, t0 + 0.015 * stretch);
    glottal.frequency.exponentialRampToValueAtTime(96 * pScale, t0 + 0.19 * stretch);

    const formant1 = g.createBiquadFilter();
    formant1.type = 'bandpass';
    formant1.frequency.setValueAtTime(590 * factors.lowpassScale, t0);
    formant1.Q.setValueAtTime(4.8, t0);

    const gruntEnv = g.createGain();
    gruntEnv.gain.setValueAtTime(0.0001, t0 + 0.015 * stretch);
    gruntEnv.gain.linearRampToValueAtTime(0.14, t0 + 0.038 * stretch);
    gruntEnv.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.20 * stretch);

    glottal.connect(formant1);
    formant1.connect(gruntEnv);
    gruntEnv.connect(targetBus);

    glottal.start(t0 + 0.015 * stretch);
    glottal.stop(t0 + 0.21 * stretch);
  }

  // ==========================================================================
  // 5. Catastrophic 3D Explosions (28Hz-90Hz Sub Shockwave + <=4.5m Tinnitus!)
  // ==========================================================================

  public playExplosion(
    worldPos: Vec3Like,
    listenerPos: Vec3Like,
    intensity: number,
  ): void {
    this.explosionCount += 1;
    if (!Number.isFinite(intensity) || intensity <= 0) {
      return;
    }

    const distM = Math.hypot(
      worldPos.x - listenerPos.x,
      worldPos.y - listenerPos.y,
      worldPos.z - listenerPos.z,
    );
    const triggersTinnitus = distM <= TINNITUS_PROXIMITY_RADIUS_M;
    if (triggersTinnitus) {
      this.tinnitusTriggerCount += 1;
    }

    const g = this.ensureGraph();
    if (!g) {
      return;
    }

    const t0 = g.ctx.currentTime;
    const factors = computeSlowMoAudioFactors(this.timeScale);
    const pScale = factors.oscillatorPitchScale;
    const stretch = factors.envelopeStretch;
    const clampedIntensity = clampNumber(intensity, 0.15, 2.5);

    const chain = g.createSpatialChain(
      worldPos,
      listenerPos,
      this.listenerYawDeg,
      this.pannerModel,
      Math.min(1.0, this.reverbWetMix * 1.45),
      {
        refDistanceM: 3.2,
        maxDistanceM: 120.0,
        rolloffFactor: 0.9,
        baseReverbWet: 0.32,
        maxReverbWet: 0.78,
      },
    );

    // Layer 1: Massive 28Hz–90Hz saturating sub-bass shockwave boom!
    const subStartHz = clampNumber(90 * pScale, 24, 140);
    const subEndHz = clampNumber(28 * pScale, 18, 80);
    this.spawnPitchDropOsc(
      g,
      chain.input,
      'sine',
      t0,
      0.88 * stretch,
      subStartHz,
      subEndHz,
      0.95 * clampedIntensity,
      g.heavyDriveCurve,
      0.003,
    );
    this.spawnPitchDropOsc(
      g,
      chain.input,
      'triangle',
      t0,
      0.46 * stretch,
      78 * pScale,
      32 * pScale,
      0.62 * clampedIntensity,
      g.warmDriveCurve,
      0.002,
    );

    // Layer 2: Supersonic detonation crack + roaring fireball lowpass sweep
    this.spawnNoiseBurst(
      g,
      chain.input,
      'WHITE',
      t0,
      0.14 * stretch,
      0.88 * clampedIntensity,
      'lowpass',
      7500,
      900,
      1.4,
      1.0,
      0.0008,
    );
    this.spawnNoiseBurst(
      g,
      chain.input,
      'PINK',
      t0 + 0.01,
      1.05 * stretch,
      0.82 * clampedIntensity,
      'lowpass',
      2400,
      130,
      0.9,
      0.78,
      0.008,
    );

    // Layer 3: Debris crackle & cascading shrapnel scatter
    this.spawnNoiseBurst(
      g,
      chain.input,
      'CRACKLE',
      t0 + 0.08 * stretch,
      0.92 * stretch,
      0.48 * clampedIntensity,
      'bandpass',
      1850,
      540,
      1.6,
      0.9,
      0.02,
    );

    // Layer 4: Short atmospheric high-pitched tinnitus ring when player is within 4.5m!
    if (triggersTinnitus) {
      const proximityFactor = clampNumber(
        1.0 - distM / TINNITUS_PROXIMITY_RADIUS_M,
        0.18,
        1.0,
      );
      const ringOsc = g.createOscillator();
      ringOsc.type = 'sine';
      ringOsc.frequency.setValueAtTime(3960, t0 + 0.02);

      const ringGain = g.createGain();
      const peakRing = 0.075 * proximityFactor * Math.min(1.25, clampedIntensity);
      ringGain.gain.setValueAtTime(0.0001, t0 + 0.02);
      ringGain.gain.linearRampToValueAtTime(peakRing, t0 + 0.08);
      ringGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.45);

      ringOsc.connect(ringGain);
      ringGain.connect(g.dryBus);
      ringOsc.start(t0 + 0.02);
      ringOsc.stop(t0 + 1.48);
    }
  }

  // ==========================================================================
  // 6. Iconic F.E.A.R. / Max Payne Reflex Slow-Mo Time-Warp & Heartbeat
  // ==========================================================================

  public playSlowMoTransition(entering: boolean): void {
    this.slowMoTransitionCount += 1;
    this.slowMoActive = entering;

    const g = this.ensureGraph();
    if (!g) {
      return;
    }

    const t0 = g.ctx.currentTime;

    if (entering) {
      // Downward bass time-warp dive (160Hz -> 29Hz) + resonant vacuum whoosh
      this.spawnPitchDropOsc(
        g,
        g.dryBus,
        'sine',
        t0,
        0.52,
        160,
        29,
        0.72,
        g.warmDriveCurve,
        0.008,
      );
      this.spawnNoiseBurst(
        g,
        g.dryBus,
        'PINK',
        t0,
        0.48,
        0.44,
        'bandpass',
        2450,
        165,
        3.8,
        0.85,
        0.015,
      );

      // Cancel any previous heartbeat bus cleanly and schedule deep Reflex cardiac lub-dub thumps
      this.stopHeartbeatBus(g, t0);
      const hbBus = g.createGain();
      hbBus.gain.setValueAtTime(0.85, t0);
      hbBus.connect(g.dryBus);
      this.heartbeatBus = hbBus;

      const cyclesToPreSchedule = 6;
      for (let c = 0; c < cyclesToPreSchedule; c++) {
        this.scheduleHeartbeatPair(g, hbBus, t0 + 0.20 + c * 0.92);
      }
      this.heartbeatNextScheduleTime = t0 + 0.20 + cyclesToPreSchedule * 0.92;
      return;
    }

    // Exiting Reflex slow-motion: stop heartbeat & fire upward snap-back warp whoosh!
    this.stopHeartbeatBus(g, t0);

    this.spawnPitchDropOsc(
      g,
      g.dryBus,
      'sine',
      t0,
      0.34,
      32,
      178,
      0.58,
      g.warmDriveCurve,
      0.006,
    );
    this.spawnNoiseBurst(
      g,
      g.dryBus,
      'PINK',
      t0,
      0.32,
      0.38,
      'bandpass',
      210,
      2950,
      3.4,
      1.1,
      0.01,
    );
  }

  private scheduleHeartbeatPair(
    g: InternalAudioGraph,
    hbBus: GainNodeLike,
    beatTime: number,
  ): void {
    // "Lub" (systolic ventricular contraction: 54Hz -> 33Hz)
    this.spawnPitchDropOsc(
      g,
      hbBus,
      'sine',
      beatTime,
      0.13,
      54,
      33,
      0.42,
      g.warmDriveCurve,
      0.008,
    );
    // "Dub" (aortic/pulmonary valve closure: 48Hz -> 29Hz, 210ms later)
    this.spawnPitchDropOsc(
      g,
      hbBus,
      'sine',
      beatTime + 0.21,
      0.11,
      48,
      29,
      0.30,
      g.warmDriveCurve,
      0.006,
    );
  }

  private stopHeartbeatBus(g: InternalAudioGraph, now: number): void {
    if (!this.heartbeatBus) {
      return;
    }
    const oldBus = this.heartbeatBus;
    this.heartbeatBus = null;
    oldBus.gain.cancelScheduledValues(now);
    oldBus.gain.setValueAtTime(Math.max(0.0001, oldBus.gain.value), now);
    oldBus.gain.exponentialRampToValueAtTime(0.0001, now + 0.055);
  }

  public destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.slowMoActive = false;

    if (this.gestureCleanup) {
      this.gestureCleanup();
      this.gestureCleanup = null;
    }

    if (this.graph) {
      this.stopHeartbeatBus(this.graph, this.graph.ctx.currentTime);
      void this.graph.ctx.close().catch(() => {
        // Ignore close errors during teardown
      });
      this.graph = null;
    }

    this.activeSources.length = 0;
    this.activeOscillators.length = 0;
  }
}
