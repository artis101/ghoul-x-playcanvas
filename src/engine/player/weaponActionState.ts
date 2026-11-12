import type { WeaponGlbInstance } from '../assets/glbLoader.ts';

export const GRENADE_GESTURE_SECONDS = 0.24;

export interface GrenadeGestureResources {
  readonly model: WeaponGlbInstance;
  readonly release: () => void;
}

export type ViewmodelActionState =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'FIRING';
      readonly cooldownRemainingS: number;
      readonly animReturnRemainingS: number;
    }
  | { readonly kind: 'RELOADING'; readonly remainingS: number }
  | {
      readonly kind: 'THROWING_GRENADE';
      readonly elapsedS: number;
      readonly durationS: number;
      readonly resources: GrenadeGestureResources;
    };

export type MuzzleFlashPhase =
  | { readonly kind: 'INACTIVE' }
  | {
      readonly kind: 'FLASHING';
      readonly remainingS: number;
      readonly durationS: number;
    };

export function transitionViewmodelAction(
  current: ViewmodelActionState,
  next: ViewmodelActionState,
  activeWeaponGlb: WeaponGlbInstance | null
): ViewmodelActionState {
  if (
    current.kind === 'THROWING_GRENADE' &&
    (next.kind !== 'THROWING_GRENADE' || next.resources !== current.resources)
  ) {
    current.resources.model.destroy();
    if (activeWeaponGlb) {
      activeWeaponGlb.rootEntity.enabled = true;
    }
  }

  if (next.kind === 'THROWING_GRENADE') {
    if (activeWeaponGlb) {
      activeWeaponGlb.rootEntity.enabled = false;
    }
  }

  return next;
}

export function canFireViewmodelAction(state: ViewmodelActionState): boolean {
  if (state.kind === 'IDLE') return true;
  if (state.kind === 'FIRING') return state.cooldownRemainingS <= 0;
  return false;
}

export function canStartReloadAction(state: ViewmodelActionState): boolean {
  return state.kind !== 'RELOADING' && state.kind !== 'THROWING_GRENADE';
}

export function canStartGrenadeThrowAction(state: ViewmodelActionState): boolean {
  return state.kind !== 'RELOADING' && state.kind !== 'THROWING_GRENADE';
}

export function getReloadRemainingS(state: ViewmodelActionState): number {
  return state.kind === 'RELOADING' ? state.remainingS : 0;
}

export function getFireCooldownRemainingS(state: ViewmodelActionState): number {
  return state.kind === 'FIRING' ? state.cooldownRemainingS : 0;
}

export function stepGrenadeThrowPose(
  state: Extract<ViewmodelActionState, { kind: 'THROWING_GRENADE' }>,
  dt: number
): {
  readonly nextState: Extract<ViewmodelActionState, { kind: 'THROWING_GRENADE' }>;
  readonly completed: boolean;
} {
  const nextElapsedS = state.elapsedS + dt;
  const durationS = Math.max(0.001, state.durationS);
  const t = Math.min(1, nextElapsedS / durationS);
  const lift = Math.sin((t * Math.PI) / 2);

  const root = state.resources.model.rootEntity;
  root.setLocalPosition(0.24 - 0.11 * lift, -0.35 + 0.25 * lift, -0.47 - 0.18 * t);
  root.setLocalEulerAngles(-15 + 32 * t, 0, 18 * (1 - t));

  return {
    nextState: {
      ...state,
      elapsedS: nextElapsedS,
    },
    completed: t >= 1,
  };
}
