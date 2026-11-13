import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { QuatLike } from '../../contracts/destruction.ts';
import { getWeaponAdsProfile } from '../ballistics/weapons/adsProfiles.ts';
import { WEAPON_MAP } from '../ballistics/weapons/weaponSpecs.ts';

/**
 * Enemy weapon sway: the small, ever-moving offset between where a combatant means to aim and
 * where the gun actually points. The same offset bends the held weapon on screen and the bullet,
 * so a shot always leaves along the barrel the player can see.
 *
 * Everything here is time-driven and deterministic: each combatant's phases come from a hash of
 * its id, and nothing calls Math.random. Angles are radians; positive yaw turns the muzzle the
 * way a growing heading turns (from +Z toward +X), positive pitch lifts the muzzle.
 */

export type SwayHold = 'RIFLE_SHOULDERED' | 'PISTOL_TWO_HAND' | 'PISTOL_ONE_HAND';
export type SwayPosture = 'STANDING' | 'KNEELING' | 'SEATED' | 'LYING';
export type SwayResolveProfile = 'HARDENED_VETERAN' | 'GRITTY_REGULAR' | 'PANICKED_SCRAPPER' | 'FANATIC_BERSERKER';

export interface WeaponSwayConditions {
  readonly hold: SwayHold;
  readonly posture: SwayPosture;
  /** 0..1 */
  readonly painShock: number;
  /** Share of the blood volume already lost, 0..1. */
  readonly bloodLossFraction: number;
  /** 0..1 */
  readonly consciousness: number;
  readonly heartRateBpm: number;
  readonly resolveProfile: SwayResolveProfile;
  /** The gun arm itself is hurt: it shakes more. */
  readonly gunArmWounded?: boolean;
}

export interface WeaponSwayOffset {
  yawRad: number;
  pitchRad: number;
}

export interface WeaponSwayState {
  readonly seed: number;
  breathPhase: number;
  beatPhase: number;
  phaseAtS: number;
  recoilYawRad: number;
  recoilPitchRad: number;
  recoilAtS: number;
  recoilRecoveryPerS: number;
  /** When the aim last came up, or null while the gun is down. */
  aimRaisedAtS: number | null;
  raiseCount: number;
  shotCount: number;
}

export interface RecoilKick {
  /** Muzzle climb per shot. */
  readonly pitchRad: number;
  /** Sideways throw per shot; successive shots alternate sides, as the player's do. */
  readonly yawRad: number;
}

const DEG = Math.PI / 180;

// How far the gun wanders at rest, roughly its peak: a shouldered long gun is braced against the
// shoulder and cheek, a pistol hangs off the hands alone, one hand worst of all.
export const HOLD_BASE_SWAY_RAD: Readonly<Record<SwayHold, number>> = {
  RIFLE_SHOULDERED: 0.45 * DEG,
  PISTOL_TWO_HAND: 0.8 * DEG,
  PISTOL_ONE_HAND: 1.05 * DEG,
};

// Kneeling braces the elbow on the knee; sitting or lying on the floor with a wounded body is
// shakier than standing, since the shooter is propped on one arm.
const POSTURE_SWAY: Readonly<Record<SwayPosture, number>> = {
  STANDING: 1.0,
  KNEELING: 0.7,
  SEATED: 1.45,
  LYING: 1.3,
};

// Hardened veterans hold steadier; panicked scrappers shake.
const PROFILE_SWAY: Readonly<Record<SwayResolveProfile, number>> = {
  HARDENED_VETERAN: 0.75,
  GRITTY_REGULAR: 1.0,
  PANICKED_SCRAPPER: 1.35,
  FANATIC_BERSERKER: 1.1,
};

// Resting breaths per second, before wounds quicken them.
const PROFILE_BREATH_HZ: Readonly<Record<SwayResolveProfile, number>> = {
  HARDENED_VETERAN: 0.22,
  GRITTY_REGULAR: 0.25,
  PANICKED_SCRAPPER: 0.33,
  FANATIC_BERSERKER: 0.29,
};

/** The wander amplitude never grows past this (peaks run about a quarter over it), however badly hurt. */
export const MAX_SWAY_RAD = 3.5 * DEG;
const MAX_WANDER_RAD = MAX_SWAY_RAD * 1.25;
// Right after the gun comes up it overshoots and settles over about a second.
const SETTLE_TIME_S = 0.38;
const SETTLE_HZ = 1.4;
const SETTLE_GAIN = 1.2;

// Recoil is the player's own model (playerCameraRig.applyRecoilKick), so a gun kicks the same
// whoever holds it: each shot lifts the muzzle by 0.72 of the weapon's recoilKickDeg and throws
// it 0.11 of that sideways, alternating sides; a braced (aimed) hold scales both by the weapon's
// adsRecoilScale. The climb stops at 8 degrees, the sideways throw at 2.2, and the muzzle falls
// back at the player's camera recovery rate.
const MAX_RECOIL_PITCH_RAD = 8 * DEG;
const MAX_RECOIL_YAW_RAD = 2.2 * DEG;
const RECOIL_PITCH_SHARE = 0.72;
const RECOIL_YAW_SHARE = 0.11;
export const PLAYER_RECOIL_RECOVERY_PER_S = 15;
const BASE_RECOVERY_PER_S = PLAYER_RECOIL_RECOVERY_PER_S;
// The backup M9 has no player spec; a 9 mm service pistol kicks about half a .50 AE.
const M9_RECOIL_KICK_DEG = 3.2;

/** The kick of one shot for a weapon held a given way, from the same numbers the player uses. */
export function recoilKickForWeapon(weaponId: string, hold: SwayHold = 'RIFLE_SHOULDERED'): RecoilKick {
  const spec = WEAPON_MAP[weaponId];
  const kickDeg = spec?.recoilKickDeg ?? (weaponId === 'weapon_beretta_m9' ? M9_RECOIL_KICK_DEG : 2.5);
  const adsId = spec ? weaponId : 'silver_talon_50ae';
  // A one-handed pistol has nothing bracing it, like the player firing from the hip.
  const brace = hold === 'PISTOL_ONE_HAND' ? 1 : getWeaponAdsProfile(adsId).adsRecoilScale;
  return {
    pitchRad: kickDeg * RECOIL_PITCH_SHARE * brace * DEG,
    yawRad: kickDeg * RECOIL_YAW_SHARE * brace * DEG,
  };
}

/** FNV-1a over the id, so each combatant breathes on its own rhythm. */
export function hashSwaySeed(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A repeatable fraction in [0, 1) from a seed and a salt. */
function unit(seed: number, salt: number): number {
  let h = (seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function createWeaponSwayState(id: string, nowS = 0): WeaponSwayState {
  const seed = hashSwaySeed(id);
  return {
    seed,
    breathPhase: unit(seed, 1),
    beatPhase: unit(seed, 2),
    phaseAtS: nowS,
    recoilYawRad: 0,
    recoilPitchRad: 0,
    recoilAtS: nowS,
    recoilRecoveryPerS: BASE_RECOVERY_PER_S,
    aimRaisedAtS: null,
    raiseCount: 0,
    shotCount: 0,
  };
}

/** How badly the body's state shakes the hold; 1 when unhurt. */
export function woundSwayFactor(c: WeaponSwayConditions): number {
  return (
    1 +
    4 * clamp01(c.painShock) +
    6 * clamp01(c.bloodLossFraction) +
    8 * Math.max(0, 0.9 - clamp01(c.consciousness)) +
    (c.gunArmWounded ? 1.2 : 0)
  );
}

/** The wander amplitude for these conditions, before the settle-in and recoil are added. */
export function holdSwayAmplitudeRad(c: WeaponSwayConditions): number {
  const amp =
    HOLD_BASE_SWAY_RAD[c.hold] * POSTURE_SWAY[c.posture] * PROFILE_SWAY[c.resolveProfile] * woundSwayFactor(c);
  return Math.min(MAX_SWAY_RAD, amp);
}

/** Starts or ends the settle-in: call every tick with whether the gun is up and aimed. */
export function noteAimRaised(state: WeaponSwayState, aiming: boolean, nowS: number): void {
  if (aiming && state.aimRaisedAtS === null) {
    state.aimRaisedAtS = nowS;
    state.raiseCount++;
  } else if (!aiming) {
    state.aimRaisedAtS = null;
  }
}

/** The recoil still in the muzzle at a moment; it falls away exponentially after each shot. */
export function recoilAt(state: WeaponSwayState, nowS: number): WeaponSwayOffset {
  const decay = Math.exp(-state.recoilRecoveryPerS * Math.max(0, nowS - state.recoilAtS));
  return { yawRad: state.recoilYawRad * decay, pitchRad: state.recoilPitchRad * decay };
}

/**
 * Adds one shot's kick. An unhurt, steady, two-handed shooter recovers at the player's rate;
 * wounds, nerves and a one-handed hold slow the muzzle's return.
 */
export function kickWeaponSway(
  state: WeaponSwayState,
  kick: RecoilKick,
  c: WeaponSwayConditions,
  nowS: number,
): void {
  const left = recoilAt(state, nowS);
  // The player's first shot throws left (the sign flips before the kick), then alternates.
  const side = state.shotCount % 2 === 0 ? -1 : 1;
  state.shotCount++;
  state.recoilPitchRad = Math.min(MAX_RECOIL_PITCH_RAD, left.pitchRad + kick.pitchRad);
  state.recoilYawRad = clampAbs(left.yawRad + kick.yawRad * side, MAX_RECOIL_YAW_RAD);
  state.recoilAtS = nowS;
  const steadiness = PROFILE_SWAY.GRITTY_REGULAR / PROFILE_SWAY[c.resolveProfile];
  const oneHand = c.hold === 'PISTOL_ONE_HAND' ? 0.7 : 1;
  state.recoilRecoveryPerS =
    (BASE_RECOVERY_PER_S * Math.sqrt(steadiness) * oneHand) / (1 + clamp01(c.painShock) + clamp01(c.bloodLossFraction));
}

/**
 * The gun's offset from the intended aim at `nowS`: breathing (a slow figure eight, mostly up and
 * down), a twitch on each heartbeat, a slow drift, a fine tremor that grows with blood loss and
 * fading consciousness, the settle-in after raising the aim, and recoil still being recovered.
 * Advances the breath and heartbeat phases, so call it with a time that never runs backwards.
 */
export function sampleWeaponSway(
  state: WeaponSwayState,
  c: WeaponSwayConditions,
  nowS: number,
): WeaponSwayOffset {
  const step = Math.max(0, nowS - state.phaseAtS);
  if (nowS > state.phaseAtS) state.phaseAtS = nowS;
  // Wounds and fear quicken the breath; the phase is integrated so a rate change never jumps.
  const breathHz = Math.min(
    0.6,
    PROFILE_BREATH_HZ[c.resolveProfile] * (1 + 0.8 * clamp01(c.painShock) + clamp01(c.bloodLossFraction)),
  );
  const beatHz = Math.min(3.5, Math.max(0.6, (c.heartRateBpm || 72) / 60));
  state.breathPhase = (state.breathPhase + step * breathHz) % 1;
  state.beatPhase = (state.beatPhase + step * beatHz) % 1;

  const amp = holdSwayAmplitudeRad(c);
  const seed = state.seed;
  const breath = state.breathPhase * Math.PI * 2;
  let pitch = 0.8 * Math.sin(breath);
  let yaw = 0.45 * Math.sin(2 * breath);

  // Each beat jolts the hands once, then the twitch dies away within the beat.
  const beatPulse = Math.exp(-state.beatPhase * 14) - 1 / 14;
  pitch += 0.14 * beatPulse;
  yaw += 0.07 * beatPulse * (unit(seed, 3) < 0.5 ? -1 : 1);

  const t = nowS;
  yaw += 0.25 * Math.sin(t * 2 * Math.PI * 0.11 + unit(seed, 4) * 6.283);
  pitch += 0.18 * Math.sin(t * 2 * Math.PI * 0.07 + unit(seed, 5) * 6.283);

  const tremor = 0.04 + 0.16 * clamp01(c.bloodLossFraction) + 0.2 * Math.max(0, 1 - clamp01(c.consciousness));
  yaw += tremor * Math.sin(t * 2 * Math.PI * 6.1 + unit(seed, 6) * 6.283);
  pitch += tremor * Math.sin(t * 2 * Math.PI * 9.7 + unit(seed, 7) * 6.283);

  yaw *= amp;
  pitch *= amp;
  // The layers can line up; keep the worst moment within a quarter of the cap.
  const wander = Math.hypot(yaw, pitch);
  if (wander > MAX_WANDER_RAD) {
    yaw *= MAX_WANDER_RAD / wander;
    pitch *= MAX_WANDER_RAD / wander;
  }

  if (state.aimRaisedAtS !== null) {
    const since = Math.max(0, nowS - state.aimRaisedAtS);
    const settle = SETTLE_GAIN * amp * Math.exp(-since / SETTLE_TIME_S) * Math.cos(since * 2 * Math.PI * SETTLE_HZ);
    const angle = unit(seed, 200 + state.raiseCount) * Math.PI * 2;
    yaw += settle * Math.cos(angle);
    // Mostly arriving from below, as a gun swung up overshoots and drops back onto the target.
    pitch -= settle * Math.abs(Math.sin(angle));
  }

  const recoil = recoilAt(state, nowS);
  return { yawRad: yaw + recoil.yawRad, pitchRad: pitch + recoil.pitchRad };
}

/** Turns a direction by a sway offset: heading by the yaw, then elevation by the pitch. */
export function applySwayToDirection(dir: Vec3Like, offset: WeaponSwayOffset): Vec3Like {
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (len < 1e-9) return { x: dir.x, y: dir.y, z: dir.z };
  const heading = Math.atan2(dir.x, dir.z) + offset.yawRad;
  const limit = 89 * DEG;
  const elevation = Math.max(-limit, Math.min(limit, Math.asin(Math.max(-1, Math.min(1, dir.y / len))) + offset.pitchRad));
  const flat = Math.cos(elevation) * len;
  return { x: Math.sin(heading) * flat, y: Math.sin(elevation) * len, z: Math.cos(heading) * flat };
}

/**
 * The rotation that carries `barrel` onto `applySwayToDirection(barrel, offset)`: a pitch about
 * the barrel's own horizontal right axis, then a yaw about +Y. Used to swing a held weapon model.
 */
export function swayRotationForBarrel(barrel: Vec3Like, offset: WeaponSwayOffset): QuatLike {
  let ax = barrel.z;
  let az = -barrel.x;
  const flat = Math.hypot(ax, az);
  if (flat < 1e-6) {
    ax = 1;
    az = 0;
  } else {
    ax /= flat;
    az /= flat;
  }
  // The pitch axis is cross(up, barrel) = (z, 0, -x); turning about it by a negative angle lifts
  // the barrel inside its own vertical plane, so only the elevation changes.
  const ps = Math.sin(-offset.pitchRad / 2);
  const pitchQ: QuatLike = { x: ax * ps, y: 0, z: az * ps, w: Math.cos(-offset.pitchRad / 2) };
  const yawQ: QuatLike = { x: 0, y: Math.sin(offset.yawRad / 2), z: 0, w: Math.cos(offset.yawRad / 2) };
  return multiplyQuat(yawQ, pitchQ);
}

export function multiplyQuat(a: QuatLike, b: QuatLike): QuatLike {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

function clampAbs(v: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, v));
}
