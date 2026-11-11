import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { QuatLike } from '../../../contracts/destruction.ts';
import { cross, length, normalize, vec3 } from '../../../core/ballistics/vec3.ts';

export function basisColumnsToQuaternion(
  tx: number,
  ty: number,
  tz: number,
  bx: number,
  by: number,
  bz: number,
  nx: number,
  ny: number,
  nz: number,
): QuatLike {
  const m00 = tx;
  const m10 = ty;
  const m20 = tz;
  const m01 = bx;
  const m11 = by;
  const m21 = bz;
  const m02 = nx;
  const m12 = ny;
  const m22 = nz;

  const trace = m00 + m11 + m22;
  let qx: number;
  let qy: number;
  let qz: number;
  let qw: number;

  if (trace > 0) {
    const s = Math.sqrt(trace + 1.0) * 2.0;
    qw = 0.25 * s;
    qx = (m21 - m12) / s;
    qy = (m02 - m20) / s;
    qz = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1.0 + m00 - m11 - m22) * 2.0;
    qw = (m21 - m12) / s;
    qx = 0.25 * s;
    qy = (m01 + m10) / s;
    qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1.0 + m11 - m00 - m22) * 2.0;
    qw = (m02 - m20) / s;
    qx = (m01 + m10) / s;
    qy = 0.25 * s;
    qz = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1.0 + m22 - m00 - m11) * 2.0;
    qw = (m10 - m01) / s;
    qx = (m02 + m20) / s;
    qy = (m12 + m21) / s;
    qz = 0.25 * s;
  }

  const len = Math.hypot(qx, qy, qz, qw);
  if (len < 1e-8) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  const inv = 1 / len;
  return { x: qx * inv, y: qy * inv, z: qz * inv, w: qw * inv };
}

export function directionToStreakQuaternion(directionWorld: Vec3Like): QuatLike {
  const n = normalize(directionWorld);
  if (length(n) < 1e-6) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  const upRef = Math.abs(n.y) < 0.96 ? vec3(0, 1, 0) : vec3(1, 0, 0);
  const t = normalize(cross(upRef, n));
  const b = normalize(cross(n, t));
  return basisColumnsToQuaternion(t.x, t.y, t.z, b.x, b.y, b.z, n.x, n.y, n.z);
}

export function computeSurfaceAlignedQuadQuaternion(
  surfaceNormalWorld: Vec3Like,
  sprayDirectionWorld: Vec3Like,
  rollRad = 0,
): QuatLike {
  const n = normalize(surfaceNormalWorld);
  if (length(n) < 1e-6) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }

  let t0: Vec3Like;
  let b0: Vec3Like;

  if (Math.abs(n.y) < 0.95) {
    t0 = normalize(cross({ x: 0, y: 1, z: 0 }, n));
    b0 = normalize(cross(n, t0));
  } else {
    const horizSpray = { x: sprayDirectionWorld.x, y: 0, z: sprayDirectionWorld.z };
    const forwardOnFloor =
      length(horizSpray) > 1e-4 ? normalize(horizSpray) : { x: 0, y: 0, z: -1 };
    t0 = normalize(cross(forwardOnFloor, n));
    b0 = normalize(cross(n, t0));
  }

  const cosR = Math.cos(rollRad);
  const sinR = Math.sin(rollRad);

  const tx = t0.x * cosR + b0.x * sinR;
  const ty = t0.y * cosR + b0.y * sinR;
  const tz = t0.z * cosR + b0.z * sinR;

  const bx = -t0.x * sinR + b0.x * cosR;
  const by = -t0.y * sinR + b0.y * cosR;
  const bz = -t0.z * sinR + b0.z * cosR;

  return basisColumnsToQuaternion(tx, ty, tz, bx, by, bz, n.x, n.y, n.z);
}
