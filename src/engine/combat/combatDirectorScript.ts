import * as pc from 'playcanvas';
import type { CombatDirector } from './combatDirector.ts';
import type { AmmoSpec, Vec3Like, WeaponSpec } from '../../contracts/ballistics.ts';

/**
 * @attribute {boolean} enableXRayInspector - Global toggle for anatomical X-ray inspector
 * @attribute {number} maxSniperRange - Maximum tracking range for sniper optic in meters
 */
export class CombatDirectorScript extends pc.ScriptType {
  public enableXRayInspector = false;
  public maxSniperRange = 150.0;

  public director: CombatDirector | null = null;

  public initialize(): void {
    this.app.on('combat:fire_weapon', this.onFireWeapon, this);
    this.app.on('combat:throw_grenade', this.onThrowGrenade, this);
    this.app.on('combat:xray_toggled', this.onXRayToggled, this);
  }

  public update(dt: number): void {
    if (this.director) {
      const camEntity = this.app.root.findByName('Camera') as pc.Entity | null;
      const cameraComp = camEntity?.camera ?? null;
      const hud = (this.app as any).hudController ?? null;
      this.director.update(dt, (this.app as any).time ?? 0, cameraComp, hud);
    }
  }

  public swap(old: CombatDirectorScript): void {
    this.director = old.director;
    this.enableXRayInspector = old.enableXRayInspector;
    this.maxSniperRange = old.maxSniperRange;
  }

  public destroy(): void {
    this.app.off('combat:fire_weapon', this.onFireWeapon, this);
    this.app.off('combat:throw_grenade', this.onThrowGrenade, this);
    this.app.off('combat:xray_toggled', this.onXRayToggled, this);
    if (this.director) {
      this.director.destroy();
      this.director = null;
    }
  }

  private onFireWeapon(payload: { weapon: WeaponSpec; ammo: AmmoSpec; origin: Vec3Like; aimDir: Vec3Like }): void {
    this.director?.fireWeapon(payload.weapon, payload.ammo, payload.origin, payload.aimDir);
  }

  private onThrowGrenade(payload: { origin: Vec3Like; aimDir: Vec3Like }): void {
    this.director?.throwFragGrenade(payload.origin, payload.aimDir);
  }

  private onXRayToggled(enabled: boolean): void {
    this.enableXRayInspector = enabled;
    this.director?.setXRayMode(enabled);
  }
}
