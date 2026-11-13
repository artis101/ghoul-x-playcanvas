import type { CombatantPostureState, TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import {
  type AlertedEngagementSubstate,
  evaluateTacticalEngagementSubstate,
} from '../../core/ai/tacticalDoctrine.ts';
import {
  cancelActiveBurst,
  tickAlertReactionHold,
  tickNeurogenicShockRecovery,
} from '../../core/ai/weaponBurstFsm.ts';
import { add, dot, normalize, sub, vec3 } from '../../core/ballistics/vec3.ts';
import { updateStandingCombatPose } from '../../core/ghoul/anatomy.ts';
import { evaluateCrawlCondition } from '../../core/ghoul/anatomy/crawlCondition.ts';
import { computeCombatantTriageStatus } from '../../core/ballistics/solver.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import type {
  EnemyAimProfile, EnemyAiAgentRuntime, EnemyHitNotification, EnemyTacticalAiState,
} from './tacticalAiTypes.ts';
import { ARCHETYPE_TUNING } from './archetypeTuning.ts';
import { approachAngleRad, yawToward } from './combatantArmEvaluation.ts';
import { syncAgentArmamentAndSidearm } from './agentArmamentController.ts';
import { computeAlertedPeekTarget, type PeekPlanCacheEntry } from './tacticalCoverFinder.ts';
import { moveHorizontalClamped } from './tacticalLocomotion.ts';
import { type BurstContext, stepWeaponBurstFire } from './tacticalBurstAndTracers.ts';

// Ground speed of an unhurt crawl.
const CRAWL_SPEED_MPS = 0.35;
const CRAWL_ARRIVAL_RADIUS_M = 0.3;
// A body on the ground shuffles round slowly; it cannot pivot like one on its feet.
const DOWNED_TURN_RATE_RAD_S = 0.9;

export type { AlertedEngagementSubstate };

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
  tryRelocateCoverAnchor?: (hs: TargetHealthState, agent: EnemyAiAgentRuntime) => boolean;
}

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

function stepAlertedEngagingState(
  dt: number,
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  aimProfile: EnemyAimProfile,
  playerEyeWorldPos: Vec3Like,
  turnTowardPlayer: (speed: number) => void,
  ctx: TacticalFsmContext
): void {
  // Doubled over on its knees, a combatant holds its ground: it neither strafes nor rushes.
  const gutShot = hs.rupturedOrgans.size > 0 && hs.zoneIntegrity.TORSO_LOWER_ABDOMEN < 65;
  if (gutShot && !hs.isRagdollActive) {
    hs.posture = 'GUT_HURT';
    agent.isPeekingOut = true;
    agent.engagementSubstate = 'COVER_PEEK';
    turnTowardPlayer(DOWNED_TURN_RATE_RAD_S);
    if (aimProfile.canReturnFire) {
      stepWeaponBurstFire(dt, hs, agent, aimProfile, playerEyeWorldPos, ctx.burstCtx);
    }
    return;
  }

  const tuning = ARCHETYPE_TUNING[hs.archetype];
  const isWounded = hs.currentHp < hs.maxHp * 0.92 || hs.painShock > 0.15 || hs.rupturedOrgans.size > 0;
  const moraleShockS = agent.moraleShockTimerS ?? 0;
  const cycleRate =
    agent.resolveProfile === 'PANICKED_SCRAPPER' && (isWounded || moraleShockS > 0) ? 1.58 : 1.0;
  const previousPeekTime = agent.peekCycleTimerS;
  agent.peekCycleTimerS += dt * cycleRate;

  const cyclePeriodS =
    hs.archetype === 'SNIPER_OPERATIVE'
      ? 3.35
      : agent.resolveProfile === 'HARDENED_VETERAN'
        ? 2.85
        : agent.resolveProfile === 'PANICKED_SCRAPPER'
          ? 2.35
          : 3.1;
  const phase = (agent.peekCycleTimerS % cyclePeriodS) / cyclePeriodS;
  const playerDistM = Math.hypot(
    playerEyeWorldPos.x - hs.worldPosition.x,
    playerEyeWorldPos.z - hs.worldPosition.z
  );

  // Sniper tactical discipline: automatically shift peek side after completing a precision shot
  const prevBurstCount = agent.lastObservedBurstCount ?? agent.completedBurstCount;
  if (hs.archetype === 'SNIPER_OPERATIVE' && agent.completedBurstCount > prevBurstCount) {
    agent.peekSign = agent.peekSign === 1 ? -1 : 1;
    ctx.onAgentFlankShift?.(hs, agent);
  }
  agent.lastObservedBurstCount = agent.completedBurstCount;

  // Probe cover blockage first so rush/juggernaut maneuvers respect solid opaque barriers
  const prelimPeek = computeAlertedPeekTarget(
    hs,
    agent,
    playerEyeWorldPos,
    ctx.elapsedClockS,
    ctx.peekPlanCache,
    ctx.isSightBlocked,
    ctx.hasCoverQueries
  );

  const substate = evaluateTacticalEngagementSubstate({
    archetype: hs.archetype,
    resolveProfile: agent.resolveProfile,
    clutchingWound: aimProfile.clutchingWound,
    isWounded,
    cyclePhase01: phase,
    playerDistanceM: playerDistM,
    hasChestArmor: hs.hasChestArmor,
    chestArmorIntegrity: hs.chestArmorIntegrity,
    primaryWeaponIntact: !aimProfile.usingBackupSidearm && !aimProfile.sidearmDrawing && !hs.weaponDropped,
    suppression: agent.suppression,
    moraleShockTimerS: moraleShockS,
    berserkerFrenzyTimerS: agent.berserkerFrenzyTimerS ?? 0,
    anchorBlockedByCover: prelimPeek.anchorBlockedByCover,
  });
  agent.engagementSubstate = substate;

  if (hs.combatantStatusTag === null) {
    if (moraleShockS > 0) hs.combatantStatusTag = 'PANIC_SHAKEN';
    else if (substate === 'JUGGERNAUT_PRESS') hs.combatantStatusTag = 'JUGGERNAUT';
    else if (substate === 'BERSERKER_CHARGE' || substate === 'FLANKING_RUSH') hs.combatantStatusTag = 'RUSHING';
  }

  const prevPeekSign = agent.peekSign;
  if (substate === 'CLUTCHING_RETREAT') {
    agent.isPeekingOut = false;
    cancelActiveBurst(agent);
    moveHorizontalClamped(
      hs,
      agent.coverAnchorWorld.x - agent.peekSign * 0.25,
      agent.coverAnchorWorld.z - 0.35,
      0.95 * dt,
      ctx.rapierWorld
    );
    turnTowardPlayer(1.8);
    return;
  }

  if (substate === 'BERSERKER_CHARGE' || substate === 'FLANKING_RUSH') {
    agent.isPeekingOut = true;
    const maxAdv = substate === 'FLANKING_RUSH' ? 3.4 : 2.9;
    agent.berserkerAdvanceOffsetM = Math.min(maxAdv, agent.berserkerAdvanceOffsetM + 1.32 * dt);
  } else if (substate === 'JUGGERNAUT_PRESS') {
    agent.isPeekingOut = true;
    agent.berserkerAdvanceOffsetM = Math.min(3.2, agent.berserkerAdvanceOffsetM + 0.78 * dt);
  } else if (substate === 'EVASIVE_BACKPEDAL') {
    agent.isPeekingOut = true;
    agent.berserkerAdvanceOffsetM = Math.max(-2.6, agent.berserkerAdvanceOffsetM - 1.15 * dt);
  } else if (substate === 'PANIC_SCRAMBLE') {
    agent.isPeekingOut = true;
  } else {
    const completedCycle =
      Math.floor(previousPeekTime / cyclePeriodS) !== Math.floor(agent.peekCycleTimerS / cyclePeriodS);
    if (completedCycle && agent.suppression > 0.62) {
      if (
        ctx.hasCoverQueries &&
        (agent.resolveProfile === 'GRITTY_REGULAR' || agent.resolveProfile === 'HARDENED_VETERAN') &&
        ctx.tryRelocateCoverAnchor?.(hs, agent)
      ) {
        ctx.onAgentCoverRetreat?.(hs, agent);
      } else if (agent.resolveProfile === 'GRITTY_REGULAR' || agent.resolveProfile === 'HARDENED_VETERAN') {
        agent.peekSign = agent.peekSign === 1 ? -1 : 1;
      }
    }
    agent.isPeekingOut = substate === 'COVER_PEEK' || substate === 'SNIPER_SNAP_PEEK';
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
  if (agent.peekSign !== prevPeekSign) ctx.onAgentFlankShift?.(hs, agent);

  const weaveOffset =
    substate === 'FLANKING_RUSH' || substate === 'BERSERKER_CHARGE'
      ? Math.sin(agent.peekCycleTimerS * 3.8) * 0.42
      : substate === 'PANIC_SCRAMBLE'
        ? Math.sin(agent.peekCycleTimerS * 5.2) * 0.62
        : 0;
  const desiredLateral = peekPlan.targetOffset + weaveOffset;
  const deltaOffset = desiredLateral - agent.currentLateralOffsetM;

  const profileSpeedMul =
    substate === 'PANIC_SCRAMBLE' || (agent.resolveProfile === 'PANICKED_SCRAPPER' && isWounded)
      ? 1.42
      : substate === 'BERSERKER_CHARGE' || substate === 'FLANKING_RUSH'
        ? 1.28
        : substate === 'JUGGERNAUT_PRESS'
          ? 0.92
          : 1.0;
  const baseStrafeSpeed = tuning.strafeSpeedMs * profileSpeedMul;
  const effectiveStrafeSpeed = Math.abs(deltaOffset) > 1.0 ? Math.max(baseStrafeSpeed, 2.35) : baseStrafeSpeed;
  const maxStrideStep = effectiveStrafeSpeed * dt;
  agent.currentLateralOffsetM +=
    Math.abs(deltaOffset) <= maxStrideStep ? deltaOffset : Math.sign(deltaOffset) * maxStrideStep;

  const goalX = agent.coverAnchorWorld.x + agent.currentLateralOffsetM;
  let goalZ = peekPlan.goalZ;
  if (
    substate === 'BERSERKER_CHARGE' ||
    substate === 'FLANKING_RUSH' ||
    substate === 'JUGGERNAUT_PRESS'
  ) {
    const minStandOff = substate === 'JUGGERNAUT_PRESS' ? 3.2 : 2.4;
    goalZ = Math.min(playerEyeWorldPos.z - minStandOff, peekPlan.goalZ + agent.berserkerAdvanceOffsetM);
  } else if (substate === 'EVASIVE_BACKPEDAL') {
    goalZ = Math.max(-21.5, peekPlan.goalZ + agent.berserkerAdvanceOffsetM);
  } else if (substate === 'PANIC_SCRAMBLE') {
    goalZ = Math.max(-21.5, peekPlan.goalZ - 0.32);
  }

  moveHorizontalClamped(hs, goalX, goalZ, effectiveStrafeSpeed * dt, ctx.rapierWorld);

  turnTowardPlayer(substate === 'SNIPER_SNAP_PEEK' ? 6.8 : 5.4);
  if (!hs.isRagdollActive) {
    hs.posture =
      hs.rupturedOrgans.size > 0 && hs.zoneIntegrity.TORSO_LOWER_ABDOMEN < 65
        ? 'GUT_HURT'
        : ('COMBAT_READY' as CombatantPostureState);
  }

  if (!agent.isPeekingOut && peekPlan.anchorBlockedByCover) {
    cancelActiveBurst(agent);
  } else if (aimProfile.canReturnFire && agent.isPeekingOut) {
    stepWeaponBurstFire(dt, hs, agent, aimProfile, playerEyeWorldPos, ctx.burstCtx);
  }
}
