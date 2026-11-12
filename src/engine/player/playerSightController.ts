import type * as pc from 'playcanvas';
import type { WeaponAdsProfile, WeaponSpec } from '../../contracts/ballistics.ts';
import {
  adsFovDeg,
  adsSensitivityScale,
  easeAdsBlend,
  stepAdsProgress,
} from '../../core/ballistics/aim/aimDownSights.ts';
import { solveAdsViewmodelPose, type AdsViewmodelPose } from '../../core/ballistics/aim/sightAlignment.ts';
import { getWeaponAdsProfile } from '../../core/ballistics/weapons.ts';
import type { HudController } from '../hudController.ts';

export const HIP_FOV_DEG = 68;
/** Aim blend at which the scope tube has reached the eye and the full-screen optic takes over. */
const SCOPE_OPTIC_BLEND_THRESHOLD = 0.8;

export type PlayerSightState =
  | { readonly kind: 'HIPFIRE'; readonly adsBlend: number }
  | { readonly kind: 'ADS_BLENDING_IN'; readonly adsBlend: number }
  | { readonly kind: 'ADS_LOCKED'; readonly adsBlend: number };

/**
 * Owns the player's aim intent and how far the weapon is raised to the eye.
 * Intent is hold (right mouse) or toggle (Shift); reloading and throwing lower the weapon
 * without clearing the intent, so the sights come back up on their own afterwards.
 */
export class PlayerSightController {
  public profile: WeaponAdsProfile = getWeaponAdsProfile('');
  public adsPose: AdsViewmodelPose = solveAdsViewmodelPose(this.profile);
  /** Eased 0..1 blend from hip to fully aimed. */
  public blend = 0;
  public currentFovDeg = HIP_FOV_DEG;
  public scopeVisible = false;

  private aimHeld = false;
  private aimToggled = false;
  private blocked = false;
  private progress = 0;
  private profileWeaponId = '';

  public get isAiming(): boolean {
    return (this.aimHeld || this.aimToggled) && !this.blocked;
  }

  public get sightState(): PlayerSightState {
    if (!this.isAiming) return { kind: 'HIPFIRE', adsBlend: this.blend };
    return this.progress >= 1
      ? { kind: 'ADS_LOCKED', adsBlend: this.blend }
      : { kind: 'ADS_BLENDING_IN', adsBlend: this.blend };
  }

  public get lookScale(): number {
    return adsSensitivityScale(HIP_FOV_DEG, this.currentFovDeg);
  }

  public setHeld(held: boolean): void {
    this.aimHeld = held;
    if (held) this.aimToggled = false;
  }

  public toggle(): void {
    this.aimToggled = !(this.aimHeld || this.aimToggled);
    this.aimHeld = false;
  }

  public release(): void {
    this.aimHeld = false;
    this.aimToggled = false;
  }

  /** The new weapon starts at the hip; a held aim button raises it again. */
  public resetForWeaponSwitch(hud: HudController): void {
    this.aimToggled = false;
    this.progress = 0;
    this.blend = 0;
    if (this.scopeVisible) {
      this.scopeVisible = false;
      hud.setScopeOverlay(false);
    }
  }

  public update(
    dt: number,
    weapon: WeaponSpec,
    blocked: boolean,
    camera: pc.CameraComponent | undefined,
    hud: HudController
  ): void {
    if (weapon.id !== this.profileWeaponId) {
      this.profileWeaponId = weapon.id;
      this.profile = getWeaponAdsProfile(weapon.id);
      this.adsPose = solveAdsViewmodelPose(this.profile);
    }
    this.blocked = blocked;
    this.progress = stepAdsProgress(this.progress, this.isAiming, dt, this.profile);
    this.blend = easeAdsBlend(this.progress);

    this.currentFovDeg = adsFovDeg(HIP_FOV_DEG, this.profile.zoom, this.blend);
    if (camera) camera.fov = this.currentFovDeg;

    const showScope = this.profile.sightKind === 'SCOPE' && this.blend >= SCOPE_OPTIC_BLEND_THRESHOLD;
    if (showScope !== this.scopeVisible) {
      this.scopeVisible = showScope;
      hud.setScopeOverlay(showScope, this.profile.zoom, 42.0, 0);
    }
  }
}
