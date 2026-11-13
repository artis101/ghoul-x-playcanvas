import * as pc from 'playcanvas';
import type { WeaponSpec } from '../../contracts/ballistics.ts';
import type { HudController } from '../hudController.ts';
import { aimSpreadRad } from '../../core/ballistics/aim/aimDownSights.ts';
import {
  absorbPlayerPullDown,
  createRecoilClimbState,
  creditClimb,
  kickRecoilClimb,
  stepRecoilClimb,
} from '../../core/ballistics/weapons/recoilClimb.ts';
import {
  addPunchImpulse,
  createViewPunch,
  hitFlinch,
  stepViewPunch,
} from '../../core/ballistics/weapons/viewPunch.ts';
import type { WeaponGlbInstance } from '../assets/glbLoader.ts';
import { PlayerSightController, type PlayerSightState } from './playerSightController.ts';
import { ViewmodelAimStabilizer } from './viewmodelAimStabilizer.ts';
import { HIP_VM_ROT, hipViewmodelPosition } from './viewmodelHipPose.ts';

export type { PlayerSightState };


/** What the weapon hands are doing this frame, as far as aiming is concerned. */
export interface ViewmodelHandsState {
  /** Reloading or throwing: the sights come down until the hands are free. */
  readonly aimBlocked: boolean;
  /** A fire clip is playing; part of its kick is kept visible while aimed. */
  readonly firing: boolean;
  readonly weaponGlb: WeaponGlbInstance | null;
}

/** Share of the fire clip's weapon kick that is cancelled when fully aimed. */
const ADS_FIRE_CLIP_DAMPING = 0.5;

export type CameraShakeState =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'SHAKING';
      readonly remainingS: number;
      readonly durationS: number;
      readonly intensityDeg: number;
      readonly clockS: number;
    };

export class PlayerCameraRig {
  public cameraPitch = -3.5;
  public cameraYaw = 0;
  public readonly sight = new PlayerSightController();
  public shakeState: CameraShakeState = { kind: 'IDLE' };
  public recoilPitch = 0;
  public recoilOffsetZ = 0;
  public moveBobPhase = 0;
  public moveBobBlend = 0;
  public swayYawOffset = 0;
  public swayPitchOffset = 0;

  private recoilYaw = 0;
  private recoilCameraRoll = 0;
  private vmRecoilPitchDeg = 0;
  private vmRecoilRollDeg = 0;
  private vmRecoilOffsetY = 0;
  private recoilShotSign = 1;
  private breathClockS = 0;
  private readonly climb = createRecoilClimbState();
  public readonly punch = createViewPunch();
  /** Smoothed camera lean into a strafe, degrees. */
  public strafeLeanRoll = 0;
  private readonly scratchBaseRot = new pc.Quat();
  private readonly scratchOffsetRot = new pc.Quat();
  private readonly scratchAdsRot = new pc.Quat();
  private readonly aimStabilizer = new ViewmodelAimStabilizer();

  public lastShakePitchOffset = 0;
  public lastShakeYawOffset = 0;
  public lastShakeRollOffset = 0;
  public lastCamHeadBobY = 0;

  public get isAimingDownSights(): boolean {
    return this.sight.isAiming;
  }

  public get adsBlend(): number {
    return this.sight.blend;
  }

  public get sightState(): PlayerSightState {
    return this.sight.sightState;
  }

  public get isScopeOpticActive(): boolean {
    return this.sight.scopeVisible;
  }

  /** Half-angle of the cone the next shot may deviate within. */
  public get currentAimSpreadRad(): number {
    return aimSpreadRad(
      this.sight.profile,
      this.sight.blend,
      this.moveBobBlend,
      this.recoilPitch,
      Math.abs(this.punch.pitch.value) + Math.abs(this.punch.yaw.value)
    );
  }

  public onLook(deltaYaw: number, deltaPitch: number): void {
    this.cameraYaw -= deltaYaw;
    const prevPitch = this.cameraPitch;
    this.cameraPitch = Math.max(-85, Math.min(85, this.cameraPitch - deltaPitch));
    absorbPlayerPullDown(this.climb, prevPitch - this.cameraPitch);
    const swayScale = 1 - this.sight.blend * 0.68;
    this.swayYawOffset = Math.max(-2.6, Math.min(2.6, this.swayYawOffset - deltaYaw * 0.28 * swayScale));
    this.swayPitchOffset = Math.max(-2.2, Math.min(2.2, this.swayPitchOffset - deltaPitch * 0.24 * swayScale));
  }

  public applyRecoilKick(recoilKickDeg: number, applyViewmodelKick = true, weaponId?: string): void {
    const adsBrace = 1 - this.sight.blend * (1 - this.sight.profile.adsRecoilScale);
    if (weaponId) this.applyRecoilClimb(weaponId);
    this.recoilShotSign = -this.recoilShotSign;
    this.recoilPitch = Math.min(8.0, this.recoilPitch + recoilKickDeg * 0.72 * adsBrace);
    this.recoilYaw = Math.max(-2.2, Math.min(2.2, this.recoilYaw + this.recoilShotSign * recoilKickDeg * 0.11 * adsBrace));
    this.recoilCameraRoll = Math.max(-2.4, Math.min(2.4, this.recoilCameraRoll + this.recoilShotSign * recoilKickDeg * 0.16 * adsBrace));

    // A little forward jolt and FOV pulse on every shot, scaled by the kick and braced when aimed.
    addPunchImpulse(this.punch, recoilKickDeg * 6 * adsBrace, 0, this.recoilShotSign * recoilKickDeg * 5 * adsBrace, recoilKickDeg * 3.5 * adsBrace);

    if (!applyViewmodelKick) return;
    const kickNorm = Math.min(1.6, Math.max(0.45, recoilKickDeg / 3.2));
    this.recoilOffsetZ = Math.min(0.105, Math.max(this.recoilOffsetZ, 0.058 * kickNorm * adsBrace));
    this.vmRecoilPitchDeg = Math.min(11.5, this.vmRecoilPitchDeg + recoilKickDeg * 1.18 * adsBrace);
    this.vmRecoilRollDeg = Math.max(-6.5, Math.min(6.5, this.vmRecoilRollDeg + this.recoilShotSign * recoilKickDeg * 0.55 * adsBrace));
    this.vmRecoilOffsetY = Math.min(0.022, this.vmRecoilOffsetY + 0.0065 * kickNorm * adsBrace);
  }

  /** The rise that stays in the view: the player has to pull down against it. */
  private applyRecoilClimb(weaponId: string): void {
    const kick = kickRecoilClimb(this.climb, weaponId, this.sight.blend, Math.random());
    const prevPitch = this.cameraPitch;
    this.cameraPitch = Math.min(85, this.cameraPitch + kick.pitchDeg);
    creditClimb(this.climb, this.cameraPitch - prevPitch);
    // Positive yaw turns left, so a throw to the right lowers it.
    this.cameraYaw -= kick.yawDeg;
  }

  /**
   * The player was hit: the view snaps and rolls away from where the round came from, and the
   * aim itself is knocked off target (the lost accuracy). `rightness` is -1 (from the left) to
   * 1 (from the right); damageNorm is 0..1.
   */
  public applyHitFlinch(rightness: number, damageNorm: number): void {
    const f = hitFlinch(rightness, damageNorm, Math.random(), Math.random());
    addPunchImpulse(this.punch, f.pitchImpulse, f.yawImpulse, f.rollImpulse, f.fovImpulse);
    this.cameraPitch = Math.max(-85, Math.min(85, this.cameraPitch + f.aimPitchDeg));
    this.cameraYaw += f.aimYawDeg;
    // The shooter is not holding this rise, so it is not paid back by the climb recovery.
  }

  /** A blast or heavy impact nearby: a hard, brief, direction-less bump. */
  public applyBump(strength: number): void {
    const s = Math.max(0, Math.min(2, strength));
    addPunchImpulse(this.punch, s * 70, (Math.random() - 0.5) * s * 60, (Math.random() - 0.5) * s * 100, s * 30);
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

  public updateRig(
    dt: number,
    currentWeapon: WeaponSpec,
    reloadTimerS: number,
    hands: ViewmodelHandsState,
    moving: boolean,
    strafeSign: number,
    camera: pc.CameraComponent | undefined,
    vmEntity: pc.Entity,
    hud: HudController
  ): void {
    this.sight.update(dt, currentWeapon, hands.aimBlocked, camera, hud);
    const isAds = this.sight.isAiming;
    const nextBlend = this.sight.blend;

    this.cameraPitch -= stepRecoilClimb(this.climb, dt);
    stepViewPunch(this.punch, dt);
    const leanTarget = -strafeSign * 1.1 * (1 - nextBlend * 0.7);
    this.strafeLeanRoll += (leanTarget - this.strafeLeanRoll) * (1 - Math.exp(-9.0 * dt));
    if (camera) camera.fov += this.punch.fov.value;

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

    // The aimed pose is solved from the weapon's own sights, so the front sight sits on screen centre.
    const adsPos = this.sight.adsPose.position;
    const adsRot = this.sight.adsPose.rotation;
    const transitionArcDipY = Math.sin(nextBlend * Math.PI) * -0.014;
    const transitionRollDeg = Math.sin(nextBlend * Math.PI) * -4.5;
    const hipPos = hipViewmodelPosition(currentWeapon.role);
    const baseVmX = hipPos.x + (adsPos.x - hipPos.x) * nextBlend;
    const baseVmY = hipPos.y + (adsPos.y - hipPos.y) * nextBlend + transitionArcDipY;
    const baseVmZ = hipPos.z + (adsPos.z - hipPos.z) * nextBlend;
    this.scratchAdsRot.set(adsRot.x, adsRot.y, adsRot.z, adsRot.w);
    this.scratchBaseRot.slerp(HIP_VM_ROT, this.scratchAdsRot, nextBlend);

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

    vmEntity.setLocalPosition(
      baseVmX + breathX + bobX + swayTransX,
      baseVmY + breathY + bobY + swayTransY + reloadDipY - this.vmRecoilOffsetY,
      baseVmZ + this.recoilOffsetZ
    );
    this.scratchOffsetRot.setFromEulerAngles(
      this.vmRecoilPitchDeg + breathPitchDeg + this.swayPitchOffset * 0.65 + reloadPitchDeg,
      this.swayYawOffset * 0.85,
      transitionRollDeg + bobRollDeg + this.vmRecoilRollDeg - this.swayYawOffset * 0.55 + reloadRollDeg
    );
    vmEntity.setLocalRotation(this.scratchBaseRot.mul(this.scratchOffsetRot));
    this.aimStabilizer.apply(
      vmEntity,
      hands.weaponGlb,
      nextBlend * (hands.firing ? ADS_FIRE_CLIP_DAMPING : 1)
    );
    vmEntity.enabled = !this.sight.scopeVisible;

    // The reticle is the spread cone: what it shows is what the next round can do.
    const bloom = 1.0 + Math.min(4, this.currentAimSpreadRad * 55);
    // Sights replace the crosshair: it is gone by the time the weapon is two-thirds raised.
    const crosshairOpacity = Math.max(0, 1 - nextBlend / 0.65);
    hud.setCrosshairBloom(bloom, this.sight.scopeVisible, crosshairOpacity);
  }
}
