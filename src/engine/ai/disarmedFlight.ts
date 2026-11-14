import type { TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import { approachAngleRad, yawToward } from './combatantArmEvaluation.ts';
import { moveHorizontalClamped } from './tacticalLocomotion.ts';
import type { EnemyAiAgentRuntime } from './tacticalAiTypes.ts';
import type { TacticalFsmContext } from './tacticalFsmContext.ts';

/** A disarmed fighter sprints for cover, faster than any combat footwork. */
const FLEE_RUN_SPEED_MS = 3.1;
/** How far behind its cover anchor (away from the player) it tucks itself. */
const HIDE_BEHIND_COVER_M = 0.8;
/** With no cover to look for, it simply runs this far away from the player. */
const OPEN_GROUND_FLEE_M = 6.0;
/** Close enough to the hiding place to stop running. */
const ARRIVED_M = 0.3;
/** Once hidden, how often it checks the player still cannot see it, and moves on if it can. */
const RECHECK_S = 2.5;
const EYE_HEIGHT_M = 1.55;
const RUN_TURN_RAD_S = 9.0;
const WATCH_TURN_RAD_S = 1.6;

function awayFromPlayer(from: Vec3Like, playerEye: Vec3Like): { x: number; z: number } {
  const dx = from.x - playerEye.x;
  const dz = from.z - playerEye.z;
  const len = Math.hypot(dx, dz);
  return len > 1e-3 ? { x: dx / len, z: dz / len } : { x: 0, z: -1 };
}

function pickHidePoint(
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  playerEye: Vec3Like,
  ctx: TacticalFsmContext,
): Vec3Like {
  if (ctx.hasCoverQueries) {
    if (ctx.tryRelocateCoverAnchor?.(hs, agent)) ctx.onAgentCoverRetreat?.(hs, agent);
    const anchor = agent.coverAnchorWorld;
    const away = awayFromPlayer(anchor, playerEye);
    return { x: anchor.x + away.x * HIDE_BEHIND_COVER_M, y: anchor.y, z: anchor.z + away.z * HIDE_BEHIND_COVER_M };
  }
  const away = awayFromPlayer(hs.worldPosition, playerEye);
  const p = hs.worldPosition;
  return { x: p.x + away.x * OPEN_GROUND_FLEE_M, y: p.y, z: p.z + away.z * OPEN_GROUND_FLEE_M };
}

function seenByPlayer(hs: TargetHealthState, playerEye: Vec3Like, ctx: TacticalFsmContext): boolean {
  const p = hs.worldPosition;
  return !ctx.isSightBlocked({ x: p.x, y: p.y + EYE_HEIGHT_M, z: p.z }, playerEye);
}

/**
 * A fighter with nothing to shoot with and no gun it can get back never stands about disarmed:
 * it breaks contact, runs for cover away from the player and hides there. If the player can still
 * see it once it gets there, it looks for somewhere better every `RECHECK_S`.
 */
export function stepDisarmedFlight(
  dt: number,
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  playerEye: Vec3Like,
  ctx: TacticalFsmContext,
): void {
  agent.isPeekingOut = false;
  agent.inFiringPosition = false;
  agent.fleeRecheckS = (agent.fleeRecheckS ?? 0) + dt;

  let goal = agent.fleeHidePoint;
  const distTo = (g: Vec3Like): number => Math.hypot(g.x - hs.worldPosition.x, g.z - hs.worldPosition.z);
  const arrived = goal !== undefined && distTo(goal) <= ARRIVED_M;
  if (!goal || (arrived && agent.fleeRecheckS >= RECHECK_S && seenByPlayer(hs, playerEye, ctx))) {
    goal = pickHidePoint(hs, agent, playerEye, ctx);
    // Nowhere better than where it already stands: keep running away from the player instead.
    if (distTo(goal) <= ARRIVED_M) {
      const away = awayFromPlayer(hs.worldPosition, playerEye);
      goal = { x: hs.worldPosition.x + away.x * 3, y: goal.y, z: hs.worldPosition.z + away.z * 3 };
    }
    agent.fleeHidePoint = goal;
    agent.fleeRecheckS = 0;
  }

  if (distTo(goal) > ARRIVED_M) {
    hs.yawRad = approachAngleRad(hs.yawRad, yawToward(hs.worldPosition, goal, hs.yawRad), RUN_TURN_RAD_S * dt);
    moveHorizontalClamped(hs, goal.x, goal.z, FLEE_RUN_SPEED_MS * dt, ctx.rapierWorld, ctx.arenaNav);
    return;
  }
  // Hidden: keep an eye on where the player is.
  hs.yawRad = approachAngleRad(hs.yawRad, yawToward(hs.worldPosition, playerEye, hs.yawRad), WATCH_TURN_RAD_S * dt);
}

/** Forgets the hiding place once the fighter is armed again (or picking its gun up). */
export function clearDisarmedFlight(agent: EnemyAiAgentRuntime): void {
  agent.fleeHidePoint = undefined;
  agent.fleeRecheckS = undefined;
}
