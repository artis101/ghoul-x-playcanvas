import * as pc from 'playcanvas';
import type { WeaponSpec } from '../../contracts/ballistics.ts';
import type { HudController } from '../hudController.ts';

export type PlayerSightOptic = 'IRON' | 'SNIPER_SCOPE';

export type PlayerSightState =
  | { readonly kind: 'HIPFIRE'; readonly adsBlend: number }
  | {
      readonly kind: 'ADS_BLENDING_IN';
      readonly adsBlend: number;
      readonly targetOptic: PlayerSightOptic;
    }
  | {
      readonly kind: 'ADS_LOCKED';
      readonly adsBlend: number;
      readonly optic: PlayerSightOptic;
    };

export type CameraShakeState =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'SHAKING';
      readonly remainingS: number;
      readonly durationS: number;
      readonly intensityDeg: number;
      readonly clockS: number;
    };

const SCOPE_OPTIC_BLEND_THRESHOLD = 0.74;

export class PlayerCameraRig {
  public cameraPitch = -3.5;
  public cameraYaw = 0;
  public sightState: PlayerSightState = { kind: 'HIPFIRE', adsBlend: 0 };
  public shakeState: CameraShakeState = { kind: 'IDLE' };
  public recoilPitch = 0;
  public recoilOffsetZ = 0;
  public moveBobPhase = 0;
  public moveBobBlend = 0;
  public swayYawOffset = 0;
  public swayPitchOffset = 0;

  private currentFov = 68;
  private sniperScopeVisible = false;
  private recoilYaw = 0;
  private recoilCameraRoll = 0;
  private vmRecoilPitchDeg = 0;
  private vmRecoilRollDeg = 0;
  private vmRecoilOffsetY = 0;
  private recoilShotSign = 1;
  private breathClockS = 0;

  public lastShakePitchOffset = 0;
  public lastShakeYawOffset = 0;
  public lastShakeRollOffset = 0;
  public lastCamHeadBobY = 0;

  public get isAimingDownSights(): boolean {
    return this.sightState.kind === 'ADS_BLENDING_IN' || this.sightState.kind === 'ADS_LOCKED';
  }

  public set isAimingDownSights(active: boolean) {
    const blend = this.sightState.adsBlend;
    if (!active) {
      this.sightState = { kind: 'HIPFIRE', adsBlend: blend };
      return;
    }
    const currentOptic: PlayerSightOptic =
      this.sightState.kind === 'ADS_LOCKED'
        ? this.sightState.optic
        : this.sightState.kind === 'ADS_BLENDING_IN'
          ? this.sightState.targetOptic
          : 'IRON';
    this.sightState =
      blend >= SCOPE_OPTIC_BLEND_THRESHOLD
        ? { kind: 'ADS_LOCKED', adsBlend: blend, optic: currentOptic }
        : { kind: 'ADS_BLENDING_IN', adsBlend: blend, targetOptic: currentOptic };
  }

  public get adsBlend(): number {
    return this.sightState.adsBlend;
  }

  public set adsBlend(value: number) {
    const clamped = Math.max(0, Math.min(1, value));
    if (this.sightState.kind === 'HIPFIRE') {
      this.sightState = { kind: 'HIPFIRE', adsBlend: clamped };
      return;
    }
    const optic =
      this.sightState.kind === 'ADS_LOCKED'
        ? this.sightState.optic
        : this.sightState.targetOptic;
    this.sightState =
      clamped >= SCOPE_OPTIC_BLEND_THRESHOLD
        ? { kind: 'ADS_LOCKED', adsBlend: clamped, optic }
        : { kind: 'ADS_BLENDING_IN', adsBlend: clamped, targetOptic: optic };
  }

  public get isScopeOpticActive(): boolean {
    return this.sightState.kind === 'ADS_LOCKED' && this.sightState.optic === 'SNIPER_SCOPE';
  }

  public onLook(deltaYaw: number, deltaPitch: number): void {
    this.cameraYaw -= deltaYaw;
    this.cameraPitch -= deltaPitch;
    this.cameraPitch = Math.max(-85, Math.min(85, this.cameraPitch));
    const swayScale = this.isAimingDownSights ? 0.32 : 1.0;
    this.swayYawOffset = Math.max(-2.6, Math.min(2.6, this.swayYawOffset - deltaYaw * 0.28 * swayScale));
    this.swayPitchOffset = Math.max(-2.2, Math.min(2.2, this.swayPitchOffset - deltaPitch * 0.24 * swayScale));
  }

  public applyRecoilKick(recoilKickDeg: number, applyViewmodelKick = true): void {
    const adsBrace = this.isAimingDownSights ? 0.68 : 1.0;
    this.recoilShotSign = -this.recoilShotSign;
    this.recoilPitch = Math.min(8.0, this.recoilPitch + recoilKickDeg * 0.72 * adsBrace);
    this.recoilYaw = Math.max(-2.2, Math.min(2.2, this.recoilYaw + this.recoilShotSign * recoilKickDeg * 0.11 * adsBrace));
    this.recoilCameraRoll = Math.max(-2.4, Math.min(2.4, this.recoilCameraRoll + this.recoilShotSign * recoilKickDeg * 0.16 * adsBrace));

    if (!applyViewmodelKick) return;
    const kickNorm = Math.min(1.6, Math.max(0.45, recoilKickDeg / 3.2));
    this.recoilOffsetZ = Math.min(0.105, Math.max(this.recoilOffsetZ, 0.058 * kickNorm * adsBrace));
    this.vmRecoilPitchDeg = Math.min(11.5, this.vmRecoilPitchDeg + recoilKickDeg * 1.18 * adsBrace);
    this.vmRecoilRollDeg = Math.max(-6.5, Math.min(6.5, this.vmRecoilRollDeg + this.recoilShotSign * recoilKickDeg * 0.55 * adsBrace));
    this.vmRecoilOffsetY = Math.min(0.022, this.vmRecoilOffsetY + 0.0065 * kickNorm * adsBrace);
  }

  public applyCameraShake(intensityDeg: number, durationS = 0.36): void {
    if (intensityDeg <= 0 || durationS <= 0) return;
    const prevIntensity = this.shakeState.kind === 'SHAKING' ? this.shakeState.intensityDeg : 0;
    const prevRemaining = this.shakeState.kind === 'SHAKING' ? this.shakeState.remainingS : 0;
    const prevClock = this.shakeState.kind === 'SHAKING' ? this.shakeState.clockS : 0;

    this.shakeState = {
      kind: 'SHAKING',
      intensityDeg: Math.min(6.5, Math.max(prevIntensity, intensityDeg)),
      durationS: Math.max(0.05, durationS),
      remainingS: Math.max(prevRemaining, durationS),
      clockS: prevClock,
    };
  }

  public setAimDownSights(active: boolean, weapon: WeaponSpec, hud: HudController): void {
    const optic: PlayerSightOptic = weapon.role === 'SNIPER' ? 'SNIPER_SCOPE' : 'IRON';
    const currentBlend = this.sightState.adsBlend;

    if (!active) {
      this.sightState = { kind: 'HIPFIRE', adsBlend: currentBlend };
    } else if (currentBlend >= SCOPE_OPTIC_BLEND_THRESHOLD) {
      this.sightState = { kind: 'ADS_LOCKED', adsBlend: currentBlend, optic };
    } else {
      this.sightState = { kind: 'ADS_BLENDING_IN', adsBlend: currentBlend, targetOptic: optic };
    }

    if (!this.isScopeOpticActive && this.sniperScopeVisible) {
      this.sniperScopeVisible = false;
      hud.setScopeOverlay(false);
    } else if (active && optic !== 'SNIPER_SCOPE') {
      this.sniperScopeVisible = false;
      hud.setScopeOverlay(false);
    }
  }

  public updateRig(
    dt: number,
    currentWeapon: WeaponSpec,
    reloadTimerS: number,
    moving: boolean,
    strafeSign: number,
    camera: pc.CameraComponent | undefined,
    vmEntity: pc.Entity,
    hud: HudController
  ): void {
    const isAds = this.isAimingDownSights;
    const targetAds = isAds ? 1.0 : 0.0;
    let nextBlend = this.sightState.adsBlend + (targetAds - this.sightState.adsBlend) * (1 - Math.exp(-15.5 * dt));
    if (Math.abs(targetAds - nextBlend) < 0.002) nextBlend = targetAds;

    const optic: PlayerSightOptic = currentWeapon.role === 'SNIPER' ? 'SNIPER_SCOPE' : 'IRON';
    if (!isAds) {
      this.sightState = { kind: 'HIPFIRE', adsBlend: nextBlend };
    } else if (nextBlend >= SCOPE_OPTIC_BLEND_THRESHOLD) {
      this.sightState = { kind: 'ADS_LOCKED', adsBlend: nextBlend, optic };
    } else {
      this.sightState = { kind: 'ADS_BLENDING_IN', adsBlend: nextBlend, targetOptic: optic };
    }

    const zoom = currentWeapon.scopeZoomLevels[0] || 1.6;
    const targetFov = isAds ? 68 / Math.max(1.25, zoom) : 68;
    this.currentFov += (targetFov - this.currentFov) * (1 - Math.exp(-16.5 * dt));
    if (camera) camera.fov = this.currentFov;

    const shouldShowScope = this.isScopeOpticActive;
    if (shouldShowScope !== this.sniperScopeVisible) {
      this.sniperScopeVisible = shouldShowScope;
      hud.setScopeOverlay(shouldShowScope, zoom, 42.0, 0);
    }

    const camDecay = Math.exp(-15.0 * dt);
    this.recoilPitch *= camDecay;
    if (this.recoilPitch < 0.002) this.recoilPitch = 0;
    this.recoilYaw *= camDecay;
    this.recoilCameraRoll *= Math.exp(-18.0 * dt);

    const vmDecay = Math.exp(-13.5 * dt);
    this.recoilOffsetZ *= vmDecay;
    if (this.recoilOffsetZ < 0.0004) this.recoilOffsetZ = 0;
    this.vmRecoilPitchDeg *= Math.exp(-14.5 * dt);
    this.vmRecoilRollDeg *= Math.exp(-16.0 * dt);
    this.vmRecoilOffsetY *= Math.exp(-15.0 * dt);

    const swayDecay = Math.exp(-13.0 * dt);
    this.swayYawOffset *= swayDecay;
    this.swayPitchOffset *= swayDecay;

    if (this.shakeState.kind === 'SHAKING') {
      const nextRemaining = Math.max(0, this.shakeState.remainingS - dt);
      const nextClock = this.shakeState.clockS + dt * 46.0;
      const decay = nextRemaining / this.shakeState.durationS;
      const amp = this.shakeState.intensityDeg * decay * decay;
      this.lastShakePitchOffset = Math.sin(nextClock * 1.3) * amp;
      this.lastShakeYawOffset = Math.cos(nextClock * 0.95) * amp * 0.75;
      this.lastShakeRollOffset = Math.sin(nextClock * 1.7) * amp * 0.55;

      if (nextRemaining <= 0) {
        this.shakeState = { kind: 'IDLE' };
      } else {
        this.shakeState = {
          ...this.shakeState,
          remainingS: nextRemaining,
          clockS: nextClock,
        };
      }
    } else {
      this.lastShakePitchOffset = 0;
      this.lastShakeYawOffset = 0;
      this.lastShakeRollOffset = 0;
    }

    this.breathClockS += dt;
    if (moving) this.moveBobPhase += dt * (isAds ? 8.2 : 10.5);
    const targetBobBlend = moving ? 1.0 : 0.0;
    this.moveBobBlend += (targetBobBlend - this.moveBobBlend) * (1 - Math.exp(-11.0 * dt));

    this.lastCamHeadBobY = Math.sin(this.moveBobPhase * 2.0) * 0.008 * this.moveBobBlend * (1 - nextBlend * 0.65);

    const baseVmX = 0.24 * (1 - nextBlend);
    const transitionArcDipY = Math.sin(nextBlend * Math.PI) * -0.014;
    const baseVmY = -0.22 + (-0.145 - -0.22) * nextBlend + transitionArcDipY;
    const baseVmZ = -0.48 + (-0.32 - -0.48) * nextBlend;

    const breathAtten = 1 - nextBlend * 0.76;
    const breathX = Math.cos(this.breathClockS * 0.92) * 0.0022 * breathAtten;
    const breathY = Math.sin(this.breathClockS * 1.84) * 0.0028 * breathAtten;
    const breathPitchDeg = Math.sin(this.breathClockS * 1.84 - 0.4) * 0.22 * breathAtten;

    const strideAtten = this.moveBobBlend * (1 - nextBlend * 0.78);
    const bobX = Math.cos(this.moveBobPhase) * 0.0085 * strideAtten;
    const bobY = Math.abs(Math.sin(this.moveBobPhase)) * -0.0095 * strideAtten;
    const bobRollDeg = Math.sin(this.moveBobPhase) * 0.85 * strideAtten - strafeSign * 1.15 * strideAtten;

    const reloadPhase = reloadTimerS > 0 ? Math.sin((reloadTimerS / 0.65) * Math.PI) : 0;
    const reloadDipY = -reloadPhase * 0.135;
    const reloadRollDeg = reloadPhase * 14.0;
    const reloadPitchDeg = -reloadPhase * 9.5;

    const swayTransX = this.swayYawOffset * 0.0045;
    const swayTransY = -this.swayPitchOffset * 0.004;
    const hipCantRollDeg = -1.75 * (1 - nextBlend);

    vmEntity.setLocalPosition(
      baseVmX + breathX + bobX + swayTransX,
      baseVmY + breathY + bobY + swayTransY + reloadDipY - this.vmRecoilOffsetY,
      baseVmZ + this.recoilOffsetZ
    );
    vmEntity.setLocalEulerAngles(
      this.vmRecoilPitchDeg + breathPitchDeg + this.swayPitchOffset * 0.65 + reloadPitchDeg,
      this.swayYawOffset * 0.85,
      hipCantRollDeg + bobRollDeg + this.vmRecoilRollDeg - this.swayYawOffset * 0.55 + reloadRollDeg
    );
    vmEntity.enabled = !this.sniperScopeVisible;

    const bloom = 1.0 + this.recoilPitch * 0.08 + this.moveBobBlend * 0.16 * (1 - nextBlend * 0.5);
    hud.setCrosshairBloom(bloom, this.sniperScopeVisible);
  }
}
