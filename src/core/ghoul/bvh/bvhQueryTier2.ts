import { Vec3Like } from '../../../contracts/ballistics.ts';
import {
  InternalOrganVolume,
  NeuralPlexusVolume,
  SkeletalBoneVolume,
  Tier2SpatialQueryResult,
} from '../../../contracts/physiology.ts';
import { length, lerp, sub } from '../../ballistics/vec3.ts';
import { aabbIntersectsSphere } from './bvhRayAabb.ts';
import {
  segmentMinSignedDistanceToShape,
  signedDistanceToShape,
} from './bvhRayPrimitives.ts';
import { closestDistanceBetweenSegments3D } from './bvhSplineMath.ts';
export { queryVascularSplinesAlongSegment } from './bvhQueryVascular.ts';
import { queryVascularSplinesAlongSegment } from './bvhQueryVascular.ts';
import { AxisAlignedBox, BakedVascularSpline } from './bvhTypes.ts';

export function queryTier2Step(
  segStartLocal: Vec3Like,
  segEndLocal: Vec3Like,
  crushRadiusM: number,
  stretchRadiusM: number,
  baseShellDensityKgM3: number,
  organs: readonly { readonly aabb: AxisAlignedBox; readonly organ: InternalOrganVolume }[],
  bones: readonly { readonly aabb: AxisAlignedBox; readonly bone: SkeletalBoneVolume }[],
  nerves: readonly { readonly aabb: AxisAlignedBox; readonly nerve: NeuralPlexusVolume }[],
  vascularSplines: readonly BakedVascularSpline[]
): Tier2SpatialQueryResult {
  const samplePointLocal = lerp(segStartLocal, segEndLocal, 0.5);
  const maxRadius = Math.max(crushRadiusM, stretchRadiusM);
  const segHalfLen = 0.5 * length(sub(segEndLocal, segStartLocal));
  const broadRadius = maxRadius + segHalfLen + 0.008;

  const directOrgans: InternalOrganVolume[] = [];
  const crushOrgans: InternalOrganVolume[] = [];
  const stretchOrgans: InternalOrganVolume[] = [];

  let organDensityOverride: number | null = null;
  for (const entry of organs) {
    if (!aabbIntersectsSphere(entry.aabb, samplePointLocal, broadRadius)) continue;
    const sd = segmentMinSignedDistanceToShape(
      segStartLocal,
      segEndLocal,
      entry.organ.shape,
      entry.organ.localCenter,
      entry.organ.halfExtents
    );
    if (sd <= 0) {
      directOrgans.push(entry.organ);
      if (organDensityOverride === null || entry.organ.densityKgM3 > organDensityOverride) {
        organDensityOverride = entry.organ.densityKgM3;
      }
    }
    if (sd <= crushRadiusM) {
      crushOrgans.push(entry.organ);
    }
    if (stretchRadiusM > 0 && sd <= stretchRadiusM) {
      stretchOrgans.push(entry.organ);
    }
  }

  const hitBones: SkeletalBoneVolume[] = [];
  for (const entry of bones) {
    if (!aabbIntersectsSphere(entry.aabb, samplePointLocal, crushRadiusM + segHalfLen + 0.005)) {
      continue;
    }
    const bone = entry.bone;
    if (bone.hollowInnerHalfExtents) {
      let intersectsCorticalShell = false;
      for (let i = 0; i <= 4; i++) {
        const pt = lerp(segStartLocal, segEndLocal, i * 0.25);
        const outerSd = signedDistanceToShape(
          pt,
          bone.shape,
          bone.localCenter,
          bone.halfExtents
        );
        const innerSd = signedDistanceToShape(
          pt,
          bone.shape,
          bone.localCenter,
          bone.hollowInnerHalfExtents
        );
        if (outerSd <= crushRadiusM && innerSd >= -crushRadiusM) {
          intersectsCorticalShell = true;
          break;
        }
      }
      if (intersectsCorticalShell) {
        hitBones.push(bone);
      }
    } else {
      const sd = segmentMinSignedDistanceToShape(
        segStartLocal,
        segEndLocal,
        bone.shape,
        bone.localCenter,
        bone.halfExtents,
        bone.capsuleStart,
        bone.capsuleEnd,
        bone.capsuleRadiusM
      );
      if (sd <= crushRadiusM) {
        hitBones.push(bone);
      }
    }
  }

  const crushNerves: NeuralPlexusVolume[] = [];
  const stretchNerves: NeuralPlexusVolume[] = [];
  for (const entry of nerves) {
    if (!aabbIntersectsSphere(entry.aabb, samplePointLocal, broadRadius)) continue;
    const sd =
      closestDistanceBetweenSegments3D(
        segStartLocal,
        segEndLocal,
        entry.nerve.capsuleStart,
        entry.nerve.capsuleEnd
      ).distanceM - entry.nerve.capsuleRadiusM;
    if (sd <= crushRadiusM) {
      crushNerves.push(entry.nerve);
    }
    if (stretchRadiusM > 0 && sd <= stretchRadiusM) {
      stretchNerves.push(entry.nerve);
    }
  }

  const allVesselMatches = queryVascularSplinesAlongSegment(
    segStartLocal,
    segEndLocal,
    maxRadius,
    vascularSplines
  );
  const crushVessels = allVesselMatches.filter((m) => m.surfaceDistanceM <= crushRadiusM);
  const stretchVessels =
    stretchRadiusM > 0
      ? allVesselMatches.filter((m) => m.surfaceDistanceM <= stretchRadiusM)
      : [];

  let localTissueDensityKgM3 = baseShellDensityKgM3;
  if (organDensityOverride !== null) {
    localTissueDensityKgM3 = organDensityOverride;
  }
  for (const b of hitBones) {
    if (b.densityKgM3 > localTissueDensityKgM3) {
      localTissueDensityKgM3 = b.densityKgM3;
    }
  }

  return {
    samplePointLocal,
    localTissueDensityKgM3,
    directOrgans,
    crushOrgans,
    stretchOrgans,
    hitBones,
    crushNerves,
    stretchNerves,
    crushVessels,
    stretchVessels,
  };
}
