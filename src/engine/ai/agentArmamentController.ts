import type { TargetHealthState } from '../../contracts/ballistics.ts';
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
  const drawProgress =
    state.kind === 'SIDEARM_ACTIVE'
      ? 1.0
      : state.kind === 'SIDEARM_DRAWING'
        ? Math.max(0, Math.min(1, 1 - state.remainingS / SIDEARM_DRAW_DURATION_S))
        : 0.0;

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
    sidearmDrawDurationS: SIDEARM_DRAW_DURATION_S,
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
    agent.triageStatus === 'MORTALLY_WOUNDED' || hs.currentHp <= hs.maxHp * 0.32;

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
    sidearmDrawDurationS: SIDEARM_DRAW_DURATION_S,
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
