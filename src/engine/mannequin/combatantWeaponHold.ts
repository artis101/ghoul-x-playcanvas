import { oppositeSide } from '../../core/ghoul/anatomy/handedness.ts';
import * as pc from 'playcanvas';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import {
  solveSupportRail,
  solveWeaponHold,
  type WeaponHoldProfile,
  type WeaponHoldStance,
} from '../../core/ghoul/anatomy/weaponHold.ts';
import type { ActiveFiringHand } from '../ai/tacticalAiTypes.ts';
import type { CombatantGlbInstance, WeaponAssetId } from '../assets/glbLoader.ts';
import { TRIGGER_GRIPS } from './combatantWeaponGrip.ts';

// Grip rails and butt plates in each weapon model's authored coordinates.
export const WEAPON_HOLD_PROFILES: Partial<Record<WeaponAssetId, WeaponHoldProfile>> = {
  m4a1_carbine: {
    trigger: TRIGGER_GRIPS.m4a1_carbine,
    supportNear: { x: 0, y: -0.054, z: -0.21 },
    supportFar: { x: 0, y: -0.054, z: -0.35 },
    butt: { x: 0, y: -0.015, z: 0.298 },
  },
  m590_shotgun: {
    trigger: TRIGGER_GRIPS.m590_shotgun,
    supportNear: { x: 0, y: -0.037, z: -0.25 },
    supportFar: { x: 0, y: -0.037, z: -0.25 },
    butt: { x: 0, y: -0.02, z: 0.306 },
  },
  msg90_sniper: {
    trigger: TRIGGER_GRIPS.msg90_sniper,
    supportNear: { x: 0, y: -0.036, z: -0.2 },
    supportFar: { x: 0, y: -0.036, z: -0.36 },
    butt: { x: 0, y: -0.02, z: 0.348 },
  },
  silver_talon_50ae: {
    trigger: TRIGGER_GRIPS.silver_talon_50ae,
    supportNear: { x: 0, y: -0.058, z: 0.004 },
    supportFar: { x: 0, y: -0.058, z: 0.004 },
  },
};

function scaledProfile(profile: WeaponHoldProfile, size: number): WeaponHoldProfile {
  const scaled = (v: Vec3Like): Vec3Like => ({ x: v.x * size, y: v.y * size, z: v.z * size });
  return {
    trigger: scaled(profile.trigger),
    supportNear: scaled(profile.supportNear),
    supportFar: scaled(profile.supportFar),
    butt: profile.butt && scaled(profile.butt),
  };
}

const BLEND_RATE = 11;
const COMFORTABLE_REACH = 0.87;

/** Poses a held weapon against the shoulders and eases it between stances. */
export class CombatantWeaponHold {
  private readonly position = new pc.Vec3();
  private readonly rotation = new pc.Quat();
  private readonly targetPosition = new pc.Vec3();
  private readonly targetRotation = new pc.Quat();
  private readonly toCharacter = new pc.Mat4();
  private readonly inverseYaw = new pc.Quat();
  private readonly triggerShoulder = new pc.Vec3();
  private readonly supportShoulder = new pc.Vec3();
  private readonly support = new pc.Vec3();
  private readonly headBase = new pc.Vec3();
  private rail = 0;
  private active = false;

  public release(): void {
    this.active = false;
  }

  /**
   * Moves the weapon into the stance. Returns the support palm center in weapon space,
   * or null when the rig cannot carry this weapon two-handed.
   */
  public place(
    weapon: pc.GraphNode,
    glb: CombatantGlbInstance,
    weaponId: WeaponAssetId,
    stance: WeaponHoldStance,
    triggerHand: ActiveFiringHand,
    dt?: number,
  ): pc.Vec3 | null {
    const authored = WEAPON_HOLD_PROFILES[weaponId];
    const supportHand = oppositeSide(triggerHand);
    const triggerArm = glb.boneNodes.get(`UPPER_ARM_${triggerHand}`);
    const supportArm = glb.boneNodes.get(`UPPER_ARM_${supportHand}`);
    const supportForearm = glb.boneNodes.get(`FOREARM_${supportHand}`);
    const supportWrist = glb.boneNodes.get(`HAND_${supportHand}`);
    if (!authored || !triggerArm || !supportArm || !supportForearm || !supportWrist) return null;

    const size = weapon.getLocalScale().x;
    const profile = size === 1 ? authored : scaledProfile(authored, size);
    const root = glb.rootEntity;
    this.toCharacter.copy(root.getWorldTransform()).invert();
    this.toCharacter.transformPoint(triggerArm.getPosition(), this.triggerShoulder);
    this.toCharacter.transformPoint(supportArm.getPosition(), this.supportShoulder);
    const triggerSide = this.triggerShoulder.x < this.supportShoulder.x ? -1 : 1;
    const arm = supportForearm.getLocalPosition().length() + supportWrist.getLocalPosition().length();
    const reach = arm * COMFORTABLE_REACH;
    const head = glb.boneNodes.get('HEAD_CRANIUM');
    if (head) this.toCharacter.transformPoint(head.getPosition(), this.headBase);
    const pose = solveWeaponHold(
      stance, profile, this.triggerShoulder, this.supportShoulder, triggerSide, reach, head ? this.headBase : undefined,
    );
    this.targetPosition.set(pose.position.x, pose.position.y, pose.position.z);
    this.targetRotation.set(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w);

    const easing = this.active && dt !== undefined ? 1 - Math.exp(-BLEND_RATE * dt) : 0;
    if (easing) {
      this.position.lerp(this.position, this.targetPosition, easing);
      this.rotation.slerp(this.rotation, this.targetRotation, easing);
    } else if (this.active && dt !== undefined) {
      // A zero-length step holds the pose.
    } else if (!this.active && dt !== undefined && weapon.enabled) {
      // Ease in from wherever the weapon was being carried.
      this.toCharacter.transformPoint(weapon.getPosition(), this.position);
      this.inverseYaw.copy(root.getRotation()).invert();
      this.rotation.mul2(this.inverseYaw, weapon.getRotation());
    } else {
      this.position.copy(this.targetPosition);
      this.rotation.copy(this.targetRotation);
    }
    this.active = true;

    const rail = solveSupportRail(
      profile, { position: this.position, rotation: this.rotation }, this.supportShoulder, reach,
    );
    // Ease the palm along the rail so it never hops between frames.
    this.rail = easing ? this.rail + (rail - this.rail) * easing : rail;
    this.support.lerp(authored.supportNear as pc.Vec3, authored.supportFar as pc.Vec3, this.rail);

    root.getWorldTransform().transformPoint(this.position, this.targetPosition);
    this.targetRotation.mul2(root.getRotation(), this.rotation);
    weapon.setPosition(this.targetPosition);
    weapon.setRotation(this.targetRotation);
    return this.support;
  }
}
