import { Vec3Like } from '../../contracts/ballistics.ts';

export type { Vec3Like };

export function vec3(x = 0, y = 0, z = 0): Vec3Like {
  return { x, y, z };
}

export function copyVec3(v: Vec3Like): Vec3Like {
  return { x: v.x, y: v.y, z: v.z };
}

export function add(a: Vec3Like, b: Vec3Like): Vec3Like {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3Like, b: Vec3Like): Vec3Like {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(v: Vec3Like, s: number): Vec3Like {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function dot(a: Vec3Like, b: Vec3Like): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3Like, b: Vec3Like): Vec3Like {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function lengthSq(v: Vec3Like): number {
  return v.x * v.x + v.y * v.y + v.z * v.z;
}

export function length(v: Vec3Like): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export function normalize(v: Vec3Like): Vec3Like {
  const len = length(v);
  if (len === 0 || !Number.isFinite(len)) {
    return { x: 0, y: 0, z: 0 };
  }
  const inv = 1 / len;
  return { x: v.x * inv, y: v.y * inv, z: v.z * inv };
}

export function distance(a: Vec3Like, b: Vec3Like): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function lerp(a: Vec3Like, b: Vec3Like, t: number): Vec3Like {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

/** A vector the in-place helpers below write into. Every helper returns `out`; `out` may be one of the inputs. */
export type MutableVec3 = Vec3Like;

export function setVec3(out: MutableVec3, x: number, y: number, z: number): MutableVec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function copyInto(out: MutableVec3, v: Vec3Like): MutableVec3 {
  out.x = v.x;
  out.y = v.y;
  out.z = v.z;
  return out;
}

export function addInto(out: MutableVec3, a: Vec3Like, b: Vec3Like): MutableVec3 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  out.z = a.z + b.z;
  return out;
}

export function subInto(out: MutableVec3, a: Vec3Like, b: Vec3Like): MutableVec3 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
}

export function scaleInto(out: MutableVec3, v: Vec3Like, s: number): MutableVec3 {
  out.x = v.x * s;
  out.y = v.y * s;
  out.z = v.z * s;
  return out;
}

/** out = a + b * s, with the same rounding as add(a, scale(b, s)). */
export function addScaledInto(out: MutableVec3, a: Vec3Like, b: Vec3Like, s: number): MutableVec3 {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  out.z = a.z + b.z * s;
  return out;
}

export function crossInto(out: MutableVec3, a: Vec3Like, b: Vec3Like): MutableVec3 {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/** Same result as normalize(v), including the zero vector for a zero or non-finite length. */
export function normalizeInto(out: MutableVec3, v: Vec3Like): MutableVec3 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len === 0 || !Number.isFinite(len)) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return out;
  }
  const inv = 1 / len;
  out.x = v.x * inv;
  out.y = v.y * inv;
  out.z = v.z * inv;
  return out;
}

export function lerpInto(out: MutableVec3, a: Vec3Like, b: Vec3Like, t: number): MutableVec3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

export function distanceSq(a: Vec3Like, b: Vec3Like): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export function reflect(v: Vec3Like, normal: Vec3Like): Vec3Like {
  const d = dot(v, normal);
  return {
    x: v.x - 2 * d * normal.x,
    y: v.y - 2 * d * normal.y,
    z: v.z - 2 * d * normal.z,
  };
}

/**
 * Rodrigues' rotation formula rotating vector `v` around unit axis `axis` by angle `angleRad`.
 */
export function rotateAroundAxis(v: Vec3Like, axis: Vec3Like, angleRad: number): Vec3Like {
  const k = normalize(axis);
  const cosTheta = Math.cos(angleRad);
  const sinTheta = Math.sin(angleRad);

  // v * cosTheta + (k x v) * sinTheta + k * (k . v) * (1 - cosTheta)
  const crossKV = cross(k, v);
  const dotKV = dot(k, v);
  const oneMinusCos = 1 - cosTheta;

  return {
    x: v.x * cosTheta + crossKV.x * sinTheta + k.x * dotKV * oneMinusCos,
    y: v.y * cosTheta + crossKV.y * sinTheta + k.y * dotKV * oneMinusCos,
    z: v.z * cosTheta + crossKV.z * sinTheta + k.z * dotKV * oneMinusCos,
  };
}

/**
 * Deterministic pseudo-random / golden-ratio spiral cone spread for pellets.
 * Produces realistic, non-degenerate shotgun pellet dispersion within spreadRad cone.
 */
export function deterministicConeSpread(
  aimDir: Vec3Like,
  spreadRad: number,
  pelletIndex: number,
  pelletCount: number,
  seed = 1337
): Vec3Like {
  const forward = normalize(aimDir);
  if (spreadRad <= 0 || pelletCount <= 1) {
    return forward;
  }

  // Golden spiral distribution on circular disk
  const goldenRatio = 1.618033988749895;
  // Pellet 0 stays near the central bore axis while pellets 1..N-1 fan out across the full cone
  const rNorm =
    pelletIndex === 0
      ? 0.05
      : Math.sqrt(pelletIndex / Math.max(1, pelletCount - 1));
  const theta = 2 * Math.PI * (pelletIndex * goldenRatio + (seed % 1000) / 1000);

  const radius = rNorm * spreadRad;
  const offX = Math.cos(theta) * radius;
  const offY = Math.sin(theta) * radius;

  // Build orthonormal basis (forward, right, up)
  const arbitraryUp = Math.abs(forward.y) < 0.999 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const right = normalize(cross(arbitraryUp, forward));
  const up = cross(forward, right);

  // Combine
  const spreadDir = add(forward, add(scale(right, offX), scale(up, offY)));
  return normalize(spreadDir);
}
