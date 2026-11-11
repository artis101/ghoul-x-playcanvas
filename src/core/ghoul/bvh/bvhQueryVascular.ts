import { Vec3Like } from '../../../contracts/ballistics.ts';
import { VascularSplineProximityHit } from '../../../contracts/physiology.ts';
import { length, lerp, sub, vec3 } from '../../ballistics/vec3.ts';
import { aabbIntersectsSphere } from './bvhRayAabb.ts';
import { closestDistanceBetweenSegments3D } from './bvhSplineMath.ts';
import { BakedVascularSpline } from './bvhTypes.ts';

export function queryVascularSplinesAlongSegment(
  segStartLocal: Vec3Like,
  segEndLocal: Vec3Like,
  maxSearchRadiusM: number,
  vascularSplines: readonly BakedVascularSpline[]
): VascularSplineProximityHit[] {
  const mid = lerp(segStartLocal, segEndLocal, 0.5);
  const broadRadius = maxSearchRadiusM + 0.5 * length(sub(segEndLocal, segStartLocal)) + 0.02;
  const results: VascularSplineProximityHit[] = [];

  for (const baked of vascularSplines) {
    if (!aabbIntersectsSphere(baked.aabb, mid, broadRadius)) continue;

    let bestCenterDist = Infinity;
    let bestPoint = vec3(0, 0, 0);
    let bestTangent = vec3(0, 1, 0);
    let bestT = 0;

    for (const seg of baked.segments) {
      const match = closestDistanceBetweenSegments3D(segStartLocal, segEndLocal, seg.p0, seg.p1);
      if (match.distanceM < bestCenterDist) {
        bestCenterDist = match.distanceM;
        bestPoint = match.pointOnB;
        bestTangent = seg.tangent;
        bestT = seg.t0 + (seg.t1 - seg.t0) * match.t;
      }
    }

    const surfaceDist = bestCenterDist - baked.spline.lumenRadiusM;
    if (surfaceDist <= maxSearchRadiusM) {
      results.push({
        spline: baked.spline,
        centerDistanceM: bestCenterDist,
        surfaceDistanceM: surfaceDist,
        closestPointLocal: bestPoint,
        tangentLocal: bestTangent,
        parameterT: bestT,
      });
    }
  }

  results.sort((a, b) => a.surfaceDistanceM - b.surfaceDistanceM);
  return results;
}
