import type { TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import type { EnemyAiAgentRuntime } from './tacticalAiTypes.ts';

export interface PeekPlanCacheEntry {
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

export function computeAlertedPeekTarget(
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  playerEyeWorldPos: Vec3Like,
  elapsedClockS: number,
  peekPlanCache: Map<string, PeekPlanCacheEntry>,
  isSightBlocked: (from: Vec3Like, to: Vec3Like) => boolean,
  hasCoverQueries: boolean
): { targetOffset: number; goalZ: number; anchorBlockedByCover: boolean } {
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

  const cached = peekPlanCache.get(agent.targetId);
  if (
    cached &&
    elapsedClockS - cached.timestampS < 0.08 &&
    cached.isPeekingOut === agent.isPeekingOut &&
    cached.peekSign === agent.peekSign &&
    Math.abs(playerEyeWorldPos.x - cached.playerX) < 0.2 &&
    Math.abs(playerEyeWorldPos.z - cached.playerZ) < 0.2
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
    anchorBlockedByCover: boolean
  ) => {
    peekPlanCache.set(agent.targetId, {
      timestampS: elapsedClockS,
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
    !isSightBlocked(anchorCore, playerChest) || !isSightBlocked(anchorEye, playerEyeWorldPos);

  if (anchorClear) {
    const sideProbeOffset = agent.peekSign * Math.min(0.85, agent.peekStrideM);
    const sideCore: Vec3Like = {
      x: agent.coverAnchorWorld.x + sideProbeOffset,
      y: hs.worldPosition.y + 1.32,
      z: agent.coverAnchorWorld.z + 0.12,
    };
    const sideClear = !isSightBlocked(sideCore, playerChest);

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
        if (isSightBlocked(shelterCore, playerChest) && isSightBlocked(shelterEye, playerEyeWorldPos)) {
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
  const signs: readonly (-1 | 1)[] = [agent.peekSign, (agent.peekSign === 1 ? -1 : 1) as -1 | 1];

  for (const d of candidateDistances) {
    for (const s of signs) {
      const rawX = agent.coverAnchorWorld.x + s * d;
      if (rawX < -8.05 || rawX > 8.05) continue;
      const candCore: Vec3Like = { x: rawX, y: hs.worldPosition.y + 1.32, z: peekZ };
      const candClear =
        !isSightBlocked(candCore, playerChest) || !isSightBlocked(candCore, playerEyeWorldPos);

      if (candClear) {
        agent.peekSign = s;
        let chosenDist = d;
        const nudgedX = agent.coverAnchorWorld.x + s * (d + 0.16);
        if (nudgedX >= -8.05 && nudgedX <= 8.05) {
          const nudgedCore: Vec3Like = { x: nudgedX, y: hs.worldPosition.y + 1.32, z: peekZ };
          if (!isSightBlocked(nudgedCore, playerChest) || !isSightBlocked(nudgedCore, playerEyeWorldPos)) {
            chosenDist = d + 0.16;
          }
        }
        return savePeekCache(s * chosenDist, 'FINE', peekZ, true);
      }
    }
  }

  return savePeekCache(agent.peekSign * agent.peekStrideM, 'NONE', peekZ, true);
}
