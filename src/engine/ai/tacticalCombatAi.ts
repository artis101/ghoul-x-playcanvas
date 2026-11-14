import type { BurstContext } from './tacticalBurstAndTracers.ts';
import * as pc from 'playcanvas';
import type {
  AiBarkCategory, AiBarkPayload, ArterialBleedState, EnemyFireMode, HealthGateState,
  PlayerCombatVitals, PlayerNearMissGrazeKind, PlayerNearMissGrazePayload, PlayerSurvivalPhase,
} from '../../contracts/ai/aiContracts.ts';
import type { TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import { AttackTokenPool } from '../../core/ai/attackTokenPool.ts';
import { SquadBarkCoordinator } from '../../core/ai/squadBarkCoordinator.ts';
import { cancelActiveBurst } from '../../core/ai/weaponBurstFsm.ts';
import type { HardwareInstancedPool } from '../physics/instancedPool.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import type {
  ActiveFiringHand, AlertedEngagementSubstate, BrutalKillRewardKind, CombatantResolveProfile,
  EnemyAiAgentRuntime, EnemyAimProfile, EnemyArmamentState, EnemyCoverShotInterceptResult,
  EnemyHitNotification, EnemySidearmVisualState, EnemyTacticalAiState, EnemyTracerEvent,
  EnemyTracerFireEvent, TacticalCombatAiConfig, TacticalCombatAiOptions, TacticalCoverStation,
  TraumaShockState, WeaponBurstState,
} from './tacticalAiTypes.ts';
import {
  BACKUP_SIDEARM_WEAPON_ID, DOWNED_ONE_HANDED_SPREAD_MULTIPLIER, MIN_CONSCIOUSNESS_TO_FIGHT,
  OFFHAND_SIDEARM_SPREAD_MULTIPLIER, SIDEARM_DRAW_DURATION_S, TACTICAL_COVER_STATIONS,
} from './tacticalAiTypes.ts';
import { type ArenaNavSpec, HALL_ARENA_NAV_SPEC } from './arenaNavSpec.ts';
import { hashCombatantTargetId, resolveDefaultCombatantProfile } from './archetypeTuning.ts';
import { isArmChainIntactAndFunctional } from './combatantArmEvaluation.ts';
import {
  createDefaultPlayerVitals,
  notifyWaveCleared,
  stepPlayerVitalsRegen,
} from './playerVitalsController.ts';
import { getSidearmVisualState, syncAgentArmamentAndSidearm } from './agentArmamentController.ts';
import { computeEnemyAimProfile } from './tacticalAimProfileCalculator.ts';
import { handleEnemyHit, handleGunshotOrExplosion } from './tacticalPerception.ts';
import { createAgentRuntime, registerWaveTargetsInternal } from './tacticalAiRegistration.ts';
import { clearEnemyWeaponSway, forgetEnemyWeaponSway, setEnemySwayClock } from './enemyWeaponSway.ts';
import { isSightBlockedBySolidCover, resolveExposedPlayerAimPoint } from './tacticalLineOfSight.ts';
import { PEEK_REPLANS_PER_UPDATE, type PeekPlanCacheEntry, type PeekPlanPolicy } from './tacticalCoverFinder.ts';
import { type TacticalFsmContext, stepSingleEnemyAgent } from './tacticalAgentFsm.ts';
import { SightQueryMemo } from './sightQueryMemo.ts';
import { createTacticalFrameContext } from './tacticalFrameContext.ts';
import {
  broadcastWitnessedBrutality,
  buildSquadMateSummary,
  createEnemyTracerPool,
  triggerHitTraumaBark,
  triggerStateTransitionBark,
  updateSquadTokensAndFrustum,
} from './tacticalSquadOrchestrator.ts';

export type {
  ActiveFiringHand, AiBarkCategory, AiBarkPayload, AlertedEngagementSubstate, ArterialBleedState,
  BrutalKillRewardKind, CombatantResolveProfile, EnemyAiAgentRuntime, EnemyAimProfile,
  EnemyArmamentState, EnemyCoverShotInterceptResult, EnemyFireMode, EnemyHitNotification,
  EnemySidearmVisualState, EnemyTacticalAiState, EnemyTracerEvent, EnemyTracerFireEvent,
  HealthGateState, PlayerCombatVitals, PlayerNearMissGrazeKind, PlayerNearMissGrazePayload,
  PlayerSurvivalPhase, TacticalCombatAiConfig, TacticalCombatAiOptions, TacticalCoverStation,
  TraumaShockState, WeaponBurstState,
};

export {
  BACKUP_SIDEARM_WEAPON_ID, DOWNED_ONE_HANDED_SPREAD_MULTIPLIER, MIN_CONSCIOUSNESS_TO_FIGHT,
  OFFHAND_SIDEARM_SPREAD_MULTIPLIER, SIDEARM_DRAW_DURATION_S, TACTICAL_COVER_STATIONS,
  hashCombatantTargetId, isArmChainIntactAndFunctional, resolveDefaultCombatantProfile,
};

export class TacticalCombatAiSystem {
  public readonly playerVitals: PlayerCombatVitals;
  public getCoverBreachVersion?: () => number;
  public isLineOfSightBlockedCallback?: (fromWorld: Vec3Like, toWorld: Vec3Like) => boolean;
  public interceptEnemyShotCover?: (
    originWorld: Vec3Like,
    directionWorld: Vec3Like,
    maxDistanceM: number
  ) => EnemyCoverShotInterceptResult;
  public onEnemyFireTracer?: (event: EnemyTracerFireEvent) => void;
  public onPlayerDamaged?: (vitals: Readonly<PlayerCombatVitals>, event: EnemyTracerFireEvent) => void;
  public onPlayerNearMissGraze?: (event: PlayerNearMissGrazePayload) => void;
  public onAiBark?: (bark: AiBarkPayload) => void;
  public onEnemyStateChanged?: (
    targetId: string,
    prevState: EnemyTacticalAiState,
    nextState: EnemyTacticalAiState
  ) => void;

  private readonly app: pc.Application | null;
  private readonly rapierWorld: RapierPhysicsWorld | null;
  private readonly sightDetectionRangeM: number;
  private readonly tracerPool: HardwareInstancedPool | null;
  private readonly tokenPool: AttackTokenPool;
  private readonly barkCoordinator = new SquadBarkCoordinator();
  private readonly resolveProfileOverrides = new Map<string, CombatantResolveProfile>();
  private readonly hardenedSidearmOverrides = new Map<string, boolean>();
  private readonly agents = new Map<string, EnemyAiAgentRuntime>();
  private readonly targetStateById = new Map<string, TargetHealthState>();
  private readonly peekPlanCache = new Map<string, PeekPlanCacheEntry>();
  private readonly faultedAgentIds = new Set<string>();
  private readonly peekPolicy: PeekPlanPolicy = { breachVersion: null, replansLeft: PEEK_REPLANS_PER_UPDATE };
  private readonly sightMemo = new SightQueryMemo();
  private readonly arenaNav: ArenaNavSpec;
  private readonly frameCtx: TacticalFsmContext;
  private elapsedClockS = 0;
  private destroyed = false;

  private readonly castSight = (from: Vec3Like, to: Vec3Like): boolean =>
    isSightBlockedBySolidCover(from, to, this.rapierWorld, this.isLineOfSightBlockedCallback);
  private readonly isSightBlockedMemo = (from: Vec3Like, to: Vec3Like): boolean =>
    this.sightMemo.isBlocked(from, to, this.castSight);
  private readonly aimProfileOf = (hs: TargetHealthState, ag: EnemyAiAgentRuntime): EnemyAimProfile =>
    this.computeEnemyAimProfile(hs, ag);
  private readonly resolveAimMemo =(hs: TargetHealthState, ag: EnemyAiAgentRuntime, eye: Vec3Like) =>
    resolveExposedPlayerAimPoint(hs, ag, eye, this.isSightBlockedMemo);
  // Shots can break cover, so the memo is dropped after each one.
  private readonly interceptShotAndForgetSight = (o: Vec3Like, d: Vec3Like, m: number): EnemyCoverShotInterceptResult => {
    try { return this.interceptEnemyShotCover!(o, d, m); } finally { this.sightMemo.clear(); }
  };
  private readonly emitTracerAndForgetSight = (ev: EnemyTracerFireEvent): void => {
    try { this.onEnemyFireTracer?.(ev); } finally { this.sightMemo.clear(); }
  };

  public constructor(options: TacticalCombatAiOptions = {}) {
    this.app = options.app ?? null;
    this.rapierWorld = options.rapierWorld ?? null;
    this.sightDetectionRangeM = Math.max(5, options.sightDetectionRangeM ?? 30.0);
    this.tokenPool = new AttackTokenPool(options.maxAggressiveTokens ?? 3);
    this.isLineOfSightBlockedCallback = options.isLineOfSightBlocked;
    this.getCoverBreachVersion = options.getCoverBreachVersion;
    this.interceptEnemyShotCover = options.interceptEnemyShotCover;
    this.onEnemyFireTracer = options.onEnemyFireTracer;
    this.onPlayerDamaged = options.onPlayerDamaged;
    this.onPlayerNearMissGraze = options.onPlayerNearMissGraze;
    this.onAiBark = options.onAiBark;
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

    this.arenaNav = options.arenaNav ?? HALL_ARENA_NAV_SPEC;
    this.playerVitals = createDefaultPlayerVitals(options);
    this.tracerPool = createEnemyTracerPool(this.app);
    this.frameCtx = createTacticalFrameContext({
      sightDetectionRangeM: this.sightDetectionRangeM,
      rapierWorld: this.rapierWorld,
      arenaNav: this.arenaNav,
      peekPlanCache: this.peekPlanCache,
      peekPolicy: this.peekPolicy,
      agents: this.agents,
      targetStateById: this.targetStateById,
      barkCoordinator: this.barkCoordinator,
      playerVitals: this.playerVitals,
      tracerPool: this.tracerPool,
      clockS: () => this.elapsedClockS,
      isSightBlocked: this.isSightBlockedMemo,
      resolveAim: this.resolveAimMemo,
      nearMissGraze: (ev) => {
        this.onPlayerNearMissGraze?.(ev);
        this.app?.fire('player:near_miss_graze', ev);
      },
      transitionState: (ag, next) => this.transitionState(ag, next),
      notifyEnemyHit: (hs, hit) => this.notifyEnemyHit(hs, hit),
      computeAimProfile: (hs, ag) => this.computeEnemyAimProfile(hs, ag),
      notifySidearmDraw: (hs) => this.notifyAgentSidearmDraw(hs),
      emitBark: (b) => this.emitBark(b),
    });
  }

  public setPlayerDamageEnabled(enabled: boolean): void {
    this.playerVitals.damageEnabled = enabled;
  }

  public setCombatantResolveProfile(
    targetId: string,
    profile: CombatantResolveProfile,
    carriesBackupSidearm?: boolean
  ): void {
    this.resolveProfileOverrides.set(targetId, profile);
    const sidearm = carriesBackupSidearm ?? true;
    this.hardenedSidearmOverrides.set(targetId, sidearm);

    const existing = this.agents.get(targetId);
    if (existing) {
      existing.resolveProfile = profile;
      existing.carriesBackupSidearm = sidearm;
    }
  }

  public isGuarding(targetId: string): boolean {
    return this.agents.get(targetId)?.state === 'PATROL_GUARD';
  }

  public getSidearmVisualState(targetId: string): EnemySidearmVisualState {
    return getSidearmVisualState(this.agents.get(targetId));
  }

  public registerWaveTargets(targets: readonly TargetHealthState[], deployToCoverStations = false): void {
    this.tokenPool.reset();
    this.barkCoordinator.reset();
    this.targetStateById.clear();
    this.faultedAgentIds.clear();
    for (const hs of targets) this.targetStateById.set(hs.targetId, hs);
    // Registration replaces the roster, so bodies that are not coming back drop their sway state.
    const keptIds = new Set(targets.map((hs) => hs.targetId));
    for (const id of this.agents.keys()) if (!keptIds.has(id)) forgetEnemyWeaponSway(id);
    registerWaveTargetsInternal(
      targets,
      this.agents,
      this.peekPlanCache,
      this.resolveProfileOverrides,
      this.hardenedSidearmOverrides,
      this.arenaNav.coverStations,
      deployToCoverStations
    );
  }

  /** Adds an agent for a target first seen outside wave registration, leaving the rest of the roster alone. */
  private ensureAgent(hs: TargetHealthState): EnemyAiAgentRuntime {
    const existing = this.agents.get(hs.targetId);
    if (existing) return existing;
    const agent = createAgentRuntime(
      hs, 0, false, this.arenaNav.coverStations, this.resolveProfileOverrides, this.hardenedSidearmOverrides
    );
    this.agents.set(hs.targetId, agent);
    this.targetStateById.set(hs.targetId, hs);
    return agent;
  }

  /** One broken agent is logged once and skipped for the frame; the rest of the squad keeps running. */
  private reportAgentFault(targetId: string, err: unknown): void {
    if (this.faultedAgentIds.has(targetId)) return;
    this.faultedAgentIds.add(targetId);
    console.error(`[tactical-ai] agent ${targetId} step failed`, err);
  }

  public getAgent(targetId: string): EnemyAiAgentRuntime | undefined {
    return this.agents.get(targetId);
  }

  public notifyGunshotOrExplosion(
    soundOriginWorld: Vec3Like,
    audibleRadiusM = 38.0,
    suppressionImpulse = 0.22
  ): void {
    handleGunshotOrExplosion(this.agents, soundOriginWorld, audibleRadiusM, suppressionImpulse, (ag, next) =>
      this.transitionState(ag, next)
    );
  }

  public notifyEnemyHit(target: TargetHealthState, hit: EnemyHitNotification = {}): EnemyTacticalAiState {
    this.targetStateById.set(target.targetId, target);
    const agent = this.ensureAgent(target);

    const state = handleEnemyHit(
      target,
      hit,
      agent,
      this.agents,
      () =>
        syncAgentArmamentAndSidearm(
          0,
          target,
          agent,
          () => {},
          () => this.notifyAgentSidearmDraw(target)
        ),
      (ag, next) => this.transitionState(ag, next)
    );

    triggerHitTraumaBark(target, hit, agent, this.barkCoordinator, this.elapsedClockS, (b) =>
      this.emitBark(b)
    );

    const profile = this.computeEnemyAimProfile(target, agent, hit.externalAccuracyMultiplier);
    agent.lastSpreadMultiplier = profile.spreadMultiplier;
    agent.lastAimAccuracyMultiplier = profile.aimAccuracyMultiplier;
    agent.clutchingWound = profile.clutchingWound;
    return state;
  }

  public computeEnemyAimProfile(
    target: TargetHealthState,
    agent?: EnemyAiAgentRuntime,
    externalAccuracyMultiplier?: number
  ): EnemyAimProfile {
    return computeEnemyAimProfile(target, agent, externalAccuracyMultiplier);
  }

  public notifyWitnessedBrutality(victim: TargetHealthState, kind: BrutalKillRewardKind): number {
    return broadcastWitnessedBrutality(
      victim,
      kind,
      this.agents,
      this.targetStateById,
      this.barkCoordinator,
      this.elapsedClockS,
      (ag, next) => this.transitionState(ag, next),
      (bark) => this.emitBark(bark)
    );
  }

  public notifyWaveCleared(): void {
    notifyWaveCleared(this.playerVitals);
  }

  public update(
    dt: number,
    targets: readonly TargetHealthState[],
    playerEyeWorldPos: Vec3Like,
    playFireVisual?: BurstContext['playFireVisual'],
    playerForwardWorld?: Vec3Like,
    playReloadVisual?: BurstContext['playReloadVisual']
  ): void {
    if (this.destroyed || !Number.isFinite(dt) || dt <= 0) return;

    const stepDt = Math.min(0.1, dt);
    this.elapsedClockS += stepDt;
    this.sightMemo.clear();
    // Every held gun reads the sway clock, not only the ones firing this tick.
    setEnemySwayClock(this.elapsedClockS);
    stepPlayerVitalsRegen(this.playerVitals, stepDt);

    for (const hs of targets) {
      this.targetStateById.set(hs.targetId, hs);
      this.ensureAgent(hs);
    }

    updateSquadTokensAndFrustum(
      targets,
      this.agents,
      this.tokenPool,
      this.barkCoordinator,
      playerEyeWorldPos,
      playerForwardWorld,
      this.aimProfileOf,
      this.resolveAimMemo
    );

    this.barkCoordinator.step(
      this.elapsedClockS,
      (id) => buildSquadMateSummary(id, this.targetStateById, this.agents),
      (bark) => this.emitBark(bark)
    );

    this.peekPolicy.breachVersion = this.getCoverBreachVersion ? this.getCoverBreachVersion() : null;
    this.peekPolicy.replansLeft = PEEK_REPLANS_PER_UPDATE;
    const ctx = this.frameCtx;
    ctx.elapsedClockS = this.elapsedClockS;
    ctx.hasCoverQueries = this.rapierWorld !== null || this.isLineOfSightBlockedCallback !== undefined;
    const burst = ctx.burstCtx;
    burst.elapsedClockS = this.elapsedClockS;
    burst.playFireVisual = playFireVisual;
    burst.playReloadVisual = playReloadVisual;
    burst.onPlayerDamaged = this.onPlayerDamaged;
    burst.interceptEnemyShotCover = this.interceptEnemyShotCover ? this.interceptShotAndForgetSight : undefined;
    burst.onEnemyFireTracer = this.emitTracerAndForgetSight;

    for (const hs of targets) {
      const agent = this.agents.get(hs.targetId);
      if (!agent) continue;
      try {
        stepSingleEnemyAgent(stepDt, hs, agent, playerEyeWorldPos, ctx);
      } catch (err) {
        this.reportAgentFault(hs.targetId, err);
      }
    }

    if (this.tracerPool) this.tracerPool.syncFromPhysics(this.rapierWorld, stepDt);
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.agents.clear();
    this.targetStateById.clear();
    this.peekPlanCache.clear();
    this.faultedAgentIds.clear();
    this.tokenPool.reset();
    this.barkCoordinator.reset();
    clearEnemyWeaponSway();
    if (this.tracerPool) this.tracerPool.destroy();
  }

  private transitionState(agent: EnemyAiAgentRuntime, nextState: EnemyTacticalAiState): void {
    if (agent.state === nextState) return;
    const prev = agent.state;

    if (prev === 'ALERTED_ENGAGING' || nextState !== 'ALERTED_ENGAGING') {
      agent.isPeekingOut = false;
      agent.engagementSubstate = undefined;
      cancelActiveBurst(agent);
    }

    agent.state = nextState;
    if (nextState === 'DEAD') this.tokenPool.releaseToken(agent.targetId);

    triggerStateTransitionBark(
      agent,
      prev,
      nextState,
      this.targetStateById,
      this.agents,
      this.barkCoordinator,
      this.elapsedClockS,
      (bark) => this.emitBark(bark)
    );
    this.onEnemyStateChanged?.(agent.targetId, prev, nextState);
  }

  private notifyAgentSidearmDraw(hs: TargetHealthState): void {
    this.barkCoordinator.notifySidearmTransition(
      hs.targetId,
      hs.archetype,
      hs.worldPosition,
      this.elapsedClockS,
      (bark) => this.emitBark(bark)
    );
  }

  private emitBark(bark: AiBarkPayload): void {
    this.onAiBark?.(bark);
    this.app?.fire('ai:bark', bark);
  }
}
