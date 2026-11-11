import { Vec3Like } from '../../../contracts/ballistics.ts';
import { VascularSpline } from '../../../contracts/physiology.ts';
import { dot, normalize, sub, vec3, lerp } from '../../ballistics/vec3.ts';
import { closestDistanceBetweenSegments3D, evaluateCatmullRomSpline, pointToSegmentDistance3D } from './bvhSplineMath.ts';
import { pointToAabbSignedDistance } from './bvhRayAabb.ts';
import { BakedSplineSegment, BakedVascularSpline } from './bvhTypes.ts';

export function pointToEllipsoidSignedDistanceApprox(
  p: Vec3Like,
  center: Vec3Like,
  radii: Vec3Like
): number {
  const dx = (p.x - center.x) / radii.x;
  const dy = (p.y - center.y) / radii.y;
  const dz = (p.z - center.z) / radii.z;
  const rNorm = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (rNorm < 1e-8) {
    return -Math.min(radii.x, radii.y, radii.z);
  }
  const avgScale =
    1 /
    Math.sqrt(
      (dx * dx) / (radii.x * radii.x * rNorm * rNorm) +
        (dy * dy) / (radii.y * radii.y * rNorm * rNorm) +
        (dz * dz) / (radii.z * radii.z * rNorm * rNorm)
    );
  return (rNorm - 1) * avgScale;
}

export function pointToObbSignedDistance(
  p: Vec3Like,
  center: Vec3Like,
  half: Vec3Like,
  basisRight: Vec3Like,
  basisUp: Vec3Like,
  basisForward: Vec3Like
): { signedDistanceM: number; localCoords: Vec3Like } {
  const rel = sub(p, center);
  const localCoords = {
    x: dot(rel, basisRight),
    y: dot(rel, basisUp),
    z: dot(rel, basisForward),
  };
  const signedDistanceM = pointToAabbSignedDistance(localCoords, vec3(0, 0, 0), half);
  return { signedDistanceM, localCoords };
}

export function signedDistanceToShape(
  p: Vec3Like,
  shape: 'AABB' | 'OBB' | 'CAPSULE' | 'SPHERE',
  center: Vec3Like,
  halfExtents: Vec3Like,
  capsuleStart?: Vec3Like,
  capsuleEnd?: Vec3Like,
  capsuleRadiusM?: number,
  basisRight?: Vec3Like,
  basisUp?: Vec3Like,
  basisForward?: Vec3Like
): number {
  if (shape === 'CAPSULE' && capsuleStart && capsuleEnd && capsuleRadiusM !== undefined) {
    return pointToSegmentDistance3D(p, capsuleStart, capsuleEnd).distanceM - capsuleRadiusM;
  }
  if (shape === 'SPHERE') {
    return pointToEllipsoidSignedDistanceApprox(p, center, halfExtents);
  }
  if (shape === 'OBB' && basisRight && basisUp && basisForward) {
    return pointToObbSignedDistance(p, center, halfExtents, basisRight, basisUp, basisForward)
      .signedDistanceM;
  }
  return pointToAabbSignedDistance(p, center, halfExtents);
}

export function segmentMinSignedDistanceToShape(
  segA: Vec3Like,
  segB: Vec3Like,
  shape: 'AABB' | 'OBB' | 'CAPSULE' | 'SPHERE',
  center: Vec3Like,
  halfExtents: Vec3Like,
  capsuleStart?: Vec3Like,
  capsuleEnd?: Vec3Like,
  capsuleRadiusM?: number,
  basisRight?: Vec3Like,
  basisUp?: Vec3Like,
  basisForward?: Vec3Like
): number {
  if (shape === 'CAPSULE' && capsuleStart && capsuleEnd && capsuleRadiusM !== undefined) {
    return (
      closestDistanceBetweenSegments3D(segA, segB, capsuleStart, capsuleEnd).distanceM -
      capsuleRadiusM
    );
  }
  // Sample 5 points along the ~1.2 cm sub-step segment (every ~3 mm) for exact convex primitive clearance
  let minD = Infinity;
  for (let i = 0; i <= 4; i++) {
    const pt = lerp(segA, segB, i * 0.25);
    const d = signedDistanceToShape(
      pt,
      shape,
      center,
      halfExtents,
      capsuleStart,
      capsuleEnd,
      capsuleRadiusM,
      basisRight,
      basisUp,
      basisForward
    );
    if (d < minD) minD = d;
  }
  return minD;
}

export function bakeVascularSpline(spline: VascularSpline, samplesPerSegment = 10): BakedVascularSpline {
  const totalSamples = Math.max(8, (spline.controlPoints.length - 1) * samplesPerSegment);
  const segments: BakedSplineSegment[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  let prevPt = evaluateCatmullRomSpline(spline.controlPoints, 0);
  for (let i = 1; i <= totalSamples; i++) {
    const t0 = (i - 1) / totalSamples;
    const t1 = i / totalSamples;
    const nextPt = evaluateCatmullRomSpline(spline.controlPoints, t1);
    const tangent = normalize(sub(nextPt, prevPt));
    segments.push({ p0: prevPt, p1: nextPt, t0, t1, tangent });

    for (const pt of [prevPt, nextPt]) {
      if (pt.x - spline.lumenRadiusM < minX) minX = pt.x - spline.lumenRadiusM;
      if (pt.y - spline.lumenRadiusM < minY) minY = pt.y - spline.lumenRadiusM;
      if (pt.z - spline.lumenRadiusM < minZ) minZ = pt.z - spline.lumenRadiusM;
      if (pt.x + spline.lumenRadiusM > maxX) maxX = pt.x + spline.lumenRadiusM;
      if (pt.y + spline.lumenRadiusM > maxY) maxY = pt.y + spline.lumenRadiusM;
      if (pt.z + spline.lumenRadiusM > maxZ) maxZ = pt.z + spline.lumenRadiusM;
    }
    prevPt = nextPt;
  }

  return {
    spline,
    aabb: { min: vec3(minX, minY, minZ), max: vec3(maxX, maxY, maxZ) },
    segments,
  };
}
