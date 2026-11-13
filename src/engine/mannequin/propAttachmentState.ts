import type { TargetHealthState } from '../../contracts/ballistics.ts';
import { isArmDeadButAttached } from '../../core/ghoul/anatomy/proceduralTraumaIk.ts';
import { isDyingAnimated } from '../../core/ballistics/lifecycle/deathAnimation.ts';

export type PropAttachmentKind = 'ATTACHED' | 'HIDDEN_TEMP' | 'DETACHED_DROPPED';

export type PropAttachmentState<THand extends string = 'RIGHT' | 'LEFT'> =
  | { readonly kind: 'ATTACHED'; readonly hand?: THand }
  | { readonly kind: 'HIDDEN_TEMP'; readonly hand?: THand }
  | { readonly kind: 'DETACHED_DROPPED'; readonly lastHand?: THand };

export interface PropAttachmentTransitionInput<THand extends string = 'RIGHT' | 'LEFT'> {
  readonly shouldBeAttached: boolean;
  readonly temporarilyHidden?: boolean;
  readonly hand?: THand;
  readonly allowReattachAfterDrop?: boolean;
}

export interface PropAttachmentTransitionResult<THand extends string = 'RIGHT' | 'LEFT'> {
  readonly state: PropAttachmentState<THand>;
  readonly isVisible: boolean;
  readonly shouldSpawnDroppedProp: boolean;
  readonly dropHand: THand | undefined;
}

export function createPropAttachmentState<THand extends string = 'RIGHT' | 'LEFT'>(
  initialKind: PropAttachmentKind = 'ATTACHED',
  hand?: THand
): PropAttachmentState<THand> {
  if (initialKind === 'ATTACHED') {
    return { kind: 'ATTACHED', hand };
  }
  if (initialKind === 'HIDDEN_TEMP') {
    return { kind: 'HIDDEN_TEMP', hand };
  }
  return { kind: 'DETACHED_DROPPED', lastHand: hand };
}

export function transitionPropAttachment<THand extends string = 'RIGHT' | 'LEFT'>(
  prev: PropAttachmentState<THand>,
  input: PropAttachmentTransitionInput<THand>
): PropAttachmentTransitionResult<THand> {
  if (prev.kind === 'DETACHED_DROPPED') {
    if (input.shouldBeAttached && input.allowReattachAfterDrop) {
      return {
        state: { kind: 'ATTACHED', hand: input.hand },
        isVisible: true,
        shouldSpawnDroppedProp: false,
        dropHand: undefined,
      };
    }
    return {
      state: prev,
      isVisible: false,
      shouldSpawnDroppedProp: false,
      dropHand: prev.lastHand,
    };
  }

  const effectiveHand = input.hand ?? prev.hand;

  if (input.shouldBeAttached) {
    return {
      state: { kind: 'ATTACHED', hand: effectiveHand },
      isVisible: true,
      shouldSpawnDroppedProp: false,
      dropHand: undefined,
    };
  }

  if (input.temporarilyHidden) {
    return {
      state: { kind: 'HIDDEN_TEMP', hand: effectiveHand },
      isVisible: false,
      shouldSpawnDroppedProp: false,
      dropHand: effectiveHand,
    };
  }

  const wasPreviouslyHeld =
    prev.kind === 'ATTACHED' || (prev.kind === 'HIDDEN_TEMP' && prev.hand !== undefined);

  return {
    state: { kind: 'DETACHED_DROPPED', lastHand: effectiveHand },
    isVisible: false,
    shouldSpawnDroppedProp: wasPreviouslyHeld,
    dropHand: effectiveHand,
  };
}

export type MannequinDriveMode =
  | 'FULL_RAGDOLL'
  /** Dead on its feet: the death clip plays, then the corpse ragdoll takes over. */
  | 'ANIM_DYING'
  | 'ANIM_STANDING'
  | 'ANIM_WOUNDED_POSTURE';

export interface MannequinDriveState {
  readonly mode: MannequinDriveMode;
  readonly rightArmDeadAttached: boolean;
  readonly leftArmDeadAttached: boolean;
}

/**
 * `distalStumpAnimated` says the GLB has the stump clips, so a hand or forearm stump follows the
 * body clip instead of hanging as a dead arm.
 */
export function resolveMannequinDriveState(
  healthState: TargetHealthState,
  distalStumpAnimated = true
): MannequinDriveState {
  if (!healthState.isRagdollActive && isDyingAnimated(healthState)) {
    return { mode: 'ANIM_DYING', rightArmDeadAttached: false, leftArmDeadAttached: false };
  }
  if (healthState.isRagdollActive || !healthState.alive || healthState.currentHp <= 0) {
    return {
      mode: 'FULL_RAGDOLL',
      rightArmDeadAttached: false,
      leftArmDeadAttached: false,
    };
  }

  // A body hurt in the chest, gut or throat is still on its feet and may walk (HurtWalk), so it
  // samples a gait like any standing body once its reaction is over.
  const posture = healthState.posture;
  const isStandingPosture =
    (posture === 'COMBAT_READY' || posture === 'DISARMED' ||
      posture === 'STAGGERED' || posture === 'GUT_HURT' || posture === 'THROAT_CLUTCH') &&
    healthState.activeReaction.type === 'NONE';

  return {
    mode: isStandingPosture ? 'ANIM_STANDING' : 'ANIM_WOUNDED_POSTURE',
    rightArmDeadAttached: isArmDeadButAttached(healthState, 'RIGHT', distalStumpAnimated),
    leftArmDeadAttached: isArmDeadButAttached(healthState, 'LEFT', distalStumpAnimated),
  };
}
