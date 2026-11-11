import { GhoulZoneId, Vec3Like } from '../ballistics.ts';

/**
 * Tier-1 Ballistic Armor & Helmet Strike-Face Identifiers.
 * Models exact swimmer/shooter-cut ESAPI thoracic plates and side SAPI cummerbund plates,
 * intentionally exposing axillary (armpit) and supraclavicular (collarbone) anatomical gaps.
 */
export type ArmorPlateId =
  | 'FRONT_ESAPI_PLATE'
  | 'BACK_ESAPI_PLATE'
  | 'SIDE_SAPI_LEFT'
  | 'SIDE_SAPI_RIGHT'
  | 'HELMET_BALLISTIC_SHELL';

export type ArmorMaterialKind =
  | 'CERAMIC_ESAPI_IV'
  | 'UHMWPE_III_PLUS'
  | 'ARAMID_HELMET_IIIA';

/**
 * Tier-1 Outer Shell Volume Identifiers (Clothing + Skin/Muscle Sub-Capsules/OBBs).
 */
export type OuterShellPartId =
  | 'TACTICAL_CLOTHING_TORSO'
  | 'HEAD_SCALP_SHELL'
  | 'NECK_SHELL'
  | 'THORAX_SKIN_MUSCLE'
  | 'AXILLARY_GAP_LEFT'
  | 'AXILLARY_GAP_RIGHT'
  | 'SUPRACLAVICULAR_COLLAR_SHELL'
  | 'ABDOMEN_SKIN_MUSCLE'
  | 'PELVIS_SKIN_MUSCLE'
  | 'UPPER_ARM_LEFT_SHELL'
  | 'UPPER_ARM_RIGHT_SHELL'
  | 'FOREARM_LEFT_SHELL'
  | 'FOREARM_RIGHT_SHELL'
  | 'THIGH_LEFT_SHELL'
  | 'THIGH_RIGHT_SHELL'
  | 'CALF_LEFT_SHELL'
  | 'CALF_RIGHT_SHELL';

export type BvhPrimitiveShape = 'AABB' | 'OBB' | 'CAPSULE' | 'SPHERE';

export interface Tier1ArmorPlateVolume {
  readonly id: ArmorPlateId;
  readonly label: string;
  readonly ghoulZone: GhoulZoneId;
  readonly material: ArmorMaterialKind;
  readonly shape: 'OBB' | 'SPHERE';
  readonly localCenter: Vec3Like;
  readonly halfExtents: Vec3Like;
  /** Orthonormal local orientation axes of the OBB in character local space */
  readonly basisRight: Vec3Like;
  readonly basisUp: Vec3Like;
  readonly basisForward: Vec3Like;
  /**
   * Optional swimmer-cut upper corner bevel fraction [0..0.5]:
   * trims top-outer corners of thoracic ESAPI plates to expose axillary/pectoral crease.
   */
  readonly swimmerCutCornerFraction?: number;
  readonly thicknessM: number;
  readonly densityKgM3: number;
  /** Maximum effective threat energy (Joules / armorPenetrationFactor) defeated at 100% integrity */
  readonly maxStopEnergyJ: number;
  /** Fraction of defeated kinetic energy coupled as blunt backface trauma into underlying thorax */
  readonly backfaceBluntTransferRatio: number;
  /** Integrity lost per 1,000 J of impact energy on ceramic/composite strike face */
  readonly degradationPerKilojoule: number;
}

export interface Tier1OuterShellVolume {
  readonly id: OuterShellPartId;
  readonly label: string;
  readonly ghoulZone: GhoulZoneId;
  readonly material: 'TACTICAL_CLOTHING' | 'SKIN_SUBCUTANEOUS' | 'SKELETAL_MUSCLE';
  readonly shape: BvhPrimitiveShape;
  readonly localCenter: Vec3Like;
  readonly halfExtents: Vec3Like;
  readonly capsuleStart?: Vec3Like;
  readonly capsuleEnd?: Vec3Like;
  readonly capsuleRadiusM?: number;
  readonly basisRight?: Vec3Like;
  readonly basisUp?: Vec3Like;
  readonly basisForward?: Vec3Like;
  readonly densityKgM3: number;
}
