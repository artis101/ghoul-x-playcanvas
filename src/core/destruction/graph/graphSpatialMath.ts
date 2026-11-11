import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { QuatLike } from '../../../contracts/destruction.ts';
import type { WallTransformLike } from './connectivityTypes.ts';

const IDENTITY_ROTATION: Readonly<QuatLike> = { x: 0, y: 0, z: 0, w: 1 };

export function rotateVec3ByQuat(v: Vec3Like, q: QuatLike = IDENTITY_ROTATION): Vec3Like {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);

  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

export function inverseRotateVec3ByQuat(
  v: Vec3Like,
  q: QuatLike = IDENTITY_ROTATION,
): Vec3Like {
  const tx = 2 * (-q.y * v.z + q.z * v.y);
  const ty = 2 * (-q.z * v.x + q.x * v.z);
  const tz = 2 * (-q.x * v.y + q.y * v.x);

  return {
    x: v.x + q.w * tx + (-q.y * tz + q.z * ty),
    y: v.y + q.w * ty + (-q.z * tx + q.x * tz),
    z: v.z + q.w * tz + (-q.x * ty + q.y * tx),
  };
}

export function localToWorldPoint(
  localPoint: Vec3Like,
  transform: WallTransformLike,
): Vec3Like {
  const rotated = rotateVec3ByQuat(localPoint, transform.rotation ?? IDENTITY_ROTATION);
  return {
    x: transform.position.x + rotated.x,
    y: transform.position.y + rotated.y,
    z: transform.position.z + rotated.z,
  };
}

export function worldToLocalPoint(
  worldPoint: Vec3Like,
  transform: WallTransformLike,
): Vec3Like {
  const translated: Vec3Like = {
    x: worldPoint.x - transform.position.x,
    y: worldPoint.y - transform.position.y,
    z: worldPoint.z - transform.position.z,
  };
  return inverseRotateVec3ByQuat(translated, transform.rotation ?? IDENTITY_ROTATION);
}
