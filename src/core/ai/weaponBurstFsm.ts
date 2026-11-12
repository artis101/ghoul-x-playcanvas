export type WeaponBurstState =
  | { readonly kind: 'REACTION_HOLD'; readonly remainingS: number; readonly cooldownRemainingS: number }
  | { readonly kind: 'COOLDOWN'; readonly remainingS: number }
  | { readonly kind: 'BURSTING'; readonly shotsRemaining: number; readonly interShotS: number };

export type AlertedEngagementSubstate =
  | 'CLUTCHING_RETREAT'
  | 'BERSERKER_CHARGE'
  | 'COVER_SHELTER'
  | 'COVER_PEEK';

export type TraumaShockState =
  | { readonly kind: 'CLEAR' }
  | { readonly kind: 'NEUROGENIC_SHOCK'; readonly remainingS: number };

export interface SyncedBurstRuntimeFields {
  burstShotsRemaining: number;
  burstInterShotTimerS: number;
  fireCooldownTimerS: number;
  completedBurstCount: number;
  alertReactionTimerS?: number;
  hasFiredWarningShot?: boolean;
  timeWithoutLosS?: number;
  burstState?: WeaponBurstState;
}

export interface SyncedShockRuntimeFields {
  neurogenicShockTimerS: number;
  adrenaline: number;
  triageStatus: string;
  shockState?: TraumaShockState;
}

export interface ShockRecoveryHealthTarget {
  bloodVolumeMl: number;
  oxygenSaturationPct: number;
  consciousness: number;
  painShock: number;
}

export interface BurstCadenceStepInput {
  readonly dt: number;
  readonly hasLineOfSight: boolean;
  readonly isAimAligned: boolean;
  readonly desiredBurstShots: number;
  readonly nextInterShotDelayS: number;
  readonly nextBurstCooldownS: number;
}

export interface BurstCadenceStepResult {
  readonly state: WeaponBurstState;
  readonly shouldFireShot: boolean;
  readonly completedBurst: boolean;
}

export function createCooldownBurstState(remainingS: number): WeaponBurstState {
  return { kind: 'COOLDOWN', remainingS: Math.max(0, remainingS) };
}

export function reconcileWeaponBurstState(runtime: Readonly<SyncedBurstRuntimeFields>): WeaponBurstState {
  if (runtime.burstShotsRemaining > 0) {
    return {
      kind: 'BURSTING',
      shotsRemaining: runtime.burstShotsRemaining,
      interShotS: runtime.burstInterShotTimerS,
    };
  }
  const reactionS = runtime.alertReactionTimerS ?? 0;
  if (reactionS > 0) {
    return {
      kind: 'REACTION_HOLD',
      remainingS: reactionS,
      cooldownRemainingS: Math.max(0, runtime.fireCooldownTimerS),
    };
  }
  return { kind: 'COOLDOWN', remainingS: Math.max(0, runtime.fireCooldownTimerS) };
}

export function applyWeaponBurstStateToRuntime(
  runtime: SyncedBurstRuntimeFields,
  state: WeaponBurstState
): void {
  runtime.burstState = state;
  switch (state.kind) {
    case 'REACTION_HOLD':
      runtime.burstShotsRemaining = 0;
      runtime.burstInterShotTimerS = 0;
      runtime.fireCooldownTimerS = state.cooldownRemainingS;
      runtime.alertReactionTimerS = state.remainingS;
      break;
    case 'COOLDOWN':
      runtime.burstShotsRemaining = 0;
      runtime.burstInterShotTimerS = 0;
      runtime.fireCooldownTimerS = state.remainingS;
      break;
    case 'BURSTING':
      runtime.burstShotsRemaining = state.shotsRemaining;
      runtime.burstInterShotTimerS = state.interShotS;
      break;
  }
}

export function cancelActiveBurst(runtime: SyncedBurstRuntimeFields, minCooldownS = 0): WeaponBurstState {
  const nextCooldownS = Math.max(runtime.fireCooldownTimerS, minCooldownS);
  const reactionS = runtime.alertReactionTimerS ?? 0;
  const nextState: WeaponBurstState =
    reactionS > 0
      ? { kind: 'REACTION_HOLD', remainingS: reactionS, cooldownRemainingS: nextCooldownS }
      : { kind: 'COOLDOWN', remainingS: nextCooldownS };
  applyWeaponBurstStateToRuntime(runtime, nextState);
  return nextState;
}

export function enterAlertReactionHold(
  runtime: SyncedBurstRuntimeFields,
  minReactionS = 0.28
): WeaponBurstState {
  const nextReactionS = Math.max(runtime.alertReactionTimerS ?? 0, minReactionS);
  runtime.alertReactionTimerS = nextReactionS;
  if (runtime.burstShotsRemaining > 0) {
    const state = reconcileWeaponBurstState(runtime);
    runtime.burstState = state;
    return state;
  }
  const nextState: WeaponBurstState = {
    kind: 'REACTION_HOLD',
    remainingS: nextReactionS,
    cooldownRemainingS: Math.max(0, runtime.fireCooldownTimerS),
  };
  applyWeaponBurstStateToRuntime(runtime, nextState);
  return nextState;
}

export function tickAlertReactionHold(runtime: SyncedBurstRuntimeFields, dt: number): void {
  const prevReactionS = runtime.alertReactionTimerS ?? 0;
  if (prevReactionS <= 0) return;
  const nextReactionS = Math.max(0, prevReactionS - dt);
  runtime.alertReactionTimerS = nextReactionS;
  if (runtime.burstShotsRemaining <= 0) {
    const nextState: WeaponBurstState =
      nextReactionS > 0
        ? { kind: 'REACTION_HOLD', remainingS: nextReactionS, cooldownRemainingS: Math.max(0, runtime.fireCooldownTimerS) }
        : { kind: 'COOLDOWN', remainingS: Math.max(0, runtime.fireCooldownTimerS) };
    applyWeaponBurstStateToRuntime(runtime, nextState);
  }
}

export function stepWeaponBurstCadence(
  runtime: SyncedBurstRuntimeFields,
  input: BurstCadenceStepInput
): BurstCadenceStepResult {
  let state = reconcileWeaponBurstState(runtime);

  if (state.kind !== 'BURSTING') {
    const nextCooldown = Math.max(0, runtime.fireCooldownTimerS - input.dt);
    state =
      state.kind === 'REACTION_HOLD'
        ? { ...state, cooldownRemainingS: nextCooldown }
        : { kind: 'COOLDOWN', remainingS: nextCooldown };
    applyWeaponBurstStateToRuntime(runtime, state);
  }

  if (!input.hasLineOfSight) {
    const timeWithoutLosS = (runtime.timeWithoutLosS ?? 0) + input.dt;
    runtime.timeWithoutLosS = timeWithoutLosS;
    if (timeWithoutLosS >= 4.0) runtime.hasFiredWarningShot = false;
    if (state.kind === 'BURSTING') state = cancelActiveBurst(runtime, 0.25);
    return { state, shouldFireShot: false, completedBurst: false };
  }

  runtime.timeWithoutLosS = 0;
  if ((runtime.alertReactionTimerS ?? 0) > 0 || !input.isAimAligned) {
    return { state, shouldFireShot: false, completedBurst: false };
  }

  if (state.kind !== 'BURSTING') {
    if (runtime.fireCooldownTimerS <= 0) {
      state = { kind: 'BURSTING', shotsRemaining: Math.max(1, input.desiredBurstShots), interShotS: 0 };
      applyWeaponBurstStateToRuntime(runtime, state);
    }
    return { state, shouldFireShot: false, completedBurst: false };
  }

  const nextInterShotS = state.interShotS - input.dt;
  if (nextInterShotS > 0) {
    state = { kind: 'BURSTING', shotsRemaining: state.shotsRemaining, interShotS: nextInterShotS };
    applyWeaponBurstStateToRuntime(runtime, state);
    return { state, shouldFireShot: false, completedBurst: false };
  }

  const remainingAfterShot = state.shotsRemaining - 1;
  if (remainingAfterShot > 0) {
    state = { kind: 'BURSTING', shotsRemaining: remainingAfterShot, interShotS: input.nextInterShotDelayS };
    applyWeaponBurstStateToRuntime(runtime, state);
    return { state, shouldFireShot: true, completedBurst: false };
  }

  runtime.completedBurstCount += 1;
  state = { kind: 'COOLDOWN', remainingS: input.nextBurstCooldownS };
  applyWeaponBurstStateToRuntime(runtime, state);
  return { state, shouldFireShot: true, completedBurst: true };
}

export function evaluateAlertedEngagementSubstate(
  clutchingWound: boolean,
  isFanaticBerserker: boolean,
  isWounded: boolean,
  cyclePhase01: number
): AlertedEngagementSubstate {
  if (clutchingWound) return 'CLUTCHING_RETREAT';
  if (isFanaticBerserker && isWounded) return 'BERSERKER_CHARGE';
  return cyclePhase01 >= 0.2 && cyclePhase01 <= 0.88 ? 'COVER_PEEK' : 'COVER_SHELTER';
}

export function enterNeurogenicShock(runtime: SyncedShockRuntimeFields, durationS = 1.65): TraumaShockState {
  runtime.neurogenicShockTimerS = Math.max(runtime.neurogenicShockTimerS, durationS);
  const state: TraumaShockState = { kind: 'NEUROGENIC_SHOCK', remainingS: runtime.neurogenicShockTimerS };
  runtime.shockState = state;
  return state;
}

export function tickNeurogenicShockRecovery(
  dt: number,
  runtime: SyncedShockRuntimeFields,
  health: ShockRecoveryHealthTarget
): TraumaShockState {
  if (runtime.neurogenicShockTimerS <= 0) {
    const clearState: TraumaShockState = { kind: 'CLEAR' };
    runtime.shockState = clearState;
    return clearState;
  }

  runtime.neurogenicShockTimerS = Math.max(0, runtime.neurogenicShockTimerS - dt);
  if (runtime.neurogenicShockTimerS <= 0) {
    if (health.bloodVolumeMl > 2600 && health.oxygenSaturationPct >= 55) {
      health.consciousness = Math.max(
        health.consciousness,
        runtime.triageStatus === 'MORTALLY_WOUNDED' ? 0.48 : 0.78
      );
      health.painShock = Math.min(health.painShock, 0.52);
      runtime.adrenaline = Math.max(runtime.adrenaline, 0.88);
    }
    const clearState: TraumaShockState = { kind: 'CLEAR' };
    runtime.shockState = clearState;
    return clearState;
  }

  const activeState: TraumaShockState = { kind: 'NEUROGENIC_SHOCK', remainingS: runtime.neurogenicShockTimerS };
  runtime.shockState = activeState;
  return activeState;
}
