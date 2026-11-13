import type { CombatantGlbInstance } from '../assets/glbLoader.ts';
import { UPPER_BODY_LAYER } from './combatantUpperBodyLayer.ts';

/**
 * Turns the whole body so a bladed aim clip points its gun where the body is meant to face.
 *
 * The two-handed aims (LongGunAim, PistolAim) point the barrel straight down the body's forward,
 * but the one-handed takes are shot side-on: the standing one-hand aim puts the barrel about 39°
 * to the gun side, and the kneeling one about 93°. The AI turns `yawRad` to face its target, and
 * the aim delta only corrects ±15°, so without this the pistol points well wide and the fire gate
 * (the posed barrel must be on the player) never opens. Turning the root by the clip's own barrel
 * angle keeps the clip untouched and puts its gun on the target, the way a real shooter blades
 * the body to bring a one-handed gun to bear.
 *
 * The angles were measured on the baked GLB at the clips' held frames, by forward kinematics of
 * the trigger hand with the one-handed fist grip (sidearmFistGrip.ts). Positive is toward the
 * body's +X (heading = atan2(x, z)); the `_Southpaw` twins are mirrored, so their sign flips.
 * tests/aimClipFacing.test.ts re-measures them from the GLB so a rebake cannot leave them stale.
 */
export const AIM_CLIP_BARREL_YAW_DEG: Readonly<Record<string, number>> = {
  PistolAimOneHand: 39,
  KneelPistolAimOneHand: 93,
};

// About the clip cross-fade time, so the body turns as the arm comes up rather than snapping.
const TURN_RATE = 10;

interface LayerView {
  readonly name?: string;
  readonly activeState?: string | null;
  readonly weight?: number;
}

/**
 * How far the root must turn (radians, added to `yawRad`) for `state`'s barrel to point along
 * the body's intended facing; 0 for clips that already aim forward.
 */
export function aimClipFacingYawRad(state: string | null | undefined): number {
  if (!state) return 0;
  const southpaw = state.endsWith('_Southpaw');
  const deg = AIM_CLIP_BARREL_YAW_DEG[southpaw ? state.slice(0, -'_Southpaw'.length) : state];
  if (deg === undefined) return 0;
  return ((southpaw ? deg : -deg) * Math.PI) / 180;
}

/** The facing turn the anim layers ask for right now: the upper layer's share, then the base. */
export function layeredFacingYawRad(glb: Pick<CombatantGlbInstance, 'animComponent'>): number {
  const anim = glb.animComponent;
  if (!anim) return 0;
  const layers: readonly LayerView[] = anim.layers ?? (anim.baseLayer ? [anim.baseLayer] : []);
  const base = anim.baseLayer ?? layers[0];
  const upper = layers.find((layer) => layer?.name === UPPER_BODY_LAYER);
  const upperWeight = upper ? Math.max(0, Math.min(1, upper.weight ?? 0)) : 0;
  // The upper layer owns the arms over a gait; where it shows, its aim decides the turn.
  return aimClipFacingYawRad(upper?.activeState) * upperWeight + aimClipFacingYawRad(base?.activeState) * (1 - upperWeight);
}

/** Eases the facing turn per combatant so a clip change turns the body instead of popping it. */
export class CombatantAimFacing {
  public yawRad = 0;

  public reset(): void {
    this.yawRad = 0;
  }

  public update(glb: Pick<CombatantGlbInstance, 'animComponent'> | null, alive: boolean, dt: number): number {
    const goal = glb && alive ? layeredFacingYawRad(glb) : 0;
    const t = dt > 0 && Number.isFinite(dt) ? 1 - Math.exp(-TURN_RATE * dt) : 1;
    this.yawRad += (goal - this.yawRad) * t;
    return this.yawRad;
  }
}
