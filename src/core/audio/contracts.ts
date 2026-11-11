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
