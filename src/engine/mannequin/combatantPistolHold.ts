import type * as pc from 'playcanvas';
import type { CombatantGlbInstance } from '../assets/glbTypes.ts';
import { SidearmFistGrip } from '../combat/sidearmFistGrip.ts';
import { armsClipName } from './combatantWeaponHands.ts';

/**
 * The Desert Eagle carried as a primary, held the way the backup pistol is: rigidly in the
 * animated fist, never through the long-gun barrel heading (combatantGunHeading.ts), which leans
 * the barrel toward a forend a pistol does not have.
 *
 * Only the pistol clips (PistolAim, PistolAimOneHand, PistolOneHandHold) use the fist grip; they
 * were baked for a pistol. The shared carry and the gaits (CombatReadyIdle, Walk, ...) and every
 * flinch keep the gun-follows-hand heading, since their wrists were baked for a rifle.
 */

/** How fast the wrist eases between the one-handed and the two-handed bend. */
const GRIP_BLEND_RATE = 10;

const PISTOL_CLIPS: ReadonlySet<string> = new Set(['PistolAim', 'PistolAimOneHand', 'PistolOneHandHold']);

export class CombatantPistolHold {
  private readonly fist = new SidearmFistGrip();
  private twoHand: number | null = null;

  public reset(): void {
    this.twoHand = null;
  }

  /** True while the arms play a clip baked for a pistol, so the fist grip owns the gun. */
  public static ownsGun(glb: CombatantGlbInstance): boolean {
    const clip = armsClipName(glb);
    return clip !== undefined && PISTOL_CLIPS.has(clip);
  }

  /**
   * Seats the pistol in the animated trigger fist. Two-handed only in `PistolAim` with a working
   * support arm; every one-handed clip holds it down the forearm.
   */
  public seat(
    gun: pc.Entity, glb: CombatantGlbInstance, hand: pc.GraphNode, side: 'RIGHT' | 'LEFT',
    supportArmWorks: boolean, dt: number | undefined,
  ): void {
    const clip = armsClipName(glb);
    const goal = supportArmWorks && clip === 'PistolAim' ? 1 : 0;
    const step = dt === undefined || !Number.isFinite(dt) ? 1 : 1 - Math.exp(-GRIP_BLEND_RATE * Math.max(0, dt));
    this.twoHand = this.twoHand === null || !supportArmWorks ? goal : this.twoHand + (goal - this.twoHand) * step;
    this.fist.seat(gun, gun, hand, side, this.twoHand);
  }
}
