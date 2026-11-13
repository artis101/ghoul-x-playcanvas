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

/**
 * What the wounded sequence lets the hands do with the pistol (docs/wound-movement.md):
 * - ALLOW: draw it, or keep it drawn.
 * - HOLSTER: not now (clutching, kneeling down, falling, lying in agony): it stays in, or goes
 *   back in, the holster, and can come out later.
 * - DROP: face down or crawling away: a drawn pistol is let go of for good.
 */
export type SidearmRule = 'ALLOW' | 'HOLSTER' | 'DROP';

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
  /** Mortally wounded but on its feet: only the HUD's LAST STAND label, it never arms anything. */
  readonly isLastStandVital: boolean;
  readonly sidearmDrawDurationS: number;
  /**
   * A fall, loss or collapse clip is playing. The sidearm draw waits for it to end (the arm-loss
   * clip shows the recoil and the stump clutch first), and the clip's posture is left alone.
   */
  readonly woundClipPlaying?: boolean;
  /** The wounded sequence's say on the pistol. Absent means ALLOW (previews outside the AI). */
  readonly sidearmRule?: SidearmRule;
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
  // combatant that gets knocked about again still has it when it lands. One the wounded sequence
  // has made let go of it (face down, crawling) does not get it back this way.
  if (input.isAirborneRagdoll && current.kind === 'SIDEARM_ACTIVE' && input.sidearmRule !== 'DROP') {
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
  // A body lying on the floor cannot work a long gun; the pistol is all it can still use.
  const groundedRagdoll = input.isRagdollActive && !input.isAirborneRagdoll;

  if (primaryDisarmed || groundedRagdoll) {
    return stepSidearmFallback(current, input, intactHand, primaryDisarmed, groundedRagdoll);
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

function fallbackResult(
  state: EnemyArmamentState,
  events: readonly ArmamentTransitionEvent[],
  markPrimaryArmDisarmed: boolean,
  statusTag: CombatantStatusTag,
  extra: Partial<EnemyArmamentTransitionResult> = {}
): EnemyArmamentTransitionResult {
  return {
    state,
    events,
    dropPrimaryWeapon: true,
    markPrimaryArmDisarmed,
    forceDisarmedPosture: false,
    cancelBurst: true,
    clampFireCooldownMaxS: null,
    statusTag,
    ...extra,
  };
}

/**
 * The long gun is gone (an arm lost or wounded, the gun knocked away) or the body lies on the
 * floor. Only the backup pistol is left, and the wounded sequence decides when it may come out.
 */
function stepSidearmFallback(
  current: EnemyArmamentState,
  input: EnemyArmamentTransitionInput,
  intactHand: ActiveFiringHand,
  primaryDisarmed: boolean,
  groundedRagdoll: boolean
): EnemyArmamentTransitionResult {
  // Letting go of the rifle on the floor is not an arm wound, so it is not marked as one.
  const markArm = primaryDisarmed;
  const sidearmAlreadyDropped = current.kind === 'DISARMED' && current.sidearmDropped;
  if (!input.carriesBackupSidearm || sidearmAlreadyDropped) {
    return fallbackResult({ kind: 'DISARMED', sidearmDropped: sidearmAlreadyDropped }, [], markArm, 'DISARMED', {
      forceDisarmedPosture: !input.isRagdollActive && !input.woundClipPlaying,
    });
  }

  const events: ArmamentTransitionEvent[] = [];
  if (input.isGuarding) events.push('ALERT');

  const rule = input.sidearmRule ?? 'ALLOW';
  const sidearmOut = current.kind === 'SIDEARM_ACTIVE' || current.kind === 'SIDEARM_DRAWING';
  if (rule === 'DROP') {
    return fallbackResult({ kind: 'DISARMED', sidearmDropped: sidearmOut }, events, markArm, 'DISARMED');
  }
  if (rule === 'HOLSTER') {
    return fallbackResult({ kind: 'DISARMED', sidearmDropped: false }, events, markArm, 'DISARMED');
  }

  const drawnTag: CombatantStatusTag = groundedRagdoll ? 'LAST_STAND' : 'SIDEARM_DRAWN';
  if (current.kind === 'SIDEARM_ACTIVE') {
    return fallbackResult({ kind: 'SIDEARM_ACTIVE', hand: intactHand }, events, markArm, drawnTag, {
      cancelBurst: false,
    });
  }

  if (input.woundClipPlaying && current.kind !== 'SIDEARM_DRAWING') {
    // Hands busy with the wound for now; the draw starts on the first frame after the clip.
    return fallbackResult({ kind: 'DISARMED', sidearmDropped: false }, events, false, 'DISARMED');
  }

  let cancelBurst = false;
  let remainingS = current.kind === 'SIDEARM_DRAWING' ? current.remainingS : input.sidearmDrawDurationS;
  if (current.kind !== 'SIDEARM_DRAWING') {
    events.push('SIDEARM_DRAW_START');
    cancelBurst = true;
  }
  if (input.dt > 0) remainingS = Math.max(0, remainingS - input.dt);

  if (remainingS <= 0) {
    return fallbackResult({ kind: 'SIDEARM_ACTIVE', hand: intactHand }, events, markArm, drawnTag, {
      cancelBurst,
      clampFireCooldownMaxS: 0.08,
    });
  }
  return fallbackResult({ kind: 'SIDEARM_DRAWING', hand: intactHand, remainingS }, events, markArm, 'SIDEARM_DRAWING', {
    cancelBurst,
  });
}
