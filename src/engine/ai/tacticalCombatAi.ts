import * as pc from 'playcanvas';
import type {
  CombatantPostureState,
  EnemyArchetypeId,
  GhoulZoneId,
  TargetHealthState,
  Vec3Like,
} from '../../contracts/ballistics.ts';
import {
  add,
  copyVec3,
  cross,
  deterministicConeSpread,
  distance,
  dot,
  length,
  normalize,
  scale,
  sub,
  vec3,
} from '../../core/ballistics/vec3.ts';
import {
  CombatantTriageStatus,
  computeCombatantTriageStatus,
} from '../../core/ballistics/solver.ts';
import { updateStandingCombatPose } from '../../core/ghoul/anatomy.ts';
import { DESTRUCTION_ZONE_LAYOUT } from '../world/arenaBuilder.ts';
import { HardwareInstancedPool } from '../physics/instancedPool.ts';
import { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import { basisColumnsToQuaternion } from '../fx/mayhemDirector.ts';

// ============================================================================
// Contracts, Combatant Resolve Profiles & Tactical Cover Layout
// ============================================================================

export type EnemyTacticalAiState =
  | 'PATROL_GUARD'
  | 'ALERTED_ENGAGING'
  | 'SUPPRESSED_STAGGERED'
  | 'DOWNED_CRAWLING'
  | 'DEAD';

export type CombatantResolveProfile =
  | 'HARDENED_VETERAN'
  | 'FANATIC_BERSERKER'
  | 'GRITTY_REGULAR'
  | 'PANICKED_SCRAPPER';

export type ActiveFiringHand = 'LEFT' | 'RIGHT';

export type BrutalKillRewardKind =
  | 'CRANIAL_POP'
  | 'CLEAN_SEVER'
  | 'EVISCERATED'
  | 'MULTI_KILL_BLAST'
  | 'STANDARD_KILL';

export interface TacticalCoverStation {
  readonly stationId: string;
  readonly coverAnchorWorld: Vec3Like;
  readonly peekSign: -1 | 1;
  readonly peekStrideM: number;
  readonly guardYawDeg: number;
}

/**
 * Tactical hostile cover stations positioned directly behind Wave-2 destructible cover
 * (wood shoot-house wall, marching/Voronoi glass windows, instanced brick wall, Voronoi concrete barrier)
 * and flanking red hazard barrels.
 */
export const TACTICAL_COVER_STATIONS: readonly TacticalCoverStation[] = [
  {
    stationId: DESTRUCTION_ZONE_LAYOUT.woodShootHouseWall.id,
    coverAnchorWorld: { x: -2.3, y: 0, z: -8.35 },
    peekSign: 1,
    peekStrideM: 1.72,
    guardYawDeg: 6,
  },
  {
    stationId: DESTRUCTION_ZONE_LAYOUT.instancedBrickWall.id,
    coverAnchorWorld: { x: -3.8, y: 0, z: -13.75 },
    peekSign: 1,
    peekStrideM: 1.72,
    guardYawDeg: 10,
  },
  {
    stationId: DESTRUCTION_ZONE_LAYOUT.voronoiConcreteWall.id,
    coverAnchorWorld: { x: 2.3, y: 0, z: -14.85 },
    peekSign: -1,
    peekStrideM: 1.82,
    guardYawDeg: -8,
  },
  {
    stationId: DESTRUCTION_ZONE_LAYOUT.glassVoronoiWindow.id,
    coverAnchorWorld: { x: 5.5, y: 0, z: -8.1 },
    peekSign: -1,
    peekStrideM: 0.75,
    guardYawDeg: -14,
  },
];

export interface EnemyCoverShotInterceptResult {
  readonly blocked: boolean;
  readonly impactPointWorld?: Vec3Like;
}

export interface EnemyTracerFireEvent {
  readonly targetId: string;
  readonly archetype: EnemyArchetypeId;
  readonly muzzleOriginWorld: Vec3Like;
  readonly shotDirectionWorld: Vec3Like;
  readonly impactPointWorld: Vec3Like;
  readonly tracerSpeedMs: number;
  readonly spreadConeRad: number;
  readonly spreadMultiplier: number;
  readonly hitPlayer: boolean;
  readonly blockedByCover: boolean;
  readonly armorChipApplied: number;
  readonly healthDamageApplied: number;
  readonly activeFiringHand: ActiveFiringHand;
  readonly usedBackupSidearm: boolean;
  readonly weaponId: string;
}

export interface PlayerCombatVitals {
  health: number;
  maxHealth: number;
  armor: number;
  maxArmor: number;
  damageEnabled: boolean;
  timeSinceLastHitS: number;
  invulnerabilityRemainingS: number;
}

export interface EnemyAimProfile {
  readonly baseSpreadRad: number;
  readonly spreadMultiplier: number;
  readonly effectiveSpreadRad: number;
  readonly aimAccuracyMultiplier: number;
  readonly canReturnFire: boolean;
  readonly isOneHandedDownedFire: boolean;
  readonly clutchingWound: boolean;
  readonly usingBackupSidearm: boolean;
  readonly sidearmDrawing: boolean;
  readonly activeFiringHand: ActiveFiringHand | null;
}

export interface EnemySidearmVisualState {
  readonly visible: boolean;
  readonly drawing: boolean;
  readonly drawProgress: number;
  readonly hand: ActiveFiringHand | null;
  readonly dropped: boolean;
  readonly aimTargetWorld: Vec3Like;
  readonly weaponId: string;
}

export interface EnemyAiAgentRuntime {
  readonly targetId: string;
  state: EnemyTacticalAiState;
  triageStatus: CombatantTriageStatus;
  resolveProfile: CombatantResolveProfile;
  carriesBackupSidearm: boolean;

  coverAnchorWorld: Vec3Like;
  peekSign: -1 | 1;
  peekStrideM: number;
  guardBaseYawRad: number;

  adrenaline: number;
  suppression: number;
  neurogenicShockTimerS: number;
  staggerTimerS: number;

  peekCycleTimerS: number;
  isPeekingOut: boolean;
  currentLateralOffsetM: number;
  berserkerAdvanceOffsetM: number;

  activeFiringHand: ActiveFiringHand;
  sidearmDrawTimerS: number;
  sidearmDrawing: boolean;
  sidearmActive: boolean;
  sidearmDropped: boolean;

  burstShotsRemaining: number;
  burstInterShotTimerS: number;
  fireCooldownTimerS: number;
  tracerSeedCounter: number;
  completedBurstCount: number;

  lastObservedHp: number;
  lastSpreadMultiplier: number;
  lastAimAccuracyMultiplier: number;
  clutchingWound: boolean;
  lastAimTargetWorld: Vec3Like;
}

export interface EnemyHitNotification {
  hitZone?: GhoulZoneId;
  energyDepositedJ?: number;
  isTorsoHit?: boolean;
  externalAccuracyMultiplier?: number;
}

export interface TacticalCombatAiOptions {
  app?: pc.Application | null;
  rapierWorld?: RapierPhysicsWorld | null;
  playerDamageEnabled?: boolean;
  initialPlayerHealth?: number;
  initialPlayerArmor?: number;
  /** Sight detection range in meters when player is in front hemisphere (default 30m) */
  sightDetectionRangeM?: number;
  /** Optional deterministic per-target resolve profile overrides */
  resolveProfileOverrides?: Readonly<Record<string, CombatantResolveProfile>>;
  /** Optional deterministic per-target backup sidearm overrides */
  hardenedSidearmOverrides?: Readonly<Record<string, boolean>>;
  /** Optional breach-aware visual sight occlusion query (e.g. DestructionManager.isLineOfSightBlocked) */
  isLineOfSightBlocked?: (fromWorld: Vec3Like, toWorld: Vec3Like) => boolean;
  /** Optional physical cover shot interceptor from enemy core to player target */
  interceptEnemyShotCover?: (
    originWorld: Vec3Like,
    directionWorld: Vec3Like,
    maxDistanceM: number,
  ) => EnemyCoverShotInterceptResult;
  onEnemyFireTracer?: (event: EnemyTracerFireEvent) => void;
  onPlayerDamaged?: (vitals: Readonly<PlayerCombatVitals>, event: EnemyTracerFireEvent) => void;
  onEnemyStateChanged?: (
    targetId: string,
    prevState: EnemyTacticalAiState,
    nextState: EnemyTacticalAiState,
  ) => void;
}

interface ArchetypeCombatTuning {
  readonly primaryWeaponId: string;
  readonly baseSpreadRad: number;
  readonly burstCount: number;
  readonly interShotDelayS: number;
  readonly burstCooldownS: number;
  readonly strafeSpeedMs: number;
  readonly tracerSpeedMs: number;
  readonly baseChipDamage: number;
}

const ARCHETYPE_TUNING: Record<EnemyArchetypeId, ArchetypeCombatTuning> = {
  SKINHEAD_PUNK: {
    primaryWeaponId: 'silver_talon_50ae',
    baseSpreadRad: 0.052,
    burstCount: 4,
    interShotDelayS: 0.11,
    burstCooldownS: 1.55,
    strafeSpeedMs: 2.15,
    tracerSpeedMs: 78,
    baseChipDamage: 4.0,
  },
  MILITIA_GUNNER: {
    primaryWeaponId: 'm4a1_carbine',
    baseSpreadRad: 0.038,
    burstCount: 3,
    interShotDelayS: 0.14,
    burstCooldownS: 1.75,
    strafeSpeedMs: 1.85,
    tracerSpeedMs: 92,
    baseChipDamage: 5.0,
  },
  HEAVY_ENFORCER: {
    primaryWeaponId: 'm590_shotgun',
    baseSpreadRad: 0.062,
    burstCount: 2,
    interShotDelayS: 0.34,
    burstCooldownS: 2.05,
    strafeSpeedMs: 1.35,
    tracerSpeedMs: 72,
    baseChipDamage: 6.5,
  },
  SNIPER_OPERATIVE: {
    primaryWeaponId: 'msg90_sniper',
    baseSpreadRad: 0.018,
    burstCount: 1,
    interShotDelayS: 0.25,
    burstCooldownS: 2.65,
    strafeSpeedMs: 1.5,
    tracerSpeedMs: 125,
    baseChipDamage: 8.0,
  },
};

const SIDEARM_M9_TUNING = {
  weaponId: 'weapon_beretta_m9',
  baseSpreadRad: 0.042,
  interShotDelayS: 0.14,
  burstCooldownS: 1.25,
  tracerSpeedMs: 88,
  baseChipDamage: 4.5,
} as const;

const TORSO_ZONES: ReadonlySet<GhoulZoneId> = new Set<GhoulZoneId>([
  'TORSO_UPPER_THORAX',
  'TORSO_LOWER_ABDOMEN',
  'PELVIS_GROIN',
]);

export const BACKUP_SIDEARM_WEAPON_ID = SIDEARM_M9_TUNING.weaponId;
export const DOWNED_ONE_HANDED_SPREAD_MULTIPLIER = 4.5;
export const OFFHAND_SIDEARM_SPREAD_MULTIPLIER = 1.78;
export const SIDEARM_DRAW_DURATION_S = 0.6;
export const MIN_CONSCIOUSNESS_TO_FIGHT = 0.12;

/**
 * Deterministic 32-bit FNV-1a string hash for repeatable combatant personality assignment.
 */
export function hashCombatantTargetId(targetId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < targetId.length; i++) {
    h ^= targetId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Checks whether the specified arm chain (`SHOULDER_*` -> `UPPER_ARM_*` -> `FOREARM_*` -> `HAND_*`)
 * is structurally unsevered and motor-functional.
 */
export function isArmChainIntactAndFunctional(
  hs: TargetHealthState,
  hand: ActiveFiringHand,
): boolean {
  if (hand === 'LEFT') {
    return (
      hs.leftArmFunctional &&
      !hs.severedZones.has('HAND_LEFT') &&
      !hs.severedZones.has('FOREARM_LEFT') &&
      !hs.severedZones.has('UPPER_ARM_LEFT') &&
      !hs.severedZones.has('SHOULDER_LEFT')
    );
  }
  return (
    hs.rightArmFunctional &&
    !hs.severedZones.has('HAND_RIGHT') &&
    !hs.severedZones.has('FOREARM_RIGHT') &&
    !hs.severedZones.has('UPPER_ARM_RIGHT') &&
    !hs.severedZones.has('SHOULDER_RIGHT')
  );
}

/**
 * Deterministically assigns a `CombatantResolveProfile` and backup handgun eligibility from
 * `archetype` + `targetId` so all 7 arena hostiles exhibit distinct combat personalities while
 * unit tests remain 100% deterministic.
 */
export function resolveDefaultCombatantProfile(
  targetId: string,
  archetype: EnemyArchetypeId,
): { resolveProfile: CombatantResolveProfile; carriesBackupSidearm: boolean } {
  if (archetype === 'HEAVY_ENFORCER' || archetype === 'SNIPER_OPERATIVE') {
    return { resolveProfile: 'HARDENED_VETERAN', carriesBackupSidearm: true };
  }

  // Curated variety across the 7 Tactical Breaching Arena stations (`target_0` .. `target_6`)
  switch (targetId) {
    case 'target_0':
      return { resolveProfile: 'FANATIC_BERSERKER', carriesBackupSidearm: false };
    case 'target_1':
      return { resolveProfile: 'FANATIC_BERSERKER', carriesBackupSidearm: true };
    case 'target_2':
      return { resolveProfile: 'PANICKED_SCRAPPER', carriesBackupSidearm: false };
    case 'target_3':
      return { resolveProfile: 'GRITTY_REGULAR', carriesBackupSidearm: false };
    case 'target_4':
      return { resolveProfile: 'HARDENED_VETERAN', carriesBackupSidearm: true };
    case 'hostile_alpha':
      return { resolveProfile: 'GRITTY_REGULAR', carriesBackupSidearm: false };
    default:
      break;
  }

  const h = hashCombatantTargetId(targetId);
  if (archetype === 'SKINHEAD_PUNK') {
    return {
      resolveProfile: h % 2 === 0 ? 'FANATIC_BERSERKER' : 'PANICKED_SCRAPPER',
      carriesBackupSidearm: false,
    };
  }

  // MILITIA_GUNNER deterministic mix: veteran gunners, gritty regulars, fanatic breachers, panicked scrappers
  const bucket = h % 4;
  if (bucket === 1) {
    return { resolveProfile: 'HARDENED_VETERAN', carriesBackupSidearm: true };
  }
  if (bucket === 2) {
    return { resolveProfile: 'FANATIC_BERSERKER', carriesBackupSidearm: false };
  }
  if (bucket === 3) {
    return { resolveProfile: 'PANICKED_SCRAPPER', carriesBackupSidearm: false };
  }
  return { resolveProfile: 'GRITTY_REGULAR', carriesBackupSidearm: false };
}

function getPreferredPrimaryHand(hs: TargetHealthState): ActiveFiringHand {
  return hs.isLeftHanded ? 'RIGHT' : 'LEFT';
}

function selectIntactFiringHand(
  hs: TargetHealthState,
  preferred: ActiveFiringHand,
): ActiveFiringHand | null {
  const leftIntact = isArmChainIntactAndFunctional(hs, 'LEFT');
  const rightIntact = isArmChainIntactAndFunctional(hs, 'RIGHT');
  if (!leftIntact && !rightIntact) {
    return null;
  }
  if (leftIntact && !rightIntact) {
    return 'LEFT';
  }
  if (rightIntact && !leftIntact) {
    return 'RIGHT';
  }
  // Both arm chains are structurally intact: if one hand took a disarming graze, prefer the healthier hand
  const leftHandIntegrity = hs.zoneIntegrity.HAND_LEFT ?? 100;
  const rightHandIntegrity = hs.zoneIntegrity.HAND_RIGHT ?? 100;
  if (Math.abs(leftHandIntegrity - rightHandIntegrity) > 5) {
    return rightHandIntegrity > leftHandIntegrity ? 'RIGHT' : 'LEFT';
  }
  return preferred;
}

function wrapAngleRad(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function approachAngleRad(current: number, target: number, maxStep: number): number {
  const diff = wrapAngleRad(target - current);
  if (Math.abs(diff) <= maxStep) {
    return wrapAngleRad(target);
  }
  return wrapAngleRad(current + Math.sign(diff) * maxStep);
}

// ============================================================================
// TacticalCombatAiSystem
// ============================================================================

/**
 * Turns GHOUL combatants into relentless tactical FPS hostiles with personality resolve traits
 * (`HARDENED_VETERAN`, `FANATIC_BERSERKER`, `GRITTY_REGULAR`, `PANICKED_SCRAPPER`), wounded last-stand
 * combat resolve (fighting through gut, chest, bleeding, and leg-buckled trauma until death),
 * limb-dismemberment disarming for standard fighters, and off-hand Beretta M9 handgun draw for hardened veterans.
 */
export class TacticalCombatAiSystem {
  public readonly playerVitals: PlayerCombatVitals;

  public isLineOfSightBlockedCallback?: (fromWorld: Vec3Like, toWorld: Vec3Like) => boolean;
  public interceptEnemyShotCover?: (
    originWorld: Vec3Like,
    directionWorld: Vec3Like,
    maxDistanceM: number,
  ) => EnemyCoverShotInterceptResult;
  public onEnemyFireTracer?: (event: EnemyTracerFireEvent) => void;
  public onPlayerDamaged?: (
    vitals: Readonly<PlayerCombatVitals>,
    event: EnemyTracerFireEvent,
  ) => void;
  public onEnemyStateChanged?: (
    targetId: string,
    prevState: EnemyTacticalAiState,
    nextState: EnemyTacticalAiState,
  ) => void;

  private readonly app: pc.Application | null;
  private readonly rapierWorld: RapierPhysicsWorld | null;
  private readonly sightDetectionRangeM: number;
  private readonly tracerPool: HardwareInstancedPool | null;

  private readonly resolveProfileOverrides = new Map<string, CombatantResolveProfile>();
  private readonly hardenedSidearmOverrides = new Map<string, boolean>();
  private readonly agents = new Map<string, EnemyAiAgentRuntime>();
  private readonly peekPlanCache = new Map<
    string,
    {
      timestampS: number;
      isPeekingOut: boolean;
      peekSign: -1 | 1;
      playerX: number;
      playerZ: number;
      baseOffset: number;
      jitterMode: 'NONE' | 'FINE' | 'SIDE';
      goalZ: number;
      anchorBlockedByCover: boolean;
    }
  >();
  private readonly aimExposureCache = new Map<
    string,
    {
      timestampS: number;
      enemyX: number;
      enemyZ: number;
      playerX: number;
      playerZ: number;
      result: Vec3Like | null;
    }
  >();
  private elapsedClockS = 0;
  private destroyed = false;

  public constructor(options: TacticalCombatAiOptions = {}) {
    this.app = options.app ?? null;
    this.rapierWorld = options.rapierWorld ?? null;
    this.sightDetectionRangeM = Math.max(5, options.sightDetectionRangeM ?? 30.0);
    this.isLineOfSightBlockedCallback = options.isLineOfSightBlocked;
    this.interceptEnemyShotCover = options.interceptEnemyShotCover;
    this.onEnemyFireTracer = options.onEnemyFireTracer;
    this.onPlayerDamaged = options.onPlayerDamaged;
    this.onEnemyStateChanged = options.onEnemyStateChanged;

    if (options.resolveProfileOverrides) {
      for (const [id, prof] of Object.entries(options.resolveProfileOverrides)) {
        this.resolveProfileOverrides.set(id, prof);
      }
    }
    if (options.hardenedSidearmOverrides) {
      for (const [id, flag] of Object.entries(options.hardenedSidearmOverrides)) {
        this.hardenedSidearmOverrides.set(id, flag);
      }
    }

    const maxHealth = 100;
    const maxArmor = 100;
    this.playerVitals = {
      health: Math.max(1, Math.min(maxHealth, options.initialPlayerHealth ?? 100)),
      maxHealth,
      armor: Math.max(0, Math.min(maxArmor, options.initialPlayerArmor ?? 50)),
      maxArmor,
      damageEnabled: options.playerDamageEnabled ?? true,
      timeSinceLastHitS: 10,
      invulnerabilityRemainingS: 0,
    };

    if (this.app) {
      const dev = this.app.graphicsDevice;
      const boltMesh = pc.Mesh.fromGeometry(dev, new pc.BoxGeometry());
      const tracerMat = new pc.StandardMaterial();
      tracerMat.name = 'enemyGlowingTracerMat';
      tracerMat.diffuse = new pc.Color(1.0, 0.36, 0.08);
      tracerMat.emissive = new pc.Color(1.0, 0.42, 0.1);
      tracerMat.blendType = pc.BLEND_ADDITIVEALPHA;
      tracerMat.opacity = 0.92;
      tracerMat.depthWrite = false;
      tracerMat.cull = pc.CULLFACE_NONE;
      tracerMat.update();

      this.tracerPool = new HardwareInstancedPool(
        this.app,
        boltMesh,
        tracerMat,
        128,
        'EnemyTracerBoltPool',
        false,
      );
    } else {
      this.tracerPool = null;
    }
  }

  public setPlayerDamageEnabled(enabled: boolean): void {
    this.playerVitals.damageEnabled = enabled;
  }

  /**
   * Explicitly overrides a combatant's resolve profile and optional backup sidearm carry flag.
   */
  public setCombatantResolveProfile(
    targetId: string,
    profile: CombatantResolveProfile,
    carriesBackupSidearm?: boolean,
  ): void {
    this.resolveProfileOverrides.set(targetId, profile);
    const sidearm = carriesBackupSidearm ?? profile === 'HARDENED_VETERAN';
    this.hardenedSidearmOverrides.set(targetId, sidearm);

    const existing = this.agents.get(targetId);
    if (existing) {
      existing.resolveProfile = profile;
      existing.carriesBackupSidearm = sidearm;
    }
  }

  /**
   * Queries the live 3D visual state of a combatant's off-hand backup handgun for `CombatDirector`
   * GLB/procedural M9 attachment and dynamic single-arm aiming toward the player.
   */
  public getSidearmVisualState(targetId: string): EnemySidearmVisualState {
    const agent = this.agents.get(targetId);
    if (!agent) {
      return {
        visible: false,
        drawing: false,
        drawProgress: 0,
        hand: null,
        dropped: false,
        aimTargetWorld: vec3(0, 1.5, 0),
        weaponId: BACKUP_SIDEARM_WEAPON_ID,
      };
    }

    const visible = agent.sidearmActive || agent.sidearmDrawing;
    const drawProgress = agent.sidearmActive
      ? 1.0
      : agent.sidearmDrawing
        ? Math.max(0, Math.min(1, 1 - agent.sidearmDrawTimerS / SIDEARM_DRAW_DURATION_S))
        : 0.0;

    return {
      visible,
      drawing: agent.sidearmDrawing,
      drawProgress,
      hand: visible ? agent.activeFiringHand : null,
      dropped: agent.sidearmDropped,
      aimTargetWorld: copyVec3(agent.lastAimTargetWorld),
      weaponId: BACKUP_SIDEARM_WEAPON_ID,
    };
  }

  /**
   * Registers a wave of `TargetHealthState` combatants and optionally repositions them
   * behind tactical destructible cover stations.
   */
  public registerWaveTargets(
    targets: readonly TargetHealthState[],
    deployToCoverStations = false,
  ): void {
    this.agents.clear();
    this.peekPlanCache.clear();
    this.aimExposureCache.clear();

    for (let i = 0; i < targets.length; i++) {
      const hs = targets[i];
      let coverSpec: TacticalCoverStation | undefined;

      if (deployToCoverStations) {
        coverSpec = TACTICAL_COVER_STATIONS[i % TACTICAL_COVER_STATIONS.length];
        if (coverSpec) {
          hs.worldPosition = copyVec3(coverSpec.coverAnchorWorld);
          hs.yawRad = (coverSpec.guardYawDeg * Math.PI) / 180;
          updateStandingCombatPose(hs, this.elapsedClockS);
        }
      } else {
        let bestDist = 2.2;
        for (const st of TACTICAL_COVER_STATIONS) {
          const d = Math.hypot(
            hs.worldPosition.x - st.coverAnchorWorld.x,
            hs.worldPosition.z - st.coverAnchorWorld.z,
          );
          if (d <= bestDist) {
            bestDist = d;
            coverSpec = st;
          }
        }
      }

      const defaults = resolveDefaultCombatantProfile(hs.targetId, hs.archetype);
      const resolveProfile =
        this.resolveProfileOverrides.get(hs.targetId) ??
        hs.resolveProfile ??
        defaults.resolveProfile;
      const carriesBackupSidearm =
        this.hardenedSidearmOverrides.get(hs.targetId) ??
        (this.resolveProfileOverrides.has(hs.targetId) || hs.resolveProfile !== undefined
          ? resolveProfile === 'HARDENED_VETERAN' || defaults.carriesBackupSidearm
          : defaults.carriesBackupSidearm);

      hs.resolveProfile = resolveProfile;
      hs.combatantStatusTag = null;

      const anchor = copyVec3(hs.worldPosition);
      const peekSign: -1 | 1 = coverSpec
        ? coverSpec.peekSign
        : hs.worldPosition.x < 0
          ? 1
          : -1;

      const primaryHand = getPreferredPrimaryHand(hs);

      const agent: EnemyAiAgentRuntime = {
        targetId: hs.targetId,
        state: hs.alive ? 'PATROL_GUARD' : 'DEAD',
        triageStatus: computeCombatantTriageStatus(hs),
        resolveProfile,
        carriesBackupSidearm,

        coverAnchorWorld: anchor,
        peekSign,
        peekStrideM: coverSpec?.peekStrideM ?? 0.95,
        guardBaseYawRad: hs.yawRad,

        adrenaline: 0.05,
        suppression: 0,
        neurogenicShockTimerS: 0,
        staggerTimerS: 0,

        peekCycleTimerS: (i * 0.73) % 2.4,
        isPeekingOut: false,
        currentLateralOffsetM: 0,
        berserkerAdvanceOffsetM: 0,

        activeFiringHand: primaryHand,
        sidearmDrawTimerS: 0,
        sidearmDrawing: false,
        sidearmActive: false,
        sidearmDropped: false,

        burstShotsRemaining: 0,
        burstInterShotTimerS: 0,
        fireCooldownTimerS: 0.65 + (i % 4) * 0.35,
        tracerSeedCounter: 100 + i * 37,
        completedBurstCount: 0,

        lastObservedHp: hs.currentHp,
        lastSpreadMultiplier: 1.0,
        lastAimAccuracyMultiplier: 1.0,
        clutchingWound: false,
        lastAimTargetWorld: vec3(0, 1.5, 0),
      };

      this.agents.set(hs.targetId, agent);
    }
  }

  public getAgent(targetId: string): EnemyAiAgentRuntime | undefined {
    return this.agents.get(targetId);
  }

  /**
   * Alerts nearby `PATROL_GUARD` hostiles when the player fires unsuppressed shots or detonates explosives,
   * triggering their combat adrenaline surge (`adrenaline -> 0.88`).
   */
  public notifyGunshotOrExplosion(
    soundOriginWorld: Vec3Like,
    audibleRadiusM = 38.0,
    suppressionImpulse = 0.22,
  ): void {
    for (const agent of this.agents.values()) {
      if (agent.state === 'DEAD') continue;

      const distM = distance(soundOriginWorld, agent.coverAnchorWorld);
      if (distM > audibleRadiusM) continue;

      const proximity = Math.max(0, 1 - distM / audibleRadiusM);
      const suppressionScale =
        agent.resolveProfile === 'FANATIC_BERSERKER'
          ? 0.35
          : agent.resolveProfile === 'HARDENED_VETERAN'
            ? 0.6
            : agent.resolveProfile === 'PANICKED_SCRAPPER'
              ? 1.25
              : 1.0;
      agent.suppression = Math.min(
        1.0,
        agent.suppression + suppressionImpulse * proximity * suppressionScale,
      );

      if (agent.state === 'PATROL_GUARD') {
        agent.adrenaline = Math.max(
          agent.adrenaline,
          agent.resolveProfile === 'FANATIC_BERSERKER' ? 0.96 : 0.88,
        );
        this.transitionState(agent, 'ALERTED_ENGAGING');
      } else if (agent.state === 'ALERTED_ENGAGING') {
        agent.adrenaline = Math.min(1.0, agent.adrenaline + 0.14);
        if (
          agent.resolveProfile !== 'FANATIC_BERSERKER' &&
          agent.resolveProfile !== 'HARDENED_VETERAN' &&
          agent.suppression >= 0.88 &&
          agent.adrenaline < 0.75
        ) {
          agent.staggerTimerS = Math.max(agent.staggerTimerS, 0.5);
          this.transitionState(agent, 'SUPPRESSED_STAGGERED');
        }
      }
    }
  }

  /**
   * Processes direct ballistic/blast trauma on a specific combatant:
   * - Unsuspecting (`PATROL_GUARD`, low adrenaline) targets struck in the torso suffer immediate
   *   **neurogenic shock stagger** (`SUPPRESSED_STAGGERED`, high `painShock`, dropped `consciousness`).
   * - Already alerted (`ALERTED_ENGAGING`) targets surge with combat adrenaline and fight through
   *   gut, chest, and bleeding wounds with brief (`0.35s-0.55s`) impact stagger rather than going passive!
   */
  public notifyEnemyHit(
    target: TargetHealthState,
    hit: EnemyHitNotification = {},
  ): EnemyTacticalAiState {
    let agent = this.agents.get(target.targetId);
    if (!agent) {
      this.registerWaveTargets([target], false);
      agent = this.agents.get(target.targetId)!;
    }

    agent.lastObservedHp = target.currentHp;
    agent.triageStatus = computeCombatantTriageStatus(target);

    if (!target.alive || target.currentHp <= 0) {
      this.syncAgentArmamentAndSidearm(0, target, agent);
      this.transitionState(agent, 'DEAD');
      return agent.state;
    }

    // Immediately evaluate hand/arm dismemberment & off-hand sidearm draw state on impact
    this.syncAgentArmamentAndSidearm(0, target, agent);

    const hitTorso =
      hit.isTorsoHit === true ||
      (hit.hitZone !== undefined && TORSO_ZONES.has(hit.hitZone));
    const wasUnsuspecting = agent.state === 'PATROL_GUARD' && agent.adrenaline < 0.35;

    // Leg destruction overrides standing posture immediately -> DOWNED_CRAWLING (still fighting!)
    if (!target.leftLegFunctional || !target.rightLegFunctional) {
      agent.adrenaline = Math.max(
        agent.adrenaline,
        agent.resolveProfile === 'FANATIC_BERSERKER' ? 1.0 : 0.82,
      );
      if (!target.isRagdollActive) {
        target.posture = agent.clutchingWound ? 'DISARMED' : 'LEG_BUCKLED';
      }
      this.transitionState(agent, 'DOWNED_CRAWLING');
      this.refreshAgentAimMetrics(target, agent, hit.externalAccuracyMultiplier);
      return agent.state;
    }

    if (wasUnsuspecting && hitTorso) {
      // Stage-4 Neurogenic / Vagal Shock Stagger on unsuspecting guard!
      agent.neurogenicShockTimerS = 1.65;
      agent.staggerTimerS = 1.65;
      agent.burstShotsRemaining = 0;
      target.painShock = Math.max(target.painShock, 0.85);
      target.consciousness = Math.min(target.consciousness, 0.42);
      if (!target.isRagdollActive) {
        target.posture =
          hit.hitZone === 'TORSO_LOWER_ABDOMEN' ? 'GUT_HURT' : 'STAGGERED';
      }
      this.transitionState(agent, 'SUPPRESSED_STAGGERED');
    } else {
      // Alerted target surges with survival adrenaline!
      if (agent.resolveProfile === 'FANATIC_BERSERKER') {
        agent.adrenaline = 1.0;
      } else {
        agent.adrenaline = Math.min(1.0, Math.max(0.88, agent.adrenaline + 0.22));
      }
      agent.suppression = Math.min(1.0, agent.suppression + 0.32);

      const heavyEnergy = (hit.energyDepositedJ ?? 0) >= 850;
      const flinchDurationS =
        agent.resolveProfile === 'FANATIC_BERSERKER'
          ? 0.35
          : agent.resolveProfile === 'HARDENED_VETERAN'
            ? 0.38
            : agent.resolveProfile === 'PANICKED_SCRAPPER'
              ? 0.52
              : 0.46;

      if (
        heavyEnergy ||
        target.painShock - agent.adrenaline * 0.65 > 0.32 ||
        agent.triageStatus === 'MORTALLY_WOUNDED'
      ) {
        agent.staggerTimerS = Math.max(agent.staggerTimerS, flinchDurationS);
        agent.burstShotsRemaining = 0;
        if (!target.isRagdollActive && target.posture === 'COMBAT_READY') {
          target.posture = 'STAGGERED';
        }
        this.transitionState(agent, 'SUPPRESSED_STAGGERED');
      } else if (agent.state === 'PATROL_GUARD') {
        this.transitionState(agent, 'ALERTED_ENGAGING');
      }
    }

    // Alert nearby squadmates within 18m when an ally is shot
    for (const mate of this.agents.values()) {
      if (mate.targetId === target.targetId || mate.state !== 'PATROL_GUARD') {
        continue;
      }
      if (distance(mate.coverAnchorWorld, target.worldPosition) <= 18.0) {
        mate.adrenaline = Math.max(mate.adrenaline, 0.85);
        this.transitionState(mate, 'ALERTED_ENGAGING');
      }
    }

    this.refreshAgentAimMetrics(target, agent, hit.externalAccuracyMultiplier);
    return agent.state;
  }

  /**
   * Computes trauma-aware weapon accuracy & fire eligibility from `TargetHealthState`.
   *
   * Hardened/desperate combatants fight till the very end: gut-shot, chest-shot, bleeding,
   * mortally-wounded, and leg-buckled fighters KEEP returning fire with realistic tremor/spread
   * growth as long as they remain alive (`alive && currentHp > 0`), minimally conscious (`> 0.12`),
   * not airborne-ragdolled, and possess a usable primary weapon or drawn backup handgun!
   */
  public computeEnemyAimProfile(
    target: TargetHealthState,
    agent?: EnemyAiAgentRuntime,
    externalAccuracyMultiplier?: number,
  ): EnemyAimProfile {
    const tuning = ARCHETYPE_TUNING[target.archetype];

    // 1. Dead or completely unconscious (<= 0.12)
    if (
      !target.alive ||
      target.currentHp <= 0 ||
      target.consciousness <= MIN_CONSCIOUSNESS_TO_FIGHT
    ) {
      return {
        baseSpreadRad: tuning.baseSpreadRad,
        spreadMultiplier: 10.0,
        effectiveSpreadRad: tuning.baseSpreadRad * 10.0,
        aimAccuracyMultiplier: 0,
        canReturnFire: false,
        isOneHandedDownedFire: false,
        clutchingWound: false,
        usingBackupSidearm: false,
        sidearmDrawing: false,
        activeFiringHand: null,
      };
    }

    // 2. Full airborne ragdoll launch incapacitation
    if (target.isRagdollActive && target.posture === 'AIRBORNE_RAGDOLL') {
      return {
        baseSpreadRad: tuning.baseSpreadRad,
        spreadMultiplier: 9.0,
        effectiveSpreadRad: tuning.baseSpreadRad * 9.0,
        aimAccuracyMultiplier: 0.08,
        canReturnFire: false,
        isOneHandedDownedFire: false,
        clutchingWound: false,
        usingBackupSidearm: false,
        sidearmDrawing: false,
        activeFiringHand: null,
      };
    }

    const leftIntact = isArmChainIntactAndFunctional(target, 'LEFT');
    const rightIntact = isArmChainIntactAndFunctional(target, 'RIGHT');
    const bothArmsLost = !leftIntact && !rightIntact;
    const anyArmLost = !leftIntact || !rightIntact;

    // 3. Both arms/hands severed or crippled -> completely disarmed even for hardened veterans
    if (bothArmsLost) {
      return {
        baseSpreadRad: tuning.baseSpreadRad,
        spreadMultiplier: 8.5,
        effectiveSpreadRad: tuning.baseSpreadRad * 8.5,
        aimAccuracyMultiplier: 0.08,
        canReturnFire: false,
        isOneHandedDownedFire: false,
        clutchingWound: true,
        usingBackupSidearm: false,
        sidearmDrawing: false,
        activeFiringHand: null,
      };
    }

    const preferredHand = getPreferredPrimaryHand(target);
    const intactHand = selectIntactFiringHand(target, agent?.activeFiringHand ?? preferredHand);

    const sidearmActive =
      agent !== undefined &&
      agent.sidearmActive &&
      intactHand !== null &&
      isArmChainIntactAndFunctional(target, agent.activeFiringHand);
    const sidearmDrawing =
      agent !== undefined &&
      agent.sidearmDrawing &&
      !sidearmActive &&
      intactHand !== null;

    // Living grounded fighter after leg collapse whose arms were NOT disarmed keeps fighting from the floor
    const groundedWithUnbrokenArms =
      target.isRagdollActive &&
      target.posture !== 'AIRBORNE_RAGDOLL' &&
      !target.primaryArmDisarmed &&
      intactHand !== null;

    const primaryWeaponUsable =
      !anyArmLost &&
      !target.primaryArmDisarmed &&
      (!target.weaponDropped || groundedWithUnbrokenArms);

    if (!primaryWeaponUsable && !sidearmActive) {
      if (sidearmDrawing) {
        return {
          baseSpreadRad: SIDEARM_M9_TUNING.baseSpreadRad,
          spreadMultiplier: OFFHAND_SIDEARM_SPREAD_MULTIPLIER,
          effectiveSpreadRad:
            SIDEARM_M9_TUNING.baseSpreadRad * OFFHAND_SIDEARM_SPREAD_MULTIPLIER,
          aimAccuracyMultiplier: 1.0 / OFFHAND_SIDEARM_SPREAD_MULTIPLIER,
          canReturnFire: false,
          isOneHandedDownedFire: !target.leftLegFunctional || !target.rightLegFunctional,
          clutchingWound: false,
          usingBackupSidearm: false,
          sidearmDrawing: true,
          activeFiringHand: agent?.activeFiringHand ?? intactHand,
        };
      }

      // Disarmed non-hardened combatant clutches wound / stump in shock and cannot attack
      return {
        baseSpreadRad: tuning.baseSpreadRad,
        spreadMultiplier: 8.5,
        effectiveSpreadRad: tuning.baseSpreadRad * 8.5,
        aimAccuracyMultiplier: 0.08,
        canReturnFire: false,
        isOneHandedDownedFire: false,
        clutchingWound: true,
        usingBackupSidearm: false,
        sidearmDrawing: false,
        activeFiringHand: null,
      };
    }

    const inNeurogenicOrStagger =
      agent !== undefined &&
      (agent.neurogenicShockTimerS > 0 || agent.state === 'SUPPRESSED_STAGGERED');

    const resolveProfile =
      agent?.resolveProfile ??
      target.resolveProfile ??
      resolveDefaultCombatantProfile(target.targetId, target.archetype).resolveProfile;
    const triage = computeCombatantTriageStatus(target);

    const legCrippled =
      !target.leftLegFunctional ||
      !target.rightLegFunctional ||
      target.isRagdollActive ||
      agent?.state === 'DOWNED_CRAWLING';

    const baseSpreadRad = sidearmActive
      ? SIDEARM_M9_TUNING.baseSpreadRad
      : tuning.baseSpreadRad;
    let spreadMultiplier = 1.0;

    // Leg-crippled / grounded enemies fire one-handed with heavy >= 4.5x spread cone!
    if (legCrippled) {
      spreadMultiplier *= DOWNED_ONE_HANDED_SPREAD_MULTIPLIER;
    }

    // Off-hand backup handgun (or single crippled arm) applies realistic 1.65x-1.95x one-handed pistol spread
    if (sidearmActive || anyArmLost) {
      spreadMultiplier *= OFFHAND_SIDEARM_SPREAD_MULTIPLIER;
    }

    // Pain shock tremor (hardened veterans & fanatic berserkers resist pain through combat composure/adrenaline)
    const painMitigationFactor =
      resolveProfile === 'HARDENED_VETERAN'
        ? 0.62
        : resolveProfile === 'FANATIC_BERSERKER'
          ? 0.55
          : 0.35;
    const adrenalineVal = agent ? agent.adrenaline : resolveProfile === 'HARDENED_VETERAN' ? 0.85 : 0;
    const effectiveShock = Math.max(0, target.painShock - adrenalineVal * painMitigationFactor);
    spreadMultiplier *= 1.0 + effectiveShock * 2.2;

    // Internal organ rupture / critical bleedout tremor (degrades aim heavily without stopping return fire!)
    if (target.rupturedOrgans.size > 0 || triage === 'MORTALLY_WOUNDED') {
      const organPenalty =
        resolveProfile === 'HARDENED_VETERAN'
          ? 1.38 + Math.min(0.75, target.rupturedOrgans.size * 0.28)
          : 1.55 + Math.min(0.95, target.rupturedOrgans.size * 0.35);
      spreadMultiplier *= organPenalty;
    }

    // Blood pressure, hypoxia & fading consciousness degradation
    if (target.systolicBpMmHg < 105) {
      spreadMultiplier *= 1.0 + ((105 - target.systolicBpMmHg) / 45) * 2.0;
    }
    if (target.oxygenSaturationPct < 94) {
      spreadMultiplier *= 1.0 + ((94 - target.oxygenSaturationPct) / 25) * 1.9;
    }
    if (target.consciousness < 0.9) {
      spreadMultiplier *= 1.0 + (0.9 - target.consciousness) * 2.5;
    }

    // Panicked scrappers unleash wider erratic bursts when wounded or heavily suppressed
    if (
      resolveProfile === 'PANICKED_SCRAPPER' &&
      (target.currentHp < target.maxHp * 0.8 ||
        target.painShock > 0.22 ||
        (agent?.suppression ?? 0) > 0.45)
    ) {
      spreadMultiplier *= 1.32;
    }

    if (externalAccuracyMultiplier !== undefined && externalAccuracyMultiplier > 0) {
      spreadMultiplier *= 1 / Math.max(0.08, Math.min(1.0, externalAccuracyMultiplier));
    }

    const aimAccuracyMultiplier = Math.max(0.08, Math.min(1.0, 1.0 / spreadMultiplier));
    const activeHand: ActiveFiringHand = sidearmActive
      ? agent!.activeFiringHand
      : intactHand ?? preferredHand;

    return {
      baseSpreadRad,
      spreadMultiplier,
      effectiveSpreadRad: baseSpreadRad * spreadMultiplier,
      aimAccuracyMultiplier,
      canReturnFire: !inNeurogenicOrStagger && agent?.state !== 'PATROL_GUARD',
      isOneHandedDownedFire: legCrippled,
      clutchingWound: false,
      usingBackupSidearm: sidearmActive,
      sidearmDrawing: false,
      activeFiringHand: activeHand,
    };
  }

  /**
   * Rewards aggressive Soldier-of-Fortune / F.E.A.R. playstyles with armor & HP siphon on brutal kills.
   */
  public grantBrutalKillReward(kind: BrutalKillRewardKind): void {
    const armorGain =
      kind === 'MULTI_KILL_BLAST'
        ? 22
        : kind === 'CRANIAL_POP'
          ? 16
          : kind === 'CLEAN_SEVER' || kind === 'EVISCERATED'
            ? 14
            : 6;
    const hpGain =
      kind === 'MULTI_KILL_BLAST'
        ? 18
        : kind === 'CRANIAL_POP'
          ? 12
          : kind === 'CLEAN_SEVER' || kind === 'EVISCERATED'
            ? 10
            : 4;

    this.playerVitals.armor = Math.min(
      this.playerVitals.maxArmor,
      this.playerVitals.armor + armorGain,
    );
    this.playerVitals.health = Math.min(
      this.playerVitals.maxHealth,
      this.playerVitals.health + hpGain,
    );
  }

  /**
   * Restores player health and boosts armor on clearing a hostile wave.
   */
  public notifyWaveCleared(): void {
    this.playerVitals.health = this.playerVitals.maxHealth;
    this.playerVitals.armor = Math.min(
      this.playerVitals.maxArmor,
      this.playerVitals.armor + 35,
    );
    this.playerVitals.invulnerabilityRemainingS = 0;
  }

  /**
   * Steps all hostile AI state machines, tactical cover peeking/strafing, off-hand handgun draws,
   * yaw tracking, enemy burst tracer fire, and player combat vitals regeneration.
   */
  public update(
    dt: number,
    targets: readonly TargetHealthState[],
    playerEyeWorldPos: Vec3Like,
  ): void {
    if (this.destroyed || !Number.isFinite(dt) || dt <= 0) {
      return;
    }

    const stepDt = Math.min(0.1, dt);
    this.elapsedClockS += stepDt;

    this.stepPlayerVitalsRegen(stepDt);

    for (const hs of targets) {
      let agent = this.agents.get(hs.targetId);
      if (!agent) {
        this.registerWaveTargets([hs], false);
        agent = this.agents.get(hs.targetId)!;
      }

      this.stepSingleEnemyAgent(stepDt, hs, agent, playerEyeWorldPos);
    }

    if (this.tracerPool) {
      this.tracerPool.syncFromPhysics(this.rapierWorld, stepDt);
    }
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.agents.clear();
    if (this.tracerPool) {
      this.tracerPool.destroy();
    }
  }

  private stepPlayerVitalsRegen(dt: number): void {
    if (this.playerVitals.invulnerabilityRemainingS > 0) {
      this.playerVitals.invulnerabilityRemainingS = Math.max(
        0,
        this.playerVitals.invulnerabilityRemainingS - dt,
      );
    }
    this.playerVitals.timeSinceLastHitS += dt;

    // Fair FPS breathing recovery after 3.5s out of enemy fire
    if (
      this.playerVitals.timeSinceLastHitS >= 3.5 &&
      this.playerVitals.health < this.playerVitals.maxHealth
    ) {
      this.playerVitals.health = Math.min(
        this.playerVitals.maxHealth,
        this.playerVitals.health + 8.5 * dt,
      );
    }
  }

  /**
   * Evaluates limb dismemberment, primary weapon loss, and hardened off-hand Beretta M9 draw transitions.
   */
  private syncAgentArmamentAndSidearm(
    dt: number,
    hs: TargetHealthState,
    agent: EnemyAiAgentRuntime,
  ): void {
    hs.resolveProfile = agent.resolveProfile;

    if (!hs.alive || hs.currentHp <= 0) {
      if (agent.sidearmActive || agent.sidearmDrawing) {
        agent.sidearmDropped = true;
      }
      agent.sidearmActive = false;
      agent.sidearmDrawing = false;
      agent.sidearmDrawTimerS = 0;
      hs.combatantStatusTag = null;
      return;
    }

    const leftIntact = isArmChainIntactAndFunctional(hs, 'LEFT');
    const rightIntact = isArmChainIntactAndFunctional(hs, 'RIGHT');
    const bothArmsLost = !leftIntact && !rightIntact;
    const anyArmLost = !leftIntact || !rightIntact;
    const preferredHand = getPreferredPrimaryHand(hs);

    // 1. Both arms/hands lost -> even a hardened combatant drops their backup handgun and is disabled!
    if (bothArmsLost) {
      hs.weaponDropped = true;
      hs.primaryArmDisarmed = true;
      if (agent.sidearmActive || agent.sidearmDrawing) {
        agent.sidearmDropped = true;
      }
      agent.sidearmActive = false;
      agent.sidearmDrawing = false;
      agent.sidearmDrawTimerS = 0;
      agent.burstShotsRemaining = 0;
      if (!hs.isRagdollActive) {
        hs.posture = 'DISARMED';
      }
      hs.combatantStatusTag = 'DISARMED';
      return;
    }

    const intactHand = selectIntactFiringHand(hs, preferredHand)!;

    // 2. Primary weapon lost due to single-arm/hand sever/cripple OR direct weapon disarm
    const primaryDisarmed =
      anyArmLost ||
      hs.primaryArmDisarmed === true ||
      (!hs.isRagdollActive && hs.weaponDropped);

    if (primaryDisarmed) {
      hs.weaponDropped = true;
      hs.primaryArmDisarmed = true;

      if (!agent.carriesBackupSidearm) {
        agent.sidearmActive = false;
        agent.sidearmDrawing = false;
        agent.sidearmDrawTimerS = 0;
        agent.burstShotsRemaining = 0;
        if (!hs.isRagdollActive) {
          hs.posture = 'DISARMED';
        }
        hs.combatantStatusTag = 'DISARMED';
        return;
      }

      // Hardened combatant draws backup Beretta M9 with their remaining intact arm/hand!
      agent.activeFiringHand = intactHand;
      if (agent.state === 'PATROL_GUARD') {
        agent.adrenaline = Math.max(agent.adrenaline, 0.92);
        this.transitionState(agent, 'ALERTED_ENGAGING');
      }

      if (!agent.sidearmActive && !agent.sidearmDrawing && !agent.sidearmDropped) {
        agent.sidearmDrawing = true;
        agent.sidearmDrawTimerS = SIDEARM_DRAW_DURATION_S;
        agent.burstShotsRemaining = 0;
      }

      if (agent.sidearmDrawing && dt > 0) {
        agent.sidearmDrawTimerS = Math.max(0, agent.sidearmDrawTimerS - dt);
        if (agent.sidearmDrawTimerS <= 0) {
          agent.sidearmDrawing = false;
          agent.sidearmActive = true;
          agent.fireCooldownTimerS = Math.min(agent.fireCooldownTimerS, 0.08);
        }
      }

      hs.combatantStatusTag = agent.sidearmActive ? 'SIDEARM_DRAWN' : 'SIDEARM_DRAWING';
      return;
    }

    // 3. Living grounded combatant (propped up after leg shot) whose arms are unbroken:
    //    `mannequin.ts` drops the 2-handed rifle on ragdoll activation, so equip one-handed sidearm!
    if (hs.isRagdollActive && hs.posture !== 'AIRBORNE_RAGDOLL') {
      agent.activeFiringHand = intactHand;
      agent.sidearmDrawing = false;
      agent.sidearmDrawTimerS = 0;
      agent.sidearmActive = true;
      hs.combatantStatusTag = 'LAST_STAND';
      return;
    }

    // 4. Standard two-handed primary weapon active
    agent.activeFiringHand = preferredHand;
    const isLastStand =
      agent.triageStatus === 'MORTALLY_WOUNDED' || hs.currentHp <= hs.maxHp * 0.32;
    hs.combatantStatusTag = isLastStand ? 'LAST_STAND' : null;
  }

  private stepSingleEnemyAgent(
    dt: number,
    hs: TargetHealthState,
    agent: EnemyAiAgentRuntime,
    playerEyeWorldPos: Vec3Like,
  ): void {
    agent.triageStatus = computeCombatantTriageStatus(hs);
    agent.lastAimTargetWorld = {
      x: playerEyeWorldPos.x,
      y: playerEyeWorldPos.y - 0.16,
      z: playerEyeWorldPos.z,
    };

    // 1. Check death / exsanguination first
    if (!hs.alive || hs.currentHp <= 0) {
      agent.burstShotsRemaining = 0;
      this.syncAgentArmamentAndSidearm(dt, hs, agent);
      this.transitionState(agent, 'DEAD');
      return;
    }

    // Auto-detect unnotified HP drops (e.g. collateral round or shrapnel applied directly to TargetHealthState)
    if (hs.currentHp < agent.lastObservedHp - 0.5) {
      const lostHp = agent.lastObservedHp - hs.currentHp;
      this.notifyEnemyHit(hs, {
        isTorsoHit:
          hs.zoneIntegrity.TORSO_UPPER_THORAX < 99 ||
          hs.zoneIntegrity.TORSO_LOWER_ABDOMEN < 99,
        energyDepositedJ: lostHp * 14,
      });
      if (!hs.alive) {
        return;
      }
    }
    agent.lastObservedHp = hs.currentHp;

    // Step dismemberment / backup handgun draw state machine
    this.syncAgentArmamentAndSidearm(dt, hs, agent);

    // Decay suppression & maintain resolve-specific adrenaline
    agent.suppression = Math.max(0, agent.suppression - 0.28 * dt);
    if (agent.state !== 'PATROL_GUARD') {
      if (
        agent.resolveProfile === 'FANATIC_BERSERKER' &&
        (hs.currentHp < hs.maxHp * 0.95 || hs.painShock > 0.15)
      ) {
        agent.adrenaline = 1.0;
      } else {
        const floorAdrenaline =
          agent.resolveProfile === 'HARDENED_VETERAN' ? 0.65 : 0.42;
        agent.adrenaline = Math.max(floorAdrenaline, agent.adrenaline - 0.015 * dt);
      }
    }

    // 2. Enforce leg-crippled collapse -> DOWNED_CRAWLING
    const legCrippled = !hs.leftLegFunctional || !hs.rightLegFunctional;
    if (legCrippled && agent.state !== 'DOWNED_CRAWLING') {
      if (agent.state === 'PATROL_GUARD') {
        agent.adrenaline = Math.max(agent.adrenaline, 0.85);
      }
      if (!hs.isRagdollActive) {
        hs.posture = 'LEG_BUCKLED';
      }
      this.transitionState(agent, 'DOWNED_CRAWLING');
    }

    // 3. Evaluate aim & trauma state
    const aimProfile = this.refreshAgentAimMetrics(hs, agent);

    // Apply disarmed posture ONLY when genuinely disarmed (`clutchingWound === true`)
    if (aimProfile.clutchingWound && !hs.isRagdollActive) {
      hs.posture = 'DISARMED';
    }

    const toPlayer = sub(playerEyeWorldPos, hs.worldPosition);
    const horizDist = Math.hypot(toPlayer.x, toPlayer.z);
    const desiredYawRad =
      horizDist > 1e-3 ? Math.atan2(toPlayer.x, toPlayer.z) : hs.yawRad;

    // 4. State-specific movement, posture & combat logic
    switch (agent.state) {
      case 'PATROL_GUARD': {
        agent.peekCycleTimerS += dt;
        const scanOffset = Math.sin(agent.peekCycleTimerS * 0.9) * 0.22;
        hs.yawRad = approachAngleRad(
          hs.yawRad,
          agent.guardBaseYawRad + scanOffset,
          1.4 * dt,
        );

        const guardFwd = { x: Math.sin(hs.yawRad), y: 0, z: Math.cos(hs.yawRad) };
        const dirToPlayer =
          horizDist > 1e-3
            ? normalize({ x: toPlayer.x, y: 0, z: toPlayer.z })
            : guardFwd;
        const cosAngle = dot(guardFwd, dirToPlayer);
        const enemyEyePos = add(hs.worldPosition, vec3(0, 1.55, 0));

        const inDetectionEnvelope =
          (horizDist <= this.sightDetectionRangeM && cosAngle >= 0.38) ||
          horizDist <= 6.5;

        if (
          inDetectionEnvelope &&
          !this.isSightBlockedBySolidCover(enemyEyePos, playerEyeWorldPos)
        ) {
          agent.adrenaline = Math.max(
            agent.adrenaline,
            agent.resolveProfile === 'FANATIC_BERSERKER' ? 0.98 : 0.88,
          );
          this.transitionState(agent, 'ALERTED_ENGAGING');
        }
        break;
      }

      case 'SUPPRESSED_STAGGERED': {
        if (agent.neurogenicShockTimerS > 0) {
          agent.neurogenicShockTimerS = Math.max(0, agent.neurogenicShockTimerS - dt);
          // Shake off initial neurogenic vagal shock if still viable so wounded fighters keep battling!
          if (
            agent.neurogenicShockTimerS <= 0 &&
            hs.bloodVolumeMl > 2600 &&
            hs.oxygenSaturationPct >= 55
          ) {
            hs.consciousness = Math.max(
              hs.consciousness,
              agent.triageStatus === 'MORTALLY_WOUNDED' ? 0.48 : 0.78,
            );
            hs.painShock = Math.min(hs.painShock, 0.52);
            agent.adrenaline = Math.max(agent.adrenaline, 0.88);
          }
        }
        if (agent.staggerTimerS > 0) {
          agent.staggerTimerS = Math.max(0, agent.staggerTimerS - dt);
        }

        // Brief stagger step (berserkers hold ground instead of backing up)
        if (agent.resolveProfile !== 'FANATIC_BERSERKER') {
          this.moveHorizontalClamped(
            hs,
            agent.coverAnchorWorld.x,
            agent.coverAnchorWorld.z,
            0.75 * dt,
          );
        }
        hs.yawRad = approachAngleRad(hs.yawRad, desiredYawRad, 2.8 * dt);

        if (agent.staggerTimerS <= 0 && agent.neurogenicShockTimerS <= 0) {
          if (legCrippled) {
            this.transitionState(agent, 'DOWNED_CRAWLING');
          } else {
            if (!hs.isRagdollActive && !aimProfile.clutchingWound) {
              hs.posture = 'COMBAT_READY';
            }
            this.transitionState(agent, 'ALERTED_ENGAGING');
          }
        }
        break;
      }

      case 'ALERTED_ENGAGING': {
        const tuning = ARCHETYPE_TUNING[hs.archetype];
        const isWounded =
          hs.currentHp < hs.maxHp * 0.92 ||
          hs.painShock > 0.15 ||
          hs.rupturedOrgans.size > 0;

        const cycleRate =
          agent.resolveProfile === 'PANICKED_SCRAPPER' && isWounded ? 1.55 : 1.0;
        agent.peekCycleTimerS += dt * cycleRate;

        // ONLY genuinely disarmed combatants (`clutchingWound === true`) retreat behind cover;
        // wounded & mortally-wounded armed combatants KEEP peeking, advancing, and returning fire!
        if (aimProfile.clutchingWound) {
          agent.isPeekingOut = false;
          agent.burstShotsRemaining = 0;
          const retreatX = agent.coverAnchorWorld.x - agent.peekSign * 0.25;
          const retreatZ = agent.coverAnchorWorld.z - 0.35;
          this.moveHorizontalClamped(hs, retreatX, retreatZ, 0.95 * dt);
          hs.yawRad = approachAngleRad(hs.yawRad, desiredYawRad, 1.8 * dt);
          break;
        }

        const cyclePeriodS =
          agent.resolveProfile === 'HARDENED_VETERAN'
            ? 2.85
            : agent.resolveProfile === 'PANICKED_SCRAPPER'
              ? 2.35
              : 3.1;
        const phase = (agent.peekCycleTimerS % cyclePeriodS) / cyclePeriodS;

        // Fanatic berserkers refuse to cower when wounded — they stay exposed & press the attack!
        if (agent.resolveProfile === 'FANATIC_BERSERKER' && isWounded) {
          agent.isPeekingOut = true;
          agent.berserkerAdvanceOffsetM = Math.min(
            2.6,
            agent.berserkerAdvanceOffsetM + 1.25 * dt,
          );
        } else if (agent.resolveProfile === 'GRITTY_REGULAR' && agent.suppression > 0.62) {
          // Gritty regulars smartly shift cover side when heavily suppressed
          if (phase < 0.08) {
            agent.peekSign = (agent.peekSign === 1 ? -1 : 1) as -1 | 1;
          }
          agent.isPeekingOut = phase >= 0.2 && phase <= 0.88;
        } else {
          agent.isPeekingOut = phase >= 0.2 && phase <= 0.88;
        }

        const peekPlan = this.computeAlertedPeekTarget(hs, agent, playerEyeWorldPos);
        const deltaOffset = peekPlan.targetOffset - agent.currentLateralOffsetM;

        const profileSpeedMul =
          agent.resolveProfile === 'PANICKED_SCRAPPER' && isWounded
            ? 1.38
            : agent.resolveProfile === 'FANATIC_BERSERKER' && isWounded
              ? 1.25
              : 1.0;
        const baseStrafeSpeed = tuning.strafeSpeedMs * profileSpeedMul;
        const effectiveStrafeSpeed =
          Math.abs(deltaOffset) > 1.0
            ? Math.max(baseStrafeSpeed, 2.35)
            : baseStrafeSpeed;
        const maxStrideStep = effectiveStrafeSpeed * dt;
        agent.currentLateralOffsetM +=
          Math.abs(deltaOffset) <= maxStrideStep
            ? deltaOffset
            : Math.sign(deltaOffset) * maxStrideStep;

        const goalX = agent.coverAnchorWorld.x + agent.currentLateralOffsetM;
        const goalZ =
          agent.resolveProfile === 'FANATIC_BERSERKER' && isWounded
            ? Math.min(playerEyeWorldPos.z - 2.4, peekPlan.goalZ + agent.berserkerAdvanceOffsetM)
            : peekPlan.goalZ;
        this.moveHorizontalClamped(hs, goalX, goalZ, effectiveStrafeSpeed * dt);

        // Smoothly turn yaw toward player
        hs.yawRad = approachAngleRad(hs.yawRad, desiredYawRad, 5.4 * dt);
        if (!hs.isRagdollActive) {
          if (hs.rupturedOrgans.size > 0 && hs.zoneIntegrity.TORSO_LOWER_ABDOMEN < 65) {
            hs.posture = 'GUT_HURT';
          } else {
            hs.posture = 'COMBAT_READY' as CombatantPostureState;
          }
        }

        if (!agent.isPeekingOut && peekPlan.anchorBlockedByCover) {
          agent.burstShotsRemaining = 0;
        } else if (aimProfile.canReturnFire && agent.isPeekingOut) {
          this.stepWeaponBurstFire(dt, hs, agent, aimProfile, playerEyeWorldPos);
        }
        break;
      }

      case 'DOWNED_CRAWLING': {
        if (!hs.isRagdollActive) {
          hs.posture = aimProfile.clutchingWound ? 'DISARMED' : 'LEG_BUCKLED';
        }

        // Crawl using remaining functional upper body (berserkers crawl toward the player; others toward cover!)
        if (!hs.isRagdollActive && (hs.leftArmFunctional || hs.rightArmFunctional)) {
          const crawlTargetX = agent.coverAnchorWorld.x + agent.peekSign * 0.35;
          const crawlTargetZ =
            agent.resolveProfile === 'FANATIC_BERSERKER'
              ? Math.min(playerEyeWorldPos.z - 2.6, hs.worldPosition.z + 0.8)
              : agent.coverAnchorWorld.z - 0.25;
          this.moveHorizontalClamped(hs, crawlTargetX, crawlTargetZ, 0.35 * dt);
        }

        hs.yawRad = approachAngleRad(hs.yawRad, desiredYawRad, 2.8 * dt);

        // Leg-crippled & grounded fighters fiercely return fire one-handed until killed!
        if (aimProfile.canReturnFire) {
          this.stepWeaponBurstFire(dt, hs, agent, aimProfile, playerEyeWorldPos);
        }
        break;
      }

      case 'DEAD':
        break;
    }

    if (!hs.isRagdollActive && hs.alive) {
      updateStandingCombatPose(hs, this.elapsedClockS);
    }
  }

  private computeAlertedPeekTarget(
    hs: TargetHealthState,
    agent: EnemyAiAgentRuntime,
    playerEyeWorldPos: Vec3Like,
  ): { targetOffset: number; goalZ: number; anchorBlockedByCover: boolean } {
    const hasCoverQueries =
      this.rapierWorld !== null || this.isLineOfSightBlockedCallback !== undefined;

    const jitterScale =
      agent.resolveProfile === 'PANICKED_SCRAPPER'
        ? 0.46
        : agent.resolveProfile === 'HARDENED_VETERAN'
          ? 0.2
          : 0.28;
    const sinPhase = Math.sin(agent.peekCycleTimerS * 2.4);

    if (!hasCoverQueries) {
      return {
        targetOffset: agent.isPeekingOut
          ? agent.peekSign * (agent.peekStrideM + sinPhase * jitterScale)
          : -agent.peekSign * 0.18,
        goalZ: agent.coverAnchorWorld.z + (agent.isPeekingOut ? 0.18 : -0.12),
        anchorBlockedByCover: false,
      };
    }

    const cached = this.peekPlanCache.get(agent.targetId);
    if (
      cached &&
      this.elapsedClockS - cached.timestampS < 0.08 &&
      cached.isPeekingOut === agent.isPeekingOut &&
      cached.peekSign === agent.peekSign &&
      Math.abs(playerEyeWorldPos.x - cached.playerX) < 0.20 &&
      Math.abs(playerEyeWorldPos.z - cached.playerZ) < 0.20
    ) {
      const jitterOffset =
        cached.jitterMode === 'SIDE'
          ? agent.peekSign * sinPhase * jitterScale
          : cached.jitterMode === 'FINE'
            ? sinPhase * 0.08
            : 0;
      return {
        targetOffset: cached.baseOffset + jitterOffset,
        goalZ: cached.goalZ,
        anchorBlockedByCover: cached.anchorBlockedByCover,
      };
    }

    const savePeekCache = (
      baseOffset: number,
      jitterMode: 'NONE' | 'FINE' | 'SIDE',
      goalZ: number,
      anchorBlockedByCover: boolean,
    ): { targetOffset: number; goalZ: number; anchorBlockedByCover: boolean } => {
      this.peekPlanCache.set(agent.targetId, {
        timestampS: this.elapsedClockS,
        isPeekingOut: agent.isPeekingOut,
        peekSign: agent.peekSign,
        playerX: playerEyeWorldPos.x,
        playerZ: playerEyeWorldPos.z,
        baseOffset,
        jitterMode,
        goalZ,
        anchorBlockedByCover,
      });
      const jitterOffset =
        jitterMode === 'SIDE'
          ? agent.peekSign * sinPhase * jitterScale
          : jitterMode === 'FINE'
            ? sinPhase * 0.08
            : 0;
      return {
        targetOffset: baseOffset + jitterOffset,
        goalZ,
        anchorBlockedByCover,
      };
    };

    const playerChest: Vec3Like = {
      x: playerEyeWorldPos.x,
      y: playerEyeWorldPos.y - 0.18,
      z: playerEyeWorldPos.z,
    };
    const anchorCore: Vec3Like = {
      x: agent.coverAnchorWorld.x,
      y: hs.worldPosition.y + 1.32,
      z: agent.coverAnchorWorld.z,
    };
    const anchorEye: Vec3Like = {
      x: agent.coverAnchorWorld.x,
      y: hs.worldPosition.y + 1.55,
      z: agent.coverAnchorWorld.z,
    };

    const anchorClear =
      !this.isSightBlockedBySolidCover(anchorCore, playerChest) ||
      !this.isSightBlockedBySolidCover(anchorEye, playerEyeWorldPos);

    if (anchorClear) {
      const sideProbeOffset = agent.peekSign * Math.min(0.85, agent.peekStrideM);
      const sideCore: Vec3Like = {
        x: agent.coverAnchorWorld.x + sideProbeOffset,
        y: hs.worldPosition.y + 1.32,
        z: agent.coverAnchorWorld.z + 0.12,
      };
      const sideClear = !this.isSightBlockedBySolidCover(sideCore, playerChest);

      if (!agent.isPeekingOut) {
        for (const sign of [-agent.peekSign, agent.peekSign] as const) {
          const shelterX = agent.coverAnchorWorld.x + sign * 0.72;
          if (shelterX < -8.05 || shelterX > 8.05) continue;
          const shelterCore: Vec3Like = {
            x: shelterX,
            y: hs.worldPosition.y + 1.32,
            z: agent.coverAnchorWorld.z - 0.14,
          };
          const shelterEye: Vec3Like = {
            x: shelterX,
            y: hs.worldPosition.y + 1.55,
            z: agent.coverAnchorWorld.z - 0.14,
          };
          if (
            this.isSightBlockedBySolidCover(shelterCore, playerChest) &&
            this.isSightBlockedBySolidCover(shelterEye, playerEyeWorldPos)
          ) {
            return savePeekCache(sign * 0.72, 'NONE', agent.coverAnchorWorld.z - 0.14, false);
          }
        }

        return savePeekCache(-agent.peekSign * 0.18, 'NONE', agent.coverAnchorWorld.z - 0.12, false);
      }

      if (sideClear) {
        return savePeekCache(sideProbeOffset, 'SIDE', agent.coverAnchorWorld.z + 0.18, false);
      }

      return savePeekCache(0, 'FINE', agent.coverAnchorWorld.z + 0.12, false);
    }

    if (!agent.isPeekingOut) {
      return savePeekCache(0, 'NONE', agent.coverAnchorWorld.z - 0.14, true);
    }

    const peekZ = agent.coverAnchorWorld.z + 0.18;
    const candidateDistances = [0.55, 0.95, 1.35, 1.68, 1.98, 2.32];
    const signs: readonly (-1 | 1)[] = [
      agent.peekSign,
      (agent.peekSign === 1 ? -1 : 1) as -1 | 1,
    ];

    for (const d of candidateDistances) {
      for (const s of signs) {
        const rawX = agent.coverAnchorWorld.x + s * d;
        if (rawX < -8.05 || rawX > 8.05) continue;

        const candCore: Vec3Like = {
          x: rawX,
          y: hs.worldPosition.y + 1.32,
          z: peekZ,
        };
        const candClear =
          !this.isSightBlockedBySolidCover(candCore, playerChest) ||
          !this.isSightBlockedBySolidCover(candCore, playerEyeWorldPos);

        if (candClear) {
          agent.peekSign = s;
          let chosenDist = d;
          const nudgedX = agent.coverAnchorWorld.x + s * (d + 0.16);
          if (nudgedX >= -8.05 && nudgedX <= 8.05) {
            const nudgedCore: Vec3Like = {
              x: nudgedX,
              y: hs.worldPosition.y + 1.32,
              z: peekZ,
            };
            if (
              !this.isSightBlockedBySolidCover(nudgedCore, playerChest) ||
              !this.isSightBlockedBySolidCover(nudgedCore, playerEyeWorldPos)
            ) {
              chosenDist = d + 0.16;
            }
          }

          return savePeekCache(s * chosenDist, 'FINE', peekZ, true);
        }
      }
    }

    return savePeekCache(agent.peekSign * agent.peekStrideM, 'NONE', peekZ, true);
  }

  private resolveExposedPlayerAimPoint(
    hs: TargetHealthState,
    agent: EnemyAiAgentRuntime,
    playerEyeWorldPos: Vec3Like,
  ): Vec3Like | null {
    const isGroundedOrDowned = agent.state === 'DOWNED_CRAWLING' || hs.isRagdollActive;
    const basePos = hs.isRagdollActive
      ? hs.ragdollBones.TORSO_UPPER_THORAX?.position ?? hs.worldPosition
      : hs.worldPosition;
    const muzzleHeight = hs.isRagdollActive
      ? Math.max(0.42, basePos.y)
      : isGroundedOrDowned
        ? hs.worldPosition.y + 0.62
        : hs.worldPosition.y + 1.32;
    const eyeHeight = hs.isRagdollActive
      ? Math.max(0.55, (hs.ragdollBones.HEAD_CRANIUM?.position.y ?? basePos.y + 0.16))
      : isGroundedOrDowned
        ? hs.worldPosition.y + 0.78
        : hs.worldPosition.y + 1.55;

    const enemyCorePos: Vec3Like = {
      x: basePos.x,
      y: muzzleHeight,
      z: basePos.z,
    };
    const enemyEyePos: Vec3Like = {
      x: basePos.x,
      y: eyeHeight,
      z: basePos.z,
    };
    const playerChestTarget: Vec3Like = {
      x: playerEyeWorldPos.x,
      y: playerEyeWorldPos.y - 0.18,
      z: playerEyeWorldPos.z,
    };

    const chestLineClear = !this.isSightBlockedBySolidCover(enemyCorePos, playerChestTarget);
    const eyeToEyeClear = !this.isSightBlockedBySolidCover(enemyEyePos, playerEyeWorldPos);

    if (!chestLineClear && !eyeToEyeClear) {
      return null;
    }

    if (chestLineClear) {
      return playerChestTarget;
    }

    if (!this.isSightBlockedBySolidCover(enemyCorePos, playerEyeWorldPos)) {
      return playerEyeWorldPos;
    }

    return null;
  }

  private stepWeaponBurstFire(
    dt: number,
    hs: TargetHealthState,
    agent: EnemyAiAgentRuntime,
    aimProfile: EnemyAimProfile,
    playerEyeWorldPos: Vec3Like,
  ): void {
    const tuning = ARCHETYPE_TUNING[hs.archetype];
    const isWounded =
      hs.currentHp < hs.maxHp * 0.88 ||
      hs.painShock > 0.18 ||
      hs.rupturedOrgans.size > 0;

    if (agent.burstShotsRemaining <= 0) {
      agent.fireCooldownTimerS = Math.max(0, agent.fireCooldownTimerS - dt);
    }

    const aboutToFireNow =
      (agent.burstShotsRemaining <= 0 && agent.fireCooldownTimerS <= 0) ||
      (agent.burstShotsRemaining > 0 && agent.burstInterShotTimerS - dt <= 0);

    let exposedAimTarget: Vec3Like | null;
    const cachedAim = this.aimExposureCache.get(agent.targetId);
    if (
      !aboutToFireNow &&
      cachedAim &&
      this.elapsedClockS - cachedAim.timestampS < 0.08 &&
      Math.abs(hs.worldPosition.x - cachedAim.enemyX) < 0.15 &&
      Math.abs(hs.worldPosition.z - cachedAim.enemyZ) < 0.15 &&
      Math.abs(playerEyeWorldPos.x - cachedAim.playerX) < 0.20 &&
      Math.abs(playerEyeWorldPos.z - cachedAim.playerZ) < 0.20
    ) {
      exposedAimTarget = cachedAim.result;
    } else {
      exposedAimTarget = this.resolveExposedPlayerAimPoint(
        hs,
        agent,
        playerEyeWorldPos,
      );
      this.aimExposureCache.set(agent.targetId, {
        timestampS: this.elapsedClockS,
        enemyX: hs.worldPosition.x,
        enemyZ: hs.worldPosition.z,
        playerX: playerEyeWorldPos.x,
        playerZ: playerEyeWorldPos.z,
        result: exposedAimTarget,
      });
    }
    if (!exposedAimTarget) {
      if (agent.burstShotsRemaining > 0) {
        agent.burstShotsRemaining = 0;
        agent.fireCooldownTimerS = Math.max(agent.fireCooldownTimerS, 0.25);
      }
      return;
    }

    agent.lastAimTargetWorld = copyVec3(exposedAimTarget);

    if (agent.burstShotsRemaining <= 0) {
      if (agent.fireCooldownTimerS <= 0) {
        if (aimProfile.usingBackupSidearm) {
          // 9mm Beretta M9 double/triple-tap bursts
          agent.burstShotsRemaining = agent.completedBurstCount % 2 === 0 ? 2 : 3;
        } else {
          let desiredBurst = tuning.burstCount;
          if (agent.resolveProfile === 'FANATIC_BERSERKER' && isWounded) {
            desiredBurst += 2;
          } else if (agent.resolveProfile === 'PANICKED_SCRAPPER' && isWounded) {
            desiredBurst += 3;
          }
          agent.burstShotsRemaining = aimProfile.isOneHandedDownedFire
            ? Math.max(2, Math.ceil(desiredBurst * 0.65))
            : desiredBurst;
        }
        agent.burstInterShotTimerS = 0;
      }
      return;
    }

    agent.burstInterShotTimerS -= dt;
    if (agent.burstInterShotTimerS > 0) {
      return;
    }

    // Fire one round of the burst toward the verified exposed target point
    this.emitEnemyTracerShot(hs, agent, aimProfile, playerEyeWorldPos, exposedAimTarget);

    const cadenceScale =
      agent.resolveProfile === 'PANICKED_SCRAPPER' && isWounded
        ? 0.65
        : agent.resolveProfile === 'FANATIC_BERSERKER' && isWounded
          ? 0.75
          : agent.resolveProfile === 'HARDENED_VETERAN'
            ? 0.92
            : 1.0;

    // Ragged physiological cadence jitter when critically bleeding/hypoxic (without stopping fire!)
    const raggedWoundDelay =
      agent.triageStatus === 'MORTALLY_WOUNDED' && agent.resolveProfile !== 'FANATIC_BERSERKER'
        ? 1.18
        : 1.0;

    agent.burstShotsRemaining -= 1;
    if (agent.burstShotsRemaining > 0) {
      const baseInterShot = aimProfile.usingBackupSidearm
        ? SIDEARM_M9_TUNING.interShotDelayS
        : tuning.interShotDelayS;
      agent.burstInterShotTimerS =
        baseInterShot *
        cadenceScale *
        raggedWoundDelay *
        (aimProfile.isOneHandedDownedFire && !aimProfile.usingBackupSidearm ? 1.3 : 1.0);
    } else {
      agent.completedBurstCount += 1;
      // Hardened veterans deliberately alternate peek angles periodically between bursts
      if (agent.resolveProfile === 'HARDENED_VETERAN' && agent.completedBurstCount % 2 === 0) {
        agent.peekSign = (agent.peekSign === 1 ? -1 : 1) as -1 | 1;
      }
      const baseCooldown = aimProfile.usingBackupSidearm
        ? SIDEARM_M9_TUNING.burstCooldownS
        : tuning.burstCooldownS;
      agent.fireCooldownTimerS =
        baseCooldown *
        cadenceScale *
        (aimProfile.isOneHandedDownedFire && !aimProfile.usingBackupSidearm ? 1.25 : 1.0);
    }
  }

  private emitEnemyTracerShot(
    hs: TargetHealthState,
    agent: EnemyAiAgentRuntime,
    aimProfile: EnemyAimProfile,
    playerEyeWorldPos: Vec3Like,
    aimTargetPos: Vec3Like,
  ): void {
    const tuning = ARCHETYPE_TUNING[hs.archetype];
    const usingSidearm = aimProfile.usingBackupSidearm;
    const firingHand: ActiveFiringHand =
      aimProfile.activeFiringHand ?? agent.activeFiringHand;
    const firingHandZone: GhoulZoneId =
      firingHand === 'LEFT' ? 'HAND_LEFT' : 'HAND_RIGHT';

    const handBone = hs.ragdollBones[firingHandZone];
    const handPos = handBone && !handBone.severed ? handBone.position : undefined;

    const isGroundedOrDowned = agent.state === 'DOWNED_CRAWLING' || hs.isRagdollActive;
    const basePos = hs.isRagdollActive
      ? hs.ragdollBones.TORSO_UPPER_THORAX?.position ?? hs.worldPosition
      : hs.worldPosition;
    const muzzleHeight = hs.isRagdollActive
      ? Math.max(0.42, basePos.y)
      : isGroundedOrDowned
        ? hs.worldPosition.y + 0.62
        : hs.worldPosition.y + 1.32;

    const coreOrigin: Vec3Like = {
      x: basePos.x,
      y: muzzleHeight,
      z: basePos.z,
    };

    const idealDir = normalize(sub(aimTargetPos, coreOrigin));
    const fwdDir = usingSidearm
      ? idealDir
      : { x: Math.sin(hs.yawRad), y: 0, z: Math.cos(hs.yawRad) };

    const rawMuzzleOrigin: Vec3Like = handPos
      ? add(handPos, scale(fwdDir, usingSidearm ? 0.19 : 0.28))
      : {
          x: coreOrigin.x + fwdDir.x * 0.38,
          y: muzzleHeight,
          z: coreOrigin.z + fwdDir.z * 0.38,
        };

    const playerChestTarget: Vec3Like = {
      x: playerEyeWorldPos.x,
      y: playerEyeWorldPos.y - 0.18,
      z: playerEyeWorldPos.z,
    };

    const seed = agent.tracerSeedCounter++;
    const shotDir = deterministicConeSpread(
      idealDir,
      aimProfile.effectiveSpreadRad,
      (seed % 7) + 1,
      8,
      seed * 31,
    );

    const toChest = sub(playerChestTarget, coreOrigin);
    const alongChest = dot(toChest, shotDir);
    const closestChestPt =
      alongChest > 0 ? add(coreOrigin, scale(shotDir, alongChest)) : coreOrigin;
    const missDistChest =
      alongChest > 0 ? distance(closestChestPt, playerChestTarget) : Infinity;

    const toAim = sub(aimTargetPos, coreOrigin);
    const alongAim = dot(toAim, shotDir);
    const closestAimPt =
      alongAim > 0 ? add(coreOrigin, scale(shotDir, alongAim)) : coreOrigin;
    const missDistAim =
      alongAim > 0 ? distance(closestAimPt, aimTargetPos) : Infinity;

    const wouldHitPlayer = missDistChest <= 0.36 || missDistAim <= 0.36;
    const playerHitDist =
      missDistChest <= 0.36
        ? alongChest
        : missDistAim <= 0.36
          ? alongAim
          : Math.max(0.5, distance(coreOrigin, aimTargetPos));
    const playerHitPoint =
      missDistChest <= 0.36 ? closestChestPt : closestAimPt;

    const coverCheckDist = wouldHitPlayer
      ? Math.max(0.05, playerHitDist)
      : playerHitDist + 6.0;

    let blockedByCover = false;
    let impactPointWorld = add(coreOrigin, scale(shotDir, playerHitDist + 4.0));

    if (this.interceptEnemyShotCover) {
      const intercept = this.interceptEnemyShotCover(
        coreOrigin,
        shotDir,
        coverCheckDist,
      );
      if (intercept.blocked) {
        blockedByCover = true;
        impactPointWorld =
          intercept.impactPointWorld ?? add(coreOrigin, scale(shotDir, coverCheckDist));
      }
    } else if (this.rapierWorld) {
      const hits = this.rapierWorld.castPenetrationRay(
        coreOrigin,
        shotDir,
        coverCheckDist,
      );
      for (const h of hits) {
        if (h.distanceM > coverCheckDist) continue;
        if (
          h.surface.material === 'GLASS_MARCHING_256' ||
          h.surface.material === 'GLASS_VORONOI'
        ) {
          continue;
        }
        blockedByCover = true;
        impactPointWorld = h.pointWorld;
        break;
      }
    }

    const muzzleOrigin =
      blockedByCover && distance(coreOrigin, impactPointWorld) < 0.48
        ? coreOrigin
        : rawMuzzleOrigin;

    const tracerSpeedMs = usingSidearm
      ? SIDEARM_M9_TUNING.tracerSpeedMs
      : tuning.tracerSpeedMs;
    const rawChip = usingSidearm
      ? SIDEARM_M9_TUNING.baseChipDamage
      : tuning.baseChipDamage;

    let hitPlayer = false;
    let armorChipApplied = 0;
    let healthDamageApplied = 0;

    if (!blockedByCover && wouldHitPlayer) {
      hitPlayer = true;
      impactPointWorld = playerHitPoint;

      if (
        this.playerVitals.damageEnabled &&
        this.playerVitals.invulnerabilityRemainingS <= 0
      ) {
        if (this.playerVitals.armor > 0) {
          armorChipApplied = Math.min(this.playerVitals.armor, rawChip * 0.7);
          this.playerVitals.armor = Math.max(
            0,
            this.playerVitals.armor - armorChipApplied,
          );
          healthDamageApplied = rawChip * 0.35;
        } else {
          healthDamageApplied = rawChip;
        }

        this.playerVitals.health = Math.max(
          0,
          this.playerVitals.health - healthDamageApplied,
        );
        this.playerVitals.timeSinceLastHitS = 0;
        this.playerVitals.invulnerabilityRemainingS = 0.22;
      }
    }

    if (this.tracerPool) {
      const quat = this.computeTracerOrientationQuat(shotDir);
      const flightDist = distance(muzzleOrigin, impactPointWorld);
      const ttl = Math.max(0.05, Math.min(0.28, flightDist / tracerSpeedMs));
      this.tracerPool.spawnKinematicParticle(
        muzzleOrigin,
        scale(shotDir, tracerSpeedMs),
        vec3(0, 0, 0),
        { x: 0.024, y: 0.024, z: 0.95 },
        0,
        0,
        ttl,
        quat,
      );
    }

    const event: EnemyTracerFireEvent = {
      targetId: hs.targetId,
      archetype: hs.archetype,
      muzzleOriginWorld: muzzleOrigin,
      shotDirectionWorld: shotDir,
      impactPointWorld,
      tracerSpeedMs,
      spreadConeRad: aimProfile.effectiveSpreadRad,
      spreadMultiplier: aimProfile.spreadMultiplier,
      hitPlayer,
      blockedByCover,
      armorChipApplied,
      healthDamageApplied,
      activeFiringHand: firingHand,
      usedBackupSidearm: usingSidearm,
      weaponId: usingSidearm ? SIDEARM_M9_TUNING.weaponId : tuning.primaryWeaponId,
    };

    this.onEnemyFireTracer?.(event);
    if (hitPlayer && (armorChipApplied > 0 || healthDamageApplied > 0)) {
      this.onPlayerDamaged?.(this.playerVitals, event);
    }
  }

  private computeTracerOrientationQuat(shotDir: Vec3Like) {
    const f = normalize(shotDir);
    const upRef = Math.abs(f.y) < 0.98 ? vec3(0, 1, 0) : vec3(1, 0, 0);
    const r = normalize(cross(upRef, f));
    const u = normalize(cross(f, r));
    return basisColumnsToQuaternion(r.x, r.y, r.z, u.x, u.y, u.z, f.x, f.y, f.z);
  }

  private isSightBlockedBySolidCover(eyeOrigin: Vec3Like, targetPoint: Vec3Like): boolean {
    if (this.isLineOfSightBlockedCallback) {
      return this.isLineOfSightBlockedCallback(eyeOrigin, targetPoint);
    }
    if (!this.rapierWorld) return false;

    const delta = sub(targetPoint, eyeOrigin);
    const dist = length(delta);
    if (dist <= 0.05) return false;

    const dir = scale(delta, 1 / dist);
    const maxDist = Math.max(0.01, dist - 0.02);
    const hits = this.rapierWorld.castPenetrationRay(eyeOrigin, dir, maxDist);
    for (const h of hits) {
      if (h.distanceM > maxDist) continue;
      if (
        h.surface.material === 'GLASS_MARCHING_256' ||
        h.surface.material === 'GLASS_VORONOI'
      ) {
        continue;
      }
      return true;
    }
    return false;
  }

  private isWaistStepBlocked(
    originX: number,
    originY: number,
    originZ: number,
    stepX: number,
    stepZ: number,
  ): boolean {
    if (!this.rapierWorld) return false;
    const stepDist = Math.hypot(stepX, stepZ);
    if (stepDist < 1e-5) return false;

    const waistOrigin = {
      x: originX,
      y: originY + 0.75,
      z: originZ,
    };
    const clearanceHits = this.rapierWorld.castPenetrationRay(
      waistOrigin,
      { x: stepX / stepDist, y: 0, z: stepZ / stepDist },
      stepDist + 0.42,
    );
    return clearanceHits.length > 0 && clearanceHits[0].distanceM <= stepDist + 0.42;
  }

  private moveHorizontalClamped(
    hs: TargetHealthState,
    goalX: number,
    goalZ: number,
    maxStepM: number,
  ): void {
    if (hs.isRagdollActive || maxStepM <= 0) return;

    const clampedGoalX = Math.max(-8.1, Math.min(8.1, goalX));
    const clampedGoalZ = Math.max(-46.0, Math.min(-3.2, goalZ));

    const dx = clampedGoalX - hs.worldPosition.x;
    const dz = clampedGoalZ - hs.worldPosition.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-5) return;

    const step = Math.min(dist, maxStepM);
    const stepX = (dx / dist) * step;
    const stepZ = (dz / dist) * step;

    if (
      !this.isWaistStepBlocked(
        hs.worldPosition.x,
        hs.worldPosition.y,
        hs.worldPosition.z,
        stepX,
        stepZ,
      )
    ) {
      hs.worldPosition.x += stepX;
      hs.worldPosition.z += stepZ;
      return;
    }

    if (Math.abs(dx) > 1e-5) {
      const slideX = Math.sign(dx) * Math.min(Math.abs(dx), maxStepM);
      if (
        !this.isWaistStepBlocked(
          hs.worldPosition.x,
          hs.worldPosition.y,
          hs.worldPosition.z,
          slideX,
          0,
        )
      ) {
        hs.worldPosition.x += slideX;
      }
    }

    if (Math.abs(dz) > 1e-5) {
      const slideZ = Math.sign(dz) * Math.min(Math.abs(dz), maxStepM);
      if (
        !this.isWaistStepBlocked(
          hs.worldPosition.x,
          hs.worldPosition.y,
          hs.worldPosition.z,
          0,
          slideZ,
        )
      ) {
        hs.worldPosition.z += slideZ;
      }
    }
  }

  private refreshAgentAimMetrics(
    hs: TargetHealthState,
    agent: EnemyAiAgentRuntime,
    externalAccuracyMultiplier?: number,
  ): EnemyAimProfile {
    const profile = this.computeEnemyAimProfile(hs, agent, externalAccuracyMultiplier);
    agent.lastSpreadMultiplier = profile.spreadMultiplier;
    agent.lastAimAccuracyMultiplier = profile.aimAccuracyMultiplier;
    agent.clutchingWound = profile.clutchingWound;
    return profile;
  }

  private transitionState(
    agent: EnemyAiAgentRuntime,
    nextState: EnemyTacticalAiState,
  ): void {
    if (agent.state === nextState) return;
    const prev = agent.state;
    agent.state = nextState;
    this.onEnemyStateChanged?.(agent.targetId, prev, nextState);
  }
}
