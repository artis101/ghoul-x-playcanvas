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
      /** How long this draw takes in all (the seated draw is slower); absent means the default. */
      readonly totalS?: number;
    }
  | { readonly kind: 'SIDEARM_ACTIVE'; readonly hand: ActiveFiringHand }
  | { readonly kind: 'DISARMED'; readonly sidearmDropped: boolean };

export type ArmamentTransitionEvent = 'SIDEARM_DRAW_START' | 'ALERT';

/**
 * What the wounded sequence lets the hands do with the pistol (docs/wound-movement.md):
 * - ALLOW: draw it, or keep it drawn.
 * - HOLSTER: not now (clutching, kneeling down, falling, lying in agony): it stays in, or an
 *   early draw goes back into, the holster, and can come out later.
 * - DROP: face down or crawling away: no pistol comes out (an early draw goes back in).
 * A pistol already drawn, or drawn far enough to be out of the holster
 * (SIDEARM_OUT_OF_HOLSTER_DRAW_FRACTION, the draw is then paused), is never taken by either: no
 * hit, fall or knockdown makes the fist let go.
 * It is lost only with the arm that holds it, or on death; whether it may fire is the sequence's
 * own fire gate (woundedPhaseAllowsFire).
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
  /**
   * Sitting its animated last stand on the floor (not in the ragdoll). Like a body lying in the
   * ragdoll it can only use the pistol, its drawn pistol is a LAST_STAND, and its LEG_BUCKLED
   * posture is never overwritten with DISARMED. Pass the seated draw time as the draw duration.
   */
  readonly seatedOnFloor?: boolean;
  /**
   * The long gun lies within reach and the fighter can go and get it (weaponRecovery.ts). It does
   * that instead of drawing the handgun; a pistol already out of the holster stays in the fist.
   */
  readonly primaryPickupPending?: boolean;
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
  /** Length of the draw under way, kept so the visual draw progress uses the right total. */
  sidearmDrawTotalS?: number;
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
      ...(runtime.sidearmDrawTotalS !== undefined ? { totalS: runtime.sidearmDrawTotalS } : {}),
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
      runtime.sidearmDrawTotalS = undefined;
      break;
    case 'SIDEARM_DRAWING':
      runtime.activeFiringHand = state.hand;
      runtime.sidearmDrawing = true;
      runtime.sidearmActive = false;
      runtime.sidearmDropped = false;
      runtime.sidearmDrawTimerS = state.remainingS;
      runtime.sidearmDrawTotalS = state.totalS;
      break;
    case 'SIDEARM_ACTIVE':
      runtime.activeFiringHand = state.hand;
      runtime.sidearmDrawing = false;
      runtime.sidearmActive = true;
      runtime.sidearmDropped = false;
      runtime.sidearmDrawTimerS = 0;
      runtime.sidearmDrawTotalS = undefined;
      break;
    case 'DISARMED':
      runtime.sidearmDrawing = false;
      runtime.sidearmActive = false;
      runtime.sidearmDropped = state.sidearmDropped;
      runtime.sidearmDrawTimerS = 0;
      runtime.sidearmDrawTotalS = undefined;
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
      forceDisarmedPosture: !input.isRagdollActive && !input.seatedOnFloor,
      cancelBurst: true,
      clampFireCooldownMaxS: null,
      statusTag: 'DISARMED',
    };
  }

  const intactHand = input.intactHand;

  // The arm holding the drawn (or half-drawn) pistol is gone or no longer works: so is the pistol.
  if (sidearmInHand(current) && !armIntact(input, current.hand)) {
    return fallbackResult({ kind: 'DISARMED', sidearmDropped: true }, [], true, 'DISARMED', {
      forceDisarmedPosture: !input.isRagdollActive && !input.woundClipPlaying && !input.seatedOnFloor,
    });
  }

  // A drawn sidearm stays in the fist while the body is thrown through the air, so a downed
  // combatant that gets knocked about again still has it when it lands. A draw under way is
  // paused, not undone: the pistol may already be out of the holster.
  if (input.isAirborneRagdoll && sidearmInHand(current)) {
    return {
      state: current,
      events: [],
      dropPrimaryWeapon: false,
      markPrimaryArmDisarmed: false,
      forceDisarmedPosture: false,
      cancelBurst: false,
      clampFireCooldownMaxS: null,
      statusTag: current.kind === 'SIDEARM_ACTIVE' ? 'LAST_STAND' : 'SIDEARM_DRAWING',
    };
  }

  const anyArmLost = !input.rightArmIntact || !input.leftArmIntact;
  const primaryDisarmed =
    anyArmLost || input.primaryArmDisarmed || (!input.isRagdollActive && input.weaponDropped);
  // A body lying or sitting on the floor cannot work a long gun; the pistol is all it can still use.
  const groundedRagdoll = (input.isRagdollActive && !input.isAirborneRagdoll) || input.seatedOnFloor === true;

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

/**
 * How far through its draw the pistol counts as out of the holster and in the hand. The visual
 * draw shows the pistol from DRAW_PISTOL_VISIBLE_PROGRESS / SEATED_DRAW_PISTOL_VISIBLE_AT (0.45);
 * this sits a little earlier so a draw the clip already shows in the fist is never undone.
 */
export const SIDEARM_OUT_OF_HOLSTER_DRAW_FRACTION = 0.35;

function drawFraction(
  state: Extract<EnemyArmamentState, { kind: 'SIDEARM_DRAWING' }>,
  input: EnemyArmamentTransitionInput
): number {
  const total = state.totalS ?? input.sidearmDrawDurationS;
  return total > 0 ? 1 - state.remainingS / total : 1;
}

function sidearmInHand(
  state: EnemyArmamentState
): state is Extract<EnemyArmamentState, { kind: 'SIDEARM_ACTIVE' | 'SIDEARM_DRAWING' }> {
  return state.kind === 'SIDEARM_ACTIVE' || state.kind === 'SIDEARM_DRAWING';
}

function armIntact(input: EnemyArmamentTransitionInput, hand: ActiveFiringHand): boolean {
  return hand === 'RIGHT' ? input.rightArmIntact : input.leftArmIntact;
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
      forceDisarmedPosture: !input.isRagdollActive && !input.woundClipPlaying && !input.seatedOnFloor,
    });
  }

  const events: ArmamentTransitionEvent[] = [];
  if (input.isGuarding) events.push('ALERT');

  // The long gun is within reach: go and pick it up rather than draw (or finish drawing) the pistol.
  if (input.primaryPickupPending && !groundedRagdoll && current.kind !== 'SIDEARM_ACTIVE') {
    const outOfHolster =
      current.kind === 'SIDEARM_DRAWING' && drawFraction(current, input) >= SIDEARM_OUT_OF_HOLSTER_DRAW_FRACTION;
    if (!outOfHolster) {
      return fallbackResult({ kind: 'DISARMED', sidearmDropped: false }, events, false, 'DISARMED');
    }
  }

  const rule = input.sidearmRule ?? 'ALLOW';
  const drawnTag: CombatantStatusTag = groundedRagdoll ? 'LAST_STAND' : 'SIDEARM_DRAWN';
  // Once drawn the pistol stays in the fist whatever the sequence says (its arm was checked above).
  if (current.kind === 'SIDEARM_ACTIVE') {
    return fallbackResult({ kind: 'SIDEARM_ACTIVE', hand: current.hand }, events, markArm, drawnTag, {
      cancelBurst: false,
    });
  }
  if (rule !== 'ALLOW') {
    // A draw far enough along that the pistol is out of the holster is paused in the fist (the
    // pistol prop is attached to the hand by then; undoing the draw would throw it on the floor).
    if (current.kind === 'SIDEARM_DRAWING' && drawFraction(current, input) >= SIDEARM_OUT_OF_HOLSTER_DRAW_FRACTION) {
      return fallbackResult(current, events, markArm, 'SIDEARM_DRAWING', { cancelBurst: false });
    }
    // Not now: it stays in (or an early draw goes back into) the holster, never on the floor.
    return fallbackResult({ kind: 'DISARMED', sidearmDropped: false }, events, markArm, 'DISARMED');
  }

  if (input.woundClipPlaying && current.kind !== 'SIDEARM_DRAWING') {
    // Hands busy with the wound for now; the draw starts on the first frame after the clip.
    return fallbackResult({ kind: 'DISARMED', sidearmDropped: false }, events, false, 'DISARMED');
  }

  let cancelBurst = false;
  let remainingS = current.kind === 'SIDEARM_DRAWING' ? current.remainingS : input.sidearmDrawDurationS;
  const totalS = current.kind === 'SIDEARM_DRAWING' ? current.totalS ?? input.sidearmDrawDurationS : input.sidearmDrawDurationS;
  if (current.kind !== 'SIDEARM_DRAWING') {
    events.push('SIDEARM_DRAW_START');
    cancelBurst = true;
  }
  if (input.dt > 0) remainingS = Math.max(0, remainingS - input.dt);

  // A draw under way keeps the hand that started it (its arm was checked above).
  const hand = current.kind === 'SIDEARM_DRAWING' ? current.hand : intactHand;
  if (remainingS <= 0) {
    return fallbackResult({ kind: 'SIDEARM_ACTIVE', hand }, events, markArm, drawnTag, {
      cancelBurst,
      clampFireCooldownMaxS: 0.08,
    });
  }
  return fallbackResult({ kind: 'SIDEARM_DRAWING', hand, remainingS, totalS }, events, markArm, 'SIDEARM_DRAWING', {
    cancelBurst,
  });
}
