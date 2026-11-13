import type { PainReactionType, Vec3Like } from './ballisticsTypes.ts';
import type { ActivePainReaction } from './targetHealthContracts.ts';

/**
 * Explicit attachment state for each GHOUL PBD ragdoll bone particle.
 * Eliminates compound boolean checks coupling `severed`, `componentId`, and `goreMode`.
 */
export type RagdollBoneAttachmentState =
  | 'ATTACHED'
  | 'DETACHED_LIMB'
  | 'OBLITERATED_HIDDEN';

/**
 * Corpse settling & sleep phase sub-state for dead ragdoll physics.
 */
export type CorpseSleepPhase =
  | {
      readonly kind: 'DYNAMIC';
      settleAccumS: number;
      wokenWarmStart: boolean;
    }
  | {
      readonly kind: 'SLEEPING';
    };

/**
 * Explicit discriminated union replacing hidden off-struct WeakMap registries
 * (`corpseSleepRegistry` and `livingGroundAgonyClock`) on TargetHealthState.
 */
export type RagdollPhaseState =
  | { readonly kind: 'INACTIVE' }
  | { readonly kind: 'LIVING_AGONY'; agonyClockS: number }
  | {
      readonly kind: 'CORPSE_DYNAMIC';
      settleAccumS: number;
      wokenWarmStart: boolean;
      /** Seconds this corpse has spent on the floor still spreading out of the heap it fell in. */
      unfoldingS?: number;
    }
  | { readonly kind: 'CORPSE_SLEEPING' };

/**
 * The authored death clips (`Death*` in ghoul_combatant.glb). Each starts from the combat-ready
 * stance and ends with the body lying still; none has a mirrored twin.
 */
export type DeathClipId =
  | 'DeathFallBack'
  | 'DeathFallForward'
  | 'DeathCrumple'
  | 'DeathSpin'
  | 'DeathBleedOut';

/**
 * A body killed on its feet plays a death clip before the corpse ragdoll takes over. While it
 * plays the body is dead (`alive` false) but still animated, so its hitboxes follow the clip.
 */
export interface DyingAnimationState {
  clip: DeathClipId;
  /** Seconds the clip has played. */
  timerS: number;
  /** The clip's length; the corpse ragdoll takes over once `timerS` reaches it. */
  durationS: number;
}

/**
 * Standing combatant posture subset (excludes airborne/grounded ragdoll states).
 */
export type StandingCombatPosture =
  | 'COMBAT_READY'
  | 'STAGGERED'
  | 'THROAT_CLUTCH'
  | 'GUT_HURT'
  | 'LEG_BUCKLED'
  | 'DISARMED';

/**
 * Orthogonal body lifecycle discriminated union.
 */
export type CombatantBodyState =
  | {
      readonly kind: 'STANDING';
      posture: StandingCombatPosture;
      reaction: ActivePainReaction | null;
      hitstopRemainingS: number;
    }
  | {
      readonly kind: 'RAGDOLL_LIVING';
      grounded: boolean;
      agonyElapsedS: number;
      hitstopRemainingS: number;
    }
  | {
      /** Dead, but still on its feet playing a death clip; the ragdoll takes over when it ends. */
      readonly kind: 'DYING';
      dying: DyingAnimationState;
      hitstopRemainingS: number;
    }
  | {
      readonly kind: 'RAGDOLL_CORPSE';
      sleepPhase: CorpseSleepPhase;
      hitstopRemainingS: number;
    };

/**
 * Orthogonal armament lifecycle state for a combatant.
 */
export type CombatantArmamentState =
  | 'PRIMARY_READY'
  | 'PRIMARY_DISARMED_DRAWING_SIDEARM'
  | 'SIDEARM_READY'
  | 'LAST_STAND_GROUNDED'
  | 'COMPLETELY_DISARMED';

/**
 * Pure transition events for TargetHealthState lifecycle reducer.
 */
export type TargetLifecycleEvent =
  | {
      readonly kind: 'START_PAIN_REACTION';
      readonly reactionType: PainReactionType;
      readonly durationS: number;
      readonly intensity: number;
      readonly hitDirectionWorld: Vec3Like;
      readonly postureOverride?: StandingCombatPosture;
    }
  | {
      readonly kind: 'TICK_PAIN_REACTION';
      readonly dt: number;
    }
  | {
      readonly kind: 'PRIMARY_ARM_DISARM';
    }
  | {
      readonly kind: 'LETHAL_DEATH';
    }
  | {
      readonly kind: 'ACTIVATE_RAGDOLL';
      readonly isOverkillCorpseHit: boolean;
    }
  | {
      readonly kind: 'UPDATE_RAGDOLL_GROUNDED';
      readonly groundedBoneCount: number;
    }
  | {
      readonly kind: 'APPLY_HITSTOP';
      readonly durationS: number;
    };
