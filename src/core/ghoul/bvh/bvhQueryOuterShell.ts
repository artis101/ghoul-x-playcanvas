import { Vec3Like } from '../../../contracts/ballistics.ts';
import { Tier1ArmorPlateVolume, Tier1OuterShellVolume } from '../../../contracts/physiology.ts';
import { length, lerp, sub, vec3 } from '../../ballistics/vec3.ts';
import { aabbIntersectsSphere, intersectRayAabb } from './bvhRayAabb.ts';
import { pointToEllipsoidSignedDistanceApprox, pointToObbSignedDistance, signedDistanceToShape } from './bvhRayPrimitives.ts';
import { AxisAlignedBox, BvhGroupNode, RayIntervalHit } from './bvhTypes.ts';

export function intersectTier1Broadphase(
  originLocal: Vec3Like,
  dirLocal: Vec3Like,
  rootAabb: AxisAlignedBox,
  outerShellTree: readonly BvhGroupNode<Tier1OuterShellVolume>[],
  armorPlates: readonly { readonly aabb: AxisAlignedBox; readonly plate: Tier1ArmorPlateVolume }[]
): RayIntervalHit {
  const rootHit = intersectRayAabb(originLocal, dirLocal, rootAabb);
  if (!rootHit.hit) {
    return rootHit;
  }

  let minT = Infinity;
  let maxT = -Infinity;
  let anyHit = false;

  for (const group of outerShellTree) {
    const gHit = intersectRayAabb(originLocal, dirLocal, group.aabb);
    if (!gHit.hit) continue;
    for (const entry of group.items) {
      const iHit = intersectRayAabb(originLocal, dirLocal, entry.aabb);
      if (iHit.hit) {
        anyHit = true;
        if (iHit.tMin < minT) minT = iHit.tMin;
        if (iHit.tMax > maxT) maxT = iHit.tMax;
      }
    }
  }

  for (const pEntry of armorPlates) {
    const pHit = intersectRayAabb(originLocal, dirLocal, pEntry.aabb);
    if (pHit.hit) {
      anyHit = true;
      if (pHit.tMin < minT) minT = pHit.tMin;
      if (pHit.tMax > maxT) maxT = pHit.tMax;
    }
  }

  if (!anyHit) {
    return { hit: false, tMin: 0, tMax: 0 };
  }
  return { hit: true, tMin: Math.max(0, minT), tMax: maxT };
}

export function queryOuterShellAtPoint(
  pointLocal: Vec3Like,
  outerShellTree: readonly BvhGroupNode<Tier1OuterShellVolume>[]
): {
  insideBody: boolean;
  shellVolumes: Tier1OuterShellVolume[];
  baseDensityKgM3: number;
} {
  const shellVolumes: Tier1OuterShellVolume[] = [];
  let baseDensityKgM3 = 0;

  for (const group of outerShellTree) {
    if (!aabbIntersectsSphere(group.aabb, pointLocal, 0.002)) continue;
    for (const entry of group.items) {
      if (!aabbIntersectsSphere(entry.aabb, pointLocal, 0.002)) continue;
      const sd = signedDistanceToShape(
        pointLocal,
        entry.item.shape,
        entry.item.localCenter,
        entry.item.halfExtents,
        entry.item.capsuleStart,
        entry.item.capsuleEnd,
        entry.item.capsuleRadiusM,
        entry.item.basisRight,
        entry.item.basisUp,
        entry.item.basisForward
      );
      if (sd <= 0) {
        shellVolumes.push(entry.item);
        if (entry.item.densityKgM3 > baseDensityKgM3) {
          baseDensityKgM3 = entry.item.densityKgM3;
        }
      }
    }
  }

  return {
    insideBody: shellVolumes.length > 0,
    shellVolumes,
    baseDensityKgM3,
  };
}

export function queryArmorPlatesAlongSegment(
  segStartLocal: Vec3Like,
  segEndLocal: Vec3Like,
  armorPlates: readonly { readonly aabb: AxisAlignedBox; readonly plate: Tier1ArmorPlateVolume }[],
  enableArmorPlates = true,
  enableHelmet = true
): Tier1ArmorPlateVolume[] {
  const hits: Tier1ArmorPlateVolume[] = [];
  const mid = lerp(segStartLocal, segEndLocal, 0.5);
  const halfSegLen = 0.5 * length(sub(segEndLocal, segStartLocal)) + 0.004;

  for (const entry of armorPlates) {
    const plate = entry.plate;
    if (plate.id === 'HELMET_BALLISTIC_SHELL' && !enableHelmet) continue;
    if (plate.id !== 'HELMET_BALLISTIC_SHELL' && !enableArmorPlates) continue;
    if (!aabbIntersectsSphere(entry.aabb, mid, halfSegLen)) continue;

    if (plate.shape === 'SPHERE') {
      let hitHelmet = false;
      for (let i = 0; i <= 4; i++) {
        const pt = lerp(segStartLocal, segEndLocal, i * 0.25);
        if (pt.y < 1.665) continue;
        const outerSd = pointToEllipsoidSignedDistanceApprox(
          pt,
          plate.localCenter,
          plate.halfExtents
        );
        const innerRadii = vec3(
          plate.halfExtents.x - plate.thicknessM,
          plate.halfExtents.y - plate.thicknessM,
          plate.halfExtents.z - plate.thicknessM
        );
        const innerSd = pointToEllipsoidSignedDistanceApprox(pt, plate.localCenter, innerRadii);
        if (outerSd <= 0 && innerSd >= -0.003) {
          hitHelmet = true;
          break;
        }
      }
      if (hitHelmet) hits.push(plate);
      continue;
    }

    let hitPlate = false;
    for (let i = 0; i <= 4; i++) {
      const pt = lerp(segStartLocal, segEndLocal, i * 0.25);
      const { signedDistanceM, localCoords } = pointToObbSignedDistance(
        pt,
        plate.localCenter,
        plate.halfExtents,
        plate.basisRight,
        plate.basisUp,
        plate.basisForward
      );
      if (signedDistanceM <= 0) {
        if (plate.swimmerCutCornerFraction && plate.swimmerCutCornerFraction > 0) {
          const u = Math.abs(localCoords.x) / plate.halfExtents.x;
          const v = localCoords.y / plate.halfExtents.y;
          if (v > 0.35 && u + v > 2.0 - plate.swimmerCutCornerFraction * 2.0) {
            continue;
          }
        }
        hitPlate = true;
        break;
      }
    }
    if (hitPlate) {
      hits.push(plate);
    }
  }

  return hits;
}
