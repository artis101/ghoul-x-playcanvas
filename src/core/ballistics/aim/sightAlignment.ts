import type { Vec3Like, WeaponAdsProfile } from '../../../contracts/ballistics.ts';
import { cross, dot, normalize, sub } from '../vec3.ts';

export interface SightQuat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface AdsViewmodelPose {
  /** Viewmodel origin in camera space (camera looks down -Z). */
  position: Vec3Like;
  /** Viewmodel rotation in camera space. */
  rotation: SightQuat;
}

const CAMERA_FORWARD: Vec3Like = { x: 0, y: 0, z: -1 };

export function rotateBySightQuat(q: SightQuat, v: Vec3Like): Vec3Like {
  // v + 2w(q × v) + 2 q × (q × v)
  const qv = { x: q.x, y: q.y, z: q.z };
  const t = cross(qv, v);
  const u = cross(qv, t);
  return {
    x: v.x + 2 * (q.w * t.x + u.x),
    y: v.y + 2 * (q.w * t.y + u.y),
    z: v.z + 2 * (q.w * t.z + u.z),
  };
}

function shortestArc(from: Vec3Like, to: Vec3Like): SightQuat {
  const d = dot(from, to);
  if (d < -0.999999) return { x: 0, y: 1, z: 0, w: 0 };
  const c = cross(from, to);
  const w = 1 + d;
  const len = Math.hypot(c.x, c.y, c.z, w);
  return { x: c.x / len, y: c.y / len, z: c.z / len, w: w / len };
}

/**
 * Places the weapon so the line from its rear sight to its front sight lies exactly on the
 * camera's view axis, with the rear sight `eyeReliefM` in front of the eye. Whatever is under
 * the middle of the screen is then under the front sight.
 */
export function solveAdsViewmodelPose(profile: WeaponAdsProfile): AdsViewmodelPose {
  const sightDir = normalize(sub(profile.frontSightLocal, profile.rearSightLocal));
  const rotation = shortestArc(sightDir, CAMERA_FORWARD);
  const rearRotated = rotateBySightQuat(rotation, profile.rearSightLocal);
  return {
    position: {
      x: -rearRotated.x,
      y: -rearRotated.y,
      z: -profile.eyeReliefM - rearRotated.z,
    },
    rotation,
  };
}
