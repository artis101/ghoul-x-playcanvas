import * as RAPIER from '@dimforge/rapier3d-compat';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { ColliderSurfaceTag, PenetrationRayHit } from '../../../contracts/destruction.ts';

export function executePenetrationRay(
  world: RAPIER.World,
  surfaceTags: Map<number, ColliderSurfaceTag>,
  origin: Vec3Like,
  dirNormalized: Vec3Like,
  maxDistM: number,
  scratchRay: RAPIER.Ray | null
): { hits: PenetrationRayHit[]; ray: RAPIER.Ray } {
  if (maxDistM <= 0) return { hits: [], ray: scratchRay || new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }) };

  const dirLenSq = dirNormalized.x * dirNormalized.x + dirNormalized.y * dirNormalized.y + dirNormalized.z * dirNormalized.z;
  if (dirLenSq < 1e-12) return { hits: [], ray: scratchRay || new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }) };

  const invLen = 1 / Math.sqrt(dirLenSq);
  const dx = dirNormalized.x * invLen;
  const dy = dirNormalized.y * invLen;
  const dz = dirNormalized.z * invLen;

  let ray = scratchRay;
  if (!ray) {
    ray = new RAPIER.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: dx, y: dy, z: dz });
  } else {
    ray.origin.x = origin.x;
    ray.origin.y = origin.y;
    ray.origin.z = origin.z;
    ray.dir.x = dx;
    ray.dir.y = dy;
    ray.dir.z = dz;
  }

  const hits: PenetrationRayHit[] = [];

  world.intersectionsWithRay(ray, maxDistM, true, (intersection) => {
    const handle = intersection.collider.handle;
    const surface = surfaceTags.get(handle);
    if (surface) {
      const toi = Math.max(0, intersection.timeOfImpact);
      const rawNormal = intersection.normal;
      const nLenSq = rawNormal.x * rawNormal.x + rawNormal.y * rawNormal.y + rawNormal.z * rawNormal.z;

      let nx = -dx, ny = -dy, nz = -dz;
      if (nLenSq > 1e-10) {
        const invN = 1 / Math.sqrt(nLenSq);
        nx = rawNormal.x * invN;
        ny = rawNormal.y * invN;
        nz = rawNormal.z * invN;
      }

      hits.push({
        colliderHandle: handle,
        pointWorld: {
          x: origin.x + dx * toi,
          y: origin.y + dy * toi,
          z: origin.z + dz * toi,
        },
        normalWorld: { x: nx, y: ny, z: nz },
        distanceM: toi,
        surface,
      });
    }
    return true;
  });

  hits.sort((a, b) => (a.distanceM !== b.distanceM ? a.distanceM - b.distanceM : a.colliderHandle - b.colliderHandle));
  return { hits, ray };
}

export function testAnyBlockingHit(
  world: RAPIER.World,
  surfaceTags: Map<number, ColliderSurfaceTag>,
  origin: Vec3Like,
  dirNormalized: Vec3Like,
  maxDistM: number,
  isBlocking: (surface: ColliderSurfaceTag, pointWorld: Vec3Like, distanceM: number) => boolean,
  scratchRay: RAPIER.Ray | null,
  scratchPt: Vec3Like
): { blocked: boolean; ray: RAPIER.Ray } {
  if (maxDistM <= 0) return { blocked: false, ray: scratchRay || new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }) };

  const dirLenSq = dirNormalized.x * dirNormalized.x + dirNormalized.y * dirNormalized.y + dirNormalized.z * dirNormalized.z;
  if (dirLenSq < 1e-12) return { blocked: false, ray: scratchRay || new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }) };

  const invLen = 1 / Math.sqrt(dirLenSq);
  const dx = dirNormalized.x * invLen;
  const dy = dirNormalized.y * invLen;
  const dz = dirNormalized.z * invLen;

  let ray = scratchRay;
  if (!ray) {
    ray = new RAPIER.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: dx, y: dy, z: dz });
  } else {
    ray.origin.x = origin.x;
    ray.origin.y = origin.y;
    ray.origin.z = origin.z;
    ray.dir.x = dx;
    ray.dir.y = dy;
    ray.dir.z = dz;
  }

  let blocked = false;
  world.intersectionsWithRay(ray, maxDistM, true, (intersection) => {
    const handle = intersection.collider.handle;
    const surface = surfaceTags.get(handle);
    if (!surface) return true;
    const toi = Math.max(0, intersection.timeOfImpact);
    if (toi > maxDistM) return true;

    scratchPt.x = origin.x + dx * toi;
    scratchPt.y = origin.y + dy * toi;
    scratchPt.z = origin.z + dz * toi;

    if (isBlocking(surface, scratchPt, toi)) {
      blocked = true;
      return false;
    }
    return true;
  });

  return { blocked, ray };
}
