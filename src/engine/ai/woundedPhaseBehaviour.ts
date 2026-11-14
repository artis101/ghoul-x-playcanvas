import type { TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import { cancelActiveBurst } from '../../core/ai/weaponBurstFsm.ts';
import { evaluateCrawlCondition } from '../../core/ghoul/anatomy/crawlCondition.ts';
import { SIT_TO_CRAWL_S } from '../../core/ballistics/trauma/woundReactionTimings.ts';
import type { EnemyAimProfile, EnemyAiAgentRuntime } from './tacticalAiTypes.ts';
import { approachAngleRad, yawToward } from './combatantArmEvaluation.ts';
import { moveHorizontalClamped } from './tacticalLocomotion.ts';
import { stepWeaponBurstFire } from './tacticalBurstAndTracers.ts';
import { DOWNED_TURN_RATE_RAD_S, type TacticalFsmContext } from './tacticalFsmContext.ts';
import { currentWoundedPhase } from './woundedSequenceDriver.ts';

/**
 * How the body moves in each wounded-sequence phase (docs/wound-movement.md). One thing at a
 * time: clutching, kneeling down, sitting down, lying in agony and lying face down hold still and
 * never shoot; BLAZE walks at the player gunning one-handed; KNEEL_FIRE shuffles round on its
 * knees; a downed shooter never turns to track; a crawler drags itself away and never fires.
 */

/** A blazing combatant walks, it does not run: it is bleeding out on its feet. */
export const BLAZE_WALK_SPEED_MPS = 1.1;
/** It stops this close so it does not walk into the player. */
const BLAZE_STAND_OFF_M = 1.6;
/** On its feet it turns to keep the player in front of the pistol. */
const BLAZE_TURN_RATE_RAD_S = 3.0;
/** On its knees it shuffles round slowly. */
export const KNEEL_TURN_RATE_RAD_S = 0.9;
/** Ground speed of an unhurt crawl. */
export const CRAWL_SPEED_MPS = 0.35;
const CRAWL_ARRIVAL_RADIUS_M = 0.3;
/** Without cover behind it, a crawler heads this far straight away from the player. */
const CRAWL_AWAY_REACH_M = 3.0;
/** Cover only counts as a refuge when it lies roughly away from the player. */
const COVER_AWAY_MIN_DOT = 0.5;

/**
 * Runs the current wounded phase. Returns false in NONE (normal fighting goes on), true when the
 * phase has taken the body this tick.
 */
export function stepWoundedPhaseBehaviour(
  dt: number,
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  aimProfile: EnemyAimProfile,
  playerEye: Vec3Like,
  ctx: TacticalFsmContext
): boolean {
  const phase = currentWoundedPhase(hs);
  if (phase === 'NONE') return false;
  agent.moveSpeedMs = 0;
  agent.isPeekingOut = false;

  switch (phase) {
    case 'BLAZE':
      stepBlaze(dt, hs, agent, aimProfile, playerEye, ctx);
      break;
    case 'KNEEL_FIRE':
      if (!hs.isRagdollActive) {
        const wanted = yawToward(hs.worldPosition, playerEye, hs.yawRad);
        hs.yawRad = approachAngleRad(hs.yawRad, wanted, KNEEL_TURN_RATE_RAD_S * dt);
      }
      fireIfAble(dt, hs, agent, aimProfile, playerEye, ctx);
      break;
    case 'DOWNED_ENGAGE':
      // It never turns toward the player: it only shoots while the player stays in front of it.
      fireIfAble(dt, hs, agent, aimProfile, playerEye, ctx);
      break;
    case 'DOWNED_CRAWL':
      cancelActiveBurst(agent);
      // While the sit-to-crawl clip rolls it over, it does not go anywhere yet.
      if ((hs.woundedPhaseTimerS ?? 0) >= SIT_TO_CRAWL_S) crawlAwayFromPlayer(dt, hs, agent, playerEye, ctx);
      break;
    default:
      // CLUTCH, KNEEL_DOWN, SIT_DOWN, DOWNED_AGONY, FACE_DOWN: no steps, no turning, no shots.
      cancelActiveBurst(agent);
      break;
  }
  return true;
}

function fireIfAble(
  dt: number,
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  aimProfile: EnemyAimProfile,
  playerEye: Vec3Like,
  ctx: TacticalFsmContext
): void {
  if (aimProfile.canReturnFire) stepWeaponBurstFire(dt, hs, agent, aimProfile, playerEye, ctx.burstCtx);
  else cancelActiveBurst(agent);
}

/** On its feet, one-handed, walking at the player and firing until it drops. */
function stepBlaze(
  dt: number,
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  aimProfile: EnemyAimProfile,
  playerEye: Vec3Like,
  ctx: TacticalFsmContext
): void {
  if (hs.isRagdollActive) return;
  const wanted = yawToward(hs.worldPosition, playerEye, hs.yawRad);
  hs.yawRad = approachAngleRad(hs.yawRad, wanted, BLAZE_TURN_RATE_RAD_S * dt);
  if (!aimProfile.usingBackupSidearm) {
    // The pistol is still coming out: it draws standing where it is, then sets off.
    cancelActiveBurst(agent);
    return;
  }
  hs.posture = 'COMBAT_READY';
  hs.combatantStatusTag = 'RUSHING';
  const dist = Math.hypot(playerEye.x - hs.worldPosition.x, playerEye.z - hs.worldPosition.z);
  if (dist > BLAZE_STAND_OFF_M) {
    const before = { x: hs.worldPosition.x, z: hs.worldPosition.z };
    moveHorizontalClamped(hs, playerEye.x, playerEye.z, BLAZE_WALK_SPEED_MPS * dt, ctx.rapierWorld, ctx.arenaNav);
    const moved = Math.hypot(hs.worldPosition.x - before.x, hs.worldPosition.z - before.z);
    agent.moveSpeedMs = dt > 0 ? moved / dt : 0;
  }
  // It fires on the move: there is no settling in a blaze of glory.
  if (aimProfile.canReturnFire) stepWeaponBurstFire(dt, hs, agent, aimProfile, playerEye, ctx.burstCtx, false);
}

/**
 * Where a crawler heads: its cover when that lies away from the player, else straight away from
 * the player. The goal moves on with the body, so it keeps going until the arena wall stops it.
 */
export function crawlAwayGoal(hs: TargetHealthState, agent: EnemyAiAgentRuntime, playerEye: Vec3Like): Vec3Like {
  const pos = hs.worldPosition;
  let awayX = pos.x - playerEye.x;
  let awayZ = pos.z - playerEye.z;
  const awayLen = Math.hypot(awayX, awayZ);
  if (awayLen < 1e-3) {
    awayX = -Math.sin(hs.yawRad);
    awayZ = -Math.cos(hs.yawRad);
  } else {
    awayX /= awayLen;
    awayZ /= awayLen;
  }
  const cover = agent.coverAnchorWorld;
  const toCoverX = cover.x - pos.x;
  const toCoverZ = cover.z - pos.z;
  const coverDist = Math.hypot(toCoverX, toCoverZ);
  if (coverDist > CRAWL_ARRIVAL_RADIUS_M) {
    const coverAway = (toCoverX * awayX + toCoverZ * awayZ) / coverDist;
    const coverFromPlayer = Math.hypot(cover.x - playerEye.x, cover.z - playerEye.z);
    if (coverAway >= COVER_AWAY_MIN_DOT && coverFromPlayer > awayLen) return { x: cover.x, y: pos.y, z: cover.z };
  }
  return { x: pos.x + awayX * CRAWL_AWAY_REACH_M, y: pos.y, z: pos.z + awayZ * CRAWL_AWAY_REACH_M };
}

/**
 * Drags itself head first away from the player, never sideways: it turns to face the way it is
 * going (its back to the player) and only pulls once it points that way.
 */
export function crawlAwayFromPlayer(
  dt: number,
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  playerEye: Vec3Like,
  ctx: TacticalFsmContext
): void {
  if (hs.isRagdollActive || !(hs.rightArmFunctional || hs.leftArmFunctional)) return;
  const goal = crawlAwayGoal(hs, agent, playerEye);
  const goalDistM = Math.hypot(goal.x - hs.worldPosition.x, goal.z - hs.worldPosition.z);
  if (goalDistM <= CRAWL_ARRIVAL_RADIUS_M) return;
  const crawlYaw = yawToward(hs.worldPosition, goal, hs.yawRad);
  hs.yawRad = approachAngleRad(hs.yawRad, crawlYaw, DOWNED_TURN_RATE_RAD_S * dt);
  if (Math.cos(crawlYaw - hs.yawRad) > 0.8) {
    const { effort } = evaluateCrawlCondition(hs, ctx.elapsedClockS);
    moveHorizontalClamped(hs, goal.x, goal.z, CRAWL_SPEED_MPS * effort * dt, ctx.rapierWorld, ctx.arenaNav);
  }
}
