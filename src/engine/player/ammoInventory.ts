import type { AmmoSpec, WeaponSpec } from '../../contracts/ballistics.ts';
import { WEAPONS, weaponCapacity } from '../../core/ballistics/weapons.ts';
import type { WeaponAmmoState } from './arsenalTypes.ts';

export class AmmoInventory {
  public readonly states: Map<string, WeaponAmmoState> = new Map();

  constructor() {
    this.init();
  }

  public init(): void {
    this.states.clear();
    for (const w of WEAPONS) {
      const cap = weaponCapacity(w.id);
      this.states.set(w.id, {
        magCap: cap.magCap,
        mag: cap.magCap,
        reserve: cap.reserve,
        ammoIndex: 0,
      });
    }
  }

  public get(weaponId: string): WeaponAmmoState | undefined {
    return this.states.get(weaponId);
  }

  public getActiveAmmo(weapon: WeaponSpec): AmmoSpec {
    const inv = this.states.get(weapon.id);
    if (!inv) return weapon.defaultAmmo;
    return weapon.availableAmmo[inv.ammoIndex] || weapon.defaultAmmo;
  }

  public cycleAmmo(weapon: WeaponSpec): AmmoSpec | null {
    if (weapon.availableAmmo.length <= 1) return null;
    const inv = this.states.get(weapon.id);
    if (!inv) return null;
    inv.ammoIndex = (inv.ammoIndex + 1) % weapon.availableAmmo.length;
    return weapon.availableAmmo[inv.ammoIndex] || weapon.defaultAmmo;
  }

  public canShoot(weaponId: string): boolean {
    const inv = this.states.get(weaponId);
    return Boolean(inv && inv.mag > 0);
  }

  public consumeShot(weaponId: string): boolean {
    const inv = this.states.get(weaponId);
    if (!inv || inv.mag <= 0) return false;
    inv.mag -= 1;
    return true;
  }

  public prepareReload(weaponId: string, allTargetsDead: boolean, onRespawnAll?: () => void): boolean {
    const inv = this.states.get(weaponId);
    if (!inv) return false;

    if (inv.mag >= inv.magCap) {
      if (allTargetsDead && onRespawnAll) {
        onRespawnAll();
        this.init();
      }
      return false;
    }

    if (inv.reserve <= 0) {
      inv.reserve = inv.magCap * 3;
    }
    return true;
  }

  public completeReload(weaponId: string): void {
    const inv = this.states.get(weaponId);
    if (!inv) return;
    const needed = inv.magCap - inv.mag;
    const loaded = Math.min(needed, inv.reserve);
    inv.mag += loaded;
    inv.reserve -= loaded;
  }

}
