import type { CombatantPostureState, TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import type { AlertedEngagementSubstate } from '../../core/ai/tacticalDoctrine.ts';
import { evaluateTacticalEngagementSubstate } from '../../core/ai/tacticalDoctrine.ts';
import { cancelActiveBurst } from '../../core/ai/weaponBurstFsm.ts';
import { createCloseQuartersJukeState, stepCloseQuartersJuke } from '../../core/ai/closeQuartersStrafe.ts';
import { createAimDuckReflexState, stepAimDuckReflex } from '../../core/ai/aimDuckReflex.ts';
import type { EnemyAimProfile, EnemyAiAgentRuntime } from './tacticalAiTypes.ts';
import { ARCHETYPE_TUNING } from './archetypeTuning.ts';
import { computeAlertedPeekTarget } from './tacticalCoverFinder.ts';
import { moveHorizontalClamped } from './tacticalLocomotion.ts';
import { stepWeaponBurstFire } from './tacticalBurstAndTracers.ts';
import { DOWNED_TURN_RATE_RAD_S, type TacticalFsmContext } from './tacticalFsmContext.ts';
import { stepWoundFallback } from './woundFallback.ts';

// Usable half-width of the arena floor for lateral jukes, a little inside the movement clamp.
const JUKE_ARENA_HALF_WIDTH_M = 7.7;
// Smoothing rate for the engaging ground-speed estimate that drives the moving-fire penalty.
const MOVE_SPEED_SMOOTHING = 8;

/** Peeking states a combatant abandons when the duck reflex fires. */
function duckedSubstate(substate: AlertedEngagementSubstate): AlertedEngagementSubstate {
  return substate === 'COVER_PEEK' || substate === 'SNIPER_SNAP_PEEK' ? 'COVER_SHELTER' : substate;
}

export function stepAlertedEngagingState(
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

  const doctrineSubstate = evaluateTacticalEngagementSubstate({
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
  // Seeing the player's gun settle on it, a combatant in cover ducks back before it is shot.
  agent.aimDuckReflex ??= createAimDuckReflexState();
  const ducking = stepAimDuckReflex(agent.aimDuckReflex, {
    dt,
    aimThreat: agent.aimThreat ?? 0,
    resolveProfile: agent.resolveProfile,
    hasCoverToDuckBehind: ctx.hasCoverQueries && prelimPeek.anchorBlockedByCover,
    midBurst: agent.burstShotsRemaining > 0,
  });
  const fallingBack =
    doctrineSubstate !== 'CLUTCHING_RETREAT' && stepWoundFallback(dt, hs, agent, ctx);
  const substate = fallingBack
    ? 'COVER_SHELTER'
    : ducking ? duckedSubstate(doctrineSubstate) : doctrineSubstate;
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
        : !peekPlan.anchorBlockedByCover
          ? stepJuke(dt, agent, playerDistM)
          : 0;
  // A hit that lands while the combatant is not juking should not break a later juke.
  agent.jukeBreakPending = false;
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

  const beforeX = hs.worldPosition.x;
  const beforeZ = hs.worldPosition.z;
  moveHorizontalClamped(hs, goalX, goalZ, effectiveStrafeSpeed * dt, ctx.rapierWorld);
  trackEngagingMotion(dt, hs, agent, goalX, beforeX, beforeZ, maxStrideStep);

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

/** Advances the close-quarters juke, reacting to hits and to the player's aim. */
function stepJuke(dt: number, agent: EnemyAiAgentRuntime, playerDistM: number): number {
  agent.closeQuartersJuke ??= createCloseQuartersJukeState(
    agent.coverAnchorWorld.x * 1.7 + agent.coverAnchorWorld.z + agent.tracerSeedCounter,
    agent.peekSign
  );
  const offset = stepCloseQuartersJuke(agent.closeQuartersJuke, {
    dt,
    playerDistanceM: playerDistM,
    aimThreat: agent.aimThreat ?? 0,
    wasHit: agent.jukeBreakPending === true,
    lateralStalled: agent.lateralStalled === true,
    anchorX: agent.coverAnchorWorld.x,
    arenaHalfWidthM: JUKE_ARENA_HALF_WIDTH_M,
  });
  agent.jukeBreakPending = false;
  return offset;
}

/** Records ground speed (for the moving-fire penalty) and whether a sidestep was blocked. */
function trackEngagingMotion(
  dt: number,
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  goalX: number,
  beforeX: number,
  beforeZ: number,
  maxStrideStep: number
): void {
  if (dt <= 0) return;
  const moved = Math.hypot(hs.worldPosition.x - beforeX, hs.worldPosition.z - beforeZ);
  const prev = agent.moveSpeedMs ?? 0;
  agent.moveSpeedMs = prev + (moved / dt - prev) * (1 - Math.exp(-MOVE_SPEED_SMOOTHING * dt));
  const wantedLateral = Math.min(Math.abs(goalX - beforeX), maxStrideStep);
  agent.lateralStalled = wantedLateral > 0.01 && Math.abs(hs.worldPosition.x - beforeX) < wantedLateral * 0.2;
}
