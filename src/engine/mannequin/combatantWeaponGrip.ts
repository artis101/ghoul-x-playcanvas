import * as pc from 'playcanvas';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { WeaponAssetId } from '../assets/glbLoader.ts';

// Palm centers in the weapon model's authored coordinates.
export const TRIGGER_GRIPS: Readonly<Record<WeaponAssetId, pc.Vec3>> = {
  m4a1_carbine: new pc.Vec3(0, -0.05, 0.023),
  m590_shotgun: new pc.Vec3(0, -0.016, 0.068),
  msg90_sniper: new pc.Vec3(0, -0.06, 0.027),
  silver_talon_50ae: new pc.Vec3(0, -0.045, 0.02),
  frag_grenade: new pc.Vec3(),
};

export const M4A1_PALM_OFFSET_X = 0.027;

export class CombatantWeaponGrip {
  private readonly rotation = new pc.Quat();
  private readonly offset = new pc.Vec3();

  public align(
    holder: pc.GraphNode,
    weapon: pc.GraphNode,
    weaponId: WeaponAssetId,
    palm: Vec3Like,
    barrelDirection: Vec3Like,
    palmOffsetX = 0,
  ): void {
    // PlayCanvas forward and the GLB barrel both use local -Z.
    const yaw = Math.atan2(-barrelDirection.x, -barrelDirection.z) * pc.math.RAD_TO_DEG;
    const pitch = Math.atan2(barrelDirection.y, Math.hypot(barrelDirection.x, barrelDirection.z)) * pc.math.RAD_TO_DEG;
    this.rotation.setFromEulerAngles(pitch, yaw, 0);
    this.offset.copy(TRIGGER_GRIPS[weaponId]);
    this.offset.x += palmOffsetX;
    this.offset.mul(weapon.getLocalScale());
    this.rotation.transformVector(this.offset, this.offset);
    holder.setRotation(this.rotation);
    holder.setPosition(palm.x - this.offset.x, palm.y - this.offset.y, palm.z - this.offset.z);
  }
}
