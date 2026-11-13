import type { TargetHealthState } from '../../contracts/ballistics.ts';
import { RED_HEALTH_HP_FRACTION } from '../../contracts/combatantHealthBands.ts';
import {
  applyArmamentStateToRuntime,
  type ArmamentTransitionEvent,
  createPrimaryArmedState,
  type EnemyArmamentState,
  reconcileEnemyArmamentState,
  stepEnemyArmamentState,
} from '../../core/ai/enemyArmamentFsm.ts';
import { cancelActiveBurst } from '../../core/ai/weaponBurstFsm.ts';
import { copyVec3, vec3 } from '../../core/ballistics/vec3.ts';
import type { EnemyAiAgentRuntime, EnemySidearmVisualState } from './tacticalAiTypes.ts';
import { BACKUP_SIDEARM_WEAPON_ID, SIDEARM_DRAW_DURATION_S } from './archetypeTuning.ts';
import {
  getPreferredPrimaryHand,
  isArmChainIntactAndFunctional,
  selectIntactFiringHand,
} from './combatantArmEvaluation.ts';
import { isWoundClipHoldingBody } from './woundClipHold.ts';
import { isSeatedAnimated, SEATED_DRAW_S } from '../../core/ballistics/triage/seatedLastStand.ts';
import { resolveSidearmRule } from './woundedSequenceDriver.ts';
import { drawClipSecondsFor } from '../mannequin/combatantDrawClips.ts';

/**
 * How long a draw takes for this body now: the length of the draw clip it plays, so the pistol
 * comes out on the frame the clip shows it. Sitting on the floor that is the seated draw
 * (`SEATED_DRAW_S`); standing, kneeling or from the stump clutch it is PistolDraw / StumpDraw /
 * KneelStumpDraw.
 */
export function sidearmDrawSecondsFor(hs: TargetHealthState): number {
  return isSeatedAnimated(hs) ? SEATED_DRAW_S : drawClipSecondsFor(hs);
}

/** 0 when a draw starts, 1 once the pistol is out, measured against that draw's own length. */
export function sidearmDrawProgress(state: EnemyArmamentState): number {
  if (state.kind === 'SIDEARM_ACTIVE') return 1;
  if (state.kind !== 'SIDEARM_DRAWING') return 0;
  const total = state.totalS ?? SIDEARM_DRAW_DURATION_S;
  return total > 0 ? Math.max(0, Math.min(1, 1 - state.remainingS / total)) : 1;
}

export function getSidearmVisualState(agent?: EnemyAiAgentRuntime): EnemySidearmVisualState {
  if (!agent) {
    return {
      visible: false,
      drawing: false,
      drawProgress: 0,
      hand: null,
      dropped: false,
      aimTargetWorld: vec3(0, 1.5, 0),
      weaponId: BACKUP_SIDEARM_WEAPON_ID,
    };
  }

  const state = reconcileEnemyArmamentState(agent);
  const visible = state.kind === 'SIDEARM_ACTIVE' || state.kind === 'SIDEARM_DRAWING';
  const drawProgress = sidearmDrawProgress(state);

  return {
    visible,
    drawing: state.kind === 'SIDEARM_DRAWING',
    drawProgress,
    hand: visible ? state.hand : null,
    dropped: state.kind === 'DISARMED' ? state.sidearmDropped : agent.sidearmDropped,
    aimTargetWorld: copyVec3(agent.lastAimTargetWorld),
    weaponId: BACKUP_SIDEARM_WEAPON_ID,
  };
}

export function evaluateTargetArmamentState(
  hs: TargetHealthState,
  agent?: EnemyAiAgentRuntime
): EnemyArmamentState {
  const preferredHand = getPreferredPrimaryHand(hs);
  const rightIntact = isArmChainIntactAndFunctional(hs, 'RIGHT');
  const leftIntact = isArmChainIntactAndFunctional(hs, 'LEFT');
  const intactHand = selectIntactFiringHand(hs, agent?.activeFiringHand ?? preferredHand);
  const current = agent ? reconcileEnemyArmamentState(agent) : createPrimaryArmedState(preferredHand);
  const sidearmEngaged = current.kind === 'SIDEARM_ACTIVE' || current.kind === 'SIDEARM_DRAWING';

  return stepEnemyArmamentState(current, {
    dt: 0,
    alive: hs.alive && hs.currentHp > 0,
    rightArmIntact: rightIntact,
    leftArmIntact: leftIntact,
    preferredPrimaryHand: preferredHand,
    intactHand,
    weaponDropped: hs.weaponDropped,
    primaryArmDisarmed: hs.primaryArmDisarmed === true,
    isRagdollActive: hs.isRagdollActive,
    isAirborneRagdoll: hs.isRagdollActive && hs.posture === 'AIRBORNE_RAGDOLL',
    carriesBackupSidearm: sidearmEngaged,
    isGuarding: agent?.state === 'PATROL_GUARD',
    isLastStandVital: false,
    sidearmDrawDurationS: sidearmDrawSecondsFor(hs),
    seatedOnFloor: isSeatedAnimated(hs),
  }).state;
}

export function syncAgentArmamentAndSidearm(
  dt: number,
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  onAlert: () => void,
  onSidearmDrawStart?: () => void
): readonly ArmamentTransitionEvent[] {
  hs.resolveProfile = agent.resolveProfile;

  const preferredHand = getPreferredPrimaryHand(hs);
  const rightIntact = isArmChainIntactAndFunctional(hs, 'RIGHT');
  const leftIntact = isArmChainIntactAndFunctional(hs, 'LEFT');
  const intactHand = selectIntactFiringHand(hs, preferredHand);
  const isLastStandVital =
    agent.triageStatus === 'MORTALLY_WOUNDED' || hs.currentHp <= hs.maxHp * RED_HEALTH_HP_FRACTION;

  const current = reconcileEnemyArmamentState(agent);
  const result = stepEnemyArmamentState(current, {
    dt,
    alive: hs.alive && hs.currentHp > 0,
    rightArmIntact: rightIntact,
    leftArmIntact: leftIntact,
    preferredPrimaryHand: preferredHand,
    intactHand,
    weaponDropped: hs.weaponDropped,
    primaryArmDisarmed: hs.primaryArmDisarmed === true,
    isRagdollActive: hs.isRagdollActive,
    isAirborneRagdoll: hs.isRagdollActive && hs.posture === 'AIRBORNE_RAGDOLL',
    carriesBackupSidearm: agent.carriesBackupSidearm,
    isGuarding: agent.state === 'PATROL_GUARD',
    isLastStandVital,
    sidearmDrawDurationS: sidearmDrawSecondsFor(hs),
    seatedOnFloor: isSeatedAnimated(hs),
    woundClipPlaying: isWoundClipHoldingBody(hs),
    // The wounded sequence decides when the pistol may come out (docs/wound-movement.md).
    sidearmRule: resolveSidearmRule(hs, agent),
  });

  applyArmamentStateToRuntime(agent, result.state);

  if (result.dropPrimaryWeapon) {
    hs.weaponDropped = true;
  }
  if (result.markPrimaryArmDisarmed) {
    hs.primaryArmDisarmed = true;
  }
  if (result.forceDisarmedPosture) {
    hs.posture = 'DISARMED';
  }
  if (result.cancelBurst) {
    cancelActiveBurst(agent);
  }
  if (result.clampFireCooldownMaxS !== null) {
    agent.fireCooldownTimerS = Math.min(agent.fireCooldownTimerS, result.clampFireCooldownMaxS);
    if (agent.burstShotsRemaining <= 0) {
      cancelActiveBurst(agent);
    }
  }
  hs.combatantStatusTag = result.statusTag;

  for (const ev of result.events) {
    if (ev === 'ALERT') {
      agent.adrenaline = Math.max(agent.adrenaline, 0.92);
      onAlert();
    } else if (ev === 'SIDEARM_DRAW_START') {
      onSidearmDrawStart?.();
    }
  }

  return result.events;
}
