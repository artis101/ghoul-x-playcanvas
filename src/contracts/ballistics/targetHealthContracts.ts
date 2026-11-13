import {
  AmmoSpec,
  CombatantPostureState,
  EnemyArchetypeId,
  PainReactionType,
  TrajectorySample,
  Vec3Like,
} from './ballisticsTypes.ts';
import {
  DismembermentEvent,
  GhoulZoneId,
  GoreMode,
  LocalizedSurfaceWound,
  RagdollActivationPlan,
  WoundChannelEvent,
} from './ghoulZoneContracts.ts';
import type {
  CombatantArmamentState,
  CombatantBodyState,
  CorpseSleepPhase,
  RagdollBoneAttachmentState,
  RagdollPhaseState,
  StandingCombatPosture,
  TargetLifecycleEvent,
} from './targetLifecycleTypes.ts';

export type {
  CombatantArmamentState,
  CombatantBodyState,
  CorpseSleepPhase,
  RagdollBoneAttachmentState,
  RagdollPhaseState,
  StandingCombatPosture,
  TargetLifecycleEvent,
};

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
  /**
   * The basis's +X axis, with forward = right × up. On an upright body facing +Z this axis
   * points to the character's own LEFT; the name is the basis-triple convention, not a body side.
   */
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
  /** Explicit attachment state ('ATTACHED' | 'DETACHED_LIMB' | 'OBLITERATED_HIDDEN') */
  attachmentState: RagdollBoneAttachmentState;
  grounded: boolean;
}

export type AuxParticleId =
  | 'HEAD_TOP'
  | 'HAND_TIP_RIGHT'
  | 'HAND_TIP_LEFT'
  | 'FOOT_TOE_RIGHT'
  | 'FOOT_TOE_LEFT';

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
  /** Monotonic counter incremented whenever a fresh pain reaction starts */
  epoch: number;
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
  /** True (~12.5% southpaw chance) when the combatant triggers the weapon with their own left hand (+X); false for a right-hander (-X). See core `handedness.ts`. */
  isLeftHanded: boolean;
  rightLegFunctional: boolean;
  leftLegFunctional: boolean;
  rightArmFunctional: boolean;
  leftArmFunctional: boolean;
  headgearIntact: boolean;
  weaponDropped: boolean;
  /** True when the primary weapon was dropped due to direct arm/hand trauma or disarm rather than leg knockdown */
  primaryArmDisarmed?: boolean;
  /** Optional live tactical resolve archetype for AI & HUD telemetry */
  resolveProfile?:
    | 'HARDENED_VETERAN'
    | 'FANATIC_BERSERKER'
    | 'GRITTY_REGULAR'
    | 'PANICKED_SCRAPPER';
  /** Optional combatant tactical status badge surfaced in HUD triage overlays */
  combatantStatusTag?:
    | 'SIDEARM_DRAWN'
    | 'SIDEARM_DRAWING'
    | 'LAST_STAND'
    | 'DISARMED'
    | 'PANIC_SHAKEN'
    | 'JUGGERNAUT'
    | 'RUSHING'
    | null;
  hasChestArmor: boolean;
  chestArmorIntegrity: number;
  hasHelmetArmor: boolean;
  helmetArmorIntegrity: number;
  activeReaction: ActivePainReaction;
  /** Optional local micro-hitstop freeze timer in seconds (35-50ms on heavy/shattering hits) */
  hitstopRemainingS?: number;
  alive: boolean;
  isRagdollActive: boolean;
  /** Explicit ragdoll corpse-sleep & living-agony phase FSM */
  ragdollPhase: RagdollPhaseState;
  /** Synchronized orthogonal body lifecycle FSM state */
  bodyState?: CombatantBodyState;
  /** Synchronized orthogonal armament lifecycle FSM state */
  armamentState?: CombatantArmamentState;
  ragdollRootPosition: Vec3Like;
  ragdollRootVelocity: Vec3Like;
  ragdollAngularVelocity: Vec3Like;
  /** Where a downed shooter points its weapon, so its head can look along it. Null while not aiming. */
  downedAimDirWorld?: Vec3Like | null;
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
