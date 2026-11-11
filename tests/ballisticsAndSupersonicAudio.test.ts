import { describe, expect, it } from 'vitest';
import {
  applyShotReportToTarget,
  resolveMagnetizedAimDirection,
  simulateShot,
  stepProjectileRK4,
  stepProjectileRK4InPlace,
} from '../src/core/ballistics/solver.ts';
import {
  AMMO_12G_00_BUCK,
  AMMO_50AE_JHP,
  AMMO_762_NATO_M118LR,
  DEFAULT_ENVIRONMENT,
  WEAPON_M590,
  WEAPON_MSG90,
  WEAPON_SILVER_TALON,
} from '../src/core/ballistics/weapons.ts';
import { length, normalize, sub, vec3 } from '../src/core/ballistics/vec3.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { createPhysiologicalEntityState } from '../src/core/physiology/initialState.ts';
import { syncPhysiologyToHealthState } from '../src/engine/combat/physiologySyncAdapter.ts';
import { CombatAudioEngine } from '../src/engine/audio/combatAudioEngine.ts';
import { initRapierPhysics, RapierPhysicsWorld } from '../src/engine/physics/rapierWorld.ts';
import {
  type BloodSplatterSlotAnchor,
  projectBloodSplatter,
  pruneUnsupportedBloodSplatters,
} from '../src/engine/fx/decals/bloodSplatterSystem.ts';
import type { HardwareInstancedPool } from '../src/engine/physics/instancedPool.ts';
import type { BulletTimeController } from '../src/engine/fx/bulletTime/bulletTimeController.ts';
import type {
  AudioBufferLike,
  AudioContextLike,
  AudioParamLike,
} from '../src/core/audio/contracts.ts';

function createMockAudioParam(initial = 0): AudioParamLike & { scheduledTimes: number[] } {
  const scheduledTimes: number[] = [];
  const param: AudioParamLike & { scheduledTimes: number[] } = {
    value: initial,
    scheduledTimes,
    setValueAtTime(v: number, t: number) {
      this.value = v;
      scheduledTimes.push(t);
      return this;
    },
    linearRampToValueAtTime(v: number, t: number) {
      this.value = v;
      scheduledTimes.push(t);
      return this;
    },
    exponentialRampToValueAtTime(v: number, t: number) {
      this.value = v;
      scheduledTimes.push(t);
      return this;
    },
    setTargetAtTime(v: number, t: number) {
      this.value = v;
      scheduledTimes.push(t);
      return this;
    },
    cancelScheduledValues() {
      return this;
    },
  };
  return param;
}

function createMockAudioContext(): AudioContextLike & {
  startedTimes: number[];
  pannerPositions: { x: number; y: number; z: number }[];
} {
  const startedTimes: number[] = [];
  const pannerPositions: { x: number; y: number; z: number }[] = [];

  return {
    state: 'running',
    currentTime: 10.0,
    sampleRate: 44100,
    startedTimes,
    pannerPositions,
    destination: { connect: () => undefined, disconnect: () => undefined },
    listener: {
      positionX: createMockAudioParam(0),
      positionY: createMockAudioParam(1.62),
      positionZ: createMockAudioParam(0),
      forwardX: createMockAudioParam(0),
      forwardY: createMockAudioParam(0),
      forwardZ: createMockAudioParam(-1),
      upX: createMockAudioParam(0),
      upY: createMockAudioParam(1),
      upZ: createMockAudioParam(0),
    },
    resume: async () => undefined,
    close: async () => undefined,
    createGain: () => ({
      gain: createMockAudioParam(1),
      connect: () => undefined,
      disconnect: () => undefined,
    }),
    createOscillator: () => ({
      type: 'sine',
      frequency: createMockAudioParam(440),
      detune: createMockAudioParam(0),
      connect: () => undefined,
      disconnect: () => undefined,
      start: (when = 10.0) => startedTimes.push(when),
      stop: () => undefined,
    }),
    createBiquadFilter: () => ({
      type: 'lowpass',
      frequency: createMockAudioParam(1000),
      Q: createMockAudioParam(1),
      gain: createMockAudioParam(0),
      connect: () => undefined,
      disconnect: () => undefined,
    }),
    createBuffer: (ch: number, len: number, sr: number): AudioBufferLike => {
      const data = Array.from({ length: ch }, () => new Float32Array(len));
      return {
        sampleRate: sr,
        length: len,
        duration: len / sr,
        numberOfChannels: ch,
        getChannelData: (c: number) => data[c] ?? data[0],
      };
    },
    createBufferSource: () => ({
      buffer: null,
      loop: false,
      playbackRate: createMockAudioParam(1),
      connect: () => undefined,
      disconnect: () => undefined,
      start: (when = 10.0) => startedTimes.push(when),
      stop: () => undefined,
    }),
    createConvolver: () => ({
      buffer: null,
      normalize: true,
      connect: () => undefined,
      disconnect: () => undefined,
    }),
    createDynamicsCompressor: () => ({
      threshold: createMockAudioParam(-10),
      knee: createMockAudioParam(10),
      ratio: createMockAudioParam(12),
      attack: createMockAudioParam(0.002),
      release: createMockAudioParam(0.14),
      connect: () => undefined,
      disconnect: () => undefined,
    }),
    createPanner: () => {
      const px = createMockAudioParam(0);
      const py = createMockAudioParam(0);
      const pz = createMockAudioParam(0);
      return {
        panningModel: 'HRTF',
        distanceModel: 'inverse',
        refDistance: 1,
        maxDistance: 100,
        rolloffFactor: 1,
        coneInnerAngle: 360,
        coneOuterAngle: 360,
        coneOuterGain: 1,
        connect: () => {
          pannerPositions.push({ x: px.value, y: py.value, z: pz.value });
          return undefined;
        },
        disconnect: () => undefined,
        positionX: px,
        positionY: py,
        positionZ: pz,
      };
    },
    createWaveShaper: () => ({
      curve: null,
      oversample: 'none',
      connect: () => undefined,
      disconnect: () => undefined,
    }),
  };
}

describe('Ballistics, Magnetism, Hitstop & Supersonic Audio Upgrades', () => {
  it('resolves M&K 0.28° bullet magnetism on near-miss headshots while bypassing buckshot and core hits', () => {
    const target = createTargetHealthState('t_mag', 'Hostile', vec3(0, 0, -15), 0, 'MILITIA_GUNNER');
    const origin = vec3(0, 1.7, 0);
    const headPos = target.ragdollBones.HEAD_CRANIUM.position;

    // 1. Dead-center core ray is never perturbed
    const exactDir = normalize(sub(headPos, origin));
    const coreRes = resolveMagnetizedAimDirection(origin, exactDir, [target], AMMO_762_NATO_M118LR);
    expect(coreRes).toBe(exactDir);

    // 2. Narrow miss just outside the 9.5cm cranium core (e.g. 11.2cm offset at 15m -> ~0.18° past core) snaps inward
    const grazePoint = vec3(headPos.x + 0.112, headPos.y, headPos.z);
    const grazeDir = normalize(sub(grazePoint, origin));
    const magDir = resolveMagnetizedAimDirection(origin, grazeDir, [target], AMMO_762_NATO_M118LR);
    expect(magDir).not.toBe(grazeDir);

    // Magnetized aim direction reduces perpendicular miss distance to head center
    const distAt15 = length(sub(headPos, origin));
    const rawClosest = vec3(origin.x + grazeDir.x * distAt15, origin.y + grazeDir.y * distAt15, origin.z + grazeDir.z * distAt15);
    const magClosest = vec3(origin.x + magDir.x * distAt15, origin.y + magDir.y * distAt15, origin.z + magDir.z * distAt15);
    expect(length(sub(headPos, magClosest))).toBeLessThan(length(sub(headPos, rawClosest)));

    // 3. Multi-pellet buckshot is always bypassed
    const buckRes = resolveMagnetizedAimDirection(origin, grazeDir, [target], AMMO_12G_00_BUCK);
    expect(buckRes).toBe(grazeDir);
  });

  it('stamps 35-50ms local micro-hitstop on heavy/bone-shattering impacts and clamps overkill corpse impulses', () => {
    const target = createTargetHealthState('t_hitstop', 'Enforcer', vec3(0, 0, -6), 0, 'SKINHEAD_PUNK');
    const origin = vec3(0, 1.35, 0);
    const thoraxPos = target.ragdollBones.TORSO_UPPER_THORAX.position;
    const aimDir = normalize(sub(thoraxPos, origin));

    const report = simulateShot(
      WEAPON_SILVER_TALON,
      AMMO_50AE_JHP,
      origin,
      aimDir,
      target,
      DEFAULT_ENVIRONMENT
    );
    expect(report.hitTarget).toBe(true);

    applyShotReportToTarget(target, report);
    expect(target.hitstopRemainingS).toBeGreaterThanOrEqual(0.035);
    expect(target.hitstopRemainingS).toBeLessThanOrEqual(0.05);

    // Force target into dead ragdoll state and fire overkill shots — bone speeds must stay clamped <= 2.6 m/s
    target.alive = false;
    target.isRagdollActive = true;
    for (let i = 0; i < 4; i++) {
      const overkillReport = simulateShot(WEAPON_MSG90, AMMO_762_NATO_M118LR, origin, aimDir, target, DEFAULT_ENVIRONMENT);
      applyShotReportToTarget(target, overkillReport);
    }
    for (const bone of Object.values(target.ragdollBones)) {
      expect(length(bone.velocity)).toBeLessThanOrEqual(2.65);
      expect(bone.velocity.y).toBeLessThanOrEqual(0.15);
    }
    expect(target.activeReaction.type).toBe('NONE');
  });

  it('stabilizes ragdoll transition when physiology death syncs to health state', () => {
    const hs = createTargetHealthState('t_phys', 'Guard', vec3(4, 0, -10), 0, 'MILITIA_GUNNER');
    // Perturb a bone position relative to prevPosition as if mid-animation
    hs.ragdollBones.HEAD_CRANIUM.position = vec3(4.2, 1.72, -9.8);
    hs.ragdollBones.HEAD_CRANIUM.prevPosition = vec3(3.1, 1.72, -8.5);

    const physio = createPhysiologicalEntityState({ entityId: 't_phys', enableArmorPlates: false });
    physio.alive = false;
    physio.conscious = false;

    syncPhysiologyToHealthState(physio, hs, null);
    expect(hs.alive).toBe(false);
    expect(hs.isRagdollActive).toBe(true);
    expect(hs.weaponDropped).toBe(true);
    expect(hs.posture).toBe('AIRBORNE_RAGDOLL');
    // prevPosition must be synchronized with position so substep 1 never explodes
    expect(hs.ragdollBones.HEAD_CRANIUM.prevPosition).toEqual(hs.ragdollBones.HEAD_CRANIUM.position);
  });

  it('produces identical numerical results between stepProjectileRK4 and stepProjectileRK4InPlace', () => {
    const baseProj = {
      id: 'rk4_test_p2',
      ammo: AMMO_12G_00_BUCK,
      position: { x: 0, y: 1.5, z: 0 },
      velocity: { x: 12, y: -4, z: -395 },
      spinRadS: 2400,
      currentDiameterM: AMMO_12G_00_BUCK.diameterM,
      flightTimeS: 0.015,
      distanceTraveledM: 6.2,
      kineticEnergyJ: 280,
      penetratedLayers: 0,
      alive: true,
    };

    const immutableNext = stepProjectileRK4(baseProj, DEFAULT_ENVIRONMENT, 0.0015, 2);
    const mutableProj = {
      ...baseProj,
      position: { ...baseProj.position },
      velocity: { ...baseProj.velocity },
    };
    stepProjectileRK4InPlace(mutableProj, DEFAULT_ENVIRONMENT, 0.0015, 2);

    expect(mutableProj.position).toEqual(immutableNext.position);
    expect(mutableProj.velocity).toEqual(immutableNext.velocity);
    expect(mutableProj.distanceTraveledM).toBeCloseTo(immutableNext.distanceTraveledM, 8);
    expect(mutableProj.kineticEnergyJ).toBeCloseTo(immutableNext.kineticEnergyJ, 8);
  });

  it('schedules Stage 1 supersonic crack at closest approach before Stage 2 speed-of-sound delayed muzzle thump', () => {
    const mockCtx = createMockAudioContext();
    const audio = new CombatAudioEngine({ context: mockCtx, autoUnlockOnGesture: false });

    // Enemy fires supersonic 7.62 rifle from 25m away (z = -25) passing 0.8m to the right of listener at (0, 1.62, 0)
    const res = audio.playEnemyBallisticShot({
      muzzleOrigin: vec3(0.8, 1.62, -25),
      impactPoint: vec3(0.8, 1.62, 5),
      listenerPos: vec3(0, 1.62, 0),
      weaponId: 'msg90_sniper',
      isSupersonic: true,
    });

    expect(res).not.toBeNull();
    expect(res!.firedSupersonicCrack).toBe(true);
    // At 25m: bullet flight to closest approach (~805 m/s) is ~31ms; speed of sound (343 m/s) is ~73ms
    expect(res!.crackDelayS).toBeGreaterThan(0.02);
    expect(res!.crackDelayS).toBeLessThan(0.045);
    expect(res!.muzzleDelayS).toBeGreaterThan(res!.crackDelayS + 0.01);
    expect(res!.muzzleDelayS).toBeCloseTo(Math.hypot(0.8, 25) / 343.0, 2);

    // Subsonic M9 sidearm or wide miss (> 3.0m) does not fire supersonic crack
    const subsonicRes = audio.playEnemyBallisticShot({
      muzzleOrigin: vec3(0.8, 1.62, -18),
      impactPoint: vec3(0.8, 1.62, 4),
      listenerPos: vec3(0, 1.62, 0),
      weaponId: 'weapon_beretta_m9',
      isSupersonic: false,
    });
    expect(subsonicRes!.firedSupersonicCrack).toBe(false);

    // Radio bark and near-miss graze tinnitus execute cleanly
    audio.playRadioBarkCue({
      isRadio: true,
      vocalCue: 'SHARP_GASP',
      worldPos: vec3(2, 1.5, -10),
      listenerPos: vec3(0, 1.62, 0),
    });
    audio.playNearMissGrazeTinnitus('HELMET_POP', vec3(0.1, 1.7, -0.2), vec3(0, 1.62, 0));
    audio.playRicochetSnap(vec3(1.2, 1.1, -6), vec3(0, 1.62, 0));
    expect(audio.getDiagnostics().tinnitusTriggerCount).toBe(1);
  });

  it('evicts wall blood splatters when supporting surfaces are destroyed while preserving floor decals and waking resting debris', async () => {
    await initRapierPhysics();
    const rapierWorld = new RapierPhysicsWorld();

    // 1. Create a destructible static wall at z = -4.0 and a dynamic debris chunk near the blood ray path
    const wallCollider = rapierWorld.createStaticBox(
      vec3(0, 1.5, -4.0),
      vec3(1.5, 1.5, 0.15),
      undefined,
      { objectId: 'wall_test_01', material: 'WOOD_DRYWALL', thicknessM: 0.3, penetrationResistanceJ: 150 }
    );
    const dynamicChunk = rapierWorld.spawnDynamicBox(
      vec3(0, 1.5, -3.2),
      vec3(0.2, 0.2, 0.2),
      5.0,
      undefined,
      undefined,
      undefined,
      { objectId: 'debris_chunk_01', material: 'CONCRETE_CHUNKS', thicknessM: 0.4, penetrationResistanceJ: 800 }
    );

    const activeSlots = new Set<number>();
    const maxInstances = 16;
    const mockPool = {
      maxInstances,
      allocSlot: () => {
        for (let i = 0; i < maxInstances; i++) {
          if (!activeSlots.has(i)) {
            activeSlots.add(i);
            return i;
          }
        }
        return -1;
      },
      freeSlot: (slot: number) => activeSlots.delete(slot),
      isSlotActive: (slot: number) => activeSlots.has(slot),
      setSlotTRS: () => undefined,
      upload: () => undefined,
    } as unknown as HardwareInstancedPool;

    const slotAnchors: BloodSplatterSlotAnchor[] = Array.from({ length: maxInstances }, () => ({
      active: false,
      isFloor: false,
      pointWorld: { x: 0, y: 0, z: 0 },
      normalWorld: { x: 0, y: 1, z: 0 },
    }));
    const recycleCursor = { value: 0 };
    const seedCounter = { value: 1 };
    const ctx = {
      rapierWorld,
      bloodSplatterPool: mockPool,
      bulletTime: { triggerKillPunch: () => undefined } as unknown as BulletTimeController,
      slotAnchors,
    };

    // Stamp one wall splatter (passes right through dynamicChunk and anchors to static wall at z ≈ -3.85)
    const wallStamped = projectBloodSplatter(
      ctx,
      { originWorld: vec3(0, 1.5, -2.5), impactDirectionWorld: vec3(0, 0, -1), exitEnergyJ: 260 },
      recycleCursor,
      seedCounter
    );
    // Stamp one floor splatter (anchors to y = 0)
    const floorStamped = projectBloodSplatter(
      ctx,
      { originWorld: vec3(0.5, 0.9, -1.0), impactDirectionWorld: vec3(0, -1, 0), exitEnergyJ: 260 },
      recycleCursor,
      seedCounter
    );
    expect(wallStamped).toBe(1);
    expect(floorStamped).toBe(1);
    expect(activeSlots.size).toBe(2);
    // Wall splatter ignored dynamicChunk at z=-3.2 and anchored onto the static wall at z ≈ -3.85
    expect(slotAnchors[0].pointWorld.z).toBeLessThan(-3.7);
    expect(slotAnchors[0].isFloor).toBe(false);
    expect(slotAnchors[1].isFloor).toBe(true);

    // Move dynamicChunk to rest on top of the static wall and put it to sleep
    rapierWorld.removeBody(dynamicChunk.bodyHandle);
    const restingDebris = rapierWorld.spawnDynamicBox(vec3(0, 3.15, -4.0), vec3(0.15, 0.15, 0.15), 4.0);
    for (let i = 0; i < 45; i++) rapierWorld.step(1 / 60);
    expect(rapierWorld.isBodySleeping(restingDebris.bodyHandle)).toBe(true);

    // Destroy the supporting wall collider -> wakes touching dynamic bodies and evicts wall blood decal
    rapierWorld.removeCollider(wallCollider);
    const evictedCount = pruneUnsupportedBloodSplatters(ctx);
    expect(evictedCount).toBe(1);
    expect(activeSlots.has(0)).toBe(false);
    expect(activeSlots.has(1)).toBe(true);

    // Step physics after wall removal -> resting debris wakes and falls downward
    for (let i = 0; i < 15; i++) rapierWorld.step(1 / 60);
    const postFallPose = rapierWorld.getBodyPose(restingDebris.bodyHandle);
    expect(postFallPose).not.toBeNull();
    expect(postFallPose!.position.y).toBeLessThan(2.9);

    rapierWorld.destroy();
  });
});
