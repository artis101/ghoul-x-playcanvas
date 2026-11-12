import { GhoulZoneId, Vec3Like } from '../ballistics.ts';
import { BvhPrimitiveShape } from './armorShellTypes.ts';

/**
 * Tier-2 Internal Organ Identifiers.
 * Note: `BRAIN` and `LIVER` are marked `isInelastic: true` (high vulnerability to temporary stretch cavitation).
 */
export type InternalOrganId =
  | 'BRAIN'
  | 'HEART'
  | 'LUNG_RIGHT'
  | 'LUNG_LEFT'
  | 'DIAPHRAGM'
  | 'LIVER'
  | 'GI_TRACT';

/**
 * Tier-2 Cortical Skeletal Identifiers.
 */
export type SkeletalStructureId =
  | 'SKULL'
  | 'SPINE_CERVICAL'
  | 'SPINE_THORACIC'
  | 'SPINE_LUMBAR'
  | 'RIB_CAGE'
  | 'PELVIS'
  | 'FEMUR_RIGHT'
  | 'FEMUR_LEFT'
  | 'HUMERUS_RIGHT'
  | 'HUMERUS_LEFT'
  | 'RADIUS_ULNA_RIGHT'
  | 'RADIUS_ULNA_LEFT';

/**
 * Tier-2 Major Peripheral Neural Plexus Identifiers.
 */
export type NeuralPlexusId =
  | 'BRACHIAL_PLEXUS_RIGHT'
  | 'BRACHIAL_PLEXUS_LEFT';

export type NerveSegmentId = NeuralPlexusId;

/**
 * Tier-2 Major Vascular 3D Spline Identifiers.
 */
export type VascularVesselId =
  | 'CAROTID_RIGHT'
  | 'CAROTID_LEFT'
  | 'SUBCLAVIAN_RIGHT'
  | 'SUBCLAVIAN_LEFT'
  | 'AORTA_THORACIC_ABDOMINAL'
  | 'FEMORAL_RIGHT'
  | 'FEMORAL_LEFT'
  | 'VENA_CAVA_JUGULAR_FEMORAL'
  | 'JUGULAR_VENOUS_RIGHT'
  | 'JUGULAR_VENOUS_LEFT'
  | 'FEMORAL_VENOUS_RIGHT'
  | 'FEMORAL_VENOUS_LEFT';

export type VesselKind = 'ARTERIAL' | 'VENOUS';

export interface InternalOrganVolume {
  readonly id: InternalOrganId;
  readonly label: string;
  readonly ghoulZone: GhoulZoneId;
  readonly shape: BvhPrimitiveShape;
  readonly localCenter: Vec3Like;
  readonly halfExtents: Vec3Like;
  readonly densityKgM3: number;
  /** Inelastic friable parenchyma (Brain, Liver) shatters/ruptures under hydrostatic temporary stretch */
  readonly isInelastic: boolean;
  /** Energy deposition per step or cumulative stretch threshold (J) causing parenchymal rupture */
  readonly parenchymaRuptureThresholdJ: number;
  readonly baseLacerationBleedMlPerSec: number;
  readonly ruptureBleedMlPerSec: number;
  readonly bleedVesselKind: VesselKind;
}

export interface SkeletalBoneVolume {
  readonly id: SkeletalStructureId;
  readonly label: string;
  readonly ghoulZone: GhoulZoneId;
  readonly shape: BvhPrimitiveShape;
  readonly localCenter: Vec3Like;
  readonly halfExtents: Vec3Like;
  readonly capsuleStart?: Vec3Like;
  readonly capsuleEnd?: Vec3Like;
  readonly capsuleRadiusM?: number;
  /** Optional hollow inner cavity half-extents (for cranial vault & thoracic ribcage shell) */
  readonly hollowInnerHalfExtents?: Vec3Like;
  readonly densityKgM3: number;
  readonly fractureThresholdJ: number;
  readonly shatterThresholdJ: number;
  readonly isLoadBearingLocomotion: boolean;
  readonly spinalSegment?: 'CERVICAL' | 'THORACIC' | 'LUMBAR';
}

export interface NeuralPlexusVolume {
  readonly id: NeuralPlexusId;
  readonly label: string;
  readonly ghoulZone: GhoulZoneId;
  readonly side: 'RIGHT' | 'LEFT';
  readonly capsuleStart: Vec3Like;
  readonly capsuleEnd: Vec3Like;
  readonly capsuleRadiusM: number;
}

export interface VascularSpline {
  readonly id: VascularVesselId;
  readonly label: string;
  readonly ghoulZone: GhoulZoneId;
  readonly vesselKind: VesselKind;
  /** 3D Catmull-Rom / piecewise control points in standing character local space */
  readonly controlPoints: readonly Vec3Like[];
  /** Vessel lumen radius in meters */
  readonly lumenRadiusM: number;
  /** Baseline hemorrhage rate (mL/sec) at normal Mean Arterial Pressure (93 mmHg) */
  readonly mlPerSec: number;
}

/**
 * Optional animated or ragdoll bone pose override for transforming local BVH primitives into posed space.
 */
export interface BonePoseFrame {
  readonly positionWorld: Vec3Like;
  readonly basisRight: Vec3Like;
  readonly basisUp: Vec3Like;
  readonly basisForward: Vec3Like;
}

export interface CharacterTransform {
  readonly positionWorld: Vec3Like;
  readonly yawRad: number;
  readonly bonePoseOverrides?: Partial<Record<GhoulZoneId, BonePoseFrame>>;
}

/**
 * Spatial distance match against a 3D vascular spline at a ray-march sample step.
 */
export interface VascularSplineProximityHit {
  readonly spline: VascularSpline;
  /** Minimum 3D Euclidean distance from sample segment/point to spline centerline (meters) */
  readonly centerDistanceM: number;
  /** Signed clearance to vessel wall (`centerDistanceM - spline.lumenRadiusM`) */
  readonly surfaceDistanceM: number;
  readonly closestPointLocal: Vec3Like;
  readonly tangentLocal: Vec3Like;
  readonly parameterT: number;
}

/**
 * Complete Tier-2 spatial query result at a 3D internal sample point + cavitation query radius.
 */
export interface Tier2SpatialQueryResult {
  readonly samplePointLocal: Vec3Like;
  readonly localTissueDensityKgM3: number;
  readonly directOrgans: InternalOrganVolume[];
  readonly crushOrgans: InternalOrganVolume[];
  readonly stretchOrgans: InternalOrganVolume[];
  readonly hitBones: SkeletalBoneVolume[];
  readonly crushNerves: NeuralPlexusVolume[];
  readonly stretchNerves: NeuralPlexusVolume[];
  readonly crushVessels: VascularSplineProximityHit[];
  readonly stretchVessels: VascularSplineProximityHit[];
}
