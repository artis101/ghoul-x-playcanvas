export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export type AmmoType = 'FMJ' | 'JHP' | 'AP' | 'BUCKSHOT_00';

export interface AmmoSpec {
  id: string;
  name: string;
  caliber: string;
  type: AmmoType;
  /** Mass of single projectile in kilograms (e.g. 0.01134 kg for 175gr 7.62 NATO, 0.0035 kg per 00 buck pellet) */
  massKg: number;
  /** Diameter in meters (e.g. 0.00782 m for 7.62mm, 0.00838 m for 00 buck) */
  diameterM: number;
  /** Muzzle velocity in m/s */
  muzzleVelocityMs: number;
  /** Ballistic drag coefficient (G1 model baseline) */
  dragCoefficient: number;
  /** Expansion factor in soft tissue (1.0 for AP, 1.8 for JHP) */
  tissueExpansionFactor: number;
  /** Armor/bone penetration multiplier (1.5 for AP, 0.65 for JHP) */
  armorPenetrationFactor: number;
  /** Number of pellets per shot (1 for rifle/pistol, 10 for 12-gauge shotgun) */
  pelletCount: number;
  /** Spread cone half-angle in radians */
  spreadRadians: number;
  /** Cinematic knockback amplification factor (e.g. 5.5x for 12-Gauge Shotgun blast, 2.5x for .50 AE) */
  ragdollImpulseMultiplier: number;
  /** Gore & dismemberment multiplier (e.g. 2.8x for 12-Gauge Buckshot and .50 AE) */
  goreFactor: number;
}

export interface WeaponSpec {
  id: string;
  name: string;
  codeName: string;
  role: 'SNIPER' | 'HEAVY_PISTOL' | 'ASSAULT_RIFLE' | 'SHOTGUN';
  description: string;
  defaultAmmo: AmmoSpec;
  availableAmmo: AmmoSpec[];
  fireRateRpm: number;
  recoilKickDeg: number;
  scopeZoomLevels: number[];
  zeroDistanceM: number;
}

export interface EnvironmentState {
  /** Gravity vector in m/s^2, default (0, -9.81, 0) */
  gravity: Vec3Like;
  /** Air density in kg/m^3, default 1.225 at sea level ISA */
  airDensityKgM3: number;
  /** Speed of sound in m/s, default 343.0 */
  speedOfSoundMs: number;
  /** Wind velocity vector in m/s */
  windVelocity: Vec3Like;
}

export interface ProjectileState {
  id: string;
  ammo: AmmoSpec;
  position: Vec3Like;
  velocity: Vec3Like;
  /** Spin rate in rad/s around forward axis */
  spinRadS: number;
  /** Current diameter (increases on mushrooming/expansion inside tissue) */
  currentDiameterM: number;
  /** Elapsed flight time in seconds */
  flightTimeS: number;
  /** Total distance traveled in meters */
  distanceTraveledM: number;
  /** Kinetic energy in Joules: 0.5 * m * |v|^2 */
  kineticEnergyJ: number;
  /** Number of anatomical layers penetrated */
  penetratedLayers: number;
  /** Whether projectile is still active in flight */
  alive: boolean;
}

export interface TrajectorySample {
  timeS: number;
  position: Vec3Like;
  velocity: Vec3Like;
  speedMs: number;
  mach: number;
  kineticEnergyJ: number;
  dropM: number;
  windDriftM: number;
}

/**
 * The classic Soldier of Fortune (2000) GHOUL Gore Zone Taxonomy (22+ distinct anatomical damage & sever zones).
 */
export type GhoulZoneId =
  | 'HEAD_CRANIUM'
  | 'HEAD_FACE_JAW'
  | 'NECK_CERVICAL'
  | 'TORSO_UPPER_THORAX'
  | 'TORSO_LOWER_ABDOMEN'
  | 'PELVIS_GROIN'
  | 'SHOULDER_LEFT'
  | 'UPPER_ARM_LEFT'
  | 'FOREARM_LEFT'
  | 'HAND_LEFT'
  | 'SHOULDER_RIGHT'
  | 'UPPER_ARM_RIGHT'
  | 'FOREARM_RIGHT'
  | 'HAND_RIGHT'
  | 'THIGH_LEFT'
  | 'KNEE_LEFT'
  | 'SHIN_LEFT'
  | 'FOOT_LEFT'
  | 'THIGH_RIGHT'
  | 'KNEE_RIGHT'
  | 'SHIN_RIGHT'
  | 'FOOT_RIGHT';

export type TissueLayerType =
  | 'ARMOR_KEVLAR'
  | 'SOFT_FLESH'
  | 'CORTICAL_BONE'
  | 'ORGAN_BRAIN'
  | 'ORGAN_HEART'
  | 'ORGAN_LUNG_LEFT'
  | 'ORGAN_LUNG_RIGHT'
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
  /** Local center relative to target root (feet at y=0, standing ~1.80m tall) */
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
  /** Child zones that automatically detach with this limb when severed (e.g. severing UPPER_ARM_LEFT takes FOREARM_LEFT + HAND_LEFT) */
  childZones?: GhoulZoneId[];
}

export interface DismembermentEvent {
  zone: GhoulZoneId;
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
}

export interface WoundChannelEvent {
  colliderId: string;
  label: string;
  ghoulZone: GhoulZoneId;
  layerType: TissueLayerType;
  entryPointWorld: Vec3Like;
  exitPointWorld: Vec3Like;
  entryNormalWorld: Vec3Like;
  /** Direction vector of projectile at entry */
  impactDirectionWorld: Vec3Like;
  pathLengthM: number;
  entryVelocityMs: number;
  exitVelocityMs: number;
  entryEnergyJ: number;
  exitEnergyJ: number;
  energyDepositedJ: number;
  /** Momentum impulse transferred to this limb in N*s (including cinematic amplifier) */
  impulseTransferredNs: number;
  permanentCavityRadiusCm: number;
  temporaryStretchCavityRadiusCm: number;
  boneFractured: boolean;
  boneShattered: boolean;
  organRuptured: boolean;
  limbSensoryShock: boolean;
  limbSevered: boolean;
  arterialSevered: boolean;
  deflectionAngleDeg: number;
}

/**
 * Pre-calculated Ragdoll & Dismemberment Activation Plan computed at trigger pull BEFORE pellets/bullets arrive.
 */
export interface RagdollActivationPlan {
  /** Whether this shot will trigger full ragdoll physics upon impact */
  willEnableRagdoll: boolean;
  /** Exact flight time (seconds after trigger pull) when ragdoll unlocks and launches */
  activationTimeS: number;
  /** Primary GHOUL zone receiving the main blast impulse */
  primaryHitZone: GhoulZoneId | null;
  /** Net world-space impulse vector (N*s) applied to the ragdoll torso/pelvis root */
  netRootImpulseWorld: Vec3Like;
  /** Upward lift component added for dramatic shotgun launch arc */
  launchLiftVelocityMs: number;
  /** Initial center-of-mass launch speed in m/s (so a point-blank shotgun blast sends the ragdoll flying backwards 3-6 meters) */
  estimatedLaunchDistanceM: number;
  /** Per-zone localized impulse vectors for realistic limb whip/spin (e.g. hitting right shoulder spins ragdoll clockwise) */
  zoneImpulses: Partial<Record<GhoulZoneId, Vec3Like>>;
  /** Angular torque vector (N*m*s) around center of mass */
  netTorqueWorld: Vec3Like;
  /** Detailed GHOUL dismemberment events triggered by this shot */
  dismembermentEvents: DismembermentEvent[];
}

export interface PelletTrajectoryResult {
  pelletIndex: number;
  aimDirectionWorld: Vec3Like;
  hitTarget: boolean;
  impactTimeS: number;
  impactPointWorld: Vec3Like | null;
  impactZone: GhoulZoneId | null;
  energyDepositedJ: number;
  impulseNs: number;
  trajectorySamples: TrajectorySample[];
  woundEvents: WoundChannelEvent[];
}

export interface ShotSimulationReport {
  shotId: string;
  weaponId: string;
  ammoId: string;
  originWorld: Vec3Like;
  aimDirectionWorld: Vec3Like;
  targetDistanceM: number;
  pelletCount: number;
  muzzleEnergyJ: number;
  impactSpeedMs: number;
  impactEnergyJ: number;
  flightTimeAtImpactS: number;
  bulletDropAtImpactCm: number;
  windDriftAtImpactCm: number;
  hitTarget: boolean;
  targetId: string | null;
  pelletResults: PelletTrajectoryResult[];
  woundEvents: WoundChannelEvent[];
  totalEnergyDepositedJ: number;
  totalDamageHp: number;
  /** Pre-calculated at trigger pull: will this shot kill the enemy? */
  isLethalKill: boolean;
  /** Pre-calculated Ragdoll & Dismemberment physics launch plan */
  ragdollPlan: RagdollActivationPlan;
  /** Whether Sniper Elite X-Ray Kill Cam should trigger */
  triggerXRayKillCam: boolean;
  xRayFocusZone: GhoulZoneId | null;
  xRayHighlightPointWorld: Vec3Like | null;
  severedZones: GhoulZoneId[];
  dismembermentEvents: DismembermentEvent[];
  shatteredBones: string[];
  rupturedOrgans: string[];
  trajectorySamples: TrajectorySample[];
}

export interface RagdollBoneState {
  zone: GhoulZoneId;
  position: Vec3Like;
  velocity: Vec3Like;
  angularVelocity: Vec3Like;
  rotationEuler: Vec3Like;
  massKg: number;
  severed: boolean;
  goreMode: GoreMode;
  grounded: boolean;
}

export interface TargetHealthState {
  targetId: string;
  name: string;
  worldPosition: Vec3Like;
  yawRad: number;
  maxHp: number;
  currentHp: number;
  bleedRateHpPerSec: number;
  alive: boolean;
  isRagdollActive: boolean;
  ragdollRootPosition: Vec3Like;
  ragdollRootVelocity: Vec3Like;
  ragdollAngularVelocity: Vec3Like;
  ragdollBones: Record<GhoulZoneId, RagdollBoneState>;
  zoneIntegrity: Record<GhoulZoneId, number>;
  zoneGoreMode: Record<GhoulZoneId, GoreMode>;
  severedZones: Set<GhoulZoneId>;
  fracturedBones: Set<string>;
  rupturedOrgans: Set<string>;
}
