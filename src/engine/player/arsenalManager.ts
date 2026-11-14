import * as pc from 'playcanvas';
import type { AmmoSpec, WeaponSpec } from '../../contracts/ballistics.ts';
import { isFullAuto } from '../../core/ballistics/weapons/weaponHandling.ts';
import { WEAPONS, WEAPON_M590, fireCycleS, RELOAD_ANIM_SPEED, reloadDurationS } from '../../core/ballistics/weapons.ts';
import type { EngineMaterialPalette } from '../materials.ts';
import type { HudController } from '../hudController.ts';
import type { GlbModelRegistry, WeaponGlbInstance } from '../assets/glbLoader.ts';
import { type WeaponAmmoState, resolveGraphicsDeviceFromEntity } from './arsenalTypes.ts';
import { BarrelSmokeSystem } from './muzzleSmokeFx.ts';
import { AmmoInventory } from './ammoInventory.ts';
import { ViewmodelCache, resetViewmodelForDraw, resetWeaponGlbToIdle, type CachedViewmodel } from './viewmodelCache.ts';
import { mountViewmodelHands } from './viewmodelHands.ts';
import { hipViewmodelPosition } from './viewmodelHipPose.ts';
import {
  GRENADE_GESTURE_SECONDS,
  type MuzzleFlashPhase,
  type ViewmodelActionState,
  canFireViewmodelAction,
  canStartGrenadeThrowAction,
  canStartReloadAction,
  getFireCooldownRemainingS,
  getReloadRemainingS,
  stepGrenadeThrowPose,
  transitionViewmodelAction,
} from './weaponActionState.ts';

export class ArsenalManager {
  public readonly weaponViewmodelEntity: pc.Entity;
  public muzzleFlashEntity: pc.Entity;
  public activeWeaponGlb: WeaponGlbInstance | null = null;
  public lastShotPlayedViewmodelClip = false;
  public currentWeaponIndex = 0;
  public currentWeapon: WeaponSpec = WEAPON_M590;
  public currentAmmo: AmmoSpec = WEAPON_M590.defaultAmmo;
  public readonly ammoInventory: Map<string, WeaponAmmoState>;
  public actionState: ViewmodelActionState = { kind: 'IDLE' };

  private readonly cameraEntity: pc.Entity;
  private readonly hudController: HudController;
  private readonly onWeaponSwitched?: (weapon: WeaponSpec) => void;
  private readonly inventory = new AmmoInventory();
  private readonly smokeSystem = new BarrelSmokeSystem();
  private readonly viewmodels: ViewmodelCache;
  private activeViewmodel: CachedViewmodel | null = null;
  private glbRegistry: GlbModelRegistry | null = null;
  private grenadeViewmodel: WeaponGlbInstance | null = null;
  private muzzleFlashPhase: MuzzleFlashPhase = { kind: 'INACTIVE' };
  private muzzleFlashBaseScale = 1.0;
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
    this.weaponViewmodelEntity.setPosition(hipViewmodelPosition(this.currentWeapon.role));
    cameraEntity.addChild(this.weaponViewmodelEntity);

    this.viewmodels = new ViewmodelCache(this.weaponViewmodelEntity, cameraEntity, this.glbRegistry);
    this.muzzleFlashEntity = this.activateCurrentViewmodel();
    this.initAmmoInventory();
    this.syncWeaponHud();
  }

  public get reloadTimerS(): number {
    return getReloadRemainingS(this.actionState);
  }

  public set reloadTimerS(value: number) {
    if (value <= 0) {
      if (this.actionState.kind === 'RELOADING') {
        this.actionState = transitionViewmodelAction(this.actionState, { kind: 'IDLE' }, this.activeWeaponGlb);
      }
    } else {
      this.actionState = transitionViewmodelAction(
        this.actionState,
        { kind: 'RELOADING', remainingS: value },
        this.activeWeaponGlb
      );
    }
  }

  /** True while the hands cannot hold a sight picture (reloading or throwing a grenade). */
  public get isHandsBusy(): boolean {
    return this.actionState.kind === 'RELOADING' || this.actionState.kind === 'THROWING_GRENADE';
  }

  public get fireCooldownTimerS(): number {
    return getFireCooldownRemainingS(this.actionState);
  }

  public set fireCooldownTimerS(value: number) {
    if (value <= 0) {
      if (this.actionState.kind === 'FIRING' && this.actionState.animReturnRemainingS <= 0) {
        this.actionState = transitionViewmodelAction(this.actionState, { kind: 'IDLE' }, this.activeWeaponGlb);
      } else if (this.actionState.kind === 'FIRING') {
        this.actionState = { ...this.actionState, cooldownRemainingS: 0 };
      }
    } else {
      const animReturnRemainingS =
        this.actionState.kind === 'FIRING' ? this.actionState.animReturnRemainingS : value;
      this.actionState = transitionViewmodelAction(
        this.actionState,
        { kind: 'FIRING', cooldownRemainingS: value, animReturnRemainingS },
        this.activeWeaponGlb
      );
    }
  }

  /** Hides the flash star; a disabled entity submits no draws. */
  private hideMuzzleFlash(): void {
    this.muzzleFlashEntity.setLocalScale(0.00001, 0.00001, 0.00001);
    this.muzzleFlashEntity.enabled = false;
    this.muzzleFlashPhase = { kind: 'INACTIVE' };
  }

  private activateCurrentViewmodel(): pc.Entity {
    if (this.activeViewmodel) this.activeViewmodel.holder.enabled = false;
    const vm = this.viewmodels.get(this.currentWeapon);
    vm.holder.enabled = true;
    resetViewmodelForDraw(vm);
    this.activeViewmodel = vm;
    this.activeWeaponGlb = vm.glb;
    if (this.actionState.kind === 'THROWING_GRENADE' && vm.glb) vm.glb.rootEntity.enabled = false;
    this.muzzleFlashBaseScale = vm.baseScale;
    return vm.flashEntity;
  }

  public initAmmoInventory(): void {
    this.inventory.init();
    this.currentAmmo = this.inventory.getActiveAmmo(this.currentWeapon);
    this.actionState = transitionViewmodelAction(this.actionState, { kind: 'IDLE' }, this.activeWeaponGlb);
    this.hideMuzzleFlash();
    this.syncWeaponHud();
  }

  public selectWeaponByIndex(idx: number): void {
    const wrapped = ((idx % WEAPONS.length) + WEAPONS.length) % WEAPONS.length;
    if (wrapped === this.currentWeaponIndex && this.actionState.kind === 'IDLE') return;

    this.actionState = transitionViewmodelAction(this.actionState, { kind: 'IDLE' }, this.activeWeaponGlb);
    this.hideMuzzleFlash();
    this.currentWeaponIndex = wrapped;
    this.currentWeapon = WEAPONS[wrapped];
    this.currentAmmo = this.inventory.getActiveAmmo(this.currentWeapon);

    this.muzzleFlashEntity = this.activateCurrentViewmodel();
    this.onWeaponSwitched?.(this.currentWeapon);
    this.syncWeaponHud();
  }

  public cycleAmmoType(): void {
    if (this.actionState.kind === 'THROWING_GRENADE') return;
    const nextAmmo = this.inventory.cycleAmmo(this.currentWeapon);
    if (!nextAmmo) {
      this.hudController.pushSystemToast(this.currentWeapon.codeName, `${this.currentAmmo.caliber} ONLY`);
      return;
    }
    this.currentAmmo = nextAmmo;
    if (this.actionState.kind === 'RELOADING') {
      const weapon = this.activeWeaponGlb;
      const reloadSpeed = RELOAD_ANIM_SPEED;
      const durationS = reloadDurationS(weapon?.getClipDuration(weapon.reloadClipName) ?? 0);
      this.actionState = transitionViewmodelAction(
        this.actionState,
        { kind: 'RELOADING', remainingS: durationS },
        this.activeWeaponGlb
      );
      weapon?.playReload(reloadSpeed);
    }
    this.syncWeaponHud();
    this.hudController.pushSystemToast('AMMO LOADED', this.currentAmmo.name.toUpperCase());
  }

  public tryConsumeRoundForShot(): boolean {
    if (!canFireViewmodelAction(this.actionState)) return false;
    if (!this.inventory.consumeShot(this.currentWeapon.id)) {
      this.startReload(false);
      return false;
    }

    const cycleS = fireCycleS(this.currentWeapon);
    const carryS =
      isFullAuto(this.currentWeapon) && this.actionState.kind === 'FIRING'
        ? Math.max(-cycleS, Math.min(0, this.actionState.cooldownRemainingS))
        : 0;
    const weapon = this.activeWeaponGlb;
    const fireDuration = weapon?.getClipDuration(weapon.fireClipName) ?? 0;
    const fireSpeed = Math.max(1, fireDuration / cycleS);
    this.lastShotPlayedViewmodelClip = weapon?.playFire(fireSpeed) ?? false;
    const animReturnS = Math.max(0.22, fireDuration / fireSpeed);

    this.actionState = transitionViewmodelAction(
      this.actionState,
      { kind: 'FIRING', cooldownRemainingS: cycleS + carryS, animReturnRemainingS: animReturnS },
      this.activeWeaponGlb
    );
    this.syncWeaponHud();

    this.shotVisualCounter++;
    const rollDeg = (this.shotVisualCounter * 67 + Math.random() * 28) % 360;
    const scaleJitter = this.muzzleFlashBaseScale * (0.9 + Math.random() * 0.24);
    this.muzzleFlashEntity.setLocalEulerAngles(0, 0, rollDeg);
    this.muzzleFlashEntity.setLocalScale(scaleJitter, scaleJitter, scaleJitter * 1.08);
    this.muzzleFlashEntity.enabled = true;
    const flashDurationS =
      this.currentWeapon.role === 'SHOTGUN' || this.currentWeapon.role === 'HEAVY_PISTOL' ? 0.062 : 0.052;
    this.muzzleFlashPhase = { kind: 'FLASHING', remainingS: flashDurationS, durationS: flashDurationS };

    const device = resolveGraphicsDeviceFromEntity(this.cameraEntity);
    if (device) this.smokeSystem.spawnWisp(device, this.cameraEntity, this.muzzleFlashEntity, this.currentWeapon.role);

    return true;
  }

  public showGrenadeThrow(release: () => void): void {
    if (!canStartGrenadeThrowAction(this.actionState)) return;
    const device = resolveGraphicsDeviceFromEntity(this.cameraEntity);
    const model = device ? this.getGrenadeViewmodel() : null;
    if (!model) {
      release();
      return;
    }

    const root = model.rootEntity;
    root.setLocalPosition(0.24, -0.35, -0.47);
    root.setLocalEulerAngles(0, 0, 0);
    root.enabled = true;
    resetWeaponGlbToIdle(model);
    this.actionState = transitionViewmodelAction(
      this.actionState,
      {
        kind: 'THROWING_GRENADE',
        elapsedS: 0,
        durationS: GRENADE_GESTURE_SECONDS,
        resources: {
          model,
          release,
          dispose: () => {
            root.enabled = false;
          },
        },
      },
      this.activeWeaponGlb
    );
  }

  private getGrenadeViewmodel(): WeaponGlbInstance | null {
    if (this.grenadeViewmodel) return this.grenadeViewmodel;
    if (!this.glbRegistry?.isLoaded('frag_grenade')) return null;
    let model: WeaponGlbInstance | null = null;
    try {
      model = this.glbRegistry.instantiateWeapon('frag_grenade');
      mountViewmodelHands(model, this.glbRegistry.getContainer('viewmodel_arms'));
      this.cameraEntity.addChild(model.rootEntity);
    } catch {
      model?.destroy();
      return null;
    }
    model.rootEntity.enabled = false;
    this.grenadeViewmodel = model;
    return model;
  }

  public startReload(allTargetsDead: boolean, onRespawnAll?: () => void): void {
    if (!canStartReloadAction(this.actionState)) return;
    if (!this.inventory.prepareReload(this.currentWeapon.id, allTargetsDead, onRespawnAll)) return;
    const weapon = this.activeWeaponGlb;
    const reloadSpeed = RELOAD_ANIM_SPEED;
    const remainingS = reloadDurationS(weapon?.getClipDuration(weapon.reloadClipName) ?? 0);
    this.actionState = transitionViewmodelAction(
      this.actionState,
      { kind: 'RELOADING', remainingS },
      this.activeWeaponGlb
    );
    weapon?.playReload(reloadSpeed);
    this.syncWeaponHud();
  }

  public syncWeaponHud(): void {
    const inv = this.inventory.get(this.currentWeapon.id);
    if (!inv) return;
    this.hudController.updateWeaponHud(
      this.currentWeapon,
      this.currentAmmo,
      inv.mag,
      inv.reserve,
      this.actionState.kind === 'RELOADING'
    );
  }

  public update(dt: number): void {
    if (this.muzzleFlashPhase.kind === 'FLASHING') {
      const nextRem = Math.max(0, this.muzzleFlashPhase.remainingS - dt);
      if (nextRem <= 0) {
        this.hideMuzzleFlash();
      } else {
        const rem = nextRem / Math.max(0.01, this.muzzleFlashPhase.durationS);
        const shrink = this.muzzleFlashBaseScale * (0.72 + 0.36 * rem);
        this.muzzleFlashEntity.setLocalScale(shrink, shrink, shrink * (0.85 + 0.3 * rem));
        this.muzzleFlashPhase = { ...this.muzzleFlashPhase, remainingS: nextRem };
      }
    }

    this.smokeSystem.update(dt, this.cameraEntity);

    switch (this.actionState.kind) {
      case 'IDLE':
        break;
      case 'THROWING_GRENADE': {
        const { nextState, completed } = stepGrenadeThrowPose(this.actionState, dt);
        if (completed) {
          const releaseFn = this.actionState.resources.release;
          this.actionState = transitionViewmodelAction(this.actionState, { kind: 'IDLE' }, this.activeWeaponGlb);
          releaseFn();
        } else {
          this.actionState = nextState;
        }
        break;
      }
      case 'RELOADING': {
        const nextRemainingS = this.actionState.remainingS - dt;
        if (nextRemainingS <= 0) {
          this.actionState = transitionViewmodelAction(this.actionState, { kind: 'IDLE' }, this.activeWeaponGlb);
          this.inventory.completeReload(this.currentWeapon.id);
          this.activeWeaponGlb?.playIdle(0.08);
          this.syncWeaponHud();
        } else {
          this.actionState = { kind: 'RELOADING', remainingS: nextRemainingS };
        }
        break;
      }
      case 'FIRING': {
        const prevCooldownS = this.actionState.cooldownRemainingS;
        // The cycle keeps its overshoot past zero only for the frame in which it completes, so a held
        // trigger fires on the true average cycle while an idle trigger never banks extra rounds.
        const nextCooldownS = prevCooldownS > 0 ? prevCooldownS - dt : 0;
        const prevAnimS = this.actionState.animReturnRemainingS;
        const nextAnimS = Math.max(0, prevAnimS - dt);
        this.actionState = {
          kind: 'FIRING',
          cooldownRemainingS: nextCooldownS,
          animReturnRemainingS: nextAnimS,
        };
        if (prevAnimS > 0 && nextAnimS === 0) {
          this.activeWeaponGlb?.playIdle(0.06);
          if (this.inventory.get(this.currentWeapon.id)?.mag === 0) {
            this.startReload(false);
            break;
          }
        }
        if (this.actionState.kind === 'FIRING' && nextCooldownS <= 0 && nextAnimS <= 0) {
          this.actionState = transitionViewmodelAction(this.actionState, { kind: 'IDLE' }, this.activeWeaponGlb);
        }
        break;
      }
    }
  }

  public destroy(): void {
    this.actionState = transitionViewmodelAction(this.actionState, { kind: 'IDLE' }, this.activeWeaponGlb);
    this.grenadeViewmodel?.destroy();
    this.grenadeViewmodel = null;
    this.viewmodels.destroy();
    this.activeViewmodel = null;
    this.activeWeaponGlb = null;
    this.smokeSystem.destroy();
    this.weaponViewmodelEntity.destroy();
  }
}
