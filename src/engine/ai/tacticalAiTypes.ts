import * as pc from 'playcanvas';
import type {
  ActiveFiringHand,
  AiBarkCategory,
  AiBarkPayload,
  ArterialBleedState,
  BrutalKillRewardKind,
  EnemyFireMode,
  HealthGateState,
  PlayerCombatVitals,
  PlayerNearMissGrazeKind,
  PlayerNearMissGrazePayload,
  PlayerSurvivalPhase,
} from '../../contracts/ai/aiContracts.ts';
import type { EnemyArchetypeId, GhoulZoneId, Vec3Like } from '../../contracts/ballistics.ts';
import type { EnemyArmamentState } from '../../core/ai/enemyArmamentFsm.ts';
import type { EnemyMagazineState } from '../../core/ai/enemyGunHandling.ts';
import type {
  AlertedEngagementSubstate,
  TraumaShockState,
  WeaponBurstState,
} from '../../core/ai/weaponBurstFsm.ts';
import type { CombatantTriageStatus } from '../../core/ballistics/solver.ts';
import type { AimDuckReflexState } from '../../core/ai/aimDuckReflex.ts';
import type { CloseQuartersJukeState } from '../../core/ai/closeQuartersStrafe.ts';
import type { PlantedFootworkState } from '../../core/ai/plantedFootwork.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import { DESTRUCTION_ZONE_LAYOUT } from '../world/arenaLayout.ts';

export type {
  ActiveFiringHand,
  AiBarkCategory,
  AiBarkPayload,
  AlertedEngagementSubstate,
  ArterialBleedState,
  BrutalKillRewardKind,
  CombatantTriageStatus,
  EnemyArmamentState,
  EnemyFireMode,
  HealthGateState,
  PlayerCombatVitals,
  PlayerNearMissGrazeKind,
  PlayerNearMissGrazePayload,
  PlayerSurvivalPhase,
  TraumaShockState,
  WeaponBurstState,
};

export const BACKUP_SIDEARM_WEAPON_ID = 'weapon_beretta_m9';
export const DOWNED_ONE_HANDED_SPREAD_MULTIPLIER = 4.5;
export const OFFHAND_SIDEARM_SPREAD_MULTIPLIER = 1.78;
export const SIDEARM_DRAW_DURATION_S = 0.6;
export const MIN_CONSCIOUSNESS_TO_FIGHT = 0.12;

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

export interface TacticalCoverStation {
  readonly stationId: string;
  readonly coverAnchorWorld: Vec3Like;
  readonly peekSign: -1 | 1;
  readonly peekStrideM: number;
  readonly guardYawDeg: number;
}

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
  readonly hitPointWorld?: Vec3Like;
  readonly hitNormalWorld?: Vec3Like;
  readonly impactNormalWorld?: Vec3Like;
  readonly surfaceTag?: string;
  readonly impactSurfaceTag?: string;
}

export interface EnemyTracerFireEvent {
  readonly targetId: string;
  readonly archetype: EnemyArchetypeId;
  readonly muzzleOriginWorld: Vec3Like;
  readonly shotDirectionWorld: Vec3Like;
  readonly impactPointWorld: Vec3Like;
  readonly impactNormalWorld?: Vec3Like;
  readonly impactSurfaceTag?: string;
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
  readonly isSupersonic: boolean;
  readonly suppressionMode: boolean;
}

export type EnemyTracerEvent = EnemyTracerFireEvent;

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

/** Where the player stands for the wounded sequence; see `woundedSequenceDriver.ts`. */
export interface WoundedPlayerSense {
  /** Unsigned flat angle between the body's facing and the player, or null when unknown. */
  readonly playerBearingRad: number | null;
  readonly playerVisible: boolean;
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

  fireMode?: EnemyFireMode;
  isOffScreen?: boolean;
  alertReactionTimerS?: number;
  hasFiredWarningShot?: boolean;
  timeWithoutLosS?: number;
  moraleShockTimerS?: number;
  berserkerFrenzyTimerS?: number;
  /** Wounded behaviour state; see `woundFallback.ts`. */
  woundFallbackHpMark?: number;
  woundFallbackTimerS?: number;
  mortalWoundMode?: 'AMBUSH_HOLD' | 'AMBUSH_SPRUNG' | 'DYING_PUSH';
  mortalHoldTimerS?: number;
  weaponPickupTimerS?: number;
  lastRelocationClockS?: number;
  lastObservedBurstCount?: number;

  /** Rounds in and for the long gun and the backup pistol; see `enemyWeaponMagazine.ts`. */
  primaryMagazine?: EnemyMagazineState;
  sidearmMagazine?: EnemyMagazineState;

  armamentState?: EnemyArmamentState;
  burstState?: WeaponBurstState;
  engagementSubstate?: AlertedEngagementSubstate;
  shockState?: TraumaShockState;

  /** 0–1: how squarely the player's crosshair sits on this combatant this frame. */
  aimThreat?: number;
  /** Set by a hit; the close-quarters juke consumes it to break the player's aim. */
  jukeBreakPending?: boolean;
  closeQuartersJuke?: CloseQuartersJukeState;
  aimDuckReflex?: AimDuckReflexState;
  /** True when the last sidestep made no headway, e.g. against a wall or prop. */
  lateralStalled?: boolean;
  /** Smoothed ground speed while engaging, in m/s; firing on the move costs accuracy. */
  moveSpeedMs?: number;
  /** Held movement goal and time standing still; see `plantedFootwork.ts`. */
  footwork?: PlantedFootworkState;
  /** This tick's read of the player for the wounded sequence (bearing from facing, line of sight). */
  woundedSense?: WoundedPlayerSense;
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
  sightDetectionRangeM?: number;
  maxAggressiveTokens?: number;
  resolveProfileOverrides?: Readonly<Record<string, CombatantResolveProfile>>;
  hardenedSidearmOverrides?: Readonly<Record<string, boolean>>;
  isLineOfSightBlocked?: (fromWorld: Vec3Like, toWorld: Vec3Like) => boolean;
  interceptEnemyShotCover?: (
    originWorld: Vec3Like,
    directionWorld: Vec3Like,
    maxDistanceM: number
  ) => EnemyCoverShotInterceptResult;
  onEnemyFireTracer?: (event: EnemyTracerFireEvent) => void;
  onPlayerDamaged?: (vitals: Readonly<PlayerCombatVitals>, event: EnemyTracerFireEvent) => void;
  onPlayerNearMissGraze?: (event: PlayerNearMissGrazePayload) => void;
  onAiBark?: (bark: AiBarkPayload) => void;
  onEnemyStateChanged?: (
    targetId: string,
    prevState: EnemyTacticalAiState,
    nextState: EnemyTacticalAiState
  ) => void;
}

export type TacticalCombatAiConfig = TacticalCombatAiOptions;
