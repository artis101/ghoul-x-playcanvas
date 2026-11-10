import * as pc from 'playcanvas';
import { WeaponSpec, AmmoSpec } from '../../contracts/ballistics.ts';
import { WEAPONS, WEAPON_M590 } from '../../core/ballistics/weapons.ts';
import { EngineMaterialPalette } from '../materials.ts';
import { populatePlayerWeaponViewmodel } from '../retroMeshBuilder.ts';
import { HudController } from '../hudController.ts';

export interface WeaponAmmoState {
  magCap: number;
  mag: number;
  reserve: number;
  ammoIndex: number;
}

export const WEAPON_CAPACITIES: Record<string, { magCap: number; reserve: number }> = {
  m590_shotgun: { magCap: 8, reserve: 40 },
  silver_talon_50ae: { magCap: 7, reserve: 35 },
  msg90_sniper: { magCap: 20, reserve: 60 },
  m4a1_carbine: { magCap: 30, reserve: 120 },
};

export class ArsenalManager {
  public readonly weaponViewmodelEntity: pc.Entity;
  public muzzleFlashEntity: pc.Entity;
  public currentWeaponIndex = 0;
  public currentWeapon: WeaponSpec = WEAPON_M590;
  public currentAmmo: AmmoSpec = WEAPON_M590.defaultAmmo;
  public readonly ammoInventory: Map<string, WeaponAmmoState> = new Map();
  public reloadTimerS = 0;
  public fireCooldownTimerS = 0;

  private readonly materials: EngineMaterialPalette;
  private readonly hudController: HudController;
  private readonly onWeaponSwitched?: (weapon: WeaponSpec) => void;
  private muzzleFlashTimeout: number | null = null;

  constructor(
    cameraEntity: pc.Entity,
    materials: EngineMaterialPalette,
    hudController: HudController,
    onWeaponSwitched?: (weapon: WeaponSpec) => void
  ) {
    this.materials = materials;
    this.hudController = hudController;
    this.onWeaponSwitched = onWeaponSwitched;

    this.weaponViewmodelEntity = new pc.Entity('WeaponViewmodel');
    this.weaponViewmodelEntity.setPosition(0.24, -0.22, -0.48);
    cameraEntity.addChild(this.weaponViewmodelEntity);

    this.muzzleFlashEntity = populatePlayerWeaponViewmodel(
      this.weaponViewmodelEntity,
      this.currentWeapon,
      this.materials
    );

    this.initAmmoInventory();
    this.syncWeaponHud();
  }

  public initAmmoInventory(): void {
    this.ammoInventory.clear();
    for (const w of WEAPONS) {
      const cap = WEAPON_CAPACITIES[w.id] || { magCap: 12, reserve: 48 };
      this.ammoInventory.set(w.id, {
        magCap: cap.magCap,
        mag: cap.magCap,
        reserve: cap.reserve,
        ammoIndex: 0,
      });
    }
    const activeInv = this.ammoInventory.get(this.currentWeapon.id);
    if (activeInv) {
      this.currentAmmo =
        this.currentWeapon.availableAmmo[activeInv.ammoIndex] || this.currentWeapon.defaultAmmo;
    }
    this.reloadTimerS = 0;
    this.syncWeaponHud();
  }

  public selectWeaponByIndex(idx: number): void {
    const wrapped = ((idx % WEAPONS.length) + WEAPONS.length) % WEAPONS.length;
    if (wrapped === this.currentWeaponIndex && this.reloadTimerS <= 0) return;

    this.currentWeaponIndex = wrapped;
    this.currentWeapon = WEAPONS[wrapped];
    const inv = this.ammoInventory.get(this.currentWeapon.id);
    const ammoIdx = inv ? inv.ammoIndex : 0;
    this.currentAmmo = this.currentWeapon.availableAmmo[ammoIdx] || this.currentWeapon.defaultAmmo;
    this.reloadTimerS = 0;

    if (this.muzzleFlashTimeout !== null) {
      window.clearTimeout(this.muzzleFlashTimeout);
      this.muzzleFlashTimeout = null;
    }

    this.muzzleFlashEntity = populatePlayerWeaponViewmodel(
      this.weaponViewmodelEntity,
      this.currentWeapon,
      this.materials
    );

    this.onWeaponSwitched?.(this.currentWeapon);
    this.syncWeaponHud();
  }

  public cycleAmmoType(): void {
    const avail = this.currentWeapon.availableAmmo;
    if (avail.length <= 1) {
      this.hudController.pushSystemToast(
        this.currentWeapon.codeName,
        `${this.currentAmmo.caliber} ONLY`
      );
      return;
    }

    const inv = this.ammoInventory.get(this.currentWeapon.id);
    if (!inv) return;

    inv.ammoIndex = (inv.ammoIndex + 1) % avail.length;
    this.currentAmmo = avail[inv.ammoIndex];
    this.syncWeaponHud();
    this.hudController.pushSystemToast('AMMO LOADED', this.currentAmmo.name.toUpperCase());
  }

  public tryConsumeRoundForShot(): boolean {
    if (this.fireCooldownTimerS > 0 || this.reloadTimerS > 0) return false;

    const inv = this.ammoInventory.get(this.currentWeapon.id);
    if (!inv || inv.mag <= 0) {
      this.startReload(false);
      return false;
    }

    inv.mag -= 1;
    this.fireCooldownTimerS = 60 / this.currentWeapon.fireRateRpm;
    this.syncWeaponHud();

    this.muzzleFlashEntity.enabled = true;
    if (this.muzzleFlashTimeout !== null) {
      window.clearTimeout(this.muzzleFlashTimeout);
    }
    this.muzzleFlashTimeout = window.setTimeout(() => {
      if (this.muzzleFlashEntity) {
        this.muzzleFlashEntity.enabled = false;
      }
      this.muzzleFlashTimeout = null;
    }, 42);

    if (inv.mag === 0) {
      window.setTimeout(() => this.startReload(false), 220);
    }

    return true;
  }

  public startReload(allTargetsDead: boolean, onRespawnAll?: () => void): void {
    if (this.reloadTimerS > 0) return;
    const inv = this.ammoInventory.get(this.currentWeapon.id);
    if (!inv) return;

    if (inv.mag >= inv.magCap) {
      // Convenience: if mag is already full and all hostiles are dead, [R] also spawns a fresh squad!
      if (allTargetsDead && onRespawnAll) {
        onRespawnAll();
        this.initAmmoInventory();
      }
      return;
    }

    if (inv.reserve <= 0) {
      // Refill tactical reserve from depot crate on empty so player never gets permanently stuck
      inv.reserve = inv.magCap * 3;
    }

    this.reloadTimerS = 0.65;
    this.syncWeaponHud();
  }

  public syncWeaponHud(): void {
    const inv = this.ammoInventory.get(this.currentWeapon.id);
    if (!inv) return;
    this.hudController.updateWeaponHud(
      this.currentWeapon,
      this.currentAmmo,
      inv.mag,
      inv.reserve,
      this.reloadTimerS > 0
    );
  }

  public update(dt: number): void {
    if (this.fireCooldownTimerS > 0) {
      this.fireCooldownTimerS -= dt;
    }

    if (this.reloadTimerS > 0) {
      this.reloadTimerS -= dt;
      if (this.reloadTimerS <= 0) {
        this.reloadTimerS = 0;
        const inv = this.ammoInventory.get(this.currentWeapon.id);
        if (inv) {
          const needed = inv.magCap - inv.mag;
          const loaded = Math.min(needed, inv.reserve);
          inv.mag += loaded;
          inv.reserve -= loaded;
        }
        this.syncWeaponHud();
      }
    }
  }
}
