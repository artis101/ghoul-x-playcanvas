import type { TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import type {
  EnemyAimProfile, EnemyAiAgentRuntime, EnemyHitNotification, EnemyTacticalAiState,
} from './tacticalAiTypes.ts';
import type { PeekPlanCacheEntry } from './tacticalCoverFinder.ts';
import type { BurstContext } from './tacticalBurstAndTracers.ts';

// A body on the ground, or doubled over, shuffles round slowly; it cannot pivot like one on its feet.
export const DOWNED_TURN_RATE_RAD_S = 0.9;

export interface TacticalFsmContext {
  elapsedClockS: number;
  sightDetectionRangeM: number;
  rapierWorld: RapierPhysicsWorld | null;
  peekPlanCache: Map<string, PeekPlanCacheEntry>;
  hasCoverQueries: boolean;
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
