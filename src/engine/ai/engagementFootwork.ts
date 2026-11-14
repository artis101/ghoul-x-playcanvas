import type { TargetHealthState } from '../../contracts/ballistics.ts';
import { createCloseQuartersJukeState, stepCloseQuartersJuke } from '../../core/ai/closeQuartersStrafe.ts';
import {
  createPlantedFootworkState,
  holdFootworkGoal,
  recordFootworkMotion,
} from '../../core/ai/plantedFootwork.ts';
import type { EnemyAiAgentRuntime } from './tacticalAiTypes.ts';
import { clampArenaGoalX, clampArenaGoalZ, moveHorizontalClamped } from './tacticalLocomotion.ts';
import type { TacticalFsmContext } from './tacticalFsmContext.ts';
import { HALL_ARENA_NAV_SPEC, type ArenaNavSpec } from './arenaNavSpec.ts';

// Smoothing rate for the engaging ground-speed estimate that drives the moving-fire penalty.
const MOVE_SPEED_SMOOTHING = 8;
// Lateral moves longer than this are a dash between firing spots, taken at a run.
const DASH_THRESHOLD_M = 1.0;
const DASH_SPEED_MS = 2.35;

export interface EngagementMoveRequest {
  /** Desired lateral offset from the cover anchor, in metres. */
  readonly lateralOffsetM: number;
  readonly goalZ: number;
  readonly strafeSpeedMs: number;
}

/**
 * Walks the combatant toward its desired spot. Once it has planted, the goal is held through
 * small changes (see `plantedFootwork.ts`), so a standing combatant stays put instead of
 * shuffling, and long sidesteps are taken as a run.
 */
export function driveEngagementFootwork(
  dt: number,
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  request: EngagementMoveRequest,
  ctx: TacticalFsmContext
): void {
  const footwork = (agent.footwork ??= createPlantedFootworkState());
  const anchorX = agent.coverAnchorWorld.x;
  const held = holdFootworkGoal(
    footwork,
    clampArenaGoalX(anchorX + request.lateralOffsetM, ctx.arenaNav),
    clampArenaGoalZ(request.goalZ, ctx.arenaNav)
  );

  const deltaOffset = held.x - anchorX - agent.currentLateralOffsetM;
  const speedMs =
    Math.abs(deltaOffset) > DASH_THRESHOLD_M
      ? Math.max(request.strafeSpeedMs, DASH_SPEED_MS)
      : request.strafeSpeedMs;
  const maxStrideStep = speedMs * dt;
  agent.currentLateralOffsetM +=
    Math.abs(deltaOffset) <= maxStrideStep ? deltaOffset : Math.sign(deltaOffset) * maxStrideStep;

  const goalX = anchorX + agent.currentLateralOffsetM;
  const beforeX = hs.worldPosition.x;
  const beforeZ = hs.worldPosition.z;
  moveHorizontalClamped(hs, goalX, held.z, maxStrideStep, ctx.rapierWorld, ctx.arenaNav);

  if (dt <= 0) return;
  const moved = Math.hypot(hs.worldPosition.x - beforeX, hs.worldPosition.z - beforeZ);
  recordFootworkMotion(footwork, moved, dt);
  const prev = agent.moveSpeedMs ?? 0;
  agent.moveSpeedMs = prev + (moved / dt - prev) * (1 - Math.exp(-MOVE_SPEED_SMOOTHING * dt));
  const wantedLateral = Math.min(Math.abs(goalX - beforeX), maxStrideStep);
  agent.lateralStalled = wantedLateral > 0.01 && Math.abs(hs.worldPosition.x - beforeX) < wantedLateral * 0.2;
}

/** Advances the close-quarters bound, reacting to hits and to the player's aim. */
export function stepCloseQuartersBound(dt: number, agent: EnemyAiAgentRuntime, playerDistM: number,
  jukeHalfWidthM = HALL_ARENA_NAV_SPEC.jukeHalfWidthM
): number {
  agent.closeQuartersJuke ??= createCloseQuartersJukeState(
    agent.coverAnchorWorld.x * 1.7 + agent.coverAnchorWorld.z + agent.tracerSeedCounter,
    agent.peekSign
  );
  const offset = stepCloseQuartersJuke(agent.closeQuartersJuke, {
    dt,
    playerDistanceM: playerDistM,
    aimThreat: agent.aimThreat ?? 0,
    wasHit: agent.jukeBreakPending === true,
    planted: (agent.footwork?.plantedS ?? 0) > 0,
    midBurst: agent.burstShotsRemaining > 0,
    lateralStalled: agent.lateralStalled === true,
    anchorX: agent.coverAnchorWorld.x,
    arenaHalfWidthM: jukeHalfWidthM,
  });
  agent.jukeBreakPending = false;
  return offset;
}
