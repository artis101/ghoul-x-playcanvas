import { oppositeSide } from '../../core/ghoul/anatomy/handedness.ts';
import * as pc from 'playcanvas';
import type { TargetHealthState } from '../../contracts/ballistics.ts';
import { isArmChainIntactAndFunctional } from '../ai/combatantArmEvaluation.ts';
import type { CombatantGlbInstance } from '../assets/glbLoader.ts';
import { CombatantSupportGrip } from './combatantSupportGrip.ts';

// Body clips are authored around a held long gun. These are the ones an empty-handed combatant plays.
// The chest stagger is among them: its support hand reaches for a forend, which with no gun leaves
// the arm cocked up in front of the chest holding nothing.
// The newer wound clips (flinches, falls, losses, stump clutch) are left out on purpose: they
// author their own arms, clutching the wound or the stump, and must not be pulled to the sides.
const RELAXED_CLIPS = new Set([
  'CombatReadyIdle', 'UnsuspectingIdle', 'Walk', 'Run', 'WalkBackward', 'StrafeLeft', 'StrafeRight', 'LongGunAim',
  'HitStaggerChest',
]);
const SIDES = ['RIGHT', 'LEFT'] as const;
const EASE_RATE = 7;

/**
 * Hangs empty arms at the sides and swings them against the stride.
 * `onlySide` limits this to the free arm of a combatant carrying a weapon in one hand.
 */
export class CombatantUnarmedArms {
  private readonly arm = new CombatantSupportGrip();
  private readonly toCharacter = new pc.Mat4();
  private readonly shoulder = new pc.Vec3();
  private readonly foot = new pc.Vec3();
  private readonly hips = new pc.Vec3();
  private readonly wrist = new pc.Vec3();
  private readonly bend = new pc.Vec3();
  private handRest: Record<(typeof SIDES)[number], pc.Quat> | null = null;
  private weight = 0;

  public reset(): void {
    this.weight = 0;
  }

  public sync(
    glb: CombatantGlbInstance,
    healthState: TargetHealthState,
    emptyHanded: boolean,
    dt?: number,
    onlySide?: (typeof SIDES)[number],
  ): void {
    const clip = glb.animComponent?.baseLayer?.activeState?.replace('_Southpaw', '');
    const relaxed = emptyHanded && healthState.alive && !healthState.isRagdollActive &&
      clip !== undefined && RELAXED_CLIPS.has(clip);
    this.weight = dt === undefined
      ? Number(relaxed)
      : this.weight + (Number(relaxed) - this.weight) * (1 - Math.exp(-EASE_RATE * dt));
    if (this.weight < 0.01) return;

    const root = glb.rootEntity;
    const hips = glb.boneNodes.get('PELVIS_GROIN');
    if (!hips) return;
    this.toCharacter.copy(root.getWorldTransform()).invert();
    this.toCharacter.transformPoint(hips.getPosition(), this.hips);
    const ready = clip === 'CombatReadyIdle' || clip === 'LongGunAim';
    const rest = this.handRest ??= this.readHandRest(glb);

    for (const side of SIDES) {
      if (onlySide && side !== onlySide) continue;
      const upper = glb.boneNodes.get(`UPPER_ARM_${side}`);
      const hand = glb.boneNodes.get(`HAND_${side}`);
      const oppositeFoot = glb.boneNodes.get(`FOOT_${oppositeSide(side)}`);
      if (!upper || !hand || !isArmChainIntactAndFunctional(healthState, side)) continue;
      this.toCharacter.transformPoint(upper.getPosition(), this.shoulder);
      const out = Math.sign(this.shoulder.x - this.hips.x) || 1;
      // Each arm swings with the opposite leg.
      let swing = 0;
      if (oppositeFoot) {
        this.toCharacter.transformPoint(oppositeFoot.getPosition(), this.foot);
        swing = pc.math.clamp((this.foot.z - this.hips.z) * 0.45, -0.22, 0.22);
      }
      this.wrist.set(
        this.shoulder.x + out * (ready ? 0.05 : 0.07),
        this.shoulder.y - (ready ? 0.43 : 0.47) + Math.abs(swing) * 0.12,
        this.shoulder.z + (ready ? 0.13 : 0.05) + swing,
      );
      root.getWorldTransform().transformPoint(this.wrist, this.wrist);
      this.wrist.lerp(hand.getPosition(), this.wrist, this.weight);
      root.getRotation().transformVector(this.bend.set(out * 0.3, 0, -1), this.bend);
      if (!this.arm.reach(glb, side, this.wrist, this.bend)) continue;
      hand.setLocalRotation(rest[side]);
    }
  }

  private readHandRest(glb: CombatantGlbInstance): Record<(typeof SIDES)[number], pc.Quat> {
    const local = (side: (typeof SIDES)[number]): pc.Quat => {
      const hand = glb.boneBindPoses.get(`HAND_${side}`);
      const forearm = glb.boneBindPoses.get(`FOREARM_${side}`);
      if (!hand || !forearm) return new pc.Quat();
      return new pc.Quat().copy(forearm.modelRot).invert().mul(hand.modelRot);
    };
    return { RIGHT: local('RIGHT'), LEFT: local('LEFT') };
  }
}
