import type { TargetHealthState } from '../../contracts/ballistics.ts';
import { isArmDeadButAttached } from '../../core/ghoul/anatomy/proceduralTraumaIk.ts';

export type PropAttachmentKind = 'ATTACHED' | 'HIDDEN_TEMP' | 'DETACHED_DROPPED';

export type PropAttachmentState<THand extends string = 'LEFT' | 'RIGHT'> =
  | { readonly kind: 'ATTACHED'; readonly hand?: THand }
  | { readonly kind: 'HIDDEN_TEMP'; readonly hand?: THand }
  | { readonly kind: 'DETACHED_DROPPED'; readonly lastHand?: THand };

export interface PropAttachmentTransitionInput<THand extends string = 'LEFT' | 'RIGHT'> {
  readonly shouldBeAttached: boolean;
  readonly temporarilyHidden?: boolean;
  readonly hand?: THand;
  readonly allowReattachAfterDrop?: boolean;
}

export interface PropAttachmentTransitionResult<THand extends string = 'LEFT' | 'RIGHT'> {
  readonly state: PropAttachmentState<THand>;
  readonly isVisible: boolean;
  readonly shouldSpawnDroppedProp: boolean;
  readonly dropHand: THand | undefined;
}

export function createPropAttachmentState<THand extends string = 'LEFT' | 'RIGHT'>(
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

export function transitionPropAttachment<THand extends string = 'LEFT' | 'RIGHT'>(
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
  | 'ANIM_STANDING'
  | 'ANIM_WOUNDED_POSTURE';

export interface MannequinDriveState {
  readonly mode: MannequinDriveMode;
  readonly leftArmDeadAttached: boolean;
  readonly rightArmDeadAttached: boolean;
}

export function resolveMannequinDriveState(healthState: TargetHealthState): MannequinDriveState {
  if (healthState.isRagdollActive || !healthState.alive || healthState.currentHp <= 0) {
    return {
      mode: 'FULL_RAGDOLL',
      leftArmDeadAttached: false,
      rightArmDeadAttached: false,
    };
  }

  const isStandingPosture =
    (healthState.posture === 'COMBAT_READY' || healthState.posture === 'DISARMED') &&
    healthState.activeReaction.type === 'NONE';

  return {
    mode: isStandingPosture ? 'ANIM_STANDING' : 'ANIM_WOUNDED_POSTURE',
    leftArmDeadAttached: isArmDeadButAttached(healthState, 'LEFT'),
    rightArmDeadAttached: isArmDeadButAttached(healthState, 'RIGHT'),
  };
}
