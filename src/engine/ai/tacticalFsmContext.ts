import type { TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import type {
  EnemyAimProfile, EnemyAiAgentRuntime, EnemyHitNotification, EnemyTacticalAiState,
} from './tacticalAiTypes.ts';
import type { ArenaNavSpec } from './arenaNavSpec.ts';
import type { PeekPlanCacheEntry, PeekPlanPolicy } from './tacticalCoverFinder.ts';
import type { BurstContext } from './tacticalBurstAndTracers.ts';

// A crawler drags itself round slowly to face away from the player. A downed shooter never turns
// at all (docs/wound-movement.md): it only fires at a player already in front of it.
export const DOWNED_TURN_RATE_RAD_S = 0.9;

export interface TacticalFsmContext {
  elapsedClockS: number;
  sightDetectionRangeM: number;
  rapierWorld: RapierPhysicsWorld | null;
  peekPlanCache: Map<string, PeekPlanCacheEntry>;
  hasCoverQueries: boolean;
  peekPolicy: PeekPlanPolicy;
  arenaNav: ArenaNavSpec;
  isSightBlocked: (from: Vec3Like, to: Vec3Like) => boolean;
  burstCtx: BurstContext;
  transitionState: (agent: EnemyAiAgentRuntime, next: EnemyTacticalAiState) => void;
  notifyEnemyHit: (hs: TargetHealthState, hit: EnemyHitNotification) => EnemyTacticalAiState;
  computeAimProfile: (hs: TargetHealthState, agent: EnemyAiAgentRuntime) => EnemyAimProfile;
  onAgentFlankShift?: (hs: TargetHealthState, agent: EnemyAiAgentRuntime) => void;
  onAgentSidearmDrawStart?: (hs: TargetHealthState, agent: EnemyAiAgentRuntime) => void;
  onAgentReloadStart?: (hs: TargetHealthState, agent: EnemyAiAgentRuntime) => void;
  onAgentCoverRetreat?: (hs: TargetHealthState, agent: EnemyAiAgentRuntime) => void;
  tryRelocateCoverAnchor?: (hs: TargetHealthState, agent: EnemyAiAgentRuntime) => boolean;
}
