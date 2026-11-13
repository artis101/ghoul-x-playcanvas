import { computeAimThreat } from '../../core/ai/aimThreat.ts';
import * as pc from 'playcanvas';
import type { AiBarkCategory, AiBarkPayload, BrutalKillRewardKind } from '../../contracts/ai/aiContracts.ts';
import type { TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import type { VocalTraumaCue } from '../../contracts/physiology/entityStateTypes.ts';
import {
  type AttackTokenCandidate,
  AttackTokenPool,
} from '../../core/ai/attackTokenPool.ts';
import {
  SquadBarkCoordinator,
  type SquadMateSummary,
} from '../../core/ai/squadBarkCoordinator.ts';
import {
  evaluateWitnessedBrutalityReaction,
  isBrutalFeatKind,
  selectCoverRelocationStation,
} from '../../core/ai/tacticalDoctrine.ts';
import { cancelActiveBurst, enterAlertReactionHold } from '../../core/ai/weaponBurstFsm.ts';
import { copyVec3, distance, dot, length, normalize, sub } from '../../core/ballistics/vec3.ts';
import { HardwareInstancedPool } from '../physics/instancedPool.ts';
import type { PeekPlanCacheEntry } from './tacticalCoverFinder.ts';
import {
  type EnemyAimProfile,
  type EnemyAiAgentRuntime,
  type EnemyHitNotification,
  type EnemyTacticalAiState,
  MIN_CONSCIOUSNESS_TO_FIGHT,
  TACTICAL_COVER_STATIONS,
} from './tacticalAiTypes.ts';

export function createEnemyTracerPool(app: pc.Application | null): HardwareInstancedPool | null {
  if (!app) return null;
  const dev = app.graphicsDevice;
  const boltMesh = pc.Mesh.fromGeometry(dev, new pc.BoxGeometry());
  const tracerMat = new pc.StandardMaterial();
  tracerMat.name = 'enemyGlowingTracerMat';
  tracerMat.diffuse = new pc.Color(1.0, 0.36, 0.08);
  tracerMat.emissive = new pc.Color(1.0, 0.42, 0.1);
  tracerMat.blendType = pc.BLEND_ADDITIVEALPHA;
  tracerMat.opacity = 0.92;
  tracerMat.depthWrite = false;
  tracerMat.cull = pc.CULLFACE_NONE;
  tracerMat.update();

  return new HardwareInstancedPool(app, boltMesh, tracerMat, 128, 'EnemyTracerBoltPool', false);
}

export function buildSquadMateSummary(
  targetId: string,
  targetStateById: ReadonlyMap<string, TargetHealthState>,
  agents: ReadonlyMap<string, EnemyAiAgentRuntime>
): SquadMateSummary | undefined {
  const hs = targetStateById.get(targetId);
  const ag = agents.get(targetId);
  if (!hs || !ag) return undefined;
  return {
    targetId: hs.targetId,
    archetype: hs.archetype,
    worldPos: hs.worldPosition,
    alive: hs.alive && hs.currentHp > 0 && ag.state !== 'DEAD',
    conscious: hs.consciousness > MIN_CONSCIOUSNESS_TO_FIGHT,
    isSuppressing: ag.fireMode === 'CINEMATIC_SUPPRESSION',
  };
}

export function buildAllSquadMateSummaries(
  targetStateById: ReadonlyMap<string, TargetHealthState>,
  agents: ReadonlyMap<string, EnemyAiAgentRuntime>
): SquadMateSummary[] {
  const list: SquadMateSummary[] = [];
  for (const id of agents.keys()) {
    const s = buildSquadMateSummary(id, targetStateById, agents);
    if (s) list.push(s);
  }
  return list;
}

export function updateSquadTokensAndFrustum(
  targets: readonly TargetHealthState[],
  agents: ReadonlyMap<string, EnemyAiAgentRuntime>,
  tokenPool: AttackTokenPool,
  barkCoordinator: SquadBarkCoordinator,
  playerEyeWorldPos: Vec3Like,
  playerForwardWorld: Vec3Like | undefined,
  computeAimProfile: (hs: TargetHealthState, ag: EnemyAiAgentRuntime) => EnemyAimProfile,
  resolveAim: (hs: TargetHealthState, ag: EnemyAiAgentRuntime, eye: Vec3Like) => Vec3Like | null
): void {
  const hasForwardFrustum =
    playerForwardWorld !== undefined && length(playerForwardWorld) > 1e-4;
  const normPlayerFwd = hasForwardFrustum ? normalize(playerForwardWorld!) : null;

  const tokenCandidates: AttackTokenCandidate[] = [];
  for (const hs of targets) {
    const ag = agents.get(hs.targetId);
    if (!ag) continue;
    const isAlive = hs.alive && hs.currentHp > 0 && ag.state !== 'DEAD';
    if (!isAlive) {
      cancelActiveBurst(ag);
      ag.fireMode = 'CINEMATIC_SUPPRESSION';
      tokenPool.releaseToken(hs.targetId);
      barkCoordinator.cancelPendingForAgent(hs.targetId);
      continue;
    }

    if (normPlayerFwd) {
      const toEnemy = sub(hs.worldPosition, playerEyeWorldPos);
      const horizLen = Math.hypot(toEnemy.x, toEnemy.z);
      const dirToEnemy = horizLen > 1e-4 ? normalize(toEnemy) : normPlayerFwd;
      ag.isOffScreen = dot(normPlayerFwd, dirToEnemy) < 0.35;
      ag.aimThreat = computeAimThreat(playerEyeWorldPos, normPlayerFwd, hs.worldPosition);
    } else {
      ag.isOffScreen = false;
      ag.aimThreat = 0;
    }

    const aimProf = computeAimProfile(hs, ag);
    const hasLos = resolveAim(hs, ag, playerEyeWorldPos) !== null;
    tokenCandidates.push({
      targetId: hs.targetId,
      alive: true,
      canReturnFire: aimProf.canReturnFire,
      isPeekingOut: ag.isPeekingOut,
      hasLineOfSight: hasLos,
      isOnScreen: !ag.isOffScreen,
      distanceToPlayerM: distance(hs.worldPosition, playerEyeWorldPos),
      resolveProfile: ag.resolveProfile,
      completedBurstCount: ag.completedBurstCount,
      suppression: ag.suppression,
    });
  }

  const tokenMap = tokenPool.assignTokens(tokenCandidates);
  for (const hs of targets) {
    const ag = agents.get(hs.targetId);
    if (ag && hs.alive && hs.currentHp > 0 && ag.state !== 'DEAD') {
      ag.fireMode = tokenMap.get(hs.targetId) ?? 'AGGRESSIVE_LETHAL';
    }
  }
}

export function triggerHitTraumaBark(
  target: TargetHealthState,
  hit: EnemyHitNotification,
  agent: EnemyAiAgentRuntime,
  barkCoordinator: SquadBarkCoordinator,
  elapsedClockS: number,
  emitBark: (bark: AiBarkPayload) => void
): void {
  if (!target.alive || target.currentHp <= 0) return;
  const vocalCue: VocalTraumaCue =
    target.rupturedOrgans.has('LUNG_RIGHT') || target.rupturedOrgans.has('LUNG_LEFT')
      ? 'WET_HEMOTHORAX_COUGH'
      : target.oxygenSaturationPct < 75
        ? 'AGUNAL_WHEEZE'
        : hit.isTorsoHit || (hit.energyDepositedJ ?? 0) >= 600
          ? 'SHARP_GASP'
          : 'PAIN_GRUNT';
  barkCoordinator.notifyWoundedTrauma(
    target.targetId,
    target.archetype,
    target.worldPosition,
    vocalCue,
    agent.resolveProfile === 'FANATIC_BERSERKER',
    elapsedClockS,
    emitBark
  );
}

export function triggerStateTransitionBark(
  agent: EnemyAiAgentRuntime,
  prevState: EnemyTacticalAiState,
  nextState: EnemyTacticalAiState,
  targetStateById: ReadonlyMap<string, TargetHealthState>,
  agents: ReadonlyMap<string, EnemyAiAgentRuntime>,
  barkCoordinator: SquadBarkCoordinator,
  elapsedClockS: number,
  emitBark: (bark: AiBarkPayload) => void
): void {
  const hs = targetStateById.get(agent.targetId);
  if (prevState === 'PATROL_GUARD' && nextState === 'ALERTED_ENGAGING') {
    enterAlertReactionHold(agent, 0.28);
    if (hs) {
      barkCoordinator.notifyContact(
        hs.targetId,
        hs.archetype,
        hs.worldPosition,
        buildAllSquadMateSummaries(targetStateById, agents),
        elapsedClockS,
        emitBark
      );
    }
  } else if (nextState === 'DEAD') {
    cancelActiveBurst(agent);
    agent.fireMode = 'CINEMATIC_SUPPRESSION';
    barkCoordinator.cancelPendingForAgent(agent.targetId);
    if (hs) {
      barkCoordinator.notifyAllyDown(
        hs.targetId,
        hs.worldPosition,
        buildAllSquadMateSummaries(targetStateById, agents),
        elapsedClockS
      );
    }
  } else if (
    nextState === 'SUPPRESSED_STAGGERED' &&
    hs &&
    agent.resolveProfile !== 'FANATIC_BERSERKER'
  ) {
    barkCoordinator.notifyCoverRetreat(
      hs.targetId,
      hs.archetype,
      hs.worldPosition,
      elapsedClockS,
      emitBark
    );
  }
}

export function broadcastWitnessedBrutality(
  victim: TargetHealthState,
  kind: BrutalKillRewardKind,
  agents: ReadonlyMap<string, EnemyAiAgentRuntime>,
  targetStateById: ReadonlyMap<string, TargetHealthState>,
  barkCoordinator: SquadBarkCoordinator,
  elapsedClockS: number,
  transitionState: (agent: EnemyAiAgentRuntime, next: EnemyTacticalAiState) => void,
  emitBark: (bark: AiBarkPayload) => void
): number {
  if (!isBrutalFeatKind(kind)) return 0;

  let affectedCount = 0;
  let closestWitness: { hs: TargetHealthState; category: AiBarkCategory; dist: number } | null = null;
  const isHeadLoss = kind === 'CRANIAL_POP' || kind === 'DECAPITATION';

  for (const [id, agent] of agents.entries()) {
    if (id === victim.targetId || agent.state === 'DEAD') continue;
    const hs = targetStateById.get(id);
    if (!hs || !hs.alive || hs.currentHp <= 0 || hs.consciousness <= MIN_CONSCIOUSNESS_TO_FIGHT) {
      continue;
    }

    const d = distance(hs.worldPosition, victim.worldPosition);
    const reaction = evaluateWitnessedBrutalityReaction(
      agent.resolveProfile,
      kind,
      d,
      agent.adrenaline,
      agent.suppression
    );
    if (!reaction) continue;

    affectedCount++;
    agent.adrenaline = reaction.nextAdrenaline;
    agent.suppression = reaction.nextSuppression;
    if (reaction.moraleShockTimerS > 0) {
      agent.moraleShockTimerS = Math.max(agent.moraleShockTimerS ?? 0, reaction.moraleShockTimerS);
    }
    if (reaction.berserkerFrenzyTimerS > 0) {
      agent.berserkerFrenzyTimerS = Math.max(
        agent.berserkerFrenzyTimerS ?? 0,
        reaction.berserkerFrenzyTimerS
      );
    }
    if (reaction.flipPeekSign) {
      agent.peekSign = agent.peekSign === 1 ? -1 : 1;
    }
    if (agent.state === 'PATROL_GUARD') {
      transitionState(agent, 'ALERTED_ENGAGING');
    }
    if (reaction.staggerDurationS > 0 && agent.state === 'ALERTED_ENGAGING') {
      agent.staggerTimerS = Math.max(agent.staggerTimerS, reaction.staggerDurationS);
      transitionState(agent, 'SUPPRESSED_STAGGERED');
    }

    if (reaction.barkCategory && (!closestWitness || d < closestWitness.dist)) {
      closestWitness = { hs, category: reaction.barkCategory, dist: d };
    }
  }

  if (closestWitness) {
    barkCoordinator.notifyWitnessedBrutality(
      closestWitness.hs.targetId,
      closestWitness.hs.archetype,
      closestWitness.hs.worldPosition,
      closestWitness.category,
      isHeadLoss,
      elapsedClockS,
      emitBark
    );
  }

  return affectedCount;
}

export function relocateAgentToAlternateCover(
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  agents: ReadonlyMap<string, EnemyAiAgentRuntime>,
  peekPlanCache: Map<string, PeekPlanCacheEntry>,
  elapsedClockS: number
): boolean {
  const lastReloc = agent.lastRelocationClockS ?? -99;
  if (elapsedClockS - lastReloc < 6.5) return false;

  const occupied: Vec3Like[] = [];
  for (const [id, other] of agents.entries()) {
    if (id === hs.targetId || other.state === 'DEAD') continue;
    occupied.push(other.coverAnchorWorld);
  }

  const nextStation = selectCoverRelocationStation(
    agent.coverAnchorWorld,
    occupied,
    TACTICAL_COVER_STATIONS
  );
  if (!nextStation) return false;

  agent.coverAnchorWorld = copyVec3(nextStation.coverAnchorWorld);
  agent.peekSign = nextStation.peekSign;
  agent.peekStrideM = nextStation.peekStrideM;
  agent.currentLateralOffsetM = 0;
  agent.berserkerAdvanceOffsetM = 0;
  agent.lastRelocationClockS = elapsedClockS;
  peekPlanCache.delete(hs.targetId);
  return true;
}
