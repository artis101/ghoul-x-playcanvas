import { GhoulZoneId, Vec3Like } from '../../../contracts/ballistics.ts';
import {
  CharacterTransform,
  VascularSpline,
} from '../../../contracts/physiology.ts';

export interface AxisAlignedBox {
  readonly min: Vec3Like;
  readonly max: Vec3Like;
}

export interface RayIntervalHit {
  readonly hit: boolean;
  readonly tMin: number;
  readonly tMax: number;
}

export interface BakedSplineSegment {
  readonly p0: Vec3Like;
  readonly p1: Vec3Like;
  readonly t0: number;
  readonly t1: number;
  readonly tangent: Vec3Like;
}

export interface BakedVascularSpline {
  readonly spline: VascularSpline;
  readonly aabb: AxisAlignedBox;
  readonly segments: readonly BakedSplineSegment[];
}

export interface BvhGroupNode<T> {
  readonly aabb: AxisAlignedBox;
  readonly items: readonly { readonly aabb: AxisAlignedBox; readonly item: T }[];
}

export const DEFAULT_CHARACTER_TRANSFORM: CharacterTransform = {
  positionWorld: { x: 0, y: 0, z: 0 },
  yawRad: 0,
};

/**
 * Standing Rest Joint Origins (matching GHOUL_ZONE_HIERARCHY) for optional posed-bone space transforms.
 */
export const STANDING_ZONE_PIVOTS: Partial<Record<GhoulZoneId, Vec3Like>> = {
  HEAD_CRANIUM: { x: 0, y: 1.66, z: 0 },
  NECK_CERVICAL: { x: 0, y: 1.55, z: 0 },
  TORSO_UPPER_THORAX: { x: 0, y: 1.30, z: 0 },
  TORSO_LOWER_ABDOMEN: { x: 0, y: 1.10, z: 0 },
  PELVIS_GROIN: { x: 0, y: 0.95, z: 0 },
  SHOULDER_LEFT: { x: -0.22, y: 1.48, z: 0 },
  SHOULDER_RIGHT: { x: 0.22, y: 1.48, z: 0 },
  UPPER_ARM_LEFT: { x: -0.28, y: 1.38, z: 0 },
  UPPER_ARM_RIGHT: { x: 0.28, y: 1.38, z: 0 },
  FOREARM_LEFT: { x: -0.30, y: 1.14, z: 0.02 },
  FOREARM_RIGHT: { x: 0.30, y: 1.14, z: 0.02 },
  THIGH_LEFT: { x: -0.115, y: 0.86, z: 0 },
  THIGH_RIGHT: { x: 0.115, y: 0.86, z: 0 },
  SHIN_LEFT: { x: -0.12, y: 0.2825, z: 0.01 },
  SHIN_RIGHT: { x: 0.12, y: 0.2825, z: 0.01 },
};
