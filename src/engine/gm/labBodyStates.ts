import type { CombatantMovementClip } from '../mannequin/combatantLocomotion.ts';
import { gunKindOf } from '../mannequin/combatantWeaponPoseMap.ts';
import type { WeaponAssetId } from '../assets/glbTypes.ts';

/**
 * The Character Lab's body states, as the game composes them: a stance (what the body does
 * standing still), a motion (the gait over it) and whether the gun is raised. Which of the three
 * are offered follows from the weapon the same way the anim controller's own rules do.
 */
export type Stance = 'READY' | 'GUARD' | 'HURT' | 'UNARMED';
export type Motion = 'STAND' | CombatantMovementClip['clip'];

export interface BodyState {
  readonly stance: Stance;
  readonly motion: Motion;
  readonly aim: boolean;
}

export const STANCE_LABELS: Record<Stance, string> = {
  READY: 'Ready', GUARD: 'Guard', HURT: 'Hurt', UNARMED: 'Unarmed',
};

export const MOTION_LABELS: Record<Motion, string> = {
  STAND: 'Stand still', Walk: 'Walk', Run: 'Run', StrafeLeft: 'Strafe left', StrafeRight: 'Strafe right',
  WalkBackward: 'Walk backward',
};

export const STANCES: readonly Stance[] = ['READY', 'GUARD', 'HURT', 'UNARMED'];
export const MOTIONS: readonly Motion[] = ['STAND', 'Walk', 'Run', 'StrafeLeft', 'StrafeRight', 'WalkBackward'];

/** The clip a stance and motion stand for on the base layer, so a GLB lacking it hides the button. */
function requiredClip(stance: Stance, motion: Motion): string | null {
  if (stance === 'HURT' && motion === 'Walk') return 'HurtWalk';
  if (stance === 'UNARMED' && (motion === 'Walk' || motion === 'Run')) return `Unarmed${motion}`;
  return null;
}

/** The stances a weapon offers; with no weapon only empty hands make sense. */
export function stancesFor(weapon: WeaponAssetId | null): readonly Stance[] {
  return weapon ? STANCES : ['UNARMED'];
}

/** Whether the gun can be raised from a stance: a gun in hand, ready or hurt, never a grenade. */
export function canRaiseGun(weapon: WeaponAssetId | null, stance: Stance): boolean {
  return weapon !== null && weapon !== 'frag_grenade' && (stance === 'READY' || stance === 'HURT');
}

export function motionsFor(stance: Stance, available: ReadonlySet<string>): readonly Motion[] {
  return MOTIONS.filter((motion) => {
    const clip = requiredClip(stance, motion);
    return !clip || available.has(clip);
  });
}

/** The nearest valid state when the weapon, stance or motion picked no longer offers the current one. */
export function normalizeState(
  state: BodyState, weapon: WeaponAssetId | null, available: ReadonlySet<string>,
): BodyState {
  const stances = stancesFor(weapon);
  const stance = stances.includes(state.stance) ? state.stance : stances[0];
  const motion = motionsFor(stance, available).includes(state.motion) ? state.motion : 'STAND';
  return { stance, motion, aim: state.aim && canRaiseGun(weapon, stance) };
}

export function isPistol(weapon: WeaponAssetId | null): boolean {
  return weapon !== null && gunKindOf(weapon) === 'PISTOL';
}

/** The movement the lab hands the anim controller; every gait plays at its nominal pace. */
export function movementFor(motion: Motion): CombatantMovementClip | undefined {
  return motion === 'STAND' ? undefined : { clip: motion, playbackSpeed: 1 };
}
