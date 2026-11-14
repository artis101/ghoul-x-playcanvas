/**
 * Writes a column-major 4x4 TRS world matrix directly into `out[offset16 .. offset16 + 15]`
 * matching PlayCanvas `pc.Mat4.setTRS` and `pc.VertexFormat.getDefaultInstancingFormat`
 * with zero temporary heap allocations.
 */
export function writeColumnMajorTrsMatrix4(
  out: Float32Array,
  offset16: number,
  tx: number,
  ty: number,
  tz: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  sx = 1,
  sy = 1,
  sz = 1
): void {
  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;

  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;

  out[offset16 + 0] = (1 - (yy + zz)) * sx;
  out[offset16 + 1] = (xy + wz) * sx;
  out[offset16 + 2] = (xz - wy) * sx;
  out[offset16 + 3] = 0;

  out[offset16 + 4] = (xy - wz) * sy;
  out[offset16 + 5] = (1 - (xx + zz)) * sy;
  out[offset16 + 6] = (yz + wx) * sy;
  out[offset16 + 7] = 0;

  out[offset16 + 8] = (xz + wy) * sz;
  out[offset16 + 9] = (yz - wx) * sz;
  out[offset16 + 10] = (1 - (xx + yy)) * sz;
  out[offset16 + 11] = 0;

  out[offset16 + 12] = tx;
  out[offset16 + 13] = ty;
  out[offset16 + 14] = tz;
  out[offset16 + 15] = 1;
}

export const DEFAULT_RESTITUTION = 0.2;
export const DEFAULT_FRICTION = 0.65;
export const DEFAULT_LINEAR_DAMPING = 0.24;
export const DEFAULT_ANGULAR_DAMPING = 0.36;
export const CCD_SPEED_THRESHOLD_SQ = 12 * 12;
export const SLEEP_LINEAR_SPEED_SQ = 0.08 * 0.08;
export const SLEEP_ANGULAR_SPEED_SQ = 0.18 * 0.18;
export const SLEEP_SETTLE_DURATION_S = 0.45;
export const MAX_STEP_DT = 1 / 10;
export const TARGET_SUBSTEP_DT = 1 / 60;
export const MAX_SUBSTEPS = 6;
/**
 * A frame may run up to this fraction of a substep long before it is split into one more substep.
 * Display frames jitter around 1/60 s; without the slack every frame a hair over it steps twice.
 */
export const SUBSTEP_SPLIT_SLACK = 0.25;
