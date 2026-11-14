import type { TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import type { EnemyAiAgentRuntime } from './tacticalAiTypes.ts';
import { HALL_ARENA_NAV_SPEC, type ArenaNavSpec } from './arenaNavSpec.ts';
import { hashCombatantTargetId } from './archetypeTuning.ts';

export interface PeekPlanCacheEntry {
  timestampS: number;
  isPeekingOut: boolean;
  peekSign: -1 | 1;
  playerX: number;
  playerY: number;
  playerZ: number;
  anchorX: number;
  anchorZ: number;
  baseY: number;
  breachVersion: number | null;
  deferred: boolean;
  baseOffset: number;
  goalZ: number;
  anchorBlockedByCover: boolean;
  firingPosition: boolean;
}

export interface AlertedPeekPlan {
  readonly targetOffset: number;
  readonly goalZ: number;
  readonly anchorBlockedByCover: boolean;
  /** True when the planned spot is one to shoot from (peeking, or exposed with nowhere to hide). */
  readonly firingPosition: boolean;
}

export interface PeekPlanPolicy {
  /** Cover topology version for this update, or null when the AI has no breach feed. */
  breachVersion: number | null;
  /** Full replans still allowed this update in breach-aware mode. */
  replansLeft: number;
}

export const PEEK_REPLANS_PER_UPDATE = 2;
const LEGACY_PLAN_TTL_S = 0.08;
const LEGACY_PLAYER_MOVE_M = 0.2;
const PLAN_TTL_S = 0.3;
const PLAN_TTL_STAGGER_S = 0.025;
const PLAN_PLAYER_MOVE_M = 0.35;
const PLAN_PLAYER_RISE_M = 0.25;

function planStillValid(
  cached: PeekPlanCacheEntry,
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  playerEye: Vec3Like,
  now: number,
  policy: PeekPlanPolicy | null,
  ignoreAgeAndPlayer: boolean
): boolean {
  if (cached.isPeekingOut !== agent.isPeekingOut || cached.peekSign !== agent.peekSign) return false;
  if (policy === null || policy.breachVersion === null) {
    return (
      !ignoreAgeAndPlayer &&
      now - cached.timestampS < LEGACY_PLAN_TTL_S &&
      Math.abs(playerEye.x - cached.playerX) < LEGACY_PLAYER_MOVE_M &&
      Math.abs(playerEye.z - cached.playerZ) < LEGACY_PLAYER_MOVE_M
    );
  }
  if (cached.breachVersion !== policy.breachVersion) return false;
  if (
    cached.anchorX !== agent.coverAnchorWorld.x ||
    cached.anchorZ !== agent.coverAnchorWorld.z ||
    cached.baseY !== hs.worldPosition.y
  ) {
    return false;
  }
  if (ignoreAgeAndPlayer) return true;
  const ttl = PLAN_TTL_S + (hashCombatantTargetId(agent.targetId) % 4) * PLAN_TTL_STAGGER_S;
  return (
    now - cached.timestampS < ttl &&
    Math.abs(playerEye.x - cached.playerX) < PLAN_PLAYER_MOVE_M &&
    Math.abs(playerEye.z - cached.playerZ) < PLAN_PLAYER_MOVE_M &&
    Math.abs(playerEye.y - cached.playerY) < PLAN_PLAYER_RISE_M
  );
}

function planFromEntry(cached: PeekPlanCacheEntry): AlertedPeekPlan {
  return {
    targetOffset: cached.baseOffset,
    goalZ: cached.goalZ,
    anchorBlockedByCover: cached.anchorBlockedByCover,
    firingPosition: cached.firingPosition,
  };
}

export function computeAlertedPeekTarget(
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  playerEyeWorldPos: Vec3Like,
  elapsedClockS: number,
  peekPlanCache: Map<string, PeekPlanCacheEntry>,
  isSightBlocked: (from: Vec3Like, to: Vec3Like) => boolean,
  hasCoverQueries: boolean,
  policy: PeekPlanPolicy | null = null,
  nav: ArenaNavSpec = HALL_ARENA_NAV_SPEC
): AlertedPeekPlan {
  // Peek spots are fixed points. A soldier steps out to a spot, plants and fires; it does not
  // sway on the spot, which would keep its walk cycle starting and stopping.
  if (!hasCoverQueries) {
    return {
      targetOffset: agent.isPeekingOut ? agent.peekSign * agent.peekStrideM : -agent.peekSign * 0.18,
      goalZ: agent.coverAnchorWorld.z + (agent.isPeekingOut ? 0.18 : -0.12),
      anchorBlockedByCover: false,
      firingPosition: agent.isPeekingOut,
    };
  }

  const cached = peekPlanCache.get(agent.targetId);
  if (cached && planStillValid(cached, hs, agent, playerEyeWorldPos, elapsedClockS, policy, false)) {
    return planFromEntry(cached);
  }
  if (policy && policy.breachVersion !== null) {
    // Over budget this update: an agent may keep its topology-valid plan for one more update.
    if (
      policy.replansLeft <= 0 &&
      cached &&
      !cached.deferred &&
      planStillValid(cached, hs, agent, playerEyeWorldPos, elapsedClockS, policy, true)
    ) {
      cached.deferred = true;
      return planFromEntry(cached);
    }
    policy.replansLeft--;
  }

  const savePeekCache = (
    baseOffset: number,
    goalZ: number,
    anchorBlockedByCover: boolean,
    firingPosition = agent.isPeekingOut
  ): AlertedPeekPlan => {
    peekPlanCache.set(agent.targetId, {
      timestampS: elapsedClockS,
      isPeekingOut: agent.isPeekingOut,
      peekSign: agent.peekSign,
      playerX: playerEyeWorldPos.x,
      playerY: playerEyeWorldPos.y,
      playerZ: playerEyeWorldPos.z,
      anchorX: agent.coverAnchorWorld.x,
      anchorZ: agent.coverAnchorWorld.z,
      baseY: hs.worldPosition.y,
      breachVersion: policy?.breachVersion ?? null,
      deferred: false,
      baseOffset,
      goalZ,
      anchorBlockedByCover,
      firingPosition,
    });
    return { targetOffset: baseOffset, goalZ, anchorBlockedByCover, firingPosition };
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
    !isSightBlocked(anchorCore, playerChest) || !isSightBlocked(anchorEye, playerEyeWorldPos);

  if (anchorClear) {
    // The anchor already sees the player, so there is nothing to step out past: it fights from
    // the anchor and the close-quarters bound supplies any lateral movement.
    const openGroundOffset = 0;
    const openGroundZ = agent.coverAnchorWorld.z + 0.12;

    if (!agent.isPeekingOut) {
      for (const sign of [-agent.peekSign, agent.peekSign] as const) {
        const shelterX = agent.coverAnchorWorld.x + sign * 0.72;
        if (shelterX < nav.peekSpotMinX || shelterX > nav.peekSpotMaxX) continue;
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
        if (isSightBlocked(shelterCore, playerChest) && isSightBlocked(shelterEye, playerEyeWorldPos)) {
          return savePeekCache(sign * 0.72, agent.coverAnchorWorld.z - 0.14, false);
        }
      }
      // Nothing to hide behind: stepping a few centimetres back would not help, so it holds
      // its spot and keeps fighting from it.
      return savePeekCache(openGroundOffset, openGroundZ, false, true);
    }

    return savePeekCache(openGroundOffset, openGroundZ, false);
  }

  if (!agent.isPeekingOut) {
    return savePeekCache(0, agent.coverAnchorWorld.z - 0.14, true);
  }

  const peekZ = agent.coverAnchorWorld.z + 0.18;
  const candidateDistances = [0.55, 0.95, 1.35, 1.68, 1.98, 2.32];
  const signs: readonly (-1 | 1)[] = [agent.peekSign, (agent.peekSign === 1 ? -1 : 1) as -1 | 1];

  for (const d of candidateDistances) {
    for (const s of signs) {
      const rawX = agent.coverAnchorWorld.x + s * d;
      if (rawX < nav.peekSpotMinX || rawX > nav.peekSpotMaxX) continue;
      const candCore: Vec3Like = { x: rawX, y: hs.worldPosition.y + 1.32, z: peekZ };
      const candClear =
        !isSightBlocked(candCore, playerChest) || !isSightBlocked(candCore, playerEyeWorldPos);

      if (candClear) {
        agent.peekSign = s;
        let chosenDist = d;
        const nudgedX = agent.coverAnchorWorld.x + s * (d + 0.16);
        if (nudgedX >= nav.peekSpotMinX && nudgedX <= nav.peekSpotMaxX) {
          const nudgedCore: Vec3Like = { x: nudgedX, y: hs.worldPosition.y + 1.32, z: peekZ };
          if (!isSightBlocked(nudgedCore, playerChest) || !isSightBlocked(nudgedCore, playerEyeWorldPos)) {
            chosenDist = d + 0.16;
          }
        }
        return savePeekCache(s * chosenDist, peekZ, true);
      }
    }
  }

  return savePeekCache(agent.peekSign * agent.peekStrideM, peekZ, true);
}
