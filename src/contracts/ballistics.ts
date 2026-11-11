export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export type AmmoType = 'FMJ' | 'JHP' | 'AP' | 'BUCKSHOT_00';

export type EnemyArchetypeId =
  | 'SKINHEAD_PUNK'
  | 'MILITIA_GUNNER'
  | 'HEAVY_ENFORCER'
  | 'SNIPER_OPERATIVE';

export type CombatantPostureState =
  | 'COMBAT_READY'
  | 'STAGGERED'
  | 'LEG_BUCKLED'
  | 'THROAT_CLUTCH'
  | 'GUT_HURT'
  | 'DISARMED'
  | 'AIRBORNE_RAGDOLL'
  | 'RAGDOLL_GROUNDED';

export type PainReactionType =
  | 'NONE'
  | 'HEAD_SNAP'
  | 'THROAT_CLUTCH'
  | 'CHEST_STAGGER'
  | 'GUT_FOLD'
  | 'ARM_WRENCH_LEFT'
  | 'ARM_WRENCH_RIGHT'
  | 'LEG_BUCKLE_LEFT'
  | 'LEG_BUCKLE_RIGHT';

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
  /** Cinematic knockback amplification factor */
  ragdollImpulseMultiplier: number;
  /** Gore & dismemberment multiplier */
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
 * The classic Soldier of Fortune (2000) GHOUL Gore Zone Taxonomy (22 distinct anatomical damage & sever zones).
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
  isLethalKill: boolean;
  ragdollPlan: RagdollActivationPlan;
  /** Retained for telemetry inspector compatibility */
  triggerXRayKillCam: boolean;
  xRayFocusZone: GhoulZoneId | null;
  xRayHighlightPointWorld: Vec3Like | null;
  severedZones: GhoulZoneId[];
  dismembermentEvents: DismembermentEvent[];
  shatteredBones: string[];
  rupturedOrgans: string[];
  /** Real-world combatant trauma effects triggered by this shot */
  combatantEffects: string[];
  headgearKnockedOff: boolean;
  weaponDisarmed: boolean;
  trajectorySamples: TrajectorySample[];
}

/**
 * 3D orthonormal orientation basis (column vectors Right, Up, Forward) + position for exact ragdoll bone rendering.
 */
export interface RagdollBoneState {
  zone: GhoulZoneId;
  position: Vec3Like;
  prevPosition: Vec3Like;
  velocity: Vec3Like;
  angularVelocity: Vec3Like;
  rotationEuler: Vec3Like;
  /** Orthonormal right (+X), up (+Y), forward (+Z) vectors in world space */
  basisRight: Vec3Like;
  basisUp: Vec3Like;
  basisForward: Vec3Like;
  /** Distal endpoint in world space (e.g. elbow for upper arm, wrist for forearm) */
  distalPosition: Vec3Like;
  massKg: number;
  radiusM: number;
  /** Connected PBD component ID ('BODY' when attached, or 'SEVERED_<ZONE>' when amputated) */
  componentId: string;
  severed: boolean;
  goreMode: GoreMode;
  grounded: boolean;
}

export type AuxParticleId =
  | 'HEAD_TOP'
  | 'HAND_TIP_LEFT'
  | 'HAND_TIP_RIGHT'
  | 'FOOT_TOE_LEFT'
  | 'FOOT_TOE_RIGHT';

export interface AuxRagdollParticle {
  id: AuxParticleId;
  parentZone: GhoulZoneId;
  position: Vec3Like;
  prevPosition: Vec3Like;
  velocity: Vec3Like;
  massKg: number;
  radiusM: number;
  componentId: string;
}

export interface RagdollDistanceConstraint {
  id: string;
  nodeA: GhoulZoneId | AuxParticleId;
  nodeB: GhoulZoneId | AuxParticleId;
  restLength: number;
  minLength: number;
  maxLength: number;
  /** Stiffness in [0, 1] per solver iteration (1.0 = rigid bone, 0.25 = soft anatomical bend limit) */
  stiffness: number;
}

export interface ActivePainReaction {
  type: PainReactionType;
  timerS: number;
  durationS: number;
  intensity: number;
  hitDirectionWorld: Vec3Like;
}

export interface TargetHealthState {
  targetId: string;
  name: string;
  archetype: EnemyArchetypeId;
  worldPosition: Vec3Like;
  yawRad: number;
  maxHp: number;
  currentHp: number;
  bleedRateHpPerSec: number;
  /** Realistic physiological vitals */
  bloodVolumeMl: number;
  bloodLossRateMlPerSec: number;
  systolicBpMmHg: number;
  heartRateBpm: number;
  oxygenSaturationPct: number;
  consciousness: number;
  painShock: number;
  posture: CombatantPostureState;
  /** True (~12.5% southpaw chance) when combatant shoulders & triggers weapon on anatomical left (+X); false (~87.5%) for standard right-handed (-X) */
  isLeftHanded: boolean;
  leftLegFunctional: boolean;
  rightLegFunctional: boolean;
  leftArmFunctional: boolean;
  rightArmFunctional: boolean;
  headgearIntact: boolean;
  weaponDropped: boolean;
  hasChestArmor: boolean;
  chestArmorIntegrity: number;
  hasHelmetArmor: boolean;
  helmetArmorIntegrity: number;
  activeReaction: ActivePainReaction;
  alive: boolean;
  isRagdollActive: boolean;
  ragdollRootPosition: Vec3Like;
  ragdollRootVelocity: Vec3Like;
  ragdollAngularVelocity: Vec3Like;
  ragdollBones: Record<GhoulZoneId, RagdollBoneState>;
  auxParticles: Record<AuxParticleId, AuxRagdollParticle>;
  ragdollConstraints: RagdollDistanceConstraint[];
  zoneIntegrity: Record<GhoulZoneId, number>;
  zoneCumulativeDamageJ: Record<GhoulZoneId, number>;
  zoneGoreMode: Record<GhoulZoneId, GoreMode>;
  severedZones: Set<GhoulZoneId>;
  fracturedBones: Set<string>;
  rupturedOrgans: Set<string>;
  surfaceWounds: LocalizedSurfaceWound[];
}
