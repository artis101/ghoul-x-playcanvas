import type { TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import { cancelActiveBurst, enterNeurogenicShock } from '../../core/ai/weaponBurstFsm.ts';
import { distance } from '../../core/ballistics/vec3.ts';
import { computeCombatantTriageStatus } from '../../core/ballistics/solver.ts';
import type {
  EnemyAiAgentRuntime,
  EnemyHitNotification,
  EnemyTacticalAiState,
} from './tacticalAiTypes.ts';
import { TORSO_ZONES } from './archetypeTuning.ts';
import { isWoundClipHoldingBody } from './woundClipHold.ts';

export function handleGunshotOrExplosion(
  agents: Map<string, EnemyAiAgentRuntime>,
  soundOriginWorld: Vec3Like,
  audibleRadiusM = 38.0,
  suppressionImpulse = 0.22,
  onTransition: (agent: EnemyAiAgentRuntime, next: EnemyTacticalAiState) => void
): void {
  for (const agent of agents.values()) {
    if (agent.state === 'DEAD') continue;
    const distM = distance(soundOriginWorld, agent.coverAnchorWorld);
    if (distM > audibleRadiusM) continue;

    const proximity = Math.max(0, 1 - distM / audibleRadiusM);
    const suppressionScale =
      agent.resolveProfile === 'FANATIC_BERSERKER'
        ? 0.35
        : agent.resolveProfile === 'HARDENED_VETERAN'
          ? 0.6
          : agent.resolveProfile === 'PANICKED_SCRAPPER'
            ? 1.25
            : 1.0;
    agent.suppression = Math.min(
      1.0,
      agent.suppression + suppressionImpulse * proximity * suppressionScale
    );

    if (agent.state === 'PATROL_GUARD') {
      agent.adrenaline = Math.max(
        agent.adrenaline,
        agent.resolveProfile === 'FANATIC_BERSERKER' ? 0.96 : 0.88
      );
      onTransition(agent, 'ALERTED_ENGAGING');
    } else if (agent.state === 'ALERTED_ENGAGING') {
      agent.adrenaline = Math.min(1.0, agent.adrenaline + 0.14);
      if (
        agent.resolveProfile !== 'FANATIC_BERSERKER' &&
        agent.resolveProfile !== 'HARDENED_VETERAN' &&
        agent.suppression >= 0.88 &&
        agent.adrenaline < 0.75
      ) {
        agent.staggerTimerS = Math.max(agent.staggerTimerS, 0.5);
        cancelActiveBurst(agent);
        onTransition(agent, 'SUPPRESSED_STAGGERED');
      }
    }
  }
}

export function handleEnemyHit(
  target: TargetHealthState,
  hit: EnemyHitNotification,
  agent: EnemyAiAgentRuntime,
  agents: Map<string, EnemyAiAgentRuntime>,
  onArmamentSync: () => void,
  onTransition: (agent: EnemyAiAgentRuntime, next: EnemyTacticalAiState) => void
): EnemyTacticalAiState {
  agent.lastObservedHp = target.currentHp;
  agent.triageStatus = computeCombatantTriageStatus(target);

  if (!target.alive || target.currentHp <= 0) {
    onArmamentSync();
    onTransition(agent, 'DEAD');
    return agent.state;
  }

  onArmamentSync();
  // Taking a round, a combatant breaks its current juke so the shooter's next one misses.
  agent.jukeBreakPending = true;
  const hitTorso =
    hit.isTorsoHit === true || (hit.hitZone !== undefined && TORSO_ZONES.has(hit.hitZone));
  const wasUnsuspecting = agent.state === 'PATROL_GUARD' && agent.adrenaline < 0.35;

  if (!target.rightLegFunctional || !target.leftLegFunctional) {
    if (wasUnsuspecting && hitTorso) {
      enterNeurogenicShock(agent, 1.65);
      target.painShock = Math.max(target.painShock, 0.85);
      target.consciousness = Math.min(target.consciousness, 0.42);
    }
    agent.adrenaline = Math.max(
      agent.adrenaline,
      agent.resolveProfile === 'FANATIC_BERSERKER' ? 1.0 : 0.82
    );
    if (!target.isRagdollActive && !isWoundClipHoldingBody(target)) {
      target.posture = agent.clutchingWound ? 'DISARMED' : 'LEG_BUCKLED';
    }
    onTransition(agent, 'DOWNED_CRAWLING');
    return agent.state;
  }

  if (wasUnsuspecting && hitTorso) {
    enterNeurogenicShock(agent, 1.65);
    agent.staggerTimerS = 1.65;
    cancelActiveBurst(agent);
    target.painShock = Math.max(target.painShock, 0.85);
    target.consciousness = Math.min(target.consciousness, 0.42);
    if (!target.isRagdollActive && !isWoundClipHoldingBody(target)) {
      target.posture = 'STAGGERED';
    }
    onTransition(agent, 'SUPPRESSED_STAGGERED');
  } else {
    if (agent.resolveProfile === 'FANATIC_BERSERKER') agent.adrenaline = 1.0;
    else agent.adrenaline = Math.min(1.0, Math.max(0.88, agent.adrenaline + 0.22));
    agent.suppression = Math.min(1.0, agent.suppression + 0.32);

    const heavyEnergy = (hit.energyDepositedJ ?? 0) >= 850;
    const flinchDurationS =
      agent.resolveProfile === 'FANATIC_BERSERKER'
        ? 0.35
        : agent.resolveProfile === 'HARDENED_VETERAN'
          ? 0.38
          : agent.resolveProfile === 'PANICKED_SCRAPPER'
            ? 0.52
            : 0.46;

    if (
      heavyEnergy ||
      target.painShock - agent.adrenaline * 0.65 > 0.32 ||
      agent.triageStatus === 'MORTALLY_WOUNDED'
    ) {
      agent.staggerTimerS = Math.max(agent.staggerTimerS, flinchDurationS);
      cancelActiveBurst(agent);
      if (!target.isRagdollActive && target.posture === 'COMBAT_READY') {
        target.posture = 'STAGGERED';
      }
      onTransition(agent, 'SUPPRESSED_STAGGERED');
    } else if (agent.state === 'PATROL_GUARD') {
      onTransition(agent, 'ALERTED_ENGAGING');
    }
  }

  for (const mate of agents.values()) {
    if (mate.targetId === target.targetId || mate.state !== 'PATROL_GUARD') continue;
    if (distance(mate.coverAnchorWorld, target.worldPosition) <= 18.0) {
      mate.adrenaline = Math.max(mate.adrenaline, 0.85);
      onTransition(mate, 'ALERTED_ENGAGING');
    }
  }

  return agent.state;
}
