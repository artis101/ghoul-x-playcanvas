import * as pc from 'playcanvas';
import type { CombatDirector } from './combatDirector.ts';
import type { AmmoSpec, Vec3Like, WeaponSpec } from '../../contracts/ballistics.ts';
import type { HudController } from '../hudController.ts';

/**
 * @attribute {boolean} enableXRayInspector - Global toggle for anatomical X-ray inspector
 * @attribute {number} maxSniperRange - Maximum tracking range for sniper optic in meters
 */
export class CombatDirectorScript extends pc.Script {
  public static scriptName = 'combatDirectorScript';

  public enableXRayInspector = false;
  public maxSniperRange = 150.0;

  public director: CombatDirector | null = null;
  private cachedCameraEntity: pc.Entity | null = null;
  private readonly _eventCleanups: Array<() => void> = [];

  public initialize(): void {
    this.refreshCameraReference();
    this.bindEvents();
  }

  private refreshCameraReference(camEntity?: pc.Entity | null): void {
    if (camEntity !== undefined) {
      this.cachedCameraEntity = camEntity;
      return;
    }
    this.cachedCameraEntity = (this.app.root.findByName('Camera') as pc.Entity | null) ?? null;
  }

  private bindEvents(): void {
    this.unbindEvents();
    this.app.on('combat:fire_weapon', this.onFireWeapon, this);
    this.app.on('combat:throw_grenade', this.onThrowGrenade, this);
    this.app.on('combat:xray_toggled', this.onXRayToggled, this);
    this.app.on('combat:camera_changed', this.onCameraChanged, this);
    this._eventCleanups.push(
      () => this.app.off('combat:fire_weapon', this.onFireWeapon, this),
      () => this.app.off('combat:throw_grenade', this.onThrowGrenade, this),
      () => this.app.off('combat:xray_toggled', this.onXRayToggled, this),
      () => this.app.off('combat:camera_changed', this.onCameraChanged, this)
    );
  }

  private unbindEvents(): void {
    for (const cleanup of this._eventCleanups) {
      cleanup();
    }
    this._eventCleanups.length = 0;
  }

  public update(dt: number): void {
    if (this.director) {
      const cameraComp = this.cachedCameraEntity?.camera ?? null;
      const appWithState = this.app as { hudController?: HudController; time?: number };
      const hud = appWithState.hudController ?? null;
      if (hud) {
        this.director.update(dt, appWithState.time ?? 0, cameraComp, hud);
      }
    }
  }

  public swap(old: CombatDirectorScript): void {
    old.unbindEvents();
    this.director = old.director;
    old.director = null;
    this.cachedCameraEntity = old.cachedCameraEntity;
    this.enableXRayInspector = old.enableXRayInspector;
    this.maxSniperRange = old.maxSniperRange;
    this.bindEvents();
  }

  public destroy(): void {
    this.unbindEvents();
    this.cachedCameraEntity = null;
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

  private onCameraChanged(camEntity?: pc.Entity | null): void {
    this.refreshCameraReference(camEntity);
  }
}

try {
  (pc.registerScript as (script: typeof pc.Script, name?: string) => void)(
    CombatDirectorScript,
    'combatDirectorScript'
  );
} catch {
  // No active pc.Application at module import time in headless tests
}
