import type {
  CombatantArmamentState,
  CombatantBodyState,
  StandingCombatPosture,
  TargetHealthState,
  TargetLifecycleEvent,
} from '../../../contracts/ballistics.ts';
import { ALL_AUX_PARTICLES, ALL_GHOUL_ZONES } from '../../ghoul/anatomy.ts';
import { deriveCorpseSleepPhase } from '../ragdoll/corpseSleepFsm.ts';
import { stabilizeRagdollPoseForTransition } from '../ragdoll/ragdollPoseStabilizer.ts';
import { add, copyVec3, scale, vec3 } from '../vec3.ts';

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
  if (!target.leftLegFunctional || !target.rightLegFunctional) {
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
      transitionTargetLifecycle(target, { kind: 'LETHAL_DEATH' });
      if (!wasRagdoll) {
        transitionTargetLifecycle(target, {
          kind: 'ACTIVATE_RAGDOLL',
          isOverkillCorpseHit: false,
        });
        stabilizeRagdollPoseForTransition(target, floorY);
        const slump = vec3(
          (Math.random() - 0.5) * 0.5,
          0,
          Math.cos(target.yawRad) * 0.75
        );
        target.ragdollBones.TORSO_UPPER_THORAX.velocity = slump;
        target.ragdollBones.HEAD_CRANIUM.velocity = scale(slump, 1.2);
      }
    }
  }

  if (target.alive && target.activeReaction.type !== 'NONE') {
    transitionTargetLifecycle(target, { kind: 'TICK_PAIN_REACTION', dt });
  }

  if (
    target.alive &&
    (!target.leftLegFunctional || !target.rightLegFunctional) &&
    !target.isRagdollActive &&
    target.activeReaction.type === 'NONE'
  ) {
    transitionTargetLifecycle(target, {
      kind: 'ACTIVATE_RAGDOLL',
      isOverkillCorpseHit: false,
    });
    stabilizeRagdollPoseForTransition(target, floorY);

    const cosY = Math.cos(target.yawRad);
    const sinY = Math.sin(target.yawRad);
    const sideSign = !target.leftLegFunctional ? -1.0 : 1.0;
    const sideWorld = vec3(cosY * sideSign, 0, -sinY * sideSign);
    const fwdWorld = vec3(sinY, 0, cosY);
    const dropVel = add(
      scale(sideWorld, 0.55),
      add(scale(fwdWorld, -0.35), vec3(0, -1.1, 0))
    );

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

  target.painShock = Math.max(0, target.painShock - dt * 0.55);
  syncTargetLifecycleDerivedState(target);
}
