import * as pc from 'playcanvas';
import type { AmmoSpec, WeaponSpec } from '../../contracts/ballistics.ts';
import { WEAPONS, WEAPON_M590 } from '../../core/ballistics/weapons.ts';
import type { EngineMaterialPalette } from '../materials.ts';
import type { HudController } from '../hudController.ts';
import type { GlbModelRegistry, WeaponGlbInstance } from '../assets/glbLoader.ts';
import { type WeaponAmmoState, resolveGraphicsDeviceFromEntity } from './arsenalTypes.ts';
import { BarrelSmokeSystem } from './muzzleSmokeFx.ts';
import { AmmoInventory } from './ammoInventory.ts';
import { buildWeaponViewmodel } from './viewmodelBuilder.ts';

export class ArsenalManager {
  public readonly weaponViewmodelEntity: pc.Entity;
  public muzzleFlashEntity: pc.Entity;
  public activeWeaponGlb: WeaponGlbInstance | null = null;
  public currentWeaponIndex = 0;
  public currentWeapon: WeaponSpec = WEAPON_M590;
  public currentAmmo: AmmoSpec = WEAPON_M590.defaultAmmo;
  public readonly ammoInventory: Map<string, WeaponAmmoState>;
  public reloadTimerS = 0;
  public fireCooldownTimerS = 0;

  private readonly cameraEntity: pc.Entity;
  private readonly hudController: HudController;
  private readonly onWeaponSwitched?: (weapon: WeaponSpec) => void;
  private readonly inventory = new AmmoInventory();
  private readonly smokeSystem = new BarrelSmokeSystem();
  private readonly activeViewmodelMaterials: pc.StandardMaterial[] = [];
  private glbRegistry: GlbModelRegistry | null = null;
  private muzzleFlashTimerS = 0;
  private muzzleFlashDurationS = 0.056;
  private muzzleFlashBaseScale = 1.0;
  private fireAnimReturnTimerS = 0;
  private shotVisualCounter = 0;

  constructor(
    cameraEntity: pc.Entity,
    _materials: EngineMaterialPalette,
    hudController: HudController,
    onWeaponSwitched?: (weapon: WeaponSpec) => void,
    glbRegistry?: GlbModelRegistry | null
  ) {
    this.cameraEntity = cameraEntity;
    this.hudController = hudController;
    this.onWeaponSwitched = onWeaponSwitched;
    this.glbRegistry = glbRegistry ?? null;
    this.ammoInventory = this.inventory.states;

    this.weaponViewmodelEntity = new pc.Entity('WeaponViewmodel');
    this.weaponViewmodelEntity.setPosition(0.24, -0.22, -0.48);
    cameraEntity.addChild(this.weaponViewmodelEntity);

    this.muzzleFlashEntity = this.rebuildActiveViewmodel();
    this.initAmmoInventory();
    this.syncWeaponHud();
  }

  public rebuildActiveViewmodel(): pc.Entity {
    this.activeWeaponGlb?.destroy();
    const res = buildWeaponViewmodel(
      this.weaponViewmodelEntity,
      this.cameraEntity,
      this.currentWeapon,
      this.glbRegistry,
      this.activeViewmodelMaterials
    );
    this.activeWeaponGlb = res.activeGlb;
    this.muzzleFlashBaseScale = res.baseScale;
    return res.flashEntity;
  }

  public initAmmoInventory(): void {
    this.inventory.init();
    this.currentAmmo = this.inventory.getActiveAmmo(this.currentWeapon);
    this.reloadTimerS = 0;
    this.syncWeaponHud();
  }

  public selectWeaponByIndex(idx: number): void {
    const wrapped = ((idx % WEAPONS.length) + WEAPONS.length) % WEAPONS.length;
    if (wrapped === this.currentWeaponIndex && this.reloadTimerS <= 0) return;

    this.currentWeaponIndex = wrapped;
    this.currentWeapon = WEAPONS[wrapped];
    this.currentAmmo = this.inventory.getActiveAmmo(this.currentWeapon);
    this.reloadTimerS = 0;
    this.muzzleFlashTimerS = 0;
    this.fireAnimReturnTimerS = 0;

    this.muzzleFlashEntity = this.rebuildActiveViewmodel();
    this.onWeaponSwitched?.(this.currentWeapon);
    this.syncWeaponHud();
  }

  public cycleAmmoType(): void {
    const nextAmmo = this.inventory.cycleAmmo(this.currentWeapon);
    if (!nextAmmo) {
      this.hudController.pushSystemToast(this.currentWeapon.codeName, `${this.currentAmmo.caliber} ONLY`);
      return;
    }
    this.currentAmmo = nextAmmo;
    this.syncWeaponHud();
    this.hudController.pushSystemToast('AMMO LOADED', this.currentAmmo.name.toUpperCase());
  }

  public tryConsumeRoundForShot(): boolean {
    if (this.fireCooldownTimerS > 0 || this.reloadTimerS > 0) return false;
    if (!this.inventory.consumeShot(this.currentWeapon.id)) {
      this.startReload(false);
      return false;
    }

    this.fireCooldownTimerS = 60 / this.currentWeapon.fireRateRpm;
    this.syncWeaponHud();
    const weapon = this.activeWeaponGlb;
    const fireDuration = weapon?.getClipDuration(weapon.fireClipName) ?? 0;
    const fireSpeed = Math.max(1, fireDuration / this.fireCooldownTimerS);
    weapon?.playFire(fireSpeed);
    this.fireAnimReturnTimerS = Math.max(0.22, fireDuration / fireSpeed);

    this.shotVisualCounter++;
    const rollDeg = (this.shotVisualCounter * 67 + Math.random() * 28) % 360;
    const scaleJitter = this.muzzleFlashBaseScale * (0.9 + Math.random() * 0.24);
    this.muzzleFlashEntity.setLocalEulerAngles(0, 0, rollDeg);
    this.muzzleFlashEntity.setLocalScale(scaleJitter, scaleJitter, scaleJitter * 1.08);
    this.muzzleFlashEntity.enabled = true;
    this.muzzleFlashDurationS =
      this.currentWeapon.role === 'SHOTGUN' || this.currentWeapon.role === 'HEAVY_PISTOL' ? 0.062 : 0.052;
    this.muzzleFlashTimerS = this.muzzleFlashDurationS;

    const device = resolveGraphicsDeviceFromEntity(this.cameraEntity);
    if (device) this.smokeSystem.spawnWisp(device, this.cameraEntity, this.muzzleFlashEntity, this.currentWeapon.role);

    return true;
  }

  public startReload(allTargetsDead: boolean, onRespawnAll?: () => void): void {
    if (this.reloadTimerS > 0) return;
    if (!this.inventory.prepareReload(this.currentWeapon.id, allTargetsDead, onRespawnAll)) return;
    const weapon = this.activeWeaponGlb;
    const reloadSpeed = 1.15;
    this.reloadTimerS = Math.max(0.65, (weapon?.getClipDuration(weapon.reloadClipName) ?? 0) / reloadSpeed);
    weapon?.playReload(reloadSpeed);
    this.syncWeaponHud();
  }

  public syncWeaponHud(): void {
    const inv = this.inventory.get(this.currentWeapon.id);
    if (!inv) return;
    this.hudController.updateWeaponHud(this.currentWeapon, this.currentAmmo, inv.mag, inv.reserve, this.reloadTimerS > 0);
  }

  public update(dt: number): void {
    if (this.fireCooldownTimerS > 0) this.fireCooldownTimerS -= dt;
    if (this.muzzleFlashTimerS > 0) {
      this.muzzleFlashTimerS = Math.max(0, this.muzzleFlashTimerS - dt);
      const rem = this.muzzleFlashTimerS / Math.max(0.01, this.muzzleFlashDurationS);
      if (this.muzzleFlashTimerS <= 0) {
        this.muzzleFlashEntity.setLocalScale(0.00001, 0.00001, 0.00001);
      } else {
        const shrink = this.muzzleFlashBaseScale * (0.72 + 0.36 * rem);
        this.muzzleFlashEntity.setLocalScale(shrink, shrink, shrink * (0.85 + 0.3 * rem));
      }
    }
    this.smokeSystem.update(dt, this.cameraEntity);
    if (this.reloadTimerS > 0) {
      this.reloadTimerS -= dt;
      if (this.reloadTimerS <= 0) {
        this.reloadTimerS = 0;
        this.inventory.completeReload(this.currentWeapon.id);
        this.activeWeaponGlb?.playIdle(0.08);
        this.syncWeaponHud();
      }
    }
    if (this.fireAnimReturnTimerS > 0) {
      this.fireAnimReturnTimerS = Math.max(0, this.fireAnimReturnTimerS - dt);
      if (this.fireAnimReturnTimerS === 0 && this.reloadTimerS <= 0) {
        this.activeWeaponGlb?.playIdle(0.06);
        if (this.inventory.get(this.currentWeapon.id)?.mag === 0) this.startReload(false);
      }
    }
  }
}
