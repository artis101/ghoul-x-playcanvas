import type { AiBarkPayload, PlayerCombatVitals, PlayerNearMissGrazePayload } from '../../contracts/ai/aiContracts.ts';
import type { TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import type { SquadBarkCoordinator } from '../../core/ai/squadBarkCoordinator.ts';
import type { HardwareInstancedPool } from '../physics/instancedPool.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import type {
  EnemyAimProfile, EnemyAiAgentRuntime, EnemyHitNotification, EnemyTacticalAiState,
} from './tacticalAiTypes.ts';
import type { PeekPlanCacheEntry, PeekPlanPolicy } from './tacticalCoverFinder.ts';
import type { ArenaNavSpec } from './arenaNavSpec.ts';
import type { TacticalFsmContext } from './tacticalFsmContext.ts';
import { buildAllSquadMateSummaries, relocateAgentToAlternateCover } from './tacticalSquadOrchestrator.ts';

export interface TacticalFrameHost {
  readonly sightDetectionRangeM: number;
  readonly rapierWorld: RapierPhysicsWorld | null;
  readonly arenaNav: ArenaNavSpec;
  readonly peekPlanCache: Map<string, PeekPlanCacheEntry>;
  readonly peekPolicy: PeekPlanPolicy;
  readonly agents: Map<string, EnemyAiAgentRuntime>;
  readonly targetStateById: Map<string, TargetHealthState>;
  readonly barkCoordinator: SquadBarkCoordinator;
  readonly playerVitals: PlayerCombatVitals;
  readonly tracerPool: HardwareInstancedPool | null;
  clockS(): number;
  isSightBlocked(from: Vec3Like, to: Vec3Like): boolean;
  resolveAim(hs: TargetHealthState, agent: EnemyAiAgentRuntime, playerEye: Vec3Like): Vec3Like | null;
  nearMissGraze(ev: PlayerNearMissGrazePayload): void;
  transitionState(agent: EnemyAiAgentRuntime, next: EnemyTacticalAiState): void;
  notifyEnemyHit(hs: TargetHealthState, hit: EnemyHitNotification): EnemyTacticalAiState;
  computeAimProfile(hs: TargetHealthState, agent: EnemyAiAgentRuntime): EnemyAimProfile;
  notifySidearmDraw(hs: TargetHealthState): void;
  emitBark(bark: AiBarkPayload): void;
}

/**
 * Builds the per-system FSM context once. The per-update fields (clock, cover-query flag and the
 * burst context's visual and damage hooks) are refreshed in place by the owner each update.
 */
export function createTacticalFrameContext(host: TacticalFrameHost): TacticalFsmContext {
  const emit = (b: AiBarkPayload): void => host.emitBark(b);
  return {
    elapsedClockS: 0,
    sightDetectionRangeM: host.sightDetectionRangeM,
    rapierWorld: host.rapierWorld,
    peekPlanCache: host.peekPlanCache,
    hasCoverQueries: false,
    peekPolicy: host.peekPolicy,
    arenaNav: host.arenaNav,
    isSightBlocked: (f, t) => host.isSightBlocked(f, t),
    burstCtx: {
      elapsedClockS: 0,
      playerVitals: host.playerVitals,
      tracerPool: host.tracerPool,
      rapierWorld: host.rapierWorld,
      interceptEnemyShotCover: undefined,
      onEnemyFireTracer: undefined,
      playFireVisual: undefined,
      playReloadVisual: undefined,
      onPlayerDamaged: undefined,
      onPlayerNearMissGraze: (ev) => host.nearMissGraze(ev),
      resolveExposedPlayerAimPoint: (hs, ag, eye) => host.resolveAim(hs, ag, eye),
    },
    transitionState: (ag, next) => host.transitionState(ag, next),
    notifyEnemyHit: (hs, hit) => host.notifyEnemyHit(hs, hit),
    computeAimProfile: (hs, ag) => host.computeAimProfile(hs, ag),
    onAgentFlankShift: (hs, ag) => {
      host.barkCoordinator.notifyFlankOrPeekShift(
        hs.targetId,
        hs.archetype,
        ag.peekSign,
        hs.worldPosition,
        buildAllSquadMateSummaries(host.targetStateById, host.agents),
        host.clockS(),
        emit
      );
    },
    onAgentSidearmDrawStart: (hs) => host.notifySidearmDraw(hs),
    onAgentReloadStart: (hs) =>
      host.barkCoordinator.notifyReloading(hs.targetId, hs.archetype, hs.worldPosition, host.clockS(), emit),
    onAgentCoverRetreat: (hs) => {
      host.barkCoordinator.notifyCoverRetreat(hs.targetId, hs.archetype, hs.worldPosition, host.clockS(), emit);
    },
    tryRelocateCoverAnchor: (hs, ag) =>
      relocateAgentToAlternateCover(hs, ag, host.agents, host.peekPlanCache, host.clockS(), host.arenaNav.coverStations),
  };
}
