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
import { hashCombatantTargetId, resolveDefaultCombatantProfile } from './archetypeTuning.ts';
import { isArmChainIntactAndFunctional } from './combatantArmEvaluation.ts';
import {
  type BrutalKillVitalsDelta,
  createDefaultPlayerVitals,
  grantBrutalKillReward,
  notifyWaveCleared,
  stepPlayerVitalsRegen,
} from './playerVitalsController.ts';
import { getSidearmVisualState, syncAgentArmamentAndSidearm } from './agentArmamentController.ts';
import { computeEnemyAimProfile } from './tacticalAimProfileCalculator.ts';
import { handleEnemyHit, handleGunshotOrExplosion } from './tacticalPerception.ts';
import { registerWaveTargetsInternal } from './tacticalAiRegistration.ts';
import { isSightBlockedBySolidCover, resolveExposedPlayerAimPoint } from './tacticalLineOfSight.ts';
import type { PeekPlanCacheEntry } from './tacticalCoverFinder.ts';
import { type TacticalFsmContext, stepSingleEnemyAgent } from './tacticalAgentFsm.ts';
import {
  broadcastWitnessedBrutality,
  buildAllSquadMateSummaries,
  buildSquadMateSummary,
  createEnemyTracerPool,
  relocateAgentToAlternateCover,
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
  private readonly aimExposureCache = new Map<string, any>();
  private elapsedClockS = 0;
  private destroyed = false;

  public constructor(options: TacticalCombatAiOptions = {}) {
    this.app = options.app ?? null;
    this.rapierWorld = options.rapierWorld ?? null;
    this.sightDetectionRangeM = Math.max(5, options.sightDetectionRangeM ?? 30.0);
    this.tokenPool = new AttackTokenPool(options.maxAggressiveTokens ?? 3);
    this.isLineOfSightBlockedCallback = options.isLineOfSightBlocked;
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

    this.playerVitals = createDefaultPlayerVitals(options);
    this.tracerPool = createEnemyTracerPool(this.app);
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
    const sidearm = carriesBackupSidearm ?? profile === 'HARDENED_VETERAN';
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
    for (const hs of targets) this.targetStateById.set(hs.targetId, hs);
    registerWaveTargetsInternal(
      targets,
      this.agents,
      this.peekPlanCache,
      this.aimExposureCache,
      this.resolveProfileOverrides,
      this.hardenedSidearmOverrides,
      deployToCoverStations,
      this.elapsedClockS
    );
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
    let agent = this.agents.get(target.targetId);
    if (!agent) {
      this.registerWaveTargets([target], false);
      agent = this.agents.get(target.targetId)!;
    }

    const state = handleEnemyHit(
      target,
      hit,
      agent,
      this.agents,
      () =>
        syncAgentArmamentAndSidearm(
          0,
          target,
          agent!,
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

  public grantBrutalKillReward(kind: BrutalKillRewardKind): BrutalKillVitalsDelta {
    return grantBrutalKillReward(this.playerVitals, kind);
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
    playerForwardWorld?: Vec3Like
  ): void {
    if (this.destroyed || !Number.isFinite(dt) || dt <= 0) return;

    const stepDt = Math.min(0.1, dt);
    this.elapsedClockS += stepDt;
    stepPlayerVitalsRegen(this.playerVitals, stepDt);

    for (const hs of targets) {
      this.targetStateById.set(hs.targetId, hs);
      if (!this.agents.has(hs.targetId)) this.registerWaveTargets([hs], false);
    }

    const isSightBlocked = (from: Vec3Like, to: Vec3Like) =>
      isSightBlockedBySolidCover(from, to, this.rapierWorld, this.isLineOfSightBlockedCallback);
    const resolveAim = (hs: TargetHealthState, ag: EnemyAiAgentRuntime, eye: Vec3Like) =>
      resolveExposedPlayerAimPoint(hs, ag, eye, this.rapierWorld, this.isLineOfSightBlockedCallback);

    updateSquadTokensAndFrustum(
      targets,
      this.agents,
      this.tokenPool,
      this.barkCoordinator,
      playerEyeWorldPos,
      playerForwardWorld,
      (hs, ag) => this.computeEnemyAimProfile(hs, ag),
      resolveAim
    );

    this.barkCoordinator.step(
      this.elapsedClockS,
      (id) => buildSquadMateSummary(id, this.targetStateById, this.agents),
      (bark) => this.emitBark(bark)
    );

    const fsmCtx: TacticalFsmContext = {
      elapsedClockS: this.elapsedClockS,
      sightDetectionRangeM: this.sightDetectionRangeM,
      rapierWorld: this.rapierWorld,
      peekPlanCache: this.peekPlanCache,
      hasCoverQueries: this.rapierWorld !== null || this.isLineOfSightBlockedCallback !== undefined,
      isSightBlocked,
      burstCtx: {
        elapsedClockS: this.elapsedClockS,
        playerVitals: this.playerVitals,
        tracerPool: this.tracerPool,
        rapierWorld: this.rapierWorld,
        interceptEnemyShotCover: this.interceptEnemyShotCover,
        onEnemyFireTracer: this.onEnemyFireTracer,
        playFireVisual,
        onPlayerDamaged: this.onPlayerDamaged,
        onPlayerNearMissGraze: (ev) => {
          this.onPlayerNearMissGraze?.(ev);
          this.app?.fire('player:near_miss_graze', ev);
        },
        resolveExposedPlayerAimPoint: resolveAim,
      },
      transitionState: (ag, next) => this.transitionState(ag, next),
      notifyEnemyHit: (hs, hit) => this.notifyEnemyHit(hs, hit),
      computeAimProfile: (hs, ag) => this.computeEnemyAimProfile(hs, ag),
      onAgentFlankShift: (hs, ag) => {
        this.barkCoordinator.notifyFlankOrPeekShift(
          hs.targetId,
          hs.archetype,
          ag.peekSign,
          hs.worldPosition,
          buildAllSquadMateSummaries(this.targetStateById, this.agents),
          this.elapsedClockS,
          (bark) => this.emitBark(bark)
        );
      },
      onAgentSidearmDrawStart: (hs) => this.notifyAgentSidearmDraw(hs),
      onAgentCoverRetreat: (hs) => {
        this.barkCoordinator.notifyCoverRetreat(
          hs.targetId,
          hs.archetype,
          hs.worldPosition,
          this.elapsedClockS,
          (bark) => this.emitBark(bark)
        );
      },
      tryRelocateCoverAnchor: (hs, ag) =>
        relocateAgentToAlternateCover(hs, ag, this.agents, this.peekPlanCache, this.elapsedClockS),
    };

    for (const hs of targets) {
      stepSingleEnemyAgent(stepDt, hs, this.agents.get(hs.targetId)!, playerEyeWorldPos, fsmCtx);
    }

    if (this.tracerPool) this.tracerPool.syncFromPhysics(this.rapierWorld, stepDt);
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.agents.clear();
    this.targetStateById.clear();
    this.peekPlanCache.clear();
    this.aimExposureCache.clear();
    this.tokenPool.reset();
    this.barkCoordinator.reset();
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
