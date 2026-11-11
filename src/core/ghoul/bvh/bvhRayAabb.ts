import { Vec3Like } from '../../../contracts/ballistics.ts';
import { add, copyVec3, length, sub, vec3 } from '../../ballistics/vec3.ts';
import { AxisAlignedBox, RayIntervalHit } from './bvhTypes.ts';

export function intersectRayAabb(
  origin: Vec3Like,
  dir: Vec3Like,
  aabb: AxisAlignedBox
): RayIntervalHit {
  let tMin = -Infinity;
  let tMax = Infinity;

  const axes: readonly ('x' | 'y' | 'z')[] = ['x', 'y', 'z'];
  for (const axis of axes) {
    const o = origin[axis];
    const d = dir[axis];
    const bMin = aabb.min[axis];
    const bMax = aabb.max[axis];

    if (Math.abs(d) < 1e-9) {
      if (o < bMin || o > bMax) {
        return { hit: false, tMin: 0, tMax: 0 };
      }
    } else {
      const invD = 1 / d;
      let t1 = (bMin - o) * invD;
      let t2 = (bMax - o) * invD;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) {
        return { hit: false, tMin: 0, tMax: 0 };
      }
    }
  }

  if (tMax < 0) {
    return { hit: false, tMin: 0, tMax: 0 };
  }
  return { hit: true, tMin: Math.max(0, tMin), tMax };
}

export function pointToAabbSignedDistance(p: Vec3Like, center: Vec3Like, half: Vec3Like): number {
  const qx = Math.abs(p.x - center.x) - half.x;
  const qy = Math.abs(p.y - center.y) - half.y;
  const qz = Math.abs(p.z - center.z) - half.z;
  const outX = Math.max(qx, 0);
  const outY = Math.max(qy, 0);
  const outZ = Math.max(qz, 0);
  const outsideDist = Math.sqrt(outX * outX + outY * outY + outZ * outZ);
  const insideDist = Math.min(Math.max(qx, Math.max(qy, qz)), 0);
  return outsideDist + insideDist;
}

export function computePrimitiveAabb(
  shape: 'AABB' | 'OBB' | 'CAPSULE' | 'SPHERE',
  center: Vec3Like,
  halfExtents: Vec3Like,
  capsuleStart?: Vec3Like,
  capsuleEnd?: Vec3Like,
  capsuleRadiusM?: number
): AxisAlignedBox {
  if (shape === 'CAPSULE' && capsuleStart && capsuleEnd && capsuleRadiusM !== undefined) {
    return {
      min: {
        x: Math.min(capsuleStart.x, capsuleEnd.x) - capsuleRadiusM,
        y: Math.min(capsuleStart.y, capsuleEnd.y) - capsuleRadiusM,
        z: Math.min(capsuleStart.z, capsuleEnd.z) - capsuleRadiusM,
      },
      max: {
        x: Math.max(capsuleStart.x, capsuleEnd.x) + capsuleRadiusM,
        y: Math.max(capsuleStart.y, capsuleEnd.y) + capsuleRadiusM,
        z: Math.max(capsuleStart.z, capsuleEnd.z) + capsuleRadiusM,
      },
    };
  }
  const pad = shape === 'OBB' ? length(halfExtents) : 0;
  if (shape === 'OBB') {
    return {
      min: { x: center.x - pad, y: center.y - pad, z: center.z - pad },
      max: { x: center.x + pad, y: center.y + pad, z: center.z + pad },
    };
  }
  return {
    min: sub(center, halfExtents),
    max: add(center, halfExtents),
  };
}

export function mergeAabbs(boxes: readonly AxisAlignedBox[]): AxisAlignedBox {
  if (boxes.length === 0) {
    return { min: vec3(0, 0, 0), max: vec3(0, 0, 0) };
  }
  const min = copyVec3(boxes[0].min);
  const max = copyVec3(boxes[0].max);
  for (let i = 1; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.min.x < min.x) min.x = b.min.x;
    if (b.min.y < min.y) min.y = b.min.y;
    if (b.min.z < min.z) min.z = b.min.z;
    if (b.max.x > max.x) max.x = b.max.x;
    if (b.max.y > max.y) max.y = b.max.y;
    if (b.max.z > max.z) max.z = b.max.z;
  }
  return { min, max };
}

export function aabbIntersectsSphere(aabb: AxisAlignedBox, center: Vec3Like, radius: number): boolean {
  const dx = Math.max(aabb.min.x - center.x, 0, center.x - aabb.max.x);
  const dy = Math.max(aabb.min.y - center.y, 0, center.y - aabb.max.y);
  const dz = Math.max(aabb.min.z - center.z, 0, center.z - aabb.max.z);
  return dx * dx + dy * dy + dz * dz <= radius * radius;
}
