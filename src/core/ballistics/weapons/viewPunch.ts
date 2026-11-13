/**
 * View punch: the cheap FPS camera tricks that sell impact. A damped spring per axis takes an
 * impulse (a hit, a shot, a blast) and rings back to rest. Pure; the engine adds the result to
 * the camera angles and hands in the time step.
 */

export interface PunchAxis {
  value: number;
  velocity: number;
}

export interface ViewPunchState {
  readonly pitch: PunchAxis;
  readonly yaw: PunchAxis;
  readonly roll: PunchAxis;
  /** Field of view widening, degrees; springs back to 0. */
  readonly fov: PunchAxis;
}

export function createViewPunch(): ViewPunchState {
  return {
    pitch: { value: 0, velocity: 0 },
    yaw: { value: 0, velocity: 0 },
    roll: { value: 0, velocity: 0 },
    fov: { value: 0, velocity: 0 },
  };
}

/** Spring stiffness (1/s^2) and damping (1/s): snappy, slightly under-damped so it overshoots once. */
const STIFFNESS = 380;
const DAMPING = 24;
const FOV_STIFFNESS = 260;
const FOV_DAMPING = 22;
/** Beyond this the spring is clamped so stacked hits cannot spin the view. */
const MAX_ANGLE_DEG = 14;
const MAX_FOV_DEG = 10;

function stepAxis(axis: PunchAxis, dt: number, stiffness: number, damping: number): void {
  // Semi-implicit Euler, sub-stepped so a long frame cannot blow the spring up.
  const steps = Math.max(1, Math.ceil(dt / 0.008));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    axis.velocity += (-stiffness * axis.value - damping * axis.velocity) * h;
    axis.value += axis.velocity * h;
  }
}

export function stepViewPunch(state: ViewPunchState, dt: number): void {
  if (dt <= 0) return;
  stepAxis(state.pitch, dt, STIFFNESS, DAMPING);
  stepAxis(state.yaw, dt, STIFFNESS, DAMPING);
  stepAxis(state.roll, dt, STIFFNESS, DAMPING);
  stepAxis(state.fov, dt, FOV_STIFFNESS, FOV_DAMPING);
  state.pitch.value = clamp(state.pitch.value, MAX_ANGLE_DEG);
  state.yaw.value = clamp(state.yaw.value, MAX_ANGLE_DEG);
  state.roll.value = clamp(state.roll.value, MAX_ANGLE_DEG);
  state.fov.value = clamp(state.fov.value, MAX_FOV_DEG);
}

function clamp(v: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, v));
}

/** Peak angle of a kick is roughly impulse / 22; these are impulses in deg/s. */
export function addPunchImpulse(
  state: ViewPunchState,
  pitchDegPerS: number,
  yawDegPerS: number,
  rollDegPerS: number,
  fovDegPerS = 0
): void {
  state.pitch.velocity += pitchDegPerS;
  state.yaw.velocity += yawDegPerS;
  state.roll.velocity += rollDegPerS;
  state.fov.velocity += fovDegPerS;
}

export interface HitFlinch {
  /** Share of the punch that is also left in the aim as a real displacement, degrees (pitch, yaw). */
  readonly aimPitchDeg: number;
  readonly aimYawDeg: number;
  readonly pitchImpulse: number;
  readonly yawImpulse: number;
  readonly rollImpulse: number;
  readonly fovImpulse: number;
  /** Speed of the lingering aim wander the hit leaves behind, degrees per second. */
  readonly swayDegPerS: number;
}

/**
 * A hit flinch. `incomingRightness` is how far to the player's right the shot came from, -1..1
 * (it shoves the view the other way and rolls the head); `damageNorm` is 0..1 of what a hit can
 * do; u1 and u2 are uniform in [0, 1) and jitter the throw. The aim itself is knocked off target
 * by the returned aim deltas, which is the lost accuracy.
 */
export function hitFlinch(incomingRightness: number, damageNorm: number, u1: number, u2: number): HitFlinch {
  const d = Math.max(0, Math.min(1, damageNorm));
  const side = Math.max(-1, Math.min(1, incomingRightness));
  const strength = 0.9 + d * 1.4;
  // Hard and direct hits knock the aim much further than a graze.
  const aimKnock = 0.7 + d * 2.6;
  const jitterYaw = (u1 * 2 - 1) * 0.5;
  const jitterPitch = 0.6 + u2 * 0.4;
  return {
    // The muzzle is thrown up and away from the side the round came from.
    aimPitchDeg: aimKnock * 1.5 * jitterPitch,
    aimYawDeg: aimKnock * 1.8 * (-side * 0.8 + jitterYaw),
    pitchImpulse: strength * 150 * jitterPitch,
    yawImpulse: strength * 130 * (-side * 0.8 + jitterYaw),
    rollImpulse: strength * 190 * side,
    fovImpulse: strength * 70,
    swayDegPerS: 8 + d * 40,
  };
}
