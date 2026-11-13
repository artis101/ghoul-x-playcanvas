import type { TargetHealthState } from '../../contracts/ballistics.ts';
import { isFlinchHoldingBody } from '../ai/woundClipHold.ts';
import {
  markWeaponPickupProgress, PICKUP_GUN_IN_HAND_PROGRESS, PICKUP_WEAPON_CLIP_S,
} from '../ai/weaponRecovery.ts';
import type { CombatantAimPose } from '../mannequin/combatantAnimController.ts';
import { primaryAimPose } from '../mannequin/combatantWeaponPoseMap.ts';

/**
 * Character Lab stand-ins for what the tactical AI does to a standing body: drop or pick up the
 * gun, walk, aim, stand hurt. The lab has no AI agent, so these let the clips the AI would ask
 * for (unarmed, pickup, hurt walk, aim while walking) be watched. No engine code here.
 */
export type LabAct = 'DROP_GUN' | 'PICK_UP_GUN' | 'WALK' | 'STOP' | 'AIM' | 'HURT';

/** Walking pace: a steady walk, well under the run threshold. */
const WALK_SPEED_MS = 1.2;
/** The walk goes this far ahead of the start and this far behind it, facing the stand-in. */
const WALK_AHEAD_M = 1.5;
const WALK_BACK_M = -1.5;

export class LabActs {
  public walking = false;
  public aiming = false;
  private hurt = false;
  private walkDir = 1;
  /** Seconds into the reach for the gun, or null while not picking it up. */
  private pickupS: number | null = null;

  /** Starts an act. Returns a short line for the sequence log. */
  public start(hs: TargetHealthState, act: LabAct): string {
    switch (act) {
      case 'DROP_GUN':
        hs.weaponDropped = true;
        hs.posture = 'DISARMED';
        hs.combatantStatusTag = 'DISARMED';
        return 'gun knocked away';
      case 'PICK_UP_GUN':
        this.walking = false;
        this.pickupS = 0;
        return 'reaches for the gun';
      case 'WALK':
        this.walking = true;
        return 'walks';
      case 'STOP':
        this.walking = false;
        return 'stops';
      case 'AIM':
        this.aiming = true;
        return 'aims';
      case 'HURT':
        this.hurt = true;
        return 'stands hurt';
    }
  }

  /**
   * Steps the acts on the body. Returns true on the frame the gun is back in hand, so the caller
   * can rearm its armament the way weaponRecovery.ts does.
   */
  public step(hs: TargetHealthState, dt: number): boolean {
    if (!hs.alive || hs.isRagdollActive) {
      this.pickupS = null;
      markWeaponPickupProgress(hs, null);
      return false;
    }
    // The hurt posture is what the AI leaves on a body hit in the gut, once the flinch is over.
    if (this.hurt && hs.activeReaction.type === 'NONE') hs.posture = 'GUT_HURT';
    if (this.pickupS !== null) return this.stepPickup(hs, dt);
    if (this.walking && !isFlinchHoldingBody(hs)) this.stepWalk(hs, dt);
    return false;
  }

  /** The aim the game would pass while this body aims with its primary. */
  public aimPose(hs: TargetHealthState): CombatantAimPose | undefined {
    if (!this.aiming || !hs.alive) return undefined;
    return primaryAimPose(hs);
  }

  private stepPickup(hs: TargetHealthState, dt: number): boolean {
    this.pickupS = (this.pickupS ?? 0) + dt;
    if (this.pickupS < PICKUP_WEAPON_CLIP_S * PICKUP_GUN_IN_HAND_PROGRESS) {
      markWeaponPickupProgress(hs, Math.max(1e-4, this.pickupS / PICKUP_WEAPON_CLIP_S));
      return false;
    }
    this.pickupS = null;
    markWeaponPickupProgress(hs, null);
    hs.weaponDropped = false;
    hs.primaryArmDisarmed = false;
    hs.posture = 'COMBAT_READY';
    if (hs.combatantStatusTag === 'DISARMED') hs.combatantStatusTag = null;
    return true;
  }

  /** Walks forward and back along the facing (+Z), so both Walk and WalkBackward play. */
  private stepWalk(hs: TargetHealthState, dt: number): void {
    const z = hs.worldPosition.z + this.walkDir * WALK_SPEED_MS * dt;
    if (z >= WALK_AHEAD_M) this.walkDir = -1;
    else if (z <= WALK_BACK_M) this.walkDir = 1;
    hs.worldPosition.z = Math.max(WALK_BACK_M, Math.min(WALK_AHEAD_M, z));
  }
}
