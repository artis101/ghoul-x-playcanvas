import type { ActiveFiringHand } from '../../contracts/ai/aiContracts.ts';
import type { TargetHealthState } from '../../contracts/ballistics/targetHealthContracts.ts';

export type { ActiveFiringHand };
export type CombatantStatusTag = NonNullable<TargetHealthState['combatantStatusTag']> | null;

export type EnemyArmamentState =
  | { readonly kind: 'PRIMARY_ARMED'; readonly hand: ActiveFiringHand }
  | {
      readonly kind: 'SIDEARM_DRAWING';
      readonly hand: ActiveFiringHand;
      readonly remainingS: number;
    }
  | { readonly kind: 'SIDEARM_ACTIVE'; readonly hand: ActiveFiringHand }
  | { readonly kind: 'DISARMED'; readonly sidearmDropped: boolean };

export type ArmamentTransitionEvent = 'SIDEARM_DRAW_START' | 'ALERT';

export interface EnemyArmamentTransitionInput {
  readonly dt: number;
  readonly alive: boolean;
  readonly rightArmIntact: boolean;
  readonly leftArmIntact: boolean;
  readonly preferredPrimaryHand: ActiveFiringHand;
  readonly intactHand: ActiveFiringHand | null;
  readonly weaponDropped: boolean;
  readonly primaryArmDisarmed: boolean;
  readonly isRagdollActive: boolean;
  readonly isAirborneRagdoll: boolean;
  readonly carriesBackupSidearm: boolean;
  readonly isGuarding: boolean;
  readonly isLastStandVital: boolean;
  readonly sidearmDrawDurationS: number;
}

export interface EnemyArmamentTransitionResult {
  readonly state: EnemyArmamentState;
  readonly events: readonly ArmamentTransitionEvent[];
  readonly dropPrimaryWeapon: boolean;
  readonly markPrimaryArmDisarmed: boolean;
  readonly forceDisarmedPosture: boolean;
  readonly cancelBurst: boolean;
  readonly clampFireCooldownMaxS: number | null;
  readonly statusTag: CombatantStatusTag;
}

export interface SyncedArmamentRuntimeFields {
  activeFiringHand: ActiveFiringHand;
  sidearmDrawTimerS: number;
  sidearmDrawing: boolean;
  sidearmActive: boolean;
  sidearmDropped: boolean;
  armamentState?: EnemyArmamentState;
}

export function createPrimaryArmedState(hand: ActiveFiringHand): EnemyArmamentState {
  return { kind: 'PRIMARY_ARMED', hand };
}

export function reconcileEnemyArmamentState(
  runtime: Readonly<SyncedArmamentRuntimeFields>
): EnemyArmamentState {
  if (runtime.sidearmDropped) {
    return { kind: 'DISARMED', sidearmDropped: true };
  }
  if (runtime.sidearmActive) {
    return { kind: 'SIDEARM_ACTIVE', hand: runtime.activeFiringHand };
  }
  if (runtime.sidearmDrawing) {
    return {
      kind: 'SIDEARM_DRAWING',
      hand: runtime.activeFiringHand,
      remainingS: Math.max(0, runtime.sidearmDrawTimerS),
    };
  }
  if (runtime.armamentState?.kind === 'DISARMED') {
    return runtime.armamentState;
  }
  return { kind: 'PRIMARY_ARMED', hand: runtime.activeFiringHand };
}

export function applyArmamentStateToRuntime(
  runtime: SyncedArmamentRuntimeFields,
  state: EnemyArmamentState
): void {
  runtime.armamentState = state;
  switch (state.kind) {
    case 'PRIMARY_ARMED':
      runtime.activeFiringHand = state.hand;
      runtime.sidearmDrawing = false;
      runtime.sidearmActive = false;
      runtime.sidearmDropped = false;
      runtime.sidearmDrawTimerS = 0;
      break;
    case 'SIDEARM_DRAWING':
      runtime.activeFiringHand = state.hand;
      runtime.sidearmDrawing = true;
      runtime.sidearmActive = false;
      runtime.sidearmDropped = false;
      runtime.sidearmDrawTimerS = state.remainingS;
      break;
    case 'SIDEARM_ACTIVE':
      runtime.activeFiringHand = state.hand;
      runtime.sidearmDrawing = false;
      runtime.sidearmActive = true;
      runtime.sidearmDropped = false;
      runtime.sidearmDrawTimerS = 0;
      break;
    case 'DISARMED':
      runtime.sidearmDrawing = false;
      runtime.sidearmActive = false;
      runtime.sidearmDropped = state.sidearmDropped;
      runtime.sidearmDrawTimerS = 0;
      break;
  }
}

export function stepEnemyArmamentState(
  current: EnemyArmamentState,
  input: EnemyArmamentTransitionInput
): EnemyArmamentTransitionResult {
  const hadSidearm =
    current.kind === 'SIDEARM_ACTIVE' ||
    current.kind === 'SIDEARM_DRAWING' ||
    (current.kind === 'DISARMED' && current.sidearmDropped);

  if (!input.alive) {
    return {
      state: { kind: 'DISARMED', sidearmDropped: hadSidearm },
      events: [],
      dropPrimaryWeapon: false,
      markPrimaryArmDisarmed: false,
      forceDisarmedPosture: false,
      cancelBurst: false,
      clampFireCooldownMaxS: null,
      statusTag: null,
    };
  }

  const bothArmsLost = (!input.rightArmIntact && !input.leftArmIntact) || input.intactHand === null;
  if (bothArmsLost) {
    return {
      state: { kind: 'DISARMED', sidearmDropped: hadSidearm },
      events: [],
      dropPrimaryWeapon: true,
      markPrimaryArmDisarmed: true,
      forceDisarmedPosture: !input.isRagdollActive,
      cancelBurst: true,
      clampFireCooldownMaxS: null,
      statusTag: 'DISARMED',
    };
  }

  const intactHand = input.intactHand;

  // A drawn sidearm stays in the fist while the body is thrown through the air, so a downed
  // combatant that gets knocked about again still has it when it lands.
  if (input.isAirborneRagdoll && current.kind === 'SIDEARM_ACTIVE') {
    return {
      state: { kind: 'SIDEARM_ACTIVE', hand: intactHand },
      events: [],
      dropPrimaryWeapon: false,
      markPrimaryArmDisarmed: false,
      forceDisarmedPosture: false,
      cancelBurst: false,
      clampFireCooldownMaxS: null,
      statusTag: 'LAST_STAND',
    };
  }

  const anyArmLost = !input.rightArmIntact || !input.leftArmIntact;
  const primaryDisarmed =
    anyArmLost || input.primaryArmDisarmed || (!input.isRagdollActive && input.weaponDropped);

  if (primaryDisarmed) {
    const sidearmAlreadyDropped = current.kind === 'DISARMED' && current.sidearmDropped;
    if (!input.carriesBackupSidearm || sidearmAlreadyDropped) {
      return {
        state: { kind: 'DISARMED', sidearmDropped: sidearmAlreadyDropped },
        events: [],
        dropPrimaryWeapon: true,
        markPrimaryArmDisarmed: true,
        forceDisarmedPosture: !input.isRagdollActive,
        cancelBurst: true,
        clampFireCooldownMaxS: null,
        statusTag: 'DISARMED',
      };
    }

    const events: ArmamentTransitionEvent[] = [];
    if (input.isGuarding) {
      events.push('ALERT');
    }

    if (current.kind === 'SIDEARM_ACTIVE') {
      return {
        state: { kind: 'SIDEARM_ACTIVE', hand: intactHand },
        events,
        dropPrimaryWeapon: true,
        markPrimaryArmDisarmed: true,
        forceDisarmedPosture: false,
        cancelBurst: false,
        clampFireCooldownMaxS: null,
        statusTag: 'SIDEARM_DRAWN',
      };
    }

    let cancelBurst = false;
    let remainingS =
      current.kind === 'SIDEARM_DRAWING' ? current.remainingS : input.sidearmDrawDurationS;

    if (current.kind !== 'SIDEARM_DRAWING') {
      events.push('SIDEARM_DRAW_START');
      cancelBurst = true;
    }

    if (input.dt > 0) {
      remainingS = Math.max(0, remainingS - input.dt);
    }

    if (remainingS <= 0) {
      return {
        state: { kind: 'SIDEARM_ACTIVE', hand: intactHand },
        events,
        dropPrimaryWeapon: true,
        markPrimaryArmDisarmed: true,
        forceDisarmedPosture: false,
        cancelBurst,
        clampFireCooldownMaxS: 0.08,
        statusTag: 'SIDEARM_DRAWN',
      };
    }

    return {
      state: { kind: 'SIDEARM_DRAWING', hand: intactHand, remainingS },
      events,
      dropPrimaryWeapon: true,
      markPrimaryArmDisarmed: true,
      forceDisarmedPosture: false,
      cancelBurst,
      clampFireCooldownMaxS: null,
      statusTag: 'SIDEARM_DRAWING',
    };
  }

  // Grounded living ragdoll with unbroken arms
  if (input.isRagdollActive && !input.isAirborneRagdoll) {
    const canUseBackupSidearm =
      input.carriesBackupSidearm && !(current.kind === 'DISARMED' && current.sidearmDropped);
    return {
      state: canUseBackupSidearm
        ? { kind: 'SIDEARM_ACTIVE', hand: intactHand }
        : { kind: 'PRIMARY_ARMED', hand: intactHand },
      events: [],
      dropPrimaryWeapon: false,
      markPrimaryArmDisarmed: false,
      forceDisarmedPosture: false,
      cancelBurst: false,
      clampFireCooldownMaxS: null,
      statusTag: 'LAST_STAND',
    };
  }

  return {
    state: { kind: 'PRIMARY_ARMED', hand: input.preferredPrimaryHand },
    events: [],
    dropPrimaryWeapon: false,
    markPrimaryArmDisarmed: false,
    forceDisarmedPosture: false,
    cancelBurst: false,
    clampFireCooldownMaxS: null,
    statusTag: input.isLastStandVital ? 'LAST_STAND' : null,
  };
}
