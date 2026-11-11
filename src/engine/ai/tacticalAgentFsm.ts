import type { CombatantPostureState, TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import { add, dot, normalize, sub, vec3 } from '../../core/ballistics/vec3.ts';
import { updateStandingCombatPose } from '../../core/ghoul/anatomy.ts';
import { computeCombatantTriageStatus } from '../../core/ballistics/solver.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import type {
  EnemyAimProfile,
  EnemyAiAgentRuntime,
  EnemyHitNotification,
  EnemyTacticalAiState,
} from './tacticalAiTypes.ts';
import { ARCHETYPE_TUNING } from './archetypeTuning.ts';
import { approachAngleRad, yawToward } from './combatantArmEvaluation.ts';
import { syncAgentArmamentAndSidearm } from './agentArmamentController.ts';
import { computeAlertedPeekTarget, type PeekPlanCacheEntry } from './tacticalCoverFinder.ts';
import { moveHorizontalClamped } from './tacticalLocomotion.ts';
import { type BurstContext, stepWeaponBurstFire } from './tacticalBurstAndTracers.ts';

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
  onAgentCoverRetreat?: (hs: TargetHealthState, agent: EnemyAiAgentRuntime) => void;
}

export function stepSingleEnemyAgent(
  dt: number,
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  playerEyeWorldPos: Vec3Like,
  ctx: TacticalFsmContext
): void {
  agent.triageStatus = computeCombatantTriageStatus(hs);

  // 1. Check death / exsanguination first — guarantee 100% zero motion for dead enemies
  if (!hs.alive || hs.currentHp <= 0 || agent.state === 'DEAD') {
    agent.burstShotsRemaining = 0;
    agent.fireMode = 'CINEMATIC_SUPPRESSION';
    syncAgentArmamentAndSidearm(dt, hs, agent, () => {});
    if (agent.state !== 'DEAD') {
      ctx.transitionState(agent, 'DEAD');
    }
    return;
  }

  agent.lastAimTargetWorld = {
    x: playerEyeWorldPos.x,
    y: playerEyeWorldPos.y - 0.16,
    z: playerEyeWorldPos.z,
  };

  // Auto-detect unnotified HP drops
  if (hs.currentHp < agent.lastObservedHp - 0.5) {
    const lostHp = agent.lastObservedHp - hs.currentHp;
    ctx.notifyEnemyHit(hs, {
      isTorsoHit:
        hs.zoneIntegrity.TORSO_UPPER_THORAX < 99 ||
        hs.zoneIntegrity.TORSO_LOWER_ABDOMEN < 99,
      energyDepositedJ: lostHp * 14,
    });
    if (!hs.alive) return;
  }
  agent.lastObservedHp = hs.currentHp;

  // Step dismemberment / sidearm draw state
  const wasSidearmDrawing = agent.sidearmDrawing;
  syncAgentArmamentAndSidearm(dt, hs, agent, () => {
    if (agent.state === 'PATROL_GUARD') {
      agent.adrenaline = Math.max(agent.adrenaline, 0.92);
      ctx.transitionState(agent, 'ALERTED_ENGAGING');
    }
  });
  if (!wasSidearmDrawing && agent.sidearmDrawing) {
    ctx.onAgentSidearmDrawStart?.(hs, agent);
  }

  // Decay suppression & maintain resolve-specific adrenaline
  agent.suppression = Math.max(0, agent.suppression - 0.28 * dt);
  if (agent.state !== 'PATROL_GUARD') {
    if ((agent.alertReactionTimerS ?? 0) > 0) {
      agent.alertReactionTimerS = Math.max(0, (agent.alertReactionTimerS ?? 0) - dt);
    }
    if (
      agent.resolveProfile === 'FANATIC_BERSERKER' &&
      (hs.currentHp < hs.maxHp * 0.95 || hs.painShock > 0.15)
    ) {
      agent.adrenaline = 1.0;
    } else {
      const floorAdrenaline = agent.resolveProfile === 'HARDENED_VETERAN' ? 0.65 : 0.42;
      agent.adrenaline = Math.max(floorAdrenaline, agent.adrenaline - 0.015 * dt);
    }
  }

  // 2. Enforce leg-crippled collapse -> DOWNED_CRAWLING
  const legCrippled = !hs.leftLegFunctional || !hs.rightLegFunctional;
  if (legCrippled && agent.state !== 'DOWNED_CRAWLING') {
    if (agent.state === 'PATROL_GUARD') {
      agent.adrenaline = Math.max(agent.adrenaline, 0.85);
    }
    if (!hs.isRagdollActive) {
      hs.posture = 'LEG_BUCKLED';
    }
    ctx.transitionState(agent, 'DOWNED_CRAWLING');
  }

  // 3. Evaluate aim & trauma state
  const aimProfile = ctx.computeAimProfile(hs, agent);
  agent.lastSpreadMultiplier = aimProfile.spreadMultiplier;
  agent.lastAimAccuracyMultiplier = aimProfile.aimAccuracyMultiplier;
  agent.clutchingWound = aimProfile.clutchingWound;

  if (aimProfile.clutchingWound && !hs.isRagdollActive) {
    hs.posture = 'DISARMED';
  }

  const turnTowardPlayer = (turnSpeed: number) => {
    if (!hs.alive || hs.currentHp <= 0 || hs.isRagdollActive || agent.state === 'DEAD') return;
    const desiredYaw = yawToward(hs.worldPosition, playerEyeWorldPos, hs.yawRad);
    hs.yawRad = approachAngleRad(hs.yawRad, desiredYaw, turnSpeed * dt);
  };

  // 4. State-specific movement, posture & combat logic
  switch (agent.state) {
    case 'PATROL_GUARD': {
      agent.peekCycleTimerS += dt;
      const scanOffset = Math.sin(agent.peekCycleTimerS * 0.9) * 0.22;
      hs.yawRad = approachAngleRad(
        hs.yawRad,
        agent.guardBaseYawRad + scanOffset,
        1.4 * dt
      );

      const toPlayer = sub(playerEyeWorldPos, hs.worldPosition);
      const horizDist = Math.hypot(toPlayer.x, toPlayer.z);
      const guardFwd = { x: Math.sin(hs.yawRad), y: 0, z: Math.cos(hs.yawRad) };
      const dirToPlayer =
        horizDist > 1e-3
          ? normalize({ x: toPlayer.x, y: 0, z: toPlayer.z })
          : guardFwd;
      const cosAngle = dot(guardFwd, dirToPlayer);
      const enemyEyePos = add(hs.worldPosition, vec3(0, 1.55, 0));

      const inDetectionEnvelope =
        (horizDist <= ctx.sightDetectionRangeM && cosAngle >= 0.38) ||
        horizDist <= 6.5;

      if (inDetectionEnvelope && !ctx.isSightBlocked(enemyEyePos, playerEyeWorldPos)) {
        agent.adrenaline = Math.max(
          agent.adrenaline,
          agent.resolveProfile === 'FANATIC_BERSERKER' ? 0.98 : 0.88
        );
        ctx.transitionState(agent, 'ALERTED_ENGAGING');
      }
      break;
    }

    case 'SUPPRESSED_STAGGERED': {
      if (agent.neurogenicShockTimerS > 0) {
        agent.neurogenicShockTimerS = Math.max(0, agent.neurogenicShockTimerS - dt);
        if (
          agent.neurogenicShockTimerS <= 0 &&
          hs.bloodVolumeMl > 2600 &&
          hs.oxygenSaturationPct >= 55
        ) {
          hs.consciousness = Math.max(
            hs.consciousness,
            agent.triageStatus === 'MORTALLY_WOUNDED' ? 0.48 : 0.78
          );
          hs.painShock = Math.min(hs.painShock, 0.52);
          agent.adrenaline = Math.max(agent.adrenaline, 0.88);
        }
      }
      if (agent.staggerTimerS > 0) {
        agent.staggerTimerS = Math.max(0, agent.staggerTimerS - dt);
      }

      if (agent.resolveProfile !== 'FANATIC_BERSERKER') {
        moveHorizontalClamped(
          hs,
          agent.coverAnchorWorld.x,
          agent.coverAnchorWorld.z,
          0.75 * dt,
          ctx.rapierWorld
        );
      }
      turnTowardPlayer(2.8);

      if (agent.staggerTimerS <= 0 && agent.neurogenicShockTimerS <= 0) {
        if (legCrippled) {
          ctx.transitionState(agent, 'DOWNED_CRAWLING');
        } else {
          if (!hs.isRagdollActive && !aimProfile.clutchingWound) {
            hs.posture = 'COMBAT_READY';
          }
          ctx.transitionState(agent, 'ALERTED_ENGAGING');
        }
      }
      break;
    }

    case 'ALERTED_ENGAGING': {
      const tuning = ARCHETYPE_TUNING[hs.archetype];
      const isWounded =
        hs.currentHp < hs.maxHp * 0.92 ||
        hs.painShock > 0.15 ||
        hs.rupturedOrgans.size > 0;

      const cycleRate =
        agent.resolveProfile === 'PANICKED_SCRAPPER' && isWounded ? 1.55 : 1.0;
      const previousPeekTime = agent.peekCycleTimerS;
      agent.peekCycleTimerS += dt * cycleRate;

      if (aimProfile.clutchingWound) {
        agent.isPeekingOut = false;
        agent.burstShotsRemaining = 0;
        const retreatX = agent.coverAnchorWorld.x - agent.peekSign * 0.25;
        const retreatZ = agent.coverAnchorWorld.z - 0.35;
        moveHorizontalClamped(hs, retreatX, retreatZ, 0.95 * dt, ctx.rapierWorld);
        turnTowardPlayer(1.8);
        break;
      }

      const cyclePeriodS =
        agent.resolveProfile === 'HARDENED_VETERAN'
          ? 2.85
          : agent.resolveProfile === 'PANICKED_SCRAPPER'
            ? 2.35
            : 3.1;
      const phase = (agent.peekCycleTimerS % cyclePeriodS) / cyclePeriodS;

      const prevPeekSign = agent.peekSign;
      if (agent.resolveProfile === 'FANATIC_BERSERKER' && isWounded) {
        agent.isPeekingOut = true;
        agent.berserkerAdvanceOffsetM = Math.min(
          2.6,
          agent.berserkerAdvanceOffsetM + 1.25 * dt
        );
      } else if (agent.resolveProfile === 'GRITTY_REGULAR' && agent.suppression > 0.62) {
        if (Math.floor(previousPeekTime / cyclePeriodS) !== Math.floor(agent.peekCycleTimerS / cyclePeriodS)) {
          agent.peekSign = agent.peekSign === 1 ? -1 : 1;
        }
        agent.isPeekingOut = phase >= 0.2 && phase <= 0.88;
      } else {
        agent.isPeekingOut = phase >= 0.2 && phase <= 0.88;
      }

      const peekPlan = computeAlertedPeekTarget(
        hs,
        agent,
        playerEyeWorldPos,
        ctx.elapsedClockS,
        ctx.peekPlanCache,
        ctx.isSightBlocked,
        ctx.hasCoverQueries
      );
      if (agent.peekSign !== prevPeekSign) {
        ctx.onAgentFlankShift?.(hs, agent);
      }
      const deltaOffset = peekPlan.targetOffset - agent.currentLateralOffsetM;

      const profileSpeedMul =
        agent.resolveProfile === 'PANICKED_SCRAPPER' && isWounded
          ? 1.38
          : agent.resolveProfile === 'FANATIC_BERSERKER' && isWounded
            ? 1.25
            : 1.0;
      const baseStrafeSpeed = tuning.strafeSpeedMs * profileSpeedMul;
      const effectiveStrafeSpeed =
        Math.abs(deltaOffset) > 1.0
          ? Math.max(baseStrafeSpeed, 2.35)
          : baseStrafeSpeed;
      const maxStrideStep = effectiveStrafeSpeed * dt;
      agent.currentLateralOffsetM +=
        Math.abs(deltaOffset) <= maxStrideStep
          ? deltaOffset
          : Math.sign(deltaOffset) * maxStrideStep;

      const goalX = agent.coverAnchorWorld.x + agent.currentLateralOffsetM;
      const goalZ =
        agent.resolveProfile === 'FANATIC_BERSERKER' && isWounded
          ? Math.min(playerEyeWorldPos.z - 2.4, peekPlan.goalZ + agent.berserkerAdvanceOffsetM)
          : peekPlan.goalZ;
      moveHorizontalClamped(hs, goalX, goalZ, effectiveStrafeSpeed * dt, ctx.rapierWorld);

      turnTowardPlayer(5.4);
      if (!hs.isRagdollActive) {
        if (hs.rupturedOrgans.size > 0 && hs.zoneIntegrity.TORSO_LOWER_ABDOMEN < 65) {
          hs.posture = 'GUT_HURT';
        } else {
          hs.posture = 'COMBAT_READY' as CombatantPostureState;
        }
      }

      if (!agent.isPeekingOut && peekPlan.anchorBlockedByCover) {
        agent.burstShotsRemaining = 0;
      } else if (aimProfile.canReturnFire && agent.isPeekingOut) {
        stepWeaponBurstFire(dt, hs, agent, aimProfile, playerEyeWorldPos, ctx.burstCtx);
      }
      break;
    }

    case 'DOWNED_CRAWLING': {
      if (!hs.isRagdollActive) {
        hs.posture = aimProfile.clutchingWound ? 'DISARMED' : 'LEG_BUCKLED';
      }

      if (!hs.isRagdollActive && (hs.leftArmFunctional || hs.rightArmFunctional)) {
        const crawlTargetX = agent.coverAnchorWorld.x + agent.peekSign * 0.35;
        const crawlTargetZ =
          agent.resolveProfile === 'FANATIC_BERSERKER'
            ? Math.min(playerEyeWorldPos.z - 2.6, hs.worldPosition.z + 0.8)
            : agent.coverAnchorWorld.z - 0.25;
        moveHorizontalClamped(hs, crawlTargetX, crawlTargetZ, 0.35 * dt, ctx.rapierWorld);
      }

      turnTowardPlayer(2.8);

      if (aimProfile.canReturnFire) {
        stepWeaponBurstFire(dt, hs, agent, aimProfile, playerEyeWorldPos, ctx.burstCtx);
      }
      break;
    }
  }

  if (!hs.isRagdollActive && hs.alive && hs.currentHp > 0 && (agent.state as EnemyTacticalAiState) !== 'DEAD') {
    updateStandingCombatPose(hs, ctx.elapsedClockS);
  }
}
