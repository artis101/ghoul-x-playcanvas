import type { CombatantConstitution, DelayedLethality, TerminalVarianceSummary } from '../combatantConstitution.ts';
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
  SeverCut,
  WoundChannelEvent,
} from './ghoulZoneContracts.ts';
import type {
  CombatantArmamentState,
  CombatantBodyState,
  CorpseSleepPhase,
  DeathClipId,
  DyingAnimationState,
  RagdollBoneAttachmentState,
  RagdollPhaseState,
  StandingCombatPosture,
  TargetLifecycleEvent,
} from './targetLifecycleTypes.ts';

export type {
  CombatantArmamentState,
  CombatantBodyState,
  CorpseSleepPhase,
  DeathClipId,
  DyingAnimationState,
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
  /** Set when the shot is fatal but the combatant fights on for a few seconds first. */
  delayedLethality?: DelayedLethality | null;
  /** True for a blast (grenade, barrel): a body it kills is thrown, never given a death clip. */
  isExplosiveBlast?: boolean;
  /** How the first round to land behaved inside the body; absent when the target has no variance seed. */
  terminalVariance?: TerminalVarianceSummary | null;
  ragdollPlan: RagdollActivationPlan;
  /** Retained for telemetry inspector compatibility */
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

/**
 * One step of the wounded sequence. Standing after an arm loss: CLUTCH, then BLAZE (draw and gun
 * on its feet), KNEEL_DOWN then KNEEL_FIRE, or SIT_DOWN. On the floor: DOWNED_ENGAGE (seated, only
 * fires straight ahead), DOWNED_CRAWL (rolls onto the belly and drags itself away; never fires),
 * DOWNED_AGONY (lies there), FACE_DOWN (landed on its face: no gun, no damage).
 */
export type WoundedPhase =
  | 'NONE'
  | 'CLUTCH'
  | 'BLAZE'
  | 'KNEEL_DOWN'
  | 'KNEEL_FIRE'
  | 'SIT_DOWN'
  | 'DOWNED_ENGAGE'
  | 'DOWNED_CRAWL'
  | 'DOWNED_AGONY'
  | 'FACE_DOWN';

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
  /** Where the dropped primary weapon lies, while it is on the ground and can be picked back up. */
  droppedWeaponWorld?: Vec3Like;
  /**
   * The hand holding the drawn (or drawing) backup handgun, written by the AI each tick; null or
   * absent while it is holstered. Cutting this arm off kills (limbLossDeathRule.ts).
   */
  sidearmHand?: 'RIGHT' | 'LEFT' | null;
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
  /**
   * Counts every hit the living body takes, including hits that land while a fall, loss or
   * collapse clip is playing and so do not start a new reaction. The pose layer watches it to
   * add a short spring jolt on each hit. Absent until the first hit.
   */
  joltEpoch?: number;
  /** World direction of the hit that last bumped `joltEpoch`. */
  lastJoltDirectionWorld?: Vec3Like;
  /** How hard that hit was, on the same 0..1.3 scale as a reaction's intensity. */
  lastJoltIntensity?: number;
  /**
   * True while a mannequin copies its animated GLB pose into `ragdollBones` every frame. The
   * procedural standing pose then leaves the bones alone, so when a fall clip ends and the body
   * goes ragdoll it starts from the seat the clip put it in, not from a made-up standing pose.
   */
  poseFromAnimation?: boolean;
  /**
   * Where a badly wounded combatant is in its one-thing-at-a-time sequence (docs/wound-movement.md).
   * Absent or NONE while it fights normally. Each phase finishes before the next starts.
   */
  woundedPhase?: WoundedPhase;
  /** Seconds spent in the current `woundedPhase`. */
  woundedPhaseTimerS?: number;
  /**
   * 0..1 grit rolled once per combatant from its resolve profile, health and consciousness. High
   * fortitude stands and guns, middling kneels and shoots, low sits down before reaching for a gun.
   */
  fortitude?: number;
  /** Chest-forward direction, flattened, when the body came to rest on the floor. */
  downedFacingWorld?: Vec3Like;
  /**
   * What a falling body will do once it is on the floor, planned every frame of the fall. A body
   * that sits down keeps SIT_DOWN through its collapse and takes this phase when the clip ends.
   */
  plannedDownedPhase?: WoundedPhase;
  /**
   * Seconds a living ragdoll has lain still in the face-down shape. Set (0 or more) as soon as the
   * shape is seen, cleared when it is not; FACE_DOWN is committed only after a settle window, and
   * the body may not draw or fire while the shape is pending.
   */
  faceDownSettleS?: number;
  /** Optional local micro-hitstop freeze timer in seconds (35-50ms on heavy/shattering hits) */
  hitstopRemainingS?: number;
  alive: boolean;
  /**
   * Set while a body killed on its feet plays its death clip (`alive` false, `isRagdollActive`
   * false). Cleared when the corpse ragdoll takes over. Absent or null otherwise.
   */
  dying?: DyingAnimationState | null;
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
  ragdollBones: Record<GhoulZoneId, RagdollBoneState>;
  auxParticles: Record<AuxParticleId, AuxRagdollParticle>;
  ragdollConstraints: RagdollDistanceConstraint[];
  zoneIntegrity: Record<GhoulZoneId, number>;
  zoneCumulativeDamageJ: Record<GhoulZoneId, number>;
  zoneGoreMode: Record<GhoulZoneId, GoreMode>;
  severedZones: Set<GhoulZoneId>;
  /** Impact-located cut for each zone severed mid-bone; zones missing here parted at their joint. */
  severCuts?: Partial<Record<GhoulZoneId, SeverCut>>;
  fracturedBones: Set<string>;
  rupturedOrgans: Set<string>;
  surfaceWounds: LocalizedSurfaceWound[];
  /** Rolled at spawn; absent means an average body (and is what headless tests use). */
  constitution?: CombatantConstitution;
  /**
   * Seeds the per-shot terminal-ballistics variance. Advances after every hit that lands, so repeated
   * shots differ while every re-simulation of one trigger pull agrees. Absent: no variance.
   */
  shotVarianceSeed?: number;
}
