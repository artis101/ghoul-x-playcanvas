import type { TargetHealthState, Vec3Like, WoundedPhase } from '../../contracts/ballistics.ts';
import {
  DOWNED_FIRE_CONE_RAD,
  rollFortitude,
  stepWoundedSequence,
  woundedPhaseAllowsDraw,
  woundedPhaseAllowsFire,
} from '../../core/ai/woundedSequenceFsm.ts';
import type { SidearmRule } from '../../core/ai/enemyArmamentFsm.ts';
import { isCommittedWoundReaction } from '../../core/ballistics/trauma/woundReactionTimings.ts';
import type { EnemyAiAgentRuntime, WoundedPlayerSense } from './tacticalAiTypes.ts';
import { isArmChainIntactAndFunctional } from './combatantArmEvaluation.ts';
import { isSeatedAnimated } from '../../core/ballistics/triage/seatedLastStand.ts';

/**
 * The AI side of the wounded sequence (docs/wound-movement.md). Each tick it measures where the
 * player stands relative to the way the body faces, lets the pure sequence pick the phase, and
 * answers the two questions the weapons ask: may the pistol come out, and may it fire now.
 */

/** Sitting up on the floor, leaning back on one hand, the eyes are about this high. */
const SEATED_EYE_HEIGHT_M = 0.9;

const NO_SENSE: WoundedPlayerSense = { playerBearingRad: null, playerVisible: false };

export function currentWoundedPhase(hs: TargetHealthState): WoundedPhase {
  return hs.woundedPhase ?? 'NONE';
}

/** Lying on the floor in the living ragdoll, not being thrown through the air. */
export function isGroundedLivingRagdoll(hs: TargetHealthState): boolean {
  return hs.alive && hs.isRagdollActive && hs.posture !== 'AIRBORNE_RAGDOLL';
}

/** Pelvis and chest slower than this: a body in the ragdoll has stopped rolling. */
const RAGDOLL_AT_REST_MS = 0.5;

/**
 * True once a body in the ragdoll lies still. Until then it may still roll onto its face, so it
 * does not reach for the pistol (a draw started mid-roll would be under a face-down body).
 */
export function isRagdollAtRest(hs: TargetHealthState): boolean {
  const speed = (zone: 'PELVIS_GROIN' | 'TORSO_UPPER_THORAX') => {
    const v = hs.ragdollBones[zone].velocity;
    return Math.hypot(v.x, v.y, v.z);
  };
  return speed('PELVIS_GROIN') < RAGDOLL_AT_REST_MS && speed('TORSO_UPPER_THORAX') < RAGDOLL_AT_REST_MS;
}

/** Down on one knee: the kneel-down clip or the kneeling pistol stance. */
export function isKneelingPhase(hs: TargetHealthState): boolean {
  const phase = currentWoundedPhase(hs);
  return phase === 'KNEEL_DOWN' || phase === 'KNEEL_FIRE';
}

/**
 * The flat direction the body faces. On the floor that is the way it came to rest, which never
 * turns to follow the player; standing or kneeling it is the yaw.
 */
export function woundedBodyFacing(hs: TargetHealthState): Vec3Like {
  if (hs.isRagdollActive && hs.downedFacingWorld) return hs.downedFacingWorld;
  return { x: Math.sin(hs.yawRad), y: 0, z: Math.cos(hs.yawRad) };
}

/** Where the body looks out from, for the line-of-sight check. */
function woundedEyeWorld(hs: TargetHealthState): Vec3Like {
  if (hs.isRagdollActive) {
    const head = hs.ragdollBones.HEAD_CRANIUM?.position ?? hs.ragdollRootPosition;
    return { x: head.x, y: Math.max(head.y + 0.06, hs.worldPosition.y + 0.3), z: head.z };
  }
  const phase = currentWoundedPhase(hs);
  const height = isKneelingPhase(hs)
    ? 1.05
    : isSeatedAnimated(hs)
      ? SEATED_EYE_HEIGHT_M
      : phase === 'DOWNED_CRAWL' || phase === 'SIT_DOWN' ? 0.5 : 1.55;
  return { x: hs.worldPosition.x, y: hs.worldPosition.y + height, z: hs.worldPosition.z };
}

/** Unsigned flat angle between the body's facing and the direction to the player. */
export function bearingToPlayerRad(hs: TargetHealthState, playerEye: Vec3Like): number | null {
  const facing = woundedBodyFacing(hs);
  const from = hs.isRagdollActive ? woundedEyeWorld(hs) : hs.worldPosition;
  const dx = playerEye.x - from.x;
  const dz = playerEye.z - from.z;
  const dist = Math.hypot(dx, dz);
  const facingLen = Math.hypot(facing.x, facing.z);
  if (dist < 1e-3 || facingLen < 1e-3) return null;
  const cos = (facing.x * dx + facing.z * dz) / (dist * facingLen);
  return Math.acos(Math.max(-1, Math.min(1, cos)));
}

export function senseWoundedPlayer(
  hs: TargetHealthState,
  playerEye: Vec3Like,
  isSightBlocked: (from: Vec3Like, to: Vec3Like) => boolean
): WoundedPlayerSense {
  return {
    playerBearingRad: bearingToPlayerRad(hs, playerEye),
    playerVisible: !isSightBlocked(woundedEyeWorld(hs), playerEye),
  };
}

export function agentHasUsableSidearm(agent: EnemyAiAgentRuntime): boolean {
  return agent.carriesBackupSidearm && !agent.sidearmDropped;
}

/**
 * Runs once per AI tick, before the armament step, so the draw and fire gates see this tick's
 * phase. Fortitude is rolled the first time, after the resolve profile is known.
 */
export function stepAgentWoundedSequence(
  dt: number,
  hs: TargetHealthState,
  agent: EnemyAiAgentRuntime,
  playerEye: Vec3Like,
  isSightBlocked: (from: Vec3Like, to: Vec3Like) => boolean
): void {
  if (!hs.alive || hs.currentHp <= 0) {
    agent.woundedSense = NO_SENSE;
    return;
  }
  // A fighter that recovered from being downed is back on its feet: it fights normally again.
  if (agent.state === 'DOWNED_CRAWLING' && !hs.isRagdollActive && hs.rightLegFunctional && hs.leftLegFunctional && currentWoundedPhase(hs) === 'NONE') {
    agent.state = 'ALERTED_ENGAGING';
  }
  hs.resolveProfile ??= agent.resolveProfile;
  rollFortitude(hs);
  const sense = senseWoundedPlayer(hs, playerEye, isSightBlocked);
  agent.woundedSense = sense;
  stepWoundedSequence(hs, {
    dt,
    hasSidearm: agentHasUsableSidearm(agent),
    freeArmWorks: isArmChainIntactAndFunctional(hs, 'RIGHT') || isArmChainIntactAndFunctional(hs, 'LEFT'),
    playerBearingRad: sense.playerBearingRad,
    playerVisible: sense.playerVisible,
  });
}

/** The player sits squarely in front of a body on the floor and it can see them. */
function downedConeClear(sense: WoundedPlayerSense): boolean {
  return sense.playerVisible && sense.playerBearingRad !== null && sense.playerBearingRad <= DOWNED_FIRE_CONE_RAD;
}

/**
 * Whether the pistol may come out now. Face down and crawling (DROP) no pistol comes out; in the
 * firing phases it is drawn once nothing else is playing; everywhere else (HOLSTER) it stays in the
 * holster, so the hands do one thing at a time. Neither rule takes a pistol that is already drawn
 * or out of the holster mid-draw: that is kept (the draw paused) until its arm goes or the body
 * dies (enemyArmamentFsm.ts).
 */
export function resolveSidearmRule(hs: TargetHealthState, agent: EnemyAiAgentRuntime): SidearmRule {
  const phase = currentWoundedPhase(hs);
  if (phase === 'FACE_DOWN' || phase === 'DOWNED_CRAWL') return 'DROP';
  // Still tumbling through the air after a fall clip: the planned downed phase may already
  // allow the pistol, but nothing reaches for it until the body has landed.
  if (hs.isRagdollActive && !isGroundedLivingRagdoll(hs)) return 'HOLSTER';
  // Landed but still rolling: it may yet come to rest on its face, which never draws.
  if (hs.isRagdollActive && !isRagdollAtRest(hs) && !agent.sidearmActive) return 'HOLSTER';
  if (phase !== 'NONE') return woundedPhaseAllowsDraw(hs) ? 'ALLOW' : 'HOLSTER';
  if (isCommittedWoundReaction(hs.activeReaction.type)) return 'HOLSTER';
  if (hs.isRagdollActive) {
    // Knocked flat outside the sequence (a blast, say): treated like a downed body. It only goes
    // for the pistol with the player in front of it, then keeps it in hand.
    if (!isGroundedLivingRagdoll(hs)) return 'HOLSTER';
    const engaged = agent.sidearmActive || agent.sidearmDrawing;
    return engaged || downedConeClear(agent.woundedSense ?? NO_SENSE) ? 'ALLOW' : 'HOLSTER';
  }
  // A lost arm goes through the clutch first; only a fighter with both arms whose long gun was
  // knocked away reaches straight for the pistol.
  const bothArms = isArmChainIntactAndFunctional(hs, 'RIGHT') && isArmChainIntactAndFunctional(hs, 'LEFT');
  return bothArms ? 'ALLOW' : 'HOLSTER';
}

/** The phases in which a body may ever pull a trigger, whatever the player's bearing. */
export function woundedPhaseCanEverFire(hs: TargetHealthState): boolean {
  const phase = currentWoundedPhase(hs);
  return phase === 'NONE' || phase === 'BLAZE' || phase === 'KNEEL_FIRE' || phase === 'DOWNED_ENGAGE';
}

/**
 * The last word on every enemy shot. A body on the floor only fires at a player straight in
 * front of it that it can see; the kneeling and blazing phases follow the sequence's own rules.
 */
export function woundedSequenceAllowsShot(hs: TargetHealthState, agent: EnemyAiAgentRuntime): boolean {
  const sense = agent.woundedSense ?? NO_SENSE;
  const phase = currentWoundedPhase(hs);
  if (hs.isRagdollActive && !isGroundedLivingRagdoll(hs)) return false;
  if (phase === 'NONE' && (hs.isRagdollActive || agent.state === 'DOWNED_CRAWLING')) {
    return downedConeClear(sense);
  }
  return woundedPhaseAllowsFire(hs, sense);
}
