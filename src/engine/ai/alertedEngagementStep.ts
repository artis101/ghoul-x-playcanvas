import type { CombatantPostureState, TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import type { AlertedEngagementSubstate } from '../../core/ai/tacticalDoctrine.ts';
import { evaluateTacticalEngagementSubstate } from '../../core/ai/tacticalDoctrine.ts';
import { cancelActiveBurst } from '../../core/ai/weaponBurstFsm.ts';
import { aimSettleTimeS, firesOnTheMove } from '../../core/ai/plantedFootwork.ts';
import { createAimDuckReflexState, stepAimDuckReflex } from '../../core/ai/aimDuckReflex.ts';
import type { EnemyAimProfile, EnemyAiAgentRuntime } from './tacticalAiTypes.ts';
import { ARCHETYPE_TUNING } from './archetypeTuning.ts';
import { computeAlertedPeekTarget } from './tacticalCoverFinder.ts';
import { moveHorizontalClamped } from './tacticalLocomotion.ts';
import { driveEngagementFootwork, stepCloseQuartersBound } from './engagementFootwork.ts';
import { stepWeaponBurstFire } from './tacticalBurstAndTracers.ts';
import type { TacticalFsmContext } from './tacticalFsmContext.ts';
import { stepWoundedBehaviour } from './woundFallback.ts';
import { stepWeaponRecovery } from './weaponRecovery.ts';
import { isAgentReloading } from './enemyWeaponMagazine.ts';

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
  // Cleared each tick and set again only where this step decides the agent shoots from here, so
  // the mannequin raises the gun (and the aim delta brings the barrel on target) exactly then.
  agent.inFiringPosition = false;
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
    previousSubstate: agent.engagementSubstate,
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
  const woundedSubstate =
    doctrineSubstate === 'CLUTCHING_RETREAT' ? null : stepWoundedBehaviour(dt, hs, agent, playerDistM, ctx);
  // A fighter changing magazines does it behind cover, not leaning out into the line of fire.
  const shelter = ducking || isAgentReloading(agent);
  const substate =
    woundedSubstate ?? (shelter ? duckedSubstate(doctrineSubstate) : doctrineSubstate);
  agent.engagementSubstate = substate;

  if (hs.combatantStatusTag === null) {
    if (moraleShockS > 0) hs.combatantStatusTag = 'PANIC_SHAKEN';
    else if (substate === 'JUGGERNAUT_PRESS') hs.combatantStatusTag = 'JUGGERNAUT';
    else if (substate === 'BERSERKER_CHARGE' || substate === 'FLANKING_RUSH') hs.combatantStatusTag = 'RUSHING';
  }

  const prevPeekSign = agent.peekSign;
  if (substate === 'CLUTCHING_RETREAT' && stepWeaponRecovery(dt, hs, agent, ctx)) {
    cancelActiveBurst(agent);
    return;
  }
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

  const rushing = substate === 'FLANKING_RUSH' || substate === 'BERSERKER_CHARGE';
  const minStandOff = substate === 'JUGGERNAUT_PRESS' ? 3.2 : 2.4;
  // A rusher weaves on the way in, then plants at its stand-off distance to shoot.
  const weaveFade = Math.max(0, Math.min(1, (playerDistM - minStandOff - 0.4) / 1.6));
  const weaveOffset = rushing
    ? Math.sin(agent.peekCycleTimerS * 3.8) * 0.42 * weaveFade
    : substate === 'PANIC_SCRAMBLE'
      ? Math.sin(agent.peekCycleTimerS * 5.2) * 0.62
      : !peekPlan.anchorBlockedByCover
        ? stepCloseQuartersBound(dt, agent, playerDistM)
        : 0;
  // A hit that lands while the combatant is not bounding should not cut a later bound short.
  agent.jukeBreakPending = false;

  const profileSpeedMul =
    substate === 'PANIC_SCRAMBLE' || (agent.resolveProfile === 'PANICKED_SCRAPPER' && isWounded)
      ? 1.42
      : rushing
        ? 1.28
        : substate === 'JUGGERNAUT_PRESS'
          ? 0.92
          : 1.0;

  let goalZ = peekPlan.goalZ;
  if (rushing || substate === 'JUGGERNAUT_PRESS') {
    goalZ = Math.min(playerEyeWorldPos.z - minStandOff, peekPlan.goalZ + agent.berserkerAdvanceOffsetM);
  } else if (substate === 'EVASIVE_BACKPEDAL') {
    goalZ = Math.max(-21.5, peekPlan.goalZ + agent.berserkerAdvanceOffsetM);
  } else if (substate === 'PANIC_SCRAMBLE') {
    goalZ = Math.max(-21.5, peekPlan.goalZ - 0.32);
  }

  driveEngagementFootwork(
    dt,
    hs,
    agent,
    {
      lateralOffsetM: peekPlan.targetOffset + weaveOffset,
      goalZ,
      strafeSpeedMs: tuning.strafeSpeedMs * profileSpeedMul,
    },
    ctx
  );

  turnTowardPlayer(substate === 'SNIPER_SNAP_PEEK' ? 6.8 : 5.4);
  if (!hs.isRagdollActive) {
    // Adrenaline keeps a gut-shot fighter on its feet; the wound shows in its aim, not a kneel.
    hs.posture = 'COMBAT_READY' as CombatantPostureState;
  }

  // Soldiers move, stop, aim, then shoot. Only assaulting substates fire on the move; a burst
  // already under way is allowed to finish.
  const settled =
    firesOnTheMove(substate) ||
    agent.burstShotsRemaining > 0 ||
    (agent.footwork?.plantedS ?? 0) >= aimSettleTimeS(agent.resolveProfile, hs.archetype === 'SNIPER_OPERATIVE');
  // Caught in the open with nothing to shelter behind, a combatant keeps fighting from its spot
  // instead of standing there with the gun down.
  const firing = agent.isPeekingOut || peekPlan.firingPosition;
  agent.inFiringPosition = firing;
  if (!firing) {
    // Back behind cover: the burst ends here rather than resuming later on the move.
    cancelActiveBurst(agent);
  } else if (aimProfile.canReturnFire) {
    stepWeaponBurstFire(dt, hs, agent, aimProfile, playerEyeWorldPos, ctx.burstCtx, !settled);
  }
}
