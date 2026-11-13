import { Vec3Like, EnemyArchetypeId } from './ballisticsTypes.ts';

export type { EnemyArchetypeId };

/**
 * The classic Soldier of Fortune (2000) GHOUL Gore Zone Taxonomy (22 distinct anatomical damage & sever zones).
 */
export type GhoulZoneId =
  | 'HEAD_CRANIUM'
  | 'HEAD_FACE_JAW'
  | 'NECK_CERVICAL'
  | 'TORSO_UPPER_THORAX'
  | 'TORSO_LOWER_ABDOMEN'
  | 'PELVIS_GROIN'
  | 'SHOULDER_RIGHT'
  | 'UPPER_ARM_RIGHT'
  | 'FOREARM_RIGHT'
  | 'HAND_RIGHT'
  | 'SHOULDER_LEFT'
  | 'UPPER_ARM_LEFT'
  | 'FOREARM_LEFT'
  | 'HAND_LEFT'
  | 'THIGH_RIGHT'
  | 'KNEE_RIGHT'
  | 'SHIN_RIGHT'
  | 'FOOT_RIGHT'
  | 'THIGH_LEFT'
  | 'KNEE_LEFT'
  | 'SHIN_LEFT'
  | 'FOOT_LEFT';

export type TissueLayerType =
  | 'ARMOR_KEVLAR'
  | 'SOFT_FLESH'
  | 'CORTICAL_BONE'
  | 'ORGAN_BRAIN'
  | 'ORGAN_HEART'
  | 'ORGAN_LUNG_RIGHT'
  | 'ORGAN_LUNG_LEFT'
  | 'ORGAN_LIVER'
  | 'ORGAN_STOMACH_GUT'
  | 'ARTERY_CAROTID_AORTA';

export type GoreMode =
  | 'INTACT'
  | 'LACERATED'
  | 'EVISCERATED'
  | 'CLEAN_SEVER'
  | 'CRANIAL_POP';

export interface AnatomicalColliderVolume {
  id: string;
  label: string;
  ghoulZone: GhoulZoneId;
  layerType: TissueLayerType;
  /** Local center relative to standing target root (feet at y=0, standing ~1.80m tall) */
  localCenter: Vec3Like;
  /** Half-extents (box) or radius/height encoded as half-extents in meters */
  halfExtents: Vec3Like;
  shape: 'BOX' | 'SPHERE' | 'CAPSULE';
  /** Tissue density in kg/m^3 (e.g. 1050 soft flesh, 1900 cortical bone) */
  densityKgM3: number;
  /** Resistance / energy absorption per meter of travel */
  stoppingPowerFactor: number;
  /** Minimum kinetic energy (Joules) required to fracture/rupture this structure */
  fractureThresholdJ: number;
  /** Cumulative or single-shot energy (Joules * goreFactor) to sever/explode this GHOUL zone */
  severThresholdJ: number;
  /** Whether destroying this organ/structure is immediately or rapidly lethal */
  vitalityMultiplier: number;
  /** Mass of this limb/zone in kg for ragdoll physics (total body ~82 kg) */
  limbMassKg: number;
  /** Parent zone in the kinematic tree (where the bloody stump & bone protrusion appear on sever) */
  parentZone?: GhoulZoneId;
  /** Child zones that automatically detach with this limb when severed */
  childZones?: GhoulZoneId[];
}

/**
 * Where a limb was cut through, in the cut zone's own bone frame. The engine places the
 * mesh split and the wound caps from this, so the limb parts where the bullet crossed it.
 */
export interface SeverCut {
  /** Where the cut crosses the bone, as a fraction of its length from its proximal joint (0) to its distal joint (1). */
  alongFraction: number;
  /** Where the bullet crossed the limb, relative to the bone origin, in the ragdoll bone basis (right, up, forward). */
  entryLocal: Vec3Like;
  /** Bullet direction in the same basis. */
  shotDirLocal: Vec3Like;
  /** Seeds the jagged fracture profile, so both halves of the cut tear the same way. */
  seed: number;
}

export interface DismembermentEvent {
  zone: GhoulZoneId;
  parentZone?: GhoulZoneId;
  goreMode: GoreMode;
  /** All child zones detached as part of this limb chain */
  detachedSubtree: GhoulZoneId[];
  /** World-space position of the severed joint / stump */
  stumpWorldPosition: Vec3Like;
  /** World-space direction of arterial blood fountain from stump */
  arterialSprayDirection: Vec3Like;
  /** Launch velocity vector (m/s) of the severed limb or gibs */
  severedLimbVelocity: Vec3Like;
  /** Spin angular velocity (rad/s) of the flying severed limb */
  severedLimbAngularVelocity: Vec3Like;
  /** Number of meat/bone gib chunks spawned (especially for CRANIAL_POP or shotgun obliteration) */
  gibCount: number;
  /** Where the limb parted along the bone; absent when it came away at its joint. */
  cut?: SeverCut;
}

export interface LocalizedSurfaceWound {
  id: string;
  zone: GhoulZoneId;
  /** Offset relative to the bone's local coordinate frame */
  localOffset: Vec3Like;
  /** Outward surface normal in bone local space */
  localNormal: Vec3Like;
  radiusM: number;
  isExit: boolean;
  armorDent: boolean;
}

export interface WoundChannelEvent {
  colliderId: string;
  label: string;
  ghoulZone: GhoulZoneId;
  layerType: TissueLayerType;
  entryPointWorld: Vec3Like;
  exitPointWorld: Vec3Like;
  entryNormalWorld: Vec3Like;
  /** Offset from the hit zone's joint position in bone-local frame */
  localEntryOffset: Vec3Like;
  localExitOffset: Vec3Like;
  /** Direction vector of projectile at entry */
  impactDirectionWorld: Vec3Like;
  pathLengthM: number;
  entryVelocityMs: number;
  exitVelocityMs: number;
  entryEnergyJ: number;
  exitEnergyJ: number;
  energyDepositedJ: number;
  /** Momentum impulse transferred to this limb in N*s */
  impulseTransferredNs: number;
  permanentCavityRadiusCm: number;
  temporaryStretchCavityRadiusCm: number;
  armorStopped: boolean;
  bluntTraumaJ: number;
  boneFractured: boolean;
  boneShattered: boolean;
  organRuptured: boolean;
  limbSensoryShock: boolean;
  limbSevered: boolean;
  arterialSevered: boolean;
  deflectionAngleDeg: number;
  /** Real-world combatant impact description */
  physiologicalEffect: string;
}

/**
 * Ragdoll & Dismemberment Activation Plan computed upon shot simulation.
 */
export interface RagdollActivationPlan {
  /** Whether this shot activates or impulses full 3D ragdoll physics */
  willEnableRagdoll: boolean;
  /** Exact flight time (seconds after trigger pull) when ragdoll unlocks and launches */
  activationTimeS: number;
  /** Primary GHOUL zone receiving the main blast impulse */
  primaryHitZone: GhoulZoneId | null;
  /** Net world-space impulse vector (N*s) applied to the ragdoll */
  netRootImpulseWorld: Vec3Like;
  /** Upward lift component added for dramatic stomach/chest blast launch arc */
  launchLiftVelocityMs: number;
  /** Initial center-of-mass estimated backward travel distance in meters */
  estimatedLaunchDistanceM: number;
  /** Per-zone localized impulse vectors for realistic limb/stomach jackknife & spin */
  zoneImpulses: Partial<Record<GhoulZoneId, Vec3Like>>;
  /** Angular torque vector (N*m*s) around center of mass */
  netTorqueWorld: Vec3Like;
  /** Detailed GHOUL dismemberment events triggered by this shot */
  dismembermentEvents: DismembermentEvent[];
}
