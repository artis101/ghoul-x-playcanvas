import type { TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import type { AlertedEngagementSubstate } from '../../core/ai/tacticalDoctrine.ts';
import {
  cancelActiveBurst,
  tickAlertReactionHold,
  tickNeurogenicShockRecovery,
} from '../../core/ai/weaponBurstFsm.ts';
import { add, dot, normalize, sub, vec3 } from '../../core/ballistics/vec3.ts';
import { updateStandingCombatPose } from '../../core/ghoul/anatomy.ts';
import { evaluateCrawlCondition } from '../../core/ghoul/anatomy/crawlCondition.ts';
import { computeCombatantTriageStatus } from '../../core/ballistics/solver.ts';
import type { EnemyAiAgentRuntime, EnemyTacticalAiState } from './tacticalAiTypes.ts';
import { approachAngleRad, yawToward } from './combatantArmEvaluation.ts';
import { syncAgentArmamentAndSidearm } from './agentArmamentController.ts';
import { moveHorizontalClamped } from './tacticalLocomotion.ts';
import { stepAgentMagazine } from './enemyWeaponMagazine.ts';
import { stepWeaponBurstFire } from './tacticalBurstAndTracers.ts';
import { stepAlertedEngagingState } from './alertedEngagementStep.ts';
import { DOWNED_TURN_RATE_RAD_S, type TacticalFsmContext } from './tacticalFsmContext.ts';

// Ground speed of an unhurt crawl.
const CRAWL_SPEED_MPS = 0.35;
const CRAWL_ARRIVAL_RADIUS_M = 0.3;

export type { AlertedEngagementSubstate, TacticalFsmContext };

export function stepSingleEnemyAgent(
  dt: number,
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  playerEyeWorldPos: Vec3Like,
  ctx: TacticalFsmContext
): void {
  agent.triageStatus = computeCombatantTriageStatus(hs);

  if (!hs.alive || hs.currentHp <= 0 || agent.state === 'DEAD') {
    cancelActiveBurst(agent);
    agent.fireMode = 'CINEMATIC_SUPPRESSION';
    syncAgentArmamentAndSidearm(dt, hs, agent, () => {});
    if (agent.state !== 'DEAD') ctx.transitionState(agent, 'DEAD');
    return;
  }

  agent.lastAimTargetWorld = { x: playerEyeWorldPos.x, y: playerEyeWorldPos.y - 0.16, z: playerEyeWorldPos.z };

  if (hs.currentHp < agent.lastObservedHp - 0.5) {
    const lostHp = agent.lastObservedHp - hs.currentHp;
    ctx.notifyEnemyHit(hs, {
      isTorsoHit: hs.zoneIntegrity.TORSO_UPPER_THORAX < 99 || hs.zoneIntegrity.TORSO_LOWER_ABDOMEN < 99,
      energyDepositedJ: lostHp * 14,
    });
    if (!hs.alive) return;
  }
  agent.lastObservedHp = hs.currentHp;

  syncAgentArmamentAndSidearm(
    dt,
    hs,
    agent,
    () => {
      if (agent.state === 'PATROL_GUARD') ctx.transitionState(agent, 'ALERTED_ENGAGING');
    },
    () => ctx.onAgentSidearmDrawStart?.(hs, agent)
  );
  stepAgentMagazine(dt, hs, agent, ctx);

  tickNeurogenicShockRecovery(dt, agent, hs);
  agent.suppression = Math.max(0, agent.suppression - 0.28 * dt);
  if ((agent.moraleShockTimerS ?? 0) > 0) {
    agent.moraleShockTimerS = Math.max(0, agent.moraleShockTimerS! - dt);
  }
  if ((agent.berserkerFrenzyTimerS ?? 0) > 0) {
    agent.berserkerFrenzyTimerS = Math.max(0, agent.berserkerFrenzyTimerS! - dt);
  }

  if (agent.state !== 'PATROL_GUARD') {
    tickAlertReactionHold(agent, dt);
    if (
      agent.resolveProfile === 'FANATIC_BERSERKER' &&
      (hs.currentHp < hs.maxHp * 0.95 || hs.painShock > 0.15 || (agent.berserkerFrenzyTimerS ?? 0) > 0)
    ) {
      agent.adrenaline = 1.0;
    } else {
      const floorAdrenaline = agent.resolveProfile === 'HARDENED_VETERAN' ? 0.65 : 0.42;
      agent.adrenaline = Math.max(floorAdrenaline, agent.adrenaline - 0.015 * dt);
    }
  }

  const legCrippled = !hs.rightLegFunctional || !hs.leftLegFunctional;
  if (legCrippled && agent.state !== 'DOWNED_CRAWLING') {
    if (agent.state === 'PATROL_GUARD') agent.adrenaline = Math.max(agent.adrenaline, 0.85);
    if (!hs.isRagdollActive) hs.posture = 'LEG_BUCKLED';
    ctx.transitionState(agent, 'DOWNED_CRAWLING');
  }

  const aimProfile = ctx.computeAimProfile(hs, agent);
  agent.lastSpreadMultiplier = aimProfile.spreadMultiplier;
  agent.lastAimAccuracyMultiplier = aimProfile.aimAccuracyMultiplier;
  agent.clutchingWound = aimProfile.clutchingWound;
  if (aimProfile.clutchingWound && !hs.isRagdollActive) hs.posture = 'DISARMED';

  const turnTowardPlayer = (turnSpeed: number) => {
    if (!hs.alive || hs.currentHp <= 0 || hs.isRagdollActive || agent.state === 'DEAD') return;
    const desiredYaw = yawToward(hs.worldPosition, playerEyeWorldPos, hs.yawRad);
    hs.yawRad = approachAngleRad(hs.yawRad, desiredYaw, turnSpeed * dt);
  };

  switch (agent.state) {
    case 'PATROL_GUARD': {
      agent.peekCycleTimerS += dt;
      const scanOffset = Math.sin(agent.peekCycleTimerS * 0.9) * 0.22;
      hs.yawRad = approachAngleRad(hs.yawRad, agent.guardBaseYawRad + scanOffset, 1.4 * dt);

      const toPlayer = sub(playerEyeWorldPos, hs.worldPosition);
      const horizDist = Math.hypot(toPlayer.x, toPlayer.z);
      const guardFwd = { x: Math.sin(hs.yawRad), y: 0, z: Math.cos(hs.yawRad) };
      const dirToPlayer = horizDist > 1e-3 ? normalize({ x: toPlayer.x, y: 0, z: toPlayer.z }) : guardFwd;
      const cosAngle = dot(guardFwd, dirToPlayer);
      const enemyEyePos = add(hs.worldPosition, vec3(0, 1.55, 0));

      if (
        ((horizDist <= ctx.sightDetectionRangeM && cosAngle >= 0.38) || horizDist <= 6.5) &&
        !ctx.isSightBlocked(enemyEyePos, playerEyeWorldPos)
      ) {
        agent.adrenaline = Math.max(
          agent.adrenaline,
          agent.resolveProfile === 'FANATIC_BERSERKER' ? 0.98 : 0.88
        );
        ctx.transitionState(agent, 'ALERTED_ENGAGING');
      }
      break;
    }

    case 'SUPPRESSED_STAGGERED': {
      if (agent.staggerTimerS > 0) agent.staggerTimerS = Math.max(0, agent.staggerTimerS - dt);
      if (hs.combatantStatusTag === null && (agent.moraleShockTimerS ?? 0) > 0) {
        hs.combatantStatusTag = 'PANIC_SHAKEN';
      }
      if (agent.resolveProfile !== 'FANATIC_BERSERKER') {
        moveHorizontalClamped(hs, agent.coverAnchorWorld.x, agent.coverAnchorWorld.z, 0.75 * dt, ctx.rapierWorld);
      }
      turnTowardPlayer(2.8);

      if (agent.staggerTimerS <= 0 && agent.neurogenicShockTimerS <= 0) {
        if (legCrippled) {
          ctx.transitionState(agent, 'DOWNED_CRAWLING');
        } else {
          if (!hs.isRagdollActive && !aimProfile.clutchingWound) hs.posture = 'COMBAT_READY';
          ctx.transitionState(agent, 'ALERTED_ENGAGING');
        }
      }
      break;
    }

    case 'ALERTED_ENGAGING':
      stepAlertedEngagingState(dt, hs, agent, aimProfile, playerEyeWorldPos, turnTowardPlayer, ctx);
      break;

    case 'DOWNED_CRAWLING': {
      if (!hs.isRagdollActive) hs.posture = aimProfile.clutchingWound ? 'DISARMED' : 'LEG_BUCKLED';
      // Down is down. A combatant that can still fight stays where it fell and shoots from
      // there. One that cannot drags itself toward cover, head first, never sideways.
      if (aimProfile.canReturnFire) {
        turnTowardPlayer(DOWNED_TURN_RATE_RAD_S);
        stepWeaponBurstFire(dt, hs, agent, aimProfile, playerEyeWorldPos, ctx.burstCtx);
      } else if (!hs.isRagdollActive && (hs.rightArmFunctional || hs.leftArmFunctional)) {
        const crawlGoal = { x: agent.coverAnchorWorld.x, y: hs.worldPosition.y, z: agent.coverAnchorWorld.z - 0.25 };
        const { effort } = evaluateCrawlCondition(hs, ctx.elapsedClockS);
        const goalDistM = Math.hypot(crawlGoal.x - hs.worldPosition.x, crawlGoal.z - hs.worldPosition.z);
        if (goalDistM > CRAWL_ARRIVAL_RADIUS_M) {
          const crawlYaw = yawToward(hs.worldPosition, crawlGoal, hs.yawRad);
          hs.yawRad = approachAngleRad(hs.yawRad, crawlYaw, DOWNED_TURN_RATE_RAD_S * dt);
          // It only pulls itself along once it is pointing the way it wants to go.
          const facing = Math.cos(crawlYaw - hs.yawRad);
          if (facing > 0.8) {
            moveHorizontalClamped(hs, crawlGoal.x, crawlGoal.z, CRAWL_SPEED_MPS * effort * dt, ctx.rapierWorld);
          }
        }
      }
      break;
    }
  }

  if (!hs.isRagdollActive && hs.alive && hs.currentHp > 0 && (agent.state as EnemyTacticalAiState) !== 'DEAD') {
    updateStandingCombatPose(hs, ctx.elapsedClockS);
  }
}
