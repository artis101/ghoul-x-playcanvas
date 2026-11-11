import type { TargetHealthState } from '../../contracts/ballistics.ts';
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

  const visible = agent.sidearmActive || agent.sidearmDrawing;
  const drawProgress = agent.sidearmActive
    ? 1.0
    : agent.sidearmDrawing
      ? Math.max(0, Math.min(1, 1 - agent.sidearmDrawTimerS / SIDEARM_DRAW_DURATION_S))
      : 0.0;

  return {
    visible,
    drawing: agent.sidearmDrawing,
    drawProgress,
    hand: visible ? agent.activeFiringHand : null,
    dropped: agent.sidearmDropped,
    aimTargetWorld: copyVec3(agent.lastAimTargetWorld),
    weaponId: BACKUP_SIDEARM_WEAPON_ID,
  };
}

export function syncAgentArmamentAndSidearm(
  dt: number,
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  onAlert: () => void
): void {
  hs.resolveProfile = agent.resolveProfile;

  if (!hs.alive || hs.currentHp <= 0) {
    if (agent.sidearmActive || agent.sidearmDrawing) {
      agent.sidearmDropped = true;
    }
    agent.sidearmActive = false;
    agent.sidearmDrawing = false;
    agent.sidearmDrawTimerS = 0;
    hs.combatantStatusTag = null;
    return;
  }

  const leftIntact = isArmChainIntactAndFunctional(hs, 'LEFT');
  const rightIntact = isArmChainIntactAndFunctional(hs, 'RIGHT');
  const bothArmsLost = !leftIntact && !rightIntact;
  const anyArmLost = !leftIntact || !rightIntact;
  const preferredHand = getPreferredPrimaryHand(hs);

  if (bothArmsLost) {
    hs.weaponDropped = true;
    hs.primaryArmDisarmed = true;
    if (agent.sidearmActive || agent.sidearmDrawing) {
      agent.sidearmDropped = true;
    }
    agent.sidearmActive = false;
    agent.sidearmDrawing = false;
    agent.sidearmDrawTimerS = 0;
    agent.burstShotsRemaining = 0;
    if (!hs.isRagdollActive) hs.posture = 'DISARMED';
    hs.combatantStatusTag = 'DISARMED';
    return;
  }

  const intactHand = selectIntactFiringHand(hs, preferredHand)!;
  const primaryDisarmed =
    anyArmLost || hs.primaryArmDisarmed === true || (!hs.isRagdollActive && hs.weaponDropped);

  if (primaryDisarmed) {
    hs.weaponDropped = true;
    hs.primaryArmDisarmed = true;

    if (!agent.carriesBackupSidearm) {
      agent.sidearmActive = false;
      agent.sidearmDrawing = false;
      agent.sidearmDrawTimerS = 0;
      agent.burstShotsRemaining = 0;
      if (!hs.isRagdollActive) hs.posture = 'DISARMED';
      hs.combatantStatusTag = 'DISARMED';
      return;
    }

    agent.activeFiringHand = intactHand;
    if (agent.state === 'PATROL_GUARD') {
      agent.adrenaline = Math.max(agent.adrenaline, 0.92);
      onAlert();
    }

    if (!agent.sidearmActive && !agent.sidearmDrawing && !agent.sidearmDropped) {
      agent.sidearmDrawing = true;
      agent.sidearmDrawTimerS = SIDEARM_DRAW_DURATION_S;
      agent.burstShotsRemaining = 0;
    }

    if (agent.sidearmDrawing && dt > 0) {
      agent.sidearmDrawTimerS = Math.max(0, agent.sidearmDrawTimerS - dt);
      if (agent.sidearmDrawTimerS <= 0) {
        agent.sidearmDrawing = false;
        agent.sidearmActive = true;
        agent.fireCooldownTimerS = Math.min(agent.fireCooldownTimerS, 0.08);
      }
    }

    hs.combatantStatusTag = agent.sidearmActive ? 'SIDEARM_DRAWN' : 'SIDEARM_DRAWING';
    return;
  }

  if (hs.isRagdollActive && hs.posture !== 'AIRBORNE_RAGDOLL') {
    agent.activeFiringHand = intactHand;
    agent.sidearmDrawing = false;
    agent.sidearmDrawTimerS = 0;
    agent.sidearmActive = true;
    hs.combatantStatusTag = 'LAST_STAND';
    return;
  }

  agent.activeFiringHand = preferredHand;
  const isLastStand = agent.triageStatus === 'MORTALLY_WOUNDED' || hs.currentHp <= hs.maxHp * 0.32;
  hs.combatantStatusTag = isLastStand ? 'LAST_STAND' : null;
}
