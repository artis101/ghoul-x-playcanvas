import { describe, it, expect } from 'vitest';
import {
  CombatAudioEngine,
  TINNITUS_PROXIMITY_RADIUS_M,
  computeSpatialAudioParams,
  createMasterLimiterCurve,
  createSoftClipCurve,
  synthesizeWarehouseImpulseResponse,
  computeImpactEnergyGain,
  type AudioParamLike,
  type AudioNodeLike,
  type GainNodeLike,
  type OscillatorNodeLike,
  type BiquadFilterNodeLike,
  type AudioBufferLike,
  type AudioBufferSourceNodeLike,
  type ConvolverNodeLike,
  type DynamicsCompressorNodeLike,
  type PannerNodeLike,
  type WaveShaperNodeLike,
  type AudioListenerLike,
  type AudioContextLike,
  type GoreImpactAudioKind,
  type VocalTraumaCueKind,
} from '../src/engine/audio/combatAudioEngine.ts';
import type { DestructibleMaterialKind } from '../src/contracts/destruction.ts';

// ============================================================================
// Lightweight Strictly-Typed Mock WebAudio Graph (Zero `any`)
// ============================================================================

interface ParamAutomationEvent {
  readonly kind: 'setValue' | 'linearRamp' | 'expRamp' | 'setTarget' | 'cancel';
  readonly value: number;
  readonly time: number;
  readonly timeConstant?: number;
}

class MockAudioParam implements AudioParamLike {
  public value: number;
  public readonly events: ParamAutomationEvent[] = [];

  constructor(initialValue = 0) {
    this.value = initialValue;
  }

  public setValueAtTime(value: number, startTime: number): AudioParamLike {
    this.value = value;
    this.events.push({ kind: 'setValue', value, time: startTime });
    return this;
  }

  public linearRampToValueAtTime(value: number, endTime: number): AudioParamLike {
    this.value = value;
    this.events.push({ kind: 'linearRamp', value, time: endTime });
    return this;
  }

  public exponentialRampToValueAtTime(value: number, endTime: number): AudioParamLike {
    this.value = value;
    this.events.push({ kind: 'expRamp', value, time: endTime });
    return this;
  }

  public setTargetAtTime(
    target: number,
    startTime: number,
    timeConstant: number,
  ): AudioParamLike {
    this.value = target;
    this.events.push({
      kind: 'setTarget',
      value: target,
      time: startTime,
      timeConstant,
    });
    return this;
  }

  public cancelScheduledValues(startTime: number): AudioParamLike {
    this.events.push({ kind: 'cancel', value: this.value, time: startTime });
    return this;
  }
}

class MockAudioNode implements AudioNodeLike {
  public channelCount?: number;
  public channelCountMode?: ChannelCountMode;
  public channelInterpretation?: ChannelInterpretation;
  public maxChannelCount?: number;
  public readonly connections: AudioNodeLike[] = [];
  public disconnected = false;

  public connect(destinationNode: AudioNodeLike): AudioNodeLike {
    this.connections.push(destinationNode);
    return destinationNode;
  }

  public disconnect(): void {
    this.disconnected = true;
    this.connections.length = 0;
  }
}

class MockGainNode extends MockAudioNode implements GainNodeLike {
  public readonly gain = new MockAudioParam(1.0);
}

class MockOscillatorNode extends MockAudioNode implements OscillatorNodeLike {
  public type: OscillatorType = 'sine';
  public readonly frequency = new MockAudioParam(440);
  public readonly detune = new MockAudioParam(0);
  public startTime: number | null = null;
  public stopTime: number | null = null;

  public start(when = 0): void {
    this.startTime = when;
  }

  public stop(when = 0): void {
    this.stopTime = when;
  }
}

class MockBiquadFilterNode extends MockAudioNode implements BiquadFilterNodeLike {
  public type: BiquadFilterType = 'lowpass';
  public readonly frequency = new MockAudioParam(350);
  public readonly Q = new MockAudioParam(1);
  public readonly gain = new MockAudioParam(0);
}

class MockAudioBuffer implements AudioBufferLike {
  public readonly sampleRate: number;
  public readonly length: number;
  public readonly duration: number;
  public readonly numberOfChannels: number;
  private readonly channels: Float32Array[];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channels = Array.from(
      { length: numberOfChannels },
      () => new Float32Array(length),
    );
  }

  public getChannelData(channel: number): Float32Array {
    const ch = this.channels[channel];
    if (!ch) {
      throw new RangeError(`Invalid channel index ${channel}`);
    }
    return ch;
  }
}

class MockAudioBufferSourceNode
  extends MockAudioNode
  implements AudioBufferSourceNodeLike<MockAudioBuffer>
{
  public buffer: MockAudioBuffer | null = null;
  public loop = false;
  public readonly playbackRate = new MockAudioParam(1.0);
  public startTime: number | null = null;
  public startOffset = 0;
  public stopTime: number | null = null;

  public start(when = 0, offset = 0): void {
    this.startTime = when;
    this.startOffset = offset;
  }

  public stop(when = 0): void {
    this.stopTime = when;
  }
}

class MockConvolverNode
  extends MockAudioNode
  implements ConvolverNodeLike<MockAudioBuffer>
{
  public buffer: MockAudioBuffer | null = null;
  public normalize = true;
}

class MockDynamicsCompressorNode
  extends MockAudioNode
  implements DynamicsCompressorNodeLike
{
  public readonly threshold = new MockAudioParam(-24);
  public readonly knee = new MockAudioParam(30);
  public readonly ratio = new MockAudioParam(12);
  public readonly attack = new MockAudioParam(0.003);
  public readonly release = new MockAudioParam(0.25);
}

class MockPannerNode extends MockAudioNode implements PannerNodeLike {
  private _panningModel: PanningModelType = 'equalpower';
  private readonly rejectHrtf: boolean;

  public distanceModel: DistanceModelType = 'inverse';
  public refDistance = 1;
  public maxDistance = 10000;
  public rolloffFactor = 1;
  public coneInnerAngle = 360;
  public coneOuterAngle = 360;
  public coneOuterGain = 0;
  public readonly positionX = new MockAudioParam(0);
  public readonly positionY = new MockAudioParam(0);
  public readonly positionZ = new MockAudioParam(0);

  constructor(rejectHrtf = false) {
    super();
    this.rejectHrtf = rejectHrtf;
  }

  public get panningModel(): PanningModelType {
    return this._panningModel;
  }

  public set panningModel(val: PanningModelType) {
    if (this.rejectHrtf && val === 'HRTF') {
      throw new Error('HRTF unsupported on mock device');
    }
    this._panningModel = val;
  }
}

class MockWaveShaperNode extends MockAudioNode implements WaveShaperNodeLike {
  public curve: Float32Array | null = null;
  public oversample: OverSampleType = 'none';
}

class MockAudioListener implements AudioListenerLike {
  public readonly positionX = new MockAudioParam(0);
  public readonly positionY = new MockAudioParam(0);
  public readonly positionZ = new MockAudioParam(0);
  public readonly forwardX = new MockAudioParam(0);
  public readonly forwardY = new MockAudioParam(0);
  public readonly forwardZ = new MockAudioParam(-1);
  public readonly upX = new MockAudioParam(0);
  public readonly upY = new MockAudioParam(1);
  public readonly upZ = new MockAudioParam(0);
}

class MockAudioContext implements AudioContextLike<MockAudioBuffer> {
  public state: AudioContextState;
  public currentTime = 0;
  public readonly sampleRate: number;
  public readonly destination = new MockAudioNode();
  public readonly listener = new MockAudioListener();

  public resumeCalls = 0;
  public closeCalls = 0;
  public rejectHrtfOnPanner = false;

  public readonly gains: MockGainNode[] = [];
  public readonly oscillators: MockOscillatorNode[] = [];
  public readonly filters: MockBiquadFilterNode[] = [];
  public readonly buffers: MockAudioBuffer[] = [];
  public readonly bufferSources: MockAudioBufferSourceNode[] = [];
  public readonly convolvers: MockConvolverNode[] = [];
  public readonly compressors: MockDynamicsCompressorNode[] = [];
  public readonly panners: MockPannerNode[] = [];
  public readonly waveShapers: MockWaveShaperNode[] = [];

  constructor(initialState: AudioContextState = 'running', sampleRate = 22050) {
    this.state = initialState;
    this.sampleRate = sampleRate;
    this.destination.maxChannelCount = 6;
  }

  public async resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.state === 'suspended') {
      this.state = 'running';
    }
  }

  public async close(): Promise<void> {
    this.closeCalls += 1;
    this.state = 'closed';
  }

  public createGain(): GainNodeLike {
    const node = new MockGainNode();
    this.gains.push(node);
    return node;
  }

  public createOscillator(): OscillatorNodeLike {
    const node = new MockOscillatorNode();
    this.oscillators.push(node);
    return node;
  }

  public createBiquadFilter(): BiquadFilterNodeLike {
    const node = new MockBiquadFilterNode();
    this.filters.push(node);
    return node;
  }

  public createBuffer(
    numberOfChannels: number,
    length: number,
    sampleRate: number,
  ): MockAudioBuffer {
    const buf = new MockAudioBuffer(numberOfChannels, length, sampleRate);
    this.buffers.push(buf);
    return buf;
  }

  public createBufferSource(): AudioBufferSourceNodeLike<MockAudioBuffer> {
    const src = new MockAudioBufferSourceNode();
    this.bufferSources.push(src);
    return src;
  }

  public createConvolver(): ConvolverNodeLike<MockAudioBuffer> {
    const conv = new MockConvolverNode();
    this.convolvers.push(conv);
    return conv;
  }

  public createDynamicsCompressor(): DynamicsCompressorNodeLike {
    const comp = new MockDynamicsCompressorNode();
    this.compressors.push(comp);
    return comp;
  }

  public createPanner(): PannerNodeLike {
    const panner = new MockPannerNode(this.rejectHrtfOnPanner);
    this.panners.push(panner);
    return panner;
  }

  public createWaveShaper(): WaveShaperNodeLike {
    const shaper = new MockWaveShaperNode();
    this.waveShapers.push(shaper);
    return shaper;
  }
}

// ============================================================================
// Test Suites
// ============================================================================

describe('AAA 3D Spatial Combat, Destruction & Gore WebAudio Engine', () => {
  describe('1. Parameter Curves & 3D Spatial Attenuation/Panning Math', () => {
    it('computes 3D distance attenuation, air-absorption filtering, warehouse wet send, and yaw-aware stereo pan', () => {
      const listener = { x: 0, y: 1.62, z: 0 };

      // Point-blank ahead (-Z)
      const nearCenter = computeSpatialAudioParams(
        { x: 0, y: 1.62, z: -1.0 },
        listener,
        { listenerYawDeg: 0 },
      );
      expect(nearCenter.distanceM).toBeCloseTo(1.0, 5);
      expect(nearCenter.gainAttenuation).toBe(1.0);
      expect(nearCenter.stereoPan).toBeCloseTo(0, 6);
      expect(nearCenter.airAbsorptionCutoffHz).toBeGreaterThan(19000);

      // Right flank (+X when yaw = 0) vs Left flank (-X when yaw = 0)
      const rightFlank = computeSpatialAudioParams(
        { x: 8.0, y: 1.62, z: 0 },
        listener,
        { listenerYawDeg: 0 },
      );
      const leftFlank = computeSpatialAudioParams(
        { x: -8.0, y: 1.62, z: 0 },
        listener,
        { listenerYawDeg: 0 },
      );
      expect(rightFlank.stereoPan).toBeCloseTo(1.0, 5);
      expect(leftFlank.stereoPan).toBeCloseTo(-1.0, 5);

      // Turning player 90 deg left (+90 yaw in PlayCanvas faces -X, so -Z is now on the player's RIGHT!)
      const rotatedListener = computeSpatialAudioParams(
        { x: 0, y: 1.62, z: -10.0 },
        listener,
        { listenerYawDeg: 90 },
      );
      expect(rotatedListener.stereoPan).toBeCloseTo(1.0, 5);

      // Monotonic distance rolloff & high-frequency air absorption at 12m vs 45m
      const midRange = computeSpatialAudioParams(
        { x: 0, y: 1.62, z: -12.0 },
        listener,
      );
      const farRange = computeSpatialAudioParams(
        { x: 0, y: 1.62, z: -45.0 },
        listener,
      );
      expect(midRange.gainAttenuation).toBeLessThan(nearCenter.gainAttenuation);
      expect(farRange.gainAttenuation).toBeLessThan(midRange.gainAttenuation);
      expect(farRange.gainAttenuation).toBeGreaterThan(0);
      expect(farRange.airAbsorptionCutoffHz).toBeLessThan(midRange.airAbsorptionCutoffHz);
      expect(midRange.reverbSendGain).toBeGreaterThan(nearCenter.reverbSendGain);
    });

    it('synthesizes symmetric tanh waveshaper curves, impact energy scaling, and stereo warehouse IR buffers', () => {
      const curve = createSoftClipCurve(3.5, 257);
      expect(curve.length).toBe(257);
      expect(curve[0]).toBeCloseTo(-1.0, 5);
      expect(curve[128]).toBeCloseTo(0.0, 6);
      expect(curve[256]).toBeCloseTo(1.0, 5);
      for (let i = 0; i < curve.length; i++) {
        expect(Number.isFinite(curve[i])).toBe(true);
        expect(Math.abs(curve[i])).toBeLessThanOrEqual(1.00001);
      }

      expect(computeImpactEnergyGain(-10)).toBe(0.25);
      expect(computeImpactEnergyGain(120)).toBeLessThan(computeImpactEnergyGain(1800));
      expect(computeImpactEnergyGain(25000)).toBe(1.35);

      const sr = 24000;
      const len = Math.floor(sr * 1.55);
      const left = new Float32Array(len);
      const right = new Float32Array(len);
      synthesizeWarehouseImpulseResponse(left, right, sr, 1.55);

      // Verify discrete asymmetric concrete wall slapback reflections (13.6ms L vs 17.4ms R)
      const leftTapIdx = Math.floor(0.0136 * sr);
      const rightTapIdx = Math.floor(0.0174 * sr);
      expect(Math.abs(left[leftTapIdx])).toBeGreaterThan(0.25);
      expect(Math.abs(right[rightTapIdx])).toBeGreaterThan(0.25);

      // Verify reverberant energy decays exponentially from early window to tail window
      let earlyEnergy = 0;
      let lateEnergy = 0;
      const windowSamples = Math.floor(sr * 0.15);
      for (let i = 0; i < windowSamples; i++) {
        earlyEnergy += left[i] * left[i] + right[i] * right[i];
        const tailIdx = len - 1 - i;
        lateEnergy += left[tailIdx] * left[tailIdx] + right[tailIdx] * right[tailIdx];
      }
      expect(earlyEnergy).toBeGreaterThan(lateEnergy * 20);
    });
  });

  describe('2. Safe Headless Degradation (Absent AudioContext in Node/Vitest)', () => {
    it('degrades cleanly to a zero-throw no-op across all combat, destruction, gore and explosion APIs', async () => {
      const engine = new CombatAudioEngine();
      expect(engine.isUnlocked()).toBe(false);
      expect(await engine.unlock()).toBe(false);

      const listener = { x: 0, y: 1.62, z: 0 };
      const targetPos = { x: 1.5, y: 1.2, z: -3.0 };

      engine.updateListener(listener, 15, -4);

      engine.playWeaponFire('m590_shotgun', 'BUCKSHOT_00', false);
      engine.playWeaponFire('silver_talon_50ae', 'JHP', true);
      engine.playWeaponFire('msg90_sniper', 'AP', true);
      engine.playWeaponFire('m4a1_carbine', 'FMJ', false);

      engine.playShellCasingBounce('BRASS', targetPos, listener);
      engine.playShellCasingBounce('SHOTGUN_HULL', targetPos, listener);

      const allMaterials: DestructibleMaterialKind[] = [
        'WOOD_DRYWALL',
        'WOOD_STUD',
        'GLASS_MARCHING_256',
        'GLASS_VORONOI',
        'BRICK_MASONRY',
        'CONCRETE_CHUNKS',
        'CONCRETE_INTACT',
        'STEEL',
      ];
      for (const mat of allMaterials) {
        engine.playMaterialImpact(mat, targetPos, 950, listener);
      }

      const allGore: GoreImpactAudioKind[] = [
        'FLESH_HIT',
        'ARMOR_SPARK',
        'BONE_SHATTER',
        'CRANIAL_POP',
        'LIMB_SEVER',
        'ARTERIAL_SPURT',
      ];
      for (const gore of allGore) {
        engine.playGoreImpact(gore, targetPos, listener);
      }

      const allVocals: VocalTraumaCueKind[] = [
        'SHARP_GASP',
        'WET_HEMOTHORAX_COUGH',
        'PAIN_GRUNT',
      ];
      for (const cue of allVocals) {
        engine.playVocalTraumaCue(cue, targetPos, listener);
      }

      engine.playExplosion(targetPos, listener, 1.2);
      engine.update(0.5);

      const diag = engine.getDiagnostics();
      expect(diag.weaponFireCount).toBe(4);
      expect(diag.casingBounceCount).toBe(2);
      expect(diag.materialImpactCount).toBe(8);
      expect(diag.goreImpactCount).toBe(6);
      expect(diag.vocalCueCount).toBe(3);
      expect(diag.explosionCount).toBe(1);
      expect(diag.tinnitusTriggerCount).toBe(1); // targetPos is ~3.38m <= 4.5m!

      engine.destroy();
      expect(engine.isAvailable()).toBe(false);
    });
  });

  describe('3. Full Procedural Synthesis & 3D Routing with Typed MockAudioContext', () => {
    it('builds master DynamicsCompressor limiter + stereo warehouse ConvolverNode and unlocks suspended context', async () => {
      const mockCtx = new MockAudioContext('suspended', 22050);
      const engine = new CombatAudioEngine({
        context: mockCtx,
        autoUnlockOnGesture: false,
      });

      // Verify master limiter/compressor & stereo impulse-response convolver initialization
      expect(mockCtx.compressors.length).toBe(1);
      expect(mockCtx.compressors[0].threshold.value).toBe(-8.0);
      expect(mockCtx.compressors[0].ratio.value).toBe(12.0);

      expect(mockCtx.convolvers.length).toBe(1);
      expect(mockCtx.convolvers[0].buffer).not.toBeNull();
      expect(mockCtx.convolvers[0].buffer?.numberOfChannels).toBe(2);

      expect(engine.isUnlocked()).toBe(false);
      const unlocked = await engine.unlock();
      expect(unlocked).toBe(true);
      expect(mockCtx.resumeCalls).toBe(1);
      expect(engine.isUnlocked()).toBe(true);

      engine.destroy();
      expect(mockCtx.closeCalls).toBe(1);
    });

    it('automatically unlocks suspended AudioContext on first mousedown/keydown user gesture and cleans up listeners', async () => {
      const listeners = new Map<string, Set<() => void>>();
      const fakeDoc = {
        addEventListener(type: string, cb: () => void): void {
          let set = listeners.get(type);
          if (!set) {
            set = new Set();
            listeners.set(type, set);
          }
          set.add(cb);
        },
        removeEventListener(type: string, cb: () => void): void {
          listeners.get(type)?.delete(cb);
        },
      };

      const globalRecord = globalThis as Record<string, unknown>;
      const prevDoc = globalRecord['document'];
      globalRecord['document'] = fakeDoc;

      try {
        const mockCtx = new MockAudioContext('suspended', 22050);
        const engine = new CombatAudioEngine({
          contextFactory: () => mockCtx,
          autoUnlockOnGesture: true,
        });

        expect(listeners.get('mousedown')?.size).toBe(1);
        expect(listeners.get('keydown')?.size).toBe(1);
        expect(engine.isUnlocked()).toBe(false);

        // Simulate first user mousedown gesture
        for (const cb of listeners.get('mousedown') ?? []) {
          cb();
        }
        await Promise.resolve();
        expect(mockCtx.resumeCalls).toBe(1);
        expect(engine.isUnlocked()).toBe(true);

        engine.destroy();
        expect(listeners.get('mousedown')?.size).toBe(0);
        expect(listeners.get('keydown')?.size).toBe(0);
      } finally {
        if (prevDoc === undefined) {
          delete globalRecord['document'];
        } else {
          globalRecord['document'] = prevDoc;
        }
      }
    });

    it('synthesizes distinct weapon profiles: M590 55Hz sub + 220ms pump rack, .50 AE slide ring, MSG90 crack, and M4A1 organic pitch jitter', () => {
      const mockCtx = new MockAudioContext('running', 22050);
      mockCtx.currentTime = 1.0;

      let seed = 0.15;
      const deterministicRng = (): number => {
        seed = (seed + 0.29) % 1.0;
        return seed;
      };

      const engine = new CombatAudioEngine({
        context: mockCtx,
        random: deterministicRng,
        autoUnlockOnGesture: false,
      });

      // 1) M590 Shotgun: 55Hz sub-punch + delayed pump-action rack ("ch-chk!") at +0.22s & +0.305s
      const oscBeforeM590 = mockCtx.oscillators.length;
      engine.playWeaponFire('m590_shotgun', 'BUCKSHOT_00', false);
      const m590Oscs = mockCtx.oscillators.slice(oscBeforeM590);
      expect(m590Oscs.length).toBeGreaterThanOrEqual(4);

      // First oscillator is the 92Hz -> 55Hz -> 33Hz chest-thumping sub-punch
      const subEvents = m590Oscs[0].frequency.events;
      expect(subEvents.some((e) => Math.abs(e.value - 55) < 0.01)).toBe(true);

      // Delayed pump-action rack oscillators start at 1.0 + 0.22 = 1.22s and ~1.317s
      expect(
        m590Oscs.some(
          (o) => o.startTime !== null && Math.abs(o.startTime - 1.22) < 0.005,
        ),
      ).toBe(true);
      expect(
        m590Oscs.some(
          (o) => o.startTime !== null && o.startTime >= 1.30,
        ),
      ).toBe(true);

      // 2) Silver Talon .50 AE: cannon drop + steel slide metallic ring (~2780Hz & ~4380Hz)
      const oscBefore50 = mockCtx.oscillators.length;
      engine.playWeaponFire('silver_talon_50ae', 'JHP', false);
      const talonOscs = mockCtx.oscillators.slice(oscBefore50);
      expect(
        talonOscs.some((o) =>
          o.frequency.events.some((e) => Math.abs(e.value - 2780) < 1),
        ),
      ).toBe(true);
      expect(
        talonOscs.some((o) =>
          o.frequency.events.some((e) => Math.abs(e.value - 4380) < 1),
        ),
      ).toBe(true);

      // 3) MSG90 Sniper: supersonic 7.62mm AP crack (4200Hz -> 1050Hz) + bolt spring ring
      const oscBeforeSniper = mockCtx.oscillators.length;
      engine.playWeaponFire('msg90_sniper', 'AP', true);
      const sniperOscs = mockCtx.oscillators.slice(oscBeforeSniper);
      expect(
        sniperOscs.some((o) =>
          o.frequency.events.some((e) => Math.abs(e.value - 4200) < 1),
        ),
      ).toBe(true);

      // 4) M4A1 Carbine: consecutive 750 RPM shots exhibit organic per-shot pitch jitter
      const jitters: number[] = [];
      for (let i = 0; i < 6; i++) {
        mockCtx.currentTime += 0.08;
        engine.playWeaponFire('m4a1_carbine', 'FMJ', false);
        jitters.push(engine.getDiagnostics().lastWeaponPitchJitter);
      }
      const uniqueJitters = new Set(jitters.map((j) => j.toFixed(5)));
      expect(uniqueJitters.size).toBeGreaterThanOrEqual(5);
      for (const j of jitters) {
        expect(j).toBeGreaterThanOrEqual(0.92);
        expect(j).toBeLessThanOrEqual(1.08);
      }

      engine.destroy();
    });

    it('synthesizes 3.8kHz + 6.2kHz + 9.1kHz metallic brass casing bounces vs hollow shotgun hulls in 3D space', () => {
      const mockCtx = new MockAudioContext('running', 22050);
      const engine = new CombatAudioEngine({
        context: mockCtx,
        random: () => 0.5, // microVar = 0.975 + 0.5 * 0.05 = 1.0 exact!
        autoUnlockOnGesture: false,
      });

      const listener = { x: 0, y: 1.62, z: 0 };
      const brassPos = { x: 0.45, y: 0.012, z: -0.6 };

      engine.playShellCasingBounce('BRASS', brassPos, listener);
      expect(mockCtx.panners.length).toBe(1);
      expect(mockCtx.panners[0].panningModel).toBe('HRTF');
      expect(mockCtx.panners[0].positionX.value).toBeCloseTo(brassPos.x, 5);
      expect(mockCtx.panners[0].positionY.value).toBeCloseTo(brassPos.y, 5);
      expect(mockCtx.panners[0].positionZ.value).toBeCloseTo(brassPos.z, 5);

      // Verify exact 3.8kHz, 6.2kHz, and 9.1kHz partials on initial bounce
      const freqs = mockCtx.oscillators.map((o) => o.frequency.events[0]?.value ?? 0);
      expect(freqs.some((f) => Math.abs(f - 3800) < 1)).toBe(true);
      expect(freqs.some((f) => Math.abs(f - 6200) < 1)).toBe(true);
      expect(freqs.some((f) => Math.abs(f - 9100) < 1)).toBe(true);

      // Verify graceful fallback to `equalpower` if device throws on HRTF
      mockCtx.rejectHrtfOnPanner = true;
      engine.playShellCasingBounce(
        'SHOTGUN_HULL',
        { x: 0.5, y: 0.012, z: -0.5 },
        listener,
      );
      expect(mockCtx.panners[1].panningModel).toBe('equalpower');

      engine.destroy();
    });

    it('synthesizes material impacts including concrete 1.8kHz->700Hz ricochet whine, glass tinkles, wood splinters, and steel clang', () => {
      const mockCtx = new MockAudioContext('running', 22050);
      const engine = new CombatAudioEngine({
        context: mockCtx,
        random: () => 0.5,
        autoUnlockOnGesture: false,
      });

      const listener = { x: 0, y: 1.62, z: 0 };
      const wallPos = { x: -2.0, y: 1.4, z: -12.5 };

      // Concrete impact must include the 1800Hz -> 700Hz supersonic ricochet sweep
      const oscBeforeConcrete = mockCtx.oscillators.length;
      engine.playMaterialImpact('CONCRETE_INTACT', wallPos, 1800, listener);
      const concreteOscs = mockCtx.oscillators.slice(oscBeforeConcrete);
      const ricochetOsc = concreteOscs.find(
        (o) =>
          o.frequency.events.some((e) => Math.abs(e.value - 1800) < 1) &&
          o.frequency.events.some((e) => Math.abs(e.value - 700) < 1),
      );
      expect(ricochetOsc).toBeDefined();

      // Glass Voronoi & Marching-256 produce cascading crystalline shard tinkles
      const oscBeforeGlass = mockCtx.oscillators.length;
      engine.playMaterialImpact('GLASS_MARCHING_256', wallPos, 450, listener);
      const glassOscs = mockCtx.oscillators.slice(oscBeforeGlass);
      expect(glassOscs.length).toBeGreaterThanOrEqual(8);

      // Brick, Wood, and Steel all generate spatialized filter/oscillator layers
      const pannersBefore = mockCtx.panners.length;
      engine.playMaterialImpact('BRICK_MASONRY', wallPos, 1200, listener);
      engine.playMaterialImpact('WOOD_STUD', wallPos, 900, listener);
      engine.playMaterialImpact('STEEL', wallPos, 1500, listener);
      expect(mockCtx.panners.length - pannersBefore).toBe(3);

      engine.destroy();
    });

    it('synthesizes visceral GHOUL gore impacts, vocal trauma cues, and close-proximity <=4.5m explosion tinnitus', () => {
      const mockCtx = new MockAudioContext('running', 22050);
      const engine = new CombatAudioEngine({
        context: mockCtx,
        random: () => 0.5,
        autoUnlockOnGesture: false,
      });

      const listener = { x: 0, y: 1.62, z: 0 };

      mockCtx.currentTime = 1.0;
      engine.playGoreImpact('FLESH_HIT', { x: 0, y: 1.4, z: -6 }, listener);
      expect(engine.getDiagnostics().vocalCueCount).toBe(1); // Triggered auto PAIN_GRUNT

      // Immediate hit 20ms later throttles duplicate vocal cue
      mockCtx.currentTime = 1.02;
      engine.playGoreImpact('BONE_SHATTER', { x: 0, y: 1.4, z: -6 }, listener);
      expect(engine.getDiagnostics().vocalCueCount).toBe(1);

      // Hit >0.28s later triggers SHARP_GASP on LIMB_SEVER
      mockCtx.currentTime = 1.5;
      engine.playGoreImpact('LIMB_SEVER', { x: 0, y: 1.4, z: -6 }, listener);
      expect(engine.getDiagnostics().vocalCueCount).toBe(2);

      engine.playGoreImpact('CRANIAL_POP', { x: 0, y: 1.65, z: -8 }, listener);
      engine.playVocalTraumaCue('WET_HEMOTHORAX_COUGH');
      expect(engine.getDiagnostics().vocalCueCount).toBe(3);

      // Explosion beyond 4.5m (at 10m): 90Hz -> 28Hz sub-bass shockwave, NO tinnitus ring
      const oscBeforeFarBlast = mockCtx.oscillators.length;
      engine.playExplosion({ x: 0, y: 0.5, z: -10.0 }, listener, 1.0);
      const farBlastOscs = mockCtx.oscillators.slice(oscBeforeFarBlast);
      expect(
        farBlastOscs.some(
          (o) =>
            o.frequency.events.some((e) => Math.abs(e.value - 90) < 1) &&
            o.frequency.events.some((e) => Math.abs(e.value - 28) < 1),
        ),
      ).toBe(true);
      expect(
        farBlastOscs.some((o) =>
          o.frequency.events.some((e) => Math.abs(e.value - 3960) < 1),
        ),
      ).toBe(false);
      expect(engine.getDiagnostics().tinnitusTriggerCount).toBe(0);

      // Explosion within 4.5m (at 3.2m <= TINNITUS_PROXIMITY_RADIUS_M): triggers 3960Hz tinnitus ring!
      expect(TINNITUS_PROXIMITY_RADIUS_M).toBe(4.5);
      const oscBeforeNearBlast = mockCtx.oscillators.length;
      engine.playExplosion({ x: 0, y: 1.62, z: -3.2 }, listener, 1.4);
      const nearBlastOscs = mockCtx.oscillators.slice(oscBeforeNearBlast);
      expect(
        nearBlastOscs.some((o) =>
          o.frequency.events.some((e) => Math.abs(e.value - 3960) < 1),
        ),
      ).toBe(true);
      expect(engine.getDiagnostics().tinnitusTriggerCount).toBe(1);

      engine.destroy();
    });

    it('locks stereo bus channels, preserves pitched orthonormal listener basis, throttles 8-pellet bursts, and disconnects finished nodes', () => {
      const limCurve = createMasterLimiterCurve(4.0, 0.65, 0.97, 1025);
      const midIdx = 512;
      expect(limCurve[midIdx]).toBeCloseTo(0, 6);
      // At x = +0.1 (signal = +0.4 <= 0.65), limiter is strictly unity-linear
      const idx01 = Math.round(((0.1 + 1) * 0.5) * 1024);
      const xActual = (idx01 * 2) / 1024 - 1;
      expect(limCurve[idx01]).toBeCloseTo(xActual * 4.0, 5);
      // At +12 dBFS (x = +1.0, signal = +4.0), output stays smoothly capped <= 0.97
      expect(limCurve[1024]).toBeLessThanOrEqual(0.971);
      expect(limCurve[0]).toBeGreaterThanOrEqual(-0.971);

      const mockCtx = new MockAudioContext('running', 48000);
      mockCtx.currentTime = 5.0;
      const engine = new CombatAudioEngine({
        context: mockCtx,
        pannerModel: 'equalpower',
        random: () => 0.5,
        autoUnlockOnGesture: false,
      });

      // Multi-channel destination (e.g. 6-speaker MacBook array) & master compressor locked to 2ch stereo
      expect(mockCtx.destination.channelCount).toBe(2);
      expect(mockCtx.destination.channelCountMode).toBe('explicit');
      expect(mockCtx.destination.channelInterpretation).toBe('speakers');
      expect(mockCtx.compressors[0].channelCount).toBe(2);
      expect(mockCtx.compressors[0].channelCountMode).toBe('explicit');

      // Update listener with non-zero pitch (-25 deg) and yaw (35 deg) -> forward & up are orthonormal,
      // and spawning a spatial sound must NOT reset listener pitch back to 0!
      const listenerPos = { x: 1.0, y: 1.62, z: -2.0 };
      engine.updateListener(listenerPos, 35, -25);
      const fyBefore = mockCtx.listener.forwardY.value;
      expect(fyBefore).toBeLessThan(-0.4);

      // Simulate 8 simultaneous buckshot pellets hitting CONCRETE_INTACT in the same millisecond
      const pannersBefore = mockCtx.panners.length;
      for (let p = 0; p < 8; p++) {
        engine.playMaterialImpact('CONCRETE_INTACT', { x: 3.5, y: 1.4, z: -9.0 }, 260, listenerPos);
      }
      expect(engine.getDiagnostics().materialImpactCount).toBe(8);
      // Capped to 3 staggered spatial chains instead of 8 in-phase clipping chains
      const spawnedPanners = mockCtx.panners.slice(pannersBefore);
      expect(spawnedPanners.length).toBe(3);
      // Stereo wet send taps post-panner (2 connections: dryBus + wetSend)
      expect(spawnedPanners[0].connections.length).toBe(2);
      // Listener pitch was preserved (not clobbered to 0)
      expect(mockCtx.listener.forwardY.value).toBeCloseTo(fyBefore, 6);

      // Advance audio clock past chain & node TTL -> update() disconnects finished transient nodes & panners
      mockCtx.currentTime = 12.0;
      engine.update(0.016);
      expect(spawnedPanners.every((p) => p.disconnected)).toBe(true);

      engine.destroy();
    });
  });
});
