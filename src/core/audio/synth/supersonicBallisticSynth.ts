import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type {
  EnemyBallisticShotAudioParams,
  NearMissGrazeAudioKind,
} from '../types.ts';
import type { SynthContext } from './synthPrimitives.ts';
import { spawnNoiseBurst, spawnPitchDropOsc } from './synthPrimitives.ts';
import { clampNumber } from '../audioMath.ts';
import { synthesizeRicochetWhine, synthesizeSteelZing } from './ricochetAudioSynth.ts';

const SPEED_OF_SOUND_MS = 343.0;
const SUPERSONIC_CRACK_MAX_RADIUS_M = 3.0;

export interface SupersonicShotAudioResult {
  readonly firedSupersonicCrack: boolean;
  readonly crackDelayS: number;
  readonly muzzleDelayS: number;
}

function inferBallisticSpeedMs(weaponId?: string, explicitSpeedMs?: number, isSupersonic?: boolean): number {
  if (explicitSpeedMs !== undefined && explicitSpeedMs > SPEED_OF_SOUND_MS) {
    return explicitSpeedMs;
  }
  const id = (weaponId ?? '').toLowerCase();
  if (id.includes('m9') || id.includes('sidearm') || id.includes('9mm')) {
    return isSupersonic === true ? 380 : 330;
  }
  if (id.includes('msg90') || id.includes('sniper') || id.includes('762')) return 805;
  if (id.includes('m4') || id.includes('carbine') || id.includes('556')) return 880;
  if (id.includes('talon') || id.includes('50ae')) return 445;
  if (id.includes('m590') || id.includes('shotgun')) return 405;
  if (isSupersonic === false) return 310;
  return explicitSpeedMs && explicitSpeedMs > 0 ? Math.max(420, explicitSpeedMs) : 780;
}

/**
 * Two-Stage Supersonic Ballistic Audio (F.E.A.R. / Squad style):
 * Stage 1: Sharp N-wave supersonic whiz-SNAP at the closest ray point P_closest (<3.0m) when v > 343 m/s.
 * Stage 2: Speed-of-sound delayed (dist / 343), distance low-pass filtered 3D muzzle blast at muzzleOrigin.
 * Scheduled deterministically via `AudioContext.currentTime` (zero JS setTimeouts).
 */
export function playEnemyBallisticShot(
  ctx: SynthContext,
  params: EnemyBallisticShotAudioParams,
  listenerPos: Vec3Like,
  listenerYawDeg: number,
  pannerModel: PanningModelType,
  reverbWetMix: number,
): SupersonicShotAudioResult {
  const g = ctx.graph;
  const now = g.ctx.currentTime;

  const muzzle = params.muzzleOrigin;
  const impact = params.impactPoint;
  const lPos = params.listenerPos ?? listenerPos;
  const speedMs = inferBallisticSpeedMs(params.weaponId, params.projectileSpeedMs, params.isSupersonic);

  const dx = impact.x - muzzle.x;
  const dy = impact.y - muzzle.y;
  const dz = impact.z - muzzle.z;
  const segLen = Math.hypot(dx, dy, dz);

  let firedSupersonicCrack = false;
  let crackDelayS = 0;

  if (segLen > 0.25 && speedMs > SPEED_OF_SOUND_MS && params.isSupersonic !== false) {
    const invLen = 1 / segLen;
    const dirX = dx * invLen;
    const dirY = dy * invLen;
    const dirZ = dz * invLen;

    const toLx = lPos.x - muzzle.x;
    const toLy = lPos.y - muzzle.y;
    const toLz = lPos.z - muzzle.z;
    const tAlong = clampNumber(toLx * dirX + toLy * dirY + toLz * dirZ, 0, segLen);

    const closestPos: Vec3Like = {
      x: muzzle.x + dirX * tAlong,
      y: muzzle.y + dirY * tAlong,
      z: muzzle.z + dirZ * tAlong,
    };
    const dPerp = Math.hypot(lPos.x - closestPos.x, lPos.y - closestPos.y, lPos.z - closestPos.z);

    if (tAlong > 0.35 && dPerp < SUPERSONIC_CRACK_MAX_RADIUS_M) {
      firedSupersonicCrack = true;
      crackDelayS = clampNumber((tAlong / speedMs), 0, 0.45);
      const tCrack = now + crackDelayS;
      const prox = clampNumber(1.0 - dPerp / SUPERSONIC_CRACK_MAX_RADIUS_M, 0.24, 1.0);

      const crackChain = g.createSpatialChain(
        closestPos,
        lPos,
        listenerYawDeg,
        pannerModel,
        reverbWetMix * 0.45,
        { refDistanceM: 1.2, maxDistanceM: 28.0, rolloffFactor: 1.35, baseReverbWet: 0.08, maxReverbWet: 0.26 },
      );

      // Pre-crack supersonic Doppler whiz sweep (2.4kHz -> 680Hz)
      const tWhiz = Math.max(now, tCrack - 0.008);
      spawnPitchDropOsc(
        ctx,
        crackChain.input,
        'sine',
        tWhiz,
        0.056,
        2400,
        680,
        0.28 * prox,
        undefined,
        0.002,
      );

      // N-wave 0.4ms-attack high-passed white noise SNAP
      spawnNoiseBurst(
        ctx,
        crackChain.input,
        'WHITE',
        tCrack,
        0.028,
        0.92 * prox,
        'highpass',
        2600,
        1400,
        1.8,
        1.25,
        0.0004,
      );
      spawnPitchDropOsc(
        ctx,
        crackChain.input,
        'sawtooth',
        tCrack,
        0.024,
        3800,
        920,
        0.54 * prox,
        g.heavyDriveCurve,
        0.0004,
      );
    }
  }

  // Stage 2: Speed-of-sound delayed, distance-LPF 3D muzzle thump
  const distToMuzzle = Math.hypot(lPos.x - muzzle.x, lPos.y - muzzle.y, lPos.z - muzzle.z);
  const rawAcousticDelayS = clampNumber((distToMuzzle / SPEED_OF_SOUND_MS), 0, 0.65);
  const muzzleDelayS = firedSupersonicCrack
    ? Math.max(rawAcousticDelayS, crackDelayS + 0.012)
    : rawAcousticDelayS;
  const tMuzzle = now + muzzleDelayS;

  const muzzleChain = g.createSpatialChain(
    muzzle,
    lPos,
    listenerYawDeg,
    pannerModel,
    Math.min(1.0, reverbWetMix * 1.25),
    { refDistanceM: 2.2, maxDistanceM: 95.0, rolloffFactor: 1.05, baseReverbWet: 0.22, maxReverbWet: 0.68 },
  );

  const lpfStartHz = clampNumber(4800 * Math.exp(-distToMuzzle / 26.0), 950, 4800);
  spawnPitchDropOsc(
    ctx,
    muzzleChain.input,
    'triangle',
    tMuzzle,
    0.135,
    158,
    46,
    0.72,
    g.warmDriveCurve,
    0.0012,
  );
  spawnNoiseBurst(
    ctx,
    muzzleChain.input,
    'WHITE',
    tMuzzle,
    0.125,
    0.74,
    'lowpass',
    lpfStartHz,
    460,
    1.25,
    0.98,
    0.001,
  );
  spawnNoiseBurst(
    ctx,
    muzzleChain.input,
    'PINK',
    tMuzzle + 0.006,
    0.26,
    0.48,
    'lowpass',
    1750,
    240,
    0.9,
    0.88,
    0.004,
  );

  return { firedSupersonicCrack, crackDelayS, muzzleDelayS };
}

export function playNearMissGrazeTinnitus(
  ctx: SynthContext,
  kind: NearMissGrazeAudioKind,
  hitOrigin: Vec3Like,
  listenerPos: Vec3Like,
  listenerYawDeg: number,
  pannerModel: PanningModelType,
  reverbWetMix: number,
): void {
  const g = ctx.graph;
  const t0 = g.ctx.currentTime;

  const chain = g.createSpatialChain(
    hitOrigin,
    listenerPos,
    listenerYawDeg,
    pannerModel,
    reverbWetMix * 0.5,
    { refDistanceM: 1.0, maxDistanceM: 18.0, rolloffFactor: 1.2 },
  );

  if (kind === 'HELMET_POP') {
    synthesizeSteelZing(ctx, chain.input, t0, 1.15);
    spawnPitchDropOsc(ctx, chain.input, 'triangle', t0, 0.14, 1920, 1280, 0.56, g.heavyDriveCurve, 0.0005);
    spawnNoiseBurst(ctx, chain.input, 'CRACKLE', t0, 0.095, 0.68, 'bandpass', 2400, 1450, 2.2, 1.1, 0.0006);
  } else {
    spawnNoiseBurst(ctx, chain.input, 'WHITE', t0, 0.075, 0.78, 'bandpass', 3200, 1100, 1.9, 1.15, 0.0005);
    spawnPitchDropOsc(ctx, chain.input, 'sine', t0, 0.12, 165, 52, 0.64, g.warmDriveCurve, 0.001);
  }

  const ringOsc = g.createOscillator();
  ringOsc.type = 'sine';
  const ringFreq = kind === 'HELMET_POP' ? 3960 : 4180;
  const ringDur = (kind === 'HELMET_POP' ? 1.55 : 1.32);
  ringOsc.frequency.setValueAtTime(ringFreq, t0 + 0.012);

  const ringGain = g.createGain();
  ringGain.gain.value = 0;
  ringGain.gain.setValueAtTime(0.0001, t0);
  ringGain.gain.setValueAtTime(0.0001, t0 + 0.012);
  ringGain.gain.linearRampToValueAtTime(0.082, t0 + 0.055);
  ringGain.gain.exponentialRampToValueAtTime(0.0001, t0 + ringDur);
  ringGain.gain.linearRampToValueAtTime(0, t0 + ringDur + 0.012);

  ringOsc.connect(ringGain);
  ringGain.connect(g.dryBus);
  const stopAt = t0 + ringDur + 0.025;
  ringOsc.start(t0 + 0.012);
  ringOsc.stop(stopAt);
  ctx.registerTransientNodes([ringOsc, ringGain], stopAt + 0.05);
}

export function playRicochetSnap(
  ctx: SynthContext,
  origin: Vec3Like,
  listenerPos: Vec3Like,
  listenerYawDeg: number,
  pannerModel: PanningModelType,
  reverbWetMix: number,
): void {
  const g = ctx.graph;
  const t0 = g.ctx.currentTime;
  const chain = g.createSpatialChain(
    origin,
    listenerPos,
    listenerYawDeg,
    pannerModel,
    reverbWetMix * 0.85,
    { refDistanceM: 1.6, maxDistanceM: 65.0, rolloffFactor: 1.1 },
  );
  synthesizeRicochetWhine(ctx, chain.input, t0, 0.95, 2350, 640, 0.22);
  synthesizeSteelZing(ctx, chain.input, t0, 0.72);
}
