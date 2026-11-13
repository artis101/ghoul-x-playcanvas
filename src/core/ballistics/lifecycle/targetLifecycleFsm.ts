import type {
  CombatantArmamentState,
  CombatantBodyState,
  PainReactionType,
  StandingCombatPosture,
  TargetHealthState,
  TargetLifecycleEvent,
} from '../../../contracts/ballistics.ts';
import { RED_HEALTH_HP_FRACTION } from '../../../contracts/combatantHealthBands.ts';
import { createSeededRng, hashStringSeed } from '../../random/seededRng.ts';
import { ALL_AUX_PARTICLES, ALL_GHOUL_ZONES } from '../../ghoul/anatomy.ts';
import { deriveCorpseSleepPhase } from '../ragdoll/corpseSleepFsm.ts';
import { stabilizeRagdollPoseForTransition } from '../ragdoll/ragdollPoseStabilizer.ts';
import { stepFaceDownSettle, yawForward } from '../triage/faceDownLanding.ts';
import { isSeatedPhase } from '../triage/seatedLastStand.ts';
import { listLostLimbs } from '../trauma/limbLossDeathRule.ts';
import { WOUND_CLIP_SECONDS, isCommittedWoundReaction, isFallingReaction } from '../trauma/woundReactionTimings.ts';
import { add, copyVec3, scale, vec3 } from '../vec3.ts';
import { canAnimateDeath, startDeathAnimation } from './deathAnimation.ts';

/** Matches the armament FSM's last-stand vitals (the red health band): below this a wounded combatant goes down fighting. */
const LAST_STAND_HP_FRACTION = RED_HEALTH_HP_FRACTION;
/** Downward speed a body already seated by its fall clip gets as the ragdoll takes it over. */
const SETTLE_DOWN_SPEED_MS = 0.15;

const STANDING_POSTURES: ReadonlySet<string> = new Set<StandingCombatPosture>([
  'COMBAT_READY',
  'STAGGERED',
  'THROAT_CLUTCH',
  'GUT_HURT',
  'LEG_BUCKLED',
  'DISARMED',
]);

export function resolveStandingPostureAfterReaction(
  target: TargetHealthState
): StandingCombatPosture {
  // A crawler or a seated last-stander is animated rather than ragdolled, but it is on the floor.
  if (target.woundedPhase === 'DOWNED_CRAWL' || isSeatedPhase(target.woundedPhase)) {
    return 'LEG_BUCKLED';
  }
  if (!target.rightLegFunctional || !target.leftLegFunctional) {
    return 'LEG_BUCKLED';
  }
  if (target.weaponDropped && target.combatantStatusTag !== 'SIDEARM_DRAWN') {
    return 'DISARMED';
  }
  return 'COMBAT_READY';
}

export function deriveCombatantArmamentState(
  target: TargetHealthState
): CombatantArmamentState {
  if (!target.alive) {
    return 'COMPLETELY_DISARMED';
  }
  if (target.combatantStatusTag === 'LAST_STAND') {
    return 'LAST_STAND_GROUNDED';
  }
  if (target.combatantStatusTag === 'SIDEARM_DRAWN') {
    return 'SIDEARM_READY';
  }
  if (target.combatantStatusTag === 'SIDEARM_DRAWING') {
    return 'PRIMARY_DISARMED_DRAWING_SIDEARM';
  }
  if (target.weaponDropped) {
    return 'COMPLETELY_DISARMED';
  }
  return 'PRIMARY_READY';
}

export function deriveCombatantBodyState(target: TargetHealthState): CombatantBodyState {
  const hitstopRemainingS = target.hitstopRemainingS ?? 0;
  if (!target.alive && !target.isRagdollActive && target.dying) {
    return { kind: 'DYING', dying: target.dying, hitstopRemainingS };
  }
  if (!target.alive) {
    return {
      kind: 'RAGDOLL_CORPSE',
      sleepPhase: deriveCorpseSleepPhase(target.ragdollPhase),
      hitstopRemainingS,
    };
  }
  if (target.isRagdollActive) {
    const agonyElapsedS =
      target.ragdollPhase.kind === 'LIVING_AGONY' ? target.ragdollPhase.agonyClockS : 0;
    return {
      kind: 'RAGDOLL_LIVING',
      grounded: target.posture === 'RAGDOLL_GROUNDED',
      agonyElapsedS,
      hitstopRemainingS,
    };
  }
  const standingPosture: StandingCombatPosture = STANDING_POSTURES.has(target.posture)
    ? (target.posture as StandingCombatPosture)
    : resolveStandingPostureAfterReaction(target);
  return {
    kind: 'STANDING',
    posture: standingPosture,
    reaction: target.activeReaction.type !== 'NONE' ? target.activeReaction : null,
    hitstopRemainingS,
  };
}

export function syncTargetLifecycleDerivedState(target: TargetHealthState): void {
  target.armamentState = deriveCombatantArmamentState(target);
  target.bodyState = deriveCombatantBodyState(target);
}

/**
 * Pure transition reducer for TargetHealthState vital, posture, pain-reaction, and armament lifecycle.
 * Keeps all legacy TargetHealthState properties synchronized for engine & test compatibility.
 */
export function transitionTargetLifecycle(
  target: TargetHealthState,
  event: TargetLifecycleEvent
): void {
  switch (event.kind) {
    case 'START_PAIN_REACTION': {
      if (!target.alive || target.isRagdollActive) break;
      const nextEpoch = (target.activeReaction.epoch ?? 0) + 1;
      target.activeReaction = {
        type: event.reactionType,
        timerS: 0,
        durationS: event.durationS,
        intensity: event.intensity,
        hitDirectionWorld: copyVec3(event.hitDirectionWorld),
        epoch: nextEpoch,
      };
      if (event.postureOverride) {
        target.posture = event.postureOverride;
      }
      break;
    }

    case 'TICK_PAIN_REACTION': {
      if (!target.alive || target.activeReaction.type === 'NONE') break;
      target.activeReaction.timerS += event.dt;
      if (target.activeReaction.timerS >= target.activeReaction.durationS) {
        target.activeReaction.type = 'NONE';
        if (!target.isRagdollActive) {
          target.posture = resolveStandingPostureAfterReaction(target);
        }
      }
      break;
    }

    case 'PRIMARY_ARM_DISARM': {
      target.weaponDropped = true;
      target.primaryArmDisarmed = true;
      if (target.alive && !target.isRagdollActive && target.activeReaction.type === 'NONE') {
        target.posture = resolveStandingPostureAfterReaction(target);
      }
      break;
    }

    case 'LETHAL_DEATH': {
      target.alive = false;
      target.consciousness = 0;
      target.heartRateBpm = 0;
      target.systolicBpMmHg = 0;
      target.weaponDropped = true;
      target.activeReaction.type = 'NONE';
      target.activeReaction.timerS = 0;
      target.combatantStatusTag = null;
      if (
        target.ragdollPhase.kind !== 'CORPSE_DYNAMIC' &&
        target.ragdollPhase.kind !== 'CORPSE_SLEEPING'
      ) {
        target.ragdollPhase = {
          kind: 'CORPSE_DYNAMIC',
          settleAccumS: 0,
          wokenWarmStart: false,
        };
      }
      break;
    }

    case 'ACTIVATE_RAGDOLL': {
      const wasGroundedCorpse =
        event.isOverkillCorpseHit &&
        target.isRagdollActive &&
        !target.alive &&
        target.posture === 'RAGDOLL_GROUNDED';

      target.isRagdollActive = true;
      target.dying = null;
      target.weaponDropped = true;
      target.activeReaction.type = 'NONE';
      target.activeReaction.timerS = 0;

      if (!target.alive) {
        target.combatantStatusTag = null;
        if (target.ragdollPhase.kind === 'INACTIVE' || target.ragdollPhase.kind === 'LIVING_AGONY') {
          target.ragdollPhase = {
            kind: 'CORPSE_DYNAMIC',
            settleAccumS: 0,
            wokenWarmStart: false,
          };
        }
      } else {
        if (target.combatantStatusTag === 'SIDEARM_DRAWING') {
          target.combatantStatusTag = null;
        }
        if (target.ragdollPhase.kind !== 'LIVING_AGONY') {
          target.ragdollPhase = { kind: 'LIVING_AGONY', agonyClockS: 0 };
        }
      }

      if (!wasGroundedCorpse) {
        target.posture = 'AIRBORNE_RAGDOLL';
      }
      break;
    }

    case 'UPDATE_RAGDOLL_GROUNDED': {
      if (target.isRagdollActive) {
        target.posture =
          event.groundedBoneCount >= 3 ? 'RAGDOLL_GROUNDED' : 'AIRBORNE_RAGDOLL';
      }
      break;
    }

    case 'APPLY_HITSTOP': {
      target.hitstopRemainingS = Math.max(target.hitstopRemainingS ?? 0, event.durationS);
      break;
    }
  }

  syncTargetLifecycleDerivedState(target);
}

/**
 * Steps ongoing physiological hemorrhage, reaction expiry, and post-reaction leg knockdown
 * for a living combatant before the PBD ragdoll solver runs.
 */
export function stepLivingTargetVitalsAndFall(
  target: TargetHealthState,
  dt: number,
  floorY: number
): void {
  if (!target.alive) {
    syncTargetLifecycleDerivedState(target);
    return;
  }

  if (target.bloodLossRateMlPerSec > 0) {
    target.bloodVolumeMl = Math.max(
      0,
      target.bloodVolumeMl - target.bloodLossRateMlPerSec * dt
    );
    const bloodRatio = target.bloodVolumeMl / 5000;
    target.systolicBpMmHg = Math.max(0, Math.round(120 * Math.pow(bloodRatio, 1.35)));
    target.consciousness = Math.max(
      0.2,
      Math.min(1.0, (target.bloodVolumeMl - 2500) / 2200)
    );
    target.currentHp = Math.max(
      0,
      target.currentHp - target.bloodLossRateMlPerSec * 0.16 * dt
    );

    if (target.bloodVolumeMl <= 2500 || target.currentHp <= 0) {
      const wasRagdoll = target.isRagdollActive;
      // Bled out on its feet: the knees give slowly and it slumps to the floor (DeathBleedOut).
      const bleedOutClip = canAnimateDeath(target);
      transitionTargetLifecycle(target, { kind: 'LETHAL_DEATH' });
      if (bleedOutClip) {
        startDeathAnimation(target, 'DeathBleedOut');
      } else if (!wasRagdoll) {
        transitionTargetLifecycle(target, {
          kind: 'ACTIVATE_RAGDOLL',
          isOverkillCorpseHit: false,
        });
        stabilizeRagdollPoseForTransition(target, floorY);
        // A little sideways sway, the same for a given combatant every time.
        const sway = createSeededRng(hashStringSeed(target.targetId))() - 0.5;
        const slump = vec3(sway * 0.5, 0, Math.cos(target.yawRad) * 0.75);
        target.ragdollBones.TORSO_UPPER_THORAX.velocity = slump;
        target.ragdollBones.HEAD_CRANIUM.velocity = scale(slump, 1.2);
      }
    }
  }

  // Read before the tick: the reaction that ends this frame decides how the body is handed over.
  const reactionBeforeTick = target.activeReaction.type;
  if (target.alive && reactionBeforeTick !== 'NONE') {
    transitionTargetLifecycle(target, { kind: 'TICK_PAIN_REACTION', dt });
  }

  // A body that sat down keeps SIT_DOWN through its collapse; once it is on the floor it takes
  // the downed phase planned during the fall (agony when nothing planned one).
  if (
    target.woundedPhase === 'SIT_DOWN' &&
    reactionBeforeTick !== 'NONE' &&
    isFallingReaction(reactionBeforeTick) &&
    target.activeReaction.type === 'NONE'
  ) {
    target.woundedPhase = target.plannedDownedPhase ?? 'DOWNED_AGONY';
    target.woundedPhaseTimerS = 0;
  }

  // A lost or useless leg drops the body once its fall has played. A lost arm keeps it on its
  // feet until it is weak enough for a last stand; then it plays the collapse and sits down to
  // fight on from the floor.
  const legGone = !target.rightLegFunctional || !target.leftLegFunctional;
  const armGoneAndSpent =
    listLostLimbs(target.severedZones).some((limb) => limb.startsWith('ARM')) &&
    target.currentHp <= target.maxHp * LAST_STAND_HP_FRACTION;
  // A body that chose to crawl away stays animated (SitToCrawl, then Crawl): the AI drags it
  // along the floor, so the gate must not hand it to the ragdoll or make it collapse again. A
  // seated last-stander (DOWNED_ENGAGE, DOWNED_AGONY) stays animated too, sitting where its fall
  // clip left it: the seated clips own it until it dies, and death drops the corpse from the seat.
  const onFloorAnimated = target.woundedPhase === 'DOWNED_CRAWL' || isSeatedPhase(target.woundedPhase);
  const standingIdle =
    target.alive && !target.isRagdollActive && target.activeReaction.type === 'NONE' && !onFloorAnimated;
  // A collapse that ended with no floor plan still must not stand the body back up.
  const downedOnFeet = reactionBeforeTick === 'DOWNED_COLLAPSE';
  if (standingIdle && armGoneAndSpent && !legGone && reactionBeforeTick !== 'DOWNED_COLLAPSE') {
    target.weaponDropped = true;
    transitionTargetLifecycle(target, {
      kind: 'START_PAIN_REACTION',
      reactionType: 'DOWNED_COLLAPSE',
      durationS: WOUND_CLIP_SECONDS.DOWNED_COLLAPSE,
      intensity: 0.8,
      hitDirectionWorld: vec3(Math.sin(target.yawRad), 0, Math.cos(target.yawRad)),
      postureOverride: 'LEG_BUCKLED',
    });
  } else if (standingIdle && legGone && endedStandingCommittedClip(reactionBeforeTick)) {
    // A leg went out while the arm-loss clip held the body (that hit only jolted it). The body is
    // still standing, so play the leg fall now rather than popping it straight into the ragdoll.
    target.weaponDropped = true;
    transitionTargetLifecycle(target, {
      kind: 'START_PAIN_REACTION',
      reactionType: !target.rightLegFunctional ? 'LEG_BUCKLE_RIGHT' : 'LEG_BUCKLE_LEFT',
      durationS: WOUND_CLIP_SECONDS.LEG_SHOT_FALL,
      intensity: 0.8,
      hitDirectionWorld: vec3(Math.sin(target.yawRad), 0, Math.cos(target.yawRad)),
      postureOverride: 'LEG_BUCKLED',
    });
  } else if (standingIdle && (legGone || armGoneAndSpent || downedOnFeet)) {
    dropLivingBodyToRagdoll(target, floorY, reactionBeforeTick !== 'NONE' && isFallingReaction(reactionBeforeTick));
  }

  if (onFloorAnimated && target.alive && !target.isRagdollActive && target.activeReaction.type === 'NONE') {
    settleSeatedOnFloor(target);
  }

  // Down on its face and settled there: no gun and no damage from here on (FACE_DOWN).
  if (target.alive) stepFaceDownSettle(target, dt, floorY);

  target.painShock = Math.max(0, target.painShock - dt * 0.55);
  syncTargetLifecycleDerivedState(target);
}

/**
 * An animated body sitting or crawling on the floor: its posture reads as on the floor, and a
 * seated one keeps facing the way it landed, which is where the downed fire cone points. It never
 * turns, so the facing is fixed on the first settled frame.
 */
function settleSeatedOnFloor(target: TargetHealthState): void {
  target.posture = 'LEG_BUCKLED';
  if (isSeatedPhase(target.woundedPhase) && target.downedFacingWorld === undefined) {
    target.downedFacingWorld = yawForward(target);
  }
}

/** True when the reaction that just ended was a long clip that leaves the body on its feet. */
function endedStandingCommittedClip(type: PainReactionType): boolean {
  return type !== 'NONE' && isCommittedWoundReaction(type) && !isFallingReaction(type);
}

/**
 * Hands a downed but living body to the ragdoll. When a fall clip has just played it is already
 * seated on the floor, so it only gets a small settling nudge; a body that went down without one
 * is thrown back and down onto its butt.
 */
function dropLivingBodyToRagdoll(target: TargetHealthState, floorY: number, clipAlreadyFell: boolean): void {
  transitionTargetLifecycle(target, {
    kind: 'ACTIVATE_RAGDOLL',
    isOverkillCorpseHit: false,
  });
  stabilizeRagdollPoseForTransition(target, floorY);
  // It lands facing roughly where it stood; the downed fire cone is measured from here.
  target.downedFacingWorld = yawForward(target);

  let dropVel = vec3(0, -SETTLE_DOWN_SPEED_MS, 0);
  if (!clipAlreadyFell) {
    const cosY = Math.cos(target.yawRad);
    const sinY = Math.sin(target.yawRad);
    // Down onto its butt: mostly back and down, leaning a little toward a bad leg.
    const sideSign = !target.rightLegFunctional ? -1.0 : !target.leftLegFunctional ? 1.0 : 0;
    const sideWorld = vec3(cosY * sideSign, 0, -sinY * sideSign);
    const fwdWorld = vec3(sinY, 0, cosY);
    dropVel = add(scale(sideWorld, 0.2), add(scale(fwdWorld, -0.6), vec3(0, -1.1, 0)));
  }

  for (const z of ALL_GHOUL_ZONES) {
    const b = target.ragdollBones[z];
    if (b.componentId === 'BODY') {
      b.velocity = copyVec3(dropVel);
    }
  }
  for (const aId of ALL_AUX_PARTICLES) {
    const a = target.auxParticles[aId];
    if (a.componentId === 'BODY') {
      a.velocity = copyVec3(dropVel);
    }
  }
}
