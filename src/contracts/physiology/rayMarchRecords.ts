import { AmmoSpec, GhoulZoneId, Vec3Like } from '../ballistics.ts';
import { ArmorPlateId } from './armorShellTypes.ts';
import {
  CharacterTransform,
  InternalOrganId,
  NeuralPlexusId,
  SkeletalStructureId,
  VascularVesselId,
  VesselKind,
} from './internalAnatomyTypes.ts';

/**
 * Stage 2: Sub-Stepped Internal Ballistics Raymarch Contracts.
 */
export interface RayMarchStepRecord {
  readonly stepIndex: number;
  readonly positionLocal: Vec3Like;
  readonly positionWorld: Vec3Like;
  readonly depthCm: number;
  readonly tissueDensityKgM3: number;
  readonly velocityMs: number;
  readonly kineticEnergyJ: number;
  readonly energyDepositedStepJ: number;
  readonly yawAngleDeg: number;
  readonly effectiveCaliberM: number;
  readonly crushRadiusM: number;
  readonly stretchRadiusM: number;
  readonly stretchCavitationActive: boolean;
  readonly armorPlateHit: ArmorPlateId | null;
  readonly organsCrushed: InternalOrganId[];
  readonly organsStretched: InternalOrganId[];
  readonly bonesHit: SkeletalStructureId[];
  readonly nervesHit: NeuralPlexusId[];
  readonly vesselsHit: VascularVesselId[];
  readonly fragmentSpawned: boolean;
}

export interface SecondaryFragmentTrajectory {
  readonly fragmentId: string;
  readonly kind: 'JACKET_FRAGMENT' | 'CORTICAL_BONE_SHARD';
  readonly sourceBoneId?: SkeletalStructureId;
  readonly originLocal: Vec3Like;
  readonly directionLocal: Vec3Like;
  readonly coneAngleDeg: number;
  readonly initialVelocityMs: number;
  readonly initialEnergyJ: number;
  readonly travelDistanceCm: number;
  readonly organsLacerated: InternalOrganId[];
  readonly vesselsLacerated: VascularVesselId[];
  readonly nervesLacerated: NeuralPlexusId[];
}

export interface VascularWoundRecord {
  readonly vesselId: VascularVesselId;
  readonly vesselKind: VesselKind;
  readonly ghoulZone: GhoulZoneId;
  readonly positionLocal: Vec3Like;
  readonly positionWorld: Vec3Like;
  readonly sprayDirectionWorld: Vec3Like;
  /** 1.0 = full direct crush transection, 0.35..0.75 = stretch avulsion or fragment nick */
  readonly severity: number;
  /** Baseline hemorrhage rate in mL/s at MAP = 93 mmHg */
  readonly baseBleedMlPerSec: number;
}

export interface OrganTraumaRecord {
  readonly organId: InternalOrganId;
  readonly isInelastic: boolean;
  readonly directCrushLacerated: boolean;
  readonly stretchCavitationRuptured: boolean;
  readonly energyDepositedJ: number;
  readonly severity: number;
  readonly positionLocal: Vec3Like;
  readonly positionWorld: Vec3Like;
}

export interface BoneTraumaRecord {
  readonly boneId: SkeletalStructureId;
  readonly fractured: boolean;
  readonly shattered: boolean;
  readonly energyDepositedJ: number;
  readonly deflectionAngleDeg: number;
  readonly spawnedShardCount: number;
  readonly positionLocal: Vec3Like;
}

export interface InternalBallisticsConfig {
  /** Sub-step march increment in meters (default 0.012 = 1.2 cm) */
  readonly stepSizeM?: number;
  /** Maximum internal path length marched in meters (default 0.90 m) */
  readonly maxMarchDistanceM?: number;
  /** Initial projectile incidence/yaw angle at outer shell entry in degrees (default 1.5 deg) */
  readonly initialYawAngleDeg?: number;
  /** Velocity threshold in m/s above which elastic soft tissue suffers destructive stretch cavitation (default 600 m/s) */
  readonly stretchVelocityThresholdMs?: number;
  /** Velocity threshold in m/s above which yawing 5.56/5.45 spitzer FMJ shears into jacket fragments (default 730 m/s) */
  readonly spitzerFragmentVelocityThresholdMs?: number;
  readonly enableArmorPlates?: boolean;
  readonly enableHelmet?: boolean;
  readonly initialPlateIntegrity?: Partial<Record<ArmorPlateId, number>>;
  readonly deterministicSeed?: number;
}

export interface InternalBallisticsInput {
  readonly ammo: AmmoSpec;
  readonly rayOriginWorld: Vec3Like;
  readonly rayDirectionWorld: Vec3Like;
  readonly impactVelocityMs: number;
  readonly characterTransform?: CharacterTransform;
  readonly config?: InternalBallisticsConfig;
}

export interface InternalBallisticsReport {
  readonly hitOuterShell: boolean;
  readonly entryPointLocal: Vec3Like | null;
  readonly exitPointLocal: Vec3Like | null;
  readonly entryPointWorld: Vec3Like | null;
  readonly exitPointWorld: Vec3Like | null;
  readonly entryVelocityMs: number;
  readonly exitVelocityMs: number;
  readonly entryEnergyJ: number;
  readonly exitEnergyJ: number;
  readonly totalEnergyDepositedJ: number;
  readonly totalPenetrationDepthCm: number;
  readonly overPenetrated: boolean;
  readonly stoppedByArmorPlate: ArmorPlateId | null;
  readonly armorPlatesIntersected: ArmorPlateId[];
  readonly armorBackfaceBluntTraumaJ: number;
  readonly plateIntegrityAfter: Record<ArmorPlateId, number>;
  readonly peakYawAngleDeg: number;
  /** Distance in cm traveled inside soft tissue before yaw angle exceeds 25 degrees ("narrow neck") */
  readonly narrowNeckDepthCm: number | null;
  readonly steps: RayMarchStepRecord[];
  readonly secondaryFragments: SecondaryFragmentTrajectory[];
  readonly organTrauma: OrganTraumaRecord[];
  readonly boneTrauma: BoneTraumaRecord[];
  readonly nervesSevered: NeuralPlexusId[];
  readonly vascularWounds: VascularWoundRecord[];
  readonly woundTractMuscleBleedMlPerSec: number;
}
