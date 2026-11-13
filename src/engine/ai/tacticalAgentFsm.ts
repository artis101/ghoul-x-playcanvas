import type { TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import type { AlertedEngagementSubstate } from '../../core/ai/tacticalDoctrine.ts';
import {
  cancelActiveBurst,
  tickAlertReactionHold,
  tickNeurogenicShockRecovery,
} from '../../core/ai/weaponBurstFsm.ts';
import { add, dot, normalize, sub, vec3 } from '../../core/ballistics/vec3.ts';
import { updateStandingCombatPose } from '../../core/ghoul/anatomy.ts';
import { computeCombatantTriageStatus } from '../../core/ballistics/solver.ts';
import type { EnemyAiAgentRuntime, EnemyTacticalAiState } from './tacticalAiTypes.ts';
import { approachAngleRad, yawToward } from './combatantArmEvaluation.ts';
import { syncAgentArmamentAndSidearm } from './agentArmamentController.ts';
import { moveHorizontalClamped } from './tacticalLocomotion.ts';
import { stepAgentWoundedSequence } from './woundedSequenceDriver.ts';
import { crawlAwayFromPlayer, stepWoundedPhaseBehaviour } from './woundedPhaseBehaviour.ts';
import { stepAgentMagazine } from './enemyWeaponMagazine.ts';
import { stepWeaponBurstFire } from './tacticalBurstAndTracers.ts';
import { stepAlertedEngagingState } from './alertedEngagementStep.ts';
import type { TacticalFsmContext } from './tacticalFsmContext.ts';
import { isWoundClipHoldingBody } from './woundClipHold.ts';

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

  // The wounded sequence picks this tick's phase first, so the draw and fire gates below see it.
  stepAgentWoundedSequence(dt, hs, agent, playerEyeWorldPos, ctx.isSightBlocked);
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

  // While a fall, loss or collapse clip plays, the reaction's posture stands and the body stays put.
  const clipHolds = isWoundClipHoldingBody(hs);
  const inWoundedPhase = (hs.woundedPhase ?? 'NONE') !== 'NONE';
  const legCrippled = !hs.rightLegFunctional || !hs.leftLegFunctional;
  if (legCrippled && agent.state !== 'DOWNED_CRAWLING') {
    if (agent.state === 'PATROL_GUARD') agent.adrenaline = Math.max(agent.adrenaline, 0.85);
    if (!hs.isRagdollActive && !clipHolds && !inWoundedPhase) hs.posture = 'LEG_BUCKLED';
    ctx.transitionState(agent, 'DOWNED_CRAWLING');
  }

  const aimProfile = ctx.computeAimProfile(hs, agent);
  agent.lastSpreadMultiplier = aimProfile.spreadMultiplier;
  agent.lastAimAccuracyMultiplier = aimProfile.aimAccuracyMultiplier;
  agent.clutchingWound = aimProfile.clutchingWound;
  // A kneeling, sitting or crawling phase keeps the posture its clip set; only the clutch shows here.
  if (aimProfile.clutchingWound && !hs.isRagdollActive && !clipHolds && (!inWoundedPhase || hs.woundedPhase === 'CLUTCH')) {
    hs.posture = 'DISARMED';
  }

  if (clipHolds) {
    // No shots, steps, crawling or turning until the clip has played out.
    cancelActiveBurst(agent);
    updateStandingCombatPose(hs, ctx.elapsedClockS);
    return;
  }

  // An arm lost or the body downed: the wounded phase runs it instead of the tactical doctrine.
  // A hit still staggers it; the stagger wears off here so it can shoot again when allowed.
  if (inWoundedPhase && agent.state === 'SUPPRESSED_STAGGERED') {
    if (agent.staggerTimerS > 0) agent.staggerTimerS = Math.max(0, agent.staggerTimerS - dt);
    endStaggerWhenSettled(hs, agent, legCrippled, true, ctx);
  }
  if (stepWoundedPhaseBehaviour(dt, hs, agent, aimProfile, playerEyeWorldPos, ctx)) {
    if (!hs.isRagdollActive) updateStandingCombatPose(hs, ctx.elapsedClockS);
    return;
  }

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

      endStaggerWhenSettled(hs, agent, legCrippled, aimProfile.clutchingWound, ctx);
      break;
    }

    case 'ALERTED_ENGAGING':
      stepAlertedEngagingState(dt, hs, agent, aimProfile, playerEyeWorldPos, turnTowardPlayer, ctx);
      break;

    case 'DOWNED_CRAWLING': {
      if (!hs.isRagdollActive) hs.posture = aimProfile.clutchingWound ? 'DISARMED' : 'LEG_BUCKLED';
      // Down is down. A combatant that can still fight stays where it fell and never turns to
      // track: it only shoots at a player straight in front of it (the shot gate checks that).
      // One that cannot drags itself away from the player, head first, never sideways.
      if (aimProfile.canReturnFire) {
        stepWeaponBurstFire(dt, hs, agent, aimProfile, playerEyeWorldPos, ctx.burstCtx);
      } else {
        cancelActiveBurst(agent);
        crawlAwayFromPlayer(dt, hs, agent, playerEyeWorldPos, ctx);
      }
      break;
    }
  }

  if (!hs.isRagdollActive && hs.alive && hs.currentHp > 0 && (agent.state as EnemyTacticalAiState) !== 'DEAD') {
    updateStandingCombatPose(hs, ctx.elapsedClockS);
  }
}

/** Once the stagger and the nerve shock have passed, the agent goes back to fighting (or crawling). */
function endStaggerWhenSettled(
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  legCrippled: boolean,
  clutchingWound: boolean,
  ctx: TacticalFsmContext
): void {
  if (agent.staggerTimerS > 0 || agent.neurogenicShockTimerS > 0) return;
  if (legCrippled) {
    ctx.transitionState(agent, 'DOWNED_CRAWLING');
    return;
  }
  if (!hs.isRagdollActive && !clutchingWound) hs.posture = 'COMBAT_READY';
  ctx.transitionState(agent, 'ALERTED_ENGAGING');
}
