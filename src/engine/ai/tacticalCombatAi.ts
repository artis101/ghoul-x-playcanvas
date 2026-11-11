import * as pc from 'playcanvas';
import type { TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import { HardwareInstancedPool } from '../physics/instancedPool.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import type {
  ActiveFiringHand,
  BrutalKillRewardKind,
  CombatantResolveProfile,
  EnemyAiAgentRuntime,
  EnemyAimProfile,
  EnemyCoverShotInterceptResult,
  EnemyHitNotification,
  EnemySidearmVisualState,
  EnemyTacticalAiState,
  EnemyTracerFireEvent,
  PlayerCombatVitals,
  TacticalCombatAiOptions,
  TacticalCoverStation,
} from './tacticalAiTypes.ts';
import {
  BACKUP_SIDEARM_WEAPON_ID,
  DOWNED_ONE_HANDED_SPREAD_MULTIPLIER,
  MIN_CONSCIOUSNESS_TO_FIGHT,
  OFFHAND_SIDEARM_SPREAD_MULTIPLIER,
  SIDEARM_DRAW_DURATION_S,
  TACTICAL_COVER_STATIONS,
} from './tacticalAiTypes.ts';
import {
  hashCombatantTargetId,
  resolveDefaultCombatantProfile,
} from './archetypeTuning.ts';
import { isArmChainIntactAndFunctional } from './combatantArmEvaluation.ts';
import {
  createDefaultPlayerVitals,
  grantBrutalKillReward,
  notifyWaveCleared,
  stepPlayerVitalsRegen,
} from './playerVitalsController.ts';
import {
  getSidearmVisualState,
  syncAgentArmamentAndSidearm,
} from './agentArmamentController.ts';
import { computeEnemyAimProfile } from './tacticalAimProfileCalculator.ts';
import {
  handleEnemyHit,
  handleGunshotOrExplosion,
} from './tacticalPerception.ts';
import { registerWaveTargetsInternal } from './tacticalAiRegistration.ts';
import {
  isSightBlockedBySolidCover,
  resolveExposedPlayerAimPoint,
} from './tacticalLineOfSight.ts';
import type { PeekPlanCacheEntry } from './tacticalCoverFinder.ts';
import { type TacticalFsmContext, stepSingleEnemyAgent } from './tacticalAgentFsm.ts';

export type {
  ActiveFiringHand,
  BrutalKillRewardKind,
  CombatantResolveProfile,
  EnemyAiAgentRuntime,
  EnemyAimProfile,
  EnemyCoverShotInterceptResult,
  EnemyHitNotification,
  EnemySidearmVisualState,
  EnemyTacticalAiState,
  EnemyTracerFireEvent,
  PlayerCombatVitals,
  TacticalCombatAiOptions,
  TacticalCoverStation,
};

export {
  BACKUP_SIDEARM_WEAPON_ID,
  DOWNED_ONE_HANDED_SPREAD_MULTIPLIER,
  MIN_CONSCIOUSNESS_TO_FIGHT,
  OFFHAND_SIDEARM_SPREAD_MULTIPLIER,
  SIDEARM_DRAW_DURATION_S,
  TACTICAL_COVER_STATIONS,
  hashCombatantTargetId,
  isArmChainIntactAndFunctional,
  resolveDefaultCombatantProfile,
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
  public onPlayerDamaged?: (
    vitals: Readonly<PlayerCombatVitals>,
    event: EnemyTracerFireEvent
  ) => void;
  public onEnemyStateChanged?: (
    targetId: string,
    prevState: EnemyTacticalAiState,
    nextState: EnemyTacticalAiState
  ) => void;

  private readonly app: pc.Application | null;
  private readonly rapierWorld: RapierPhysicsWorld | null;
  private readonly sightDetectionRangeM: number;
  private readonly tracerPool: HardwareInstancedPool | null;

  private readonly resolveProfileOverrides = new Map<string, CombatantResolveProfile>();
  private readonly hardenedSidearmOverrides = new Map<string, boolean>();
  private readonly agents = new Map<string, EnemyAiAgentRuntime>();
  private readonly peekPlanCache = new Map<string, PeekPlanCacheEntry>();
  private readonly aimExposureCache = new Map<string, any>();
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

    this.playerVitals = createDefaultPlayerVitals(options);

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
        false
      );
    } else {
      this.tracerPool = null;
    }
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

  public getSidearmVisualState(targetId: string): EnemySidearmVisualState {
    return getSidearmVisualState(this.agents.get(targetId));
  }

  public registerWaveTargets(
    targets: readonly TargetHealthState[],
    deployToCoverStations = false
  ): void {
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
    handleGunshotOrExplosion(
      this.agents,
      soundOriginWorld,
      audibleRadiusM,
      suppressionImpulse,
      (agent, next) => this.transitionState(agent, next)
    );
  }

  public notifyEnemyHit(
    target: TargetHealthState,
    hit: EnemyHitNotification = {}
  ): EnemyTacticalAiState {
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
      () => syncAgentArmamentAndSidearm(0, target, agent!, () => {}),
      (ag, next) => this.transitionState(ag, next)
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

  public grantBrutalKillReward(kind: BrutalKillRewardKind): void {
    grantBrutalKillReward(this.playerVitals, kind);
  }

  public notifyWaveCleared(): void {
    notifyWaveCleared(this.playerVitals);
  }

  public update(
    dt: number,
    targets: readonly TargetHealthState[],
    playerEyeWorldPos: Vec3Like
  ): void {
    if (this.destroyed || !Number.isFinite(dt) || dt <= 0) return;

    const stepDt = Math.min(0.1, dt);
    this.elapsedClockS += stepDt;
    stepPlayerVitalsRegen(this.playerVitals, stepDt);

    const isSightBlocked = (from: Vec3Like, to: Vec3Like) =>
      isSightBlockedBySolidCover(from, to, this.rapierWorld, this.isLineOfSightBlockedCallback);

    const resolveAim = (hs: TargetHealthState, ag: EnemyAiAgentRuntime, eye: Vec3Like) =>
      resolveExposedPlayerAimPoint(hs, ag, eye, this.rapierWorld, this.isLineOfSightBlockedCallback);

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
        onPlayerDamaged: this.onPlayerDamaged,
        resolveExposedPlayerAimPoint: resolveAim,
      },
      transitionState: (ag, next) => this.transitionState(ag, next),
      notifyEnemyHit: (hs, hit) => this.notifyEnemyHit(hs, hit),
      computeAimProfile: (hs, ag) => this.computeEnemyAimProfile(hs, ag),
    };

    for (const hs of targets) {
      let agent = this.agents.get(hs.targetId);
      if (!agent) {
        this.registerWaveTargets([hs], false);
        agent = this.agents.get(hs.targetId)!;
      }
      stepSingleEnemyAgent(stepDt, hs, agent, playerEyeWorldPos, fsmCtx);
    }

    if (this.tracerPool) {
      this.tracerPool.syncFromPhysics(this.rapierWorld, stepDt);
    }
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.agents.clear();
    this.peekPlanCache.clear();
    this.aimExposureCache.clear();
    if (this.tracerPool) {
      this.tracerPool.destroy();
    }
  }

  private transitionState(agent: EnemyAiAgentRuntime, nextState: EnemyTacticalAiState): void {
    if (agent.state === nextState) return;
    const prev = agent.state;
    agent.state = nextState;
    this.onEnemyStateChanged?.(agent.targetId, prev, nextState);
  }
}
