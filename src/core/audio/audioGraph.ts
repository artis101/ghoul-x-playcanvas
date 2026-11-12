import type { Vec3Like } from '../../contracts/ballistics.ts';
import type {
  AudioBufferLike,
  AudioContextLike,
  AudioNodeLike,
  AudioParamLike,
  BiquadFilterNodeLike,
  DynamicsCompressorNodeLike,
  GainNodeLike,
  OscillatorNodeLike,
  WaveShaperNodeLike,
} from './contracts.ts';
import type { SpatialCalcOptions } from './types.ts';
import { clampNumber } from './audioMath.ts';
import { createMasterLimiterCurve, createSoftClipCurve } from './dspCurves.ts';
import { synthesizeWarehouseImpulseResponse } from './reverbSynth.ts';
import { createPrebakedNoiseBuffers } from './noiseGenerators.ts';
import { buildSpatialChain, setListenerCoordinates, type SpatialChain } from './spatialChain.ts';

export type { SpatialChain };

const LIMITER_HEADROOM_RANGE = 4.0;

function lockStereoBus(node: AudioNodeLike): void {
  try {
    node.channelCount = 2;
    node.channelCountMode = 'explicit';
    node.channelInterpretation = 'speakers';
  } catch {
    // Ignore on minimal headless mock nodes or fixed-channel nodes
  }
}

function configureDestinationStereo(dest: AudioNodeLike): void {
  try {
    if (typeof dest.maxChannelCount === 'number' && dest.maxChannelCount >= 2) {
      dest.channelCount = 2;
      dest.channelCountMode = 'explicit';
      dest.channelInterpretation = 'speakers';
    }
  } catch {
    // Hardware destination may lock channelCount on some platforms
  }
}

export interface InternalAudioGraph {
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

export function createInternalAudioGraph<TBuffer extends AudioBufferLike>(
  ctx: AudioContextLike<TBuffer>,
  initialMasterVolume: number,
  initialReverbWetMix: number,
  rng: () => number,
  onChainCreated?: (nodes: readonly AudioNodeLike[], endTime: number) => void,
): InternalAudioGraph {
  const sr = Math.max(8000, ctx.sampleRate || 44100);
  let lastListenerPitchDeg = 0;

  configureDestinationStereo(ctx.destination);

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -8.0;
  compressor.knee.value = 12.0;
  compressor.ratio.value = 12.0;
  compressor.attack.value = 0.0005;
  compressor.release.value = 0.12;
  lockStereoBus(compressor);

  const masterGain = ctx.createGain();
  masterGain.gain.value = clampNumber(initialMasterVolume, 0, 2.0);
  lockStereoBus(masterGain);

  // Transparent brickwall soft-limiter stage prevents sub-millisecond transients
  // and multi-pellet bursts from ever hard-clipping [-1, +1] at ctx.destination
  const preLimiterGain = ctx.createGain();
  preLimiterGain.gain.value = 1.0 / LIMITER_HEADROOM_RANGE;
  lockStereoBus(preLimiterGain);

  const masterLimiter = ctx.createWaveShaper();
  masterLimiter.curve = createMasterLimiterCurve(LIMITER_HEADROOM_RANGE, 0.65, 0.97, 1025);
  masterLimiter.oversample = 'none';
  lockStereoBus(masterLimiter);

  const dryBus = ctx.createGain();
  dryBus.gain.value = 0.68;
  lockStereoBus(dryBus);

  const reverbSendBus = ctx.createGain();
  reverbSendBus.gain.value = 1.0;
  lockStereoBus(reverbSendBus);

  const reverbReturnGain = ctx.createGain();
  reverbReturnGain.gain.value = clampNumber(initialReverbWetMix * 0.72, 0, 0.9);
  lockStereoBus(reverbReturnGain);

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
  masterGain.connect(preLimiterGain);
  preLimiterGain.connect(masterLimiter);
  masterLimiter.connect(ctx.destination);

  const { whiteBuf, pinkBuf, crackleBuf } = createPrebakedNoiseBuffers(ctx);

  const warmDriveCurve = createSoftClipCurve(2.2, 512);
  const heavyDriveCurve = createSoftClipCurve(4.2, 512);

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
      const buf = kind === 'WHITE' ? whiteBuf : kind === 'PINK' ? pinkBuf : crackleBuf;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = loop;
      src.playbackRate.value = Math.max(0.04, playbackRate);
      return { source: src, bufferDuration: buf.duration };
    },
    updateListener: (pos, yaw, pitch) => {
      lastListenerPitchDeg = pitch;
      setListenerCoordinates(ctx, pos, yaw, pitch);
    },
    createSpatialChain: (wPos, lPos, lYaw, pModel, rMix, opts) => {
      void rng;
      const chain = buildSpatialChain(
        ctx as unknown as AudioContextLike,
        dryBus,
        reverbSendBus,
        wPos,
        lPos,
        lYaw,
        pModel,
        rMix,
        opts,
        lastListenerPitchDeg,
      );
      onChainCreated?.(chain.nodes, ctx.currentTime + 4.8);
      return chain;
    },
  };
}
