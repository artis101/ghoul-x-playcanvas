import {
  AnatomicalColliderVolume,
  TargetHealthState,
  Vec3Like,
} from '../../../contracts/ballistics.ts';
import { ALL_GHOUL_ZONES } from '../../ghoul/anatomy.ts';
import {
  add,
  dot,
  length,
  normalize,
  scale,
  sub,
  vec3,
} from '../vec3.ts';

export function intersectSegmentVolume(
  pA: Vec3Like,
  pB: Vec3Like,
  col: AnatomicalColliderVolume
): { tEntry: number; tExit: number; localNormal: Vec3Like } | null {
  const dir = sub(pB, pA);
  const segLen = length(dir);
  if (segLen < 1e-6) return null;
  const rayDir = scale(dir, 1 / segLen);

  if (col.shape === 'SPHERE') {
    const radius = col.halfExtents.x;
    const oc = sub(pA, col.localCenter);
    const b = dot(oc, rayDir);
    const c = dot(oc, oc) - radius * radius;
    const discr = b * b - c;
    if (discr < 0) return null;

    const sqrtD = Math.sqrt(discr);
    const t1 = -b - sqrtD;
    const t2 = -b + sqrtD;

    if (t2 < 0 || t1 > segLen) return null;

    const tEntryClamped = Math.max(0, t1);
    const tExitClamped = Math.min(segLen, t2);
    if (tEntryClamped > tExitClamped) return null;

    const entryPt = add(pA, scale(rayDir, tEntryClamped));
    const normal = normalize(sub(entryPt, col.localCenter));
    return {
      tEntry: tEntryClamped / segLen,
      tExit: tExitClamped / segLen,
      localNormal: normal,
    };
  } else if (col.shape === 'BOX') {
    const min = sub(col.localCenter, col.halfExtents);
    const max = add(col.localCenter, col.halfExtents);

    let tmin = 0;
    let tmax = segLen;
    let normalAxis = 0;
    let normalSign = 1;

    for (const axis of ['x', 'y', 'z'] as const) {
      const d = rayDir[axis];
      const p0 = pA[axis];
      if (Math.abs(d) < 1e-8) {
        if (p0 < min[axis] || p0 > max[axis]) return null;
      } else {
        const invD = 1 / d;
        let tNear = (min[axis] - p0) * invD;
        let tFar = (max[axis] - p0) * invD;
        let sign = -1;
        if (tNear > tFar) {
          const tmp = tNear;
          tNear = tFar;
          tFar = tmp;
          sign = 1;
        }
        if (tNear > tmin) {
          tmin = tNear;
          normalAxis = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
          normalSign = sign;
        }
        if (tFar < tmax) tmax = tFar;
        if (tmin > tmax) return null;
      }
    }

    if (tmax < 0 || tmin > segLen) return null;

    const norm = vec3(
      normalAxis === 0 ? normalSign : 0,
      normalAxis === 1 ? normalSign : 0,
      normalAxis === 2 ? normalSign : 0
    );

    return {
      tEntry: Math.max(0, tmin) / segLen,
      tExit: Math.min(segLen, tmax) / segLen,
      localNormal: norm,
    };
  } else if (col.shape === 'CAPSULE') {
    const radius = col.halfExtents.x;
    const pCenter = col.localCenter;

    const oc = sub(pA, pCenter);
    const dx = rayDir.x;
    const dz = rayDir.z;
    const ox = oc.x;
    const oz = oc.z;

    const aCyl = dx * dx + dz * dz;
    let t1 = 0;
    let t2 = segLen;

    if (aCyl > 1e-8) {
      const bCyl = 2 * (ox * dx + oz * dz);
      const cCyl = ox * ox + oz * oz - radius * radius;
      const discr = bCyl * bCyl - 4 * aCyl * cCyl;
      if (discr < 0) return null;
      const sqrtD = Math.sqrt(discr);
      t1 = (-bCyl - sqrtD) / (2 * aCyl);
      t2 = (-bCyl + sqrtD) / (2 * aCyl);
    } else if (ox * ox + oz * oz > radius * radius) {
      return null;
    }

    const minY = pCenter.y - col.halfExtents.y;
    const maxY = pCenter.y + col.halfExtents.y;

    if (Math.abs(rayDir.y) > 1e-8) {
      let ty1 = (minY - pA.y) / rayDir.y;
      let ty2 = (maxY - pA.y) / rayDir.y;
      if (ty1 > ty2) {
        const tmp = ty1;
        ty1 = ty2;
        ty2 = tmp;
      }
      t1 = Math.max(t1, ty1);
      t2 = Math.min(t2, ty2);
    } else if (pA.y < minY || pA.y > maxY) {
      return null;
    }

    if (t2 < 0 || t1 > segLen || t1 > t2) {
      return null;
    }

    const hitTEntry = Math.max(0, t1);
    const hitTExit = Math.min(segLen, t2);
    if (hitTEntry > hitTExit) {
      return null;
    }

    const hitPoint = add(pA, scale(rayDir, hitTEntry));
    const norm = normalize(vec3(hitPoint.x - pCenter.x, 0, hitPoint.z - pCenter.z));

    return {
      tEntry: hitTEntry / segLen,
      tExit: hitTExit / segLen,
      localNormal: norm.x === 0 && norm.z === 0 ? vec3(0, 1, 0) : norm,
    };
  }

  return null;
}

export function computeTargetLiveBounds(target: TargetHealthState): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const z of ALL_GHOUL_ZONES) {
    const b = target.ragdollBones[z];
    if (b.severed && b.goreMode === 'CRANIAL_POP') continue;
    const pad = 0.28;
    if (b.position.x - pad < minX) minX = b.position.x - pad;
    if (b.position.x + pad > maxX) maxX = b.position.x + pad;
    if (b.position.y - pad < minY) minY = b.position.y - pad;
    if (b.position.y + pad > maxY) maxY = b.position.y + pad;
    if (b.position.z - pad < minZ) minZ = b.position.z - pad;
    if (b.position.z + pad > maxZ) maxZ = b.position.z + pad;
  }

  return { minX, maxX, minY, maxY, minZ, maxZ };
}
