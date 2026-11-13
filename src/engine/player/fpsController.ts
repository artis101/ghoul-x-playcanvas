import * as pc from 'playcanvas';
import type { WeaponSpec } from '../../contracts/ballistics.ts';
import type { HudController } from '../hudController.ts';
import type { FpsInputCallbacks } from './fpsTypes.ts';
import { PlayerCameraRig, type PlayerSightState, type ViewmodelHandsState } from './playerCameraRig.ts';
import { PlayerInputManager } from './playerInput.ts';
import { HIP_FOV_DEG } from './playerSightController.ts';
import { deflectWithinCone } from '../../core/ballistics/aim/aimDownSights.ts';
import { isFullAuto } from '../../core/ballistics/weapons/weaponHandling.ts';
import { PlayerMovementSolver } from './playerMovement.ts';

export * from './fpsTypes.ts';

export class FpsController {
  public readonly cameraEntity: pc.Entity;
  private readonly hudController: HudController;
  private readonly getCurrentWeapon: () => WeaponSpec;
  private readonly callbacks: FpsInputCallbacks;

  private readonly input: PlayerInputManager;
  private readonly rig: PlayerCameraRig;
  private readonly movement: PlayerMovementSolver;

  constructor(
    app: pc.AppBase,
    canvas: HTMLCanvasElement,
    hudController: HudController,
    getCurrentWeapon: () => WeaponSpec,
    callbacks: FpsInputCallbacks,
    resolveHorizontalMovement?: (prev: pc.Vec3, next: pc.Vec3) => void
  ) {
    this.hudController = hudController;
    this.getCurrentWeapon = getCurrentWeapon;
    this.callbacks = callbacks;

    this.rig = new PlayerCameraRig();
    this.movement = new PlayerMovementSolver();
    this.movement.resolveHorizontalMovement = resolveHorizontalMovement;

    this.input = new PlayerInputManager(
      canvas,
      callbacks,
      getCurrentWeapon,
      (dy, dp) => this.rig.onLook(dy, dp),
      {
        setHeld: (held) => this.rig.sight.setHeld(held),
        toggle: () => this.rig.sight.toggle(),
        release: () => this.rig.sight.release(),
        getLookScale: () => this.rig.sight.lookScale,
      }
    );

    this.cameraEntity = new pc.Entity('PlayerCamera');
    this.cameraEntity.addComponent('camera', {
      clearColor: new pc.Color(0.1, 0.09, 0.06),
      fov: HIP_FOV_DEG,
      nearClip: 0.05,
      farClip: 400,
      toneMapping: pc.TONEMAP_LINEAR,
      gammaCorrection: pc.GAMMA_SRGB,
    });
    this.cameraEntity.setPosition(this.playerPos.x, this.playerPos.y, this.playerPos.z);
    app.root.addChild(this.cameraEntity);
  }

  public get playerPos(): pc.Vec3 { return this.movement.playerPos; }
  public get cameraPitch(): number { return this.rig.cameraPitch; }
  public set cameraPitch(val: number) { this.rig.cameraPitch = val; }
  public get cameraYaw(): number { return this.rig.cameraYaw; }
  public set cameraYaw(val: number) { this.rig.cameraYaw = val; }
  public get isPointerLocked(): boolean { return this.input.isPointerLocked; }
  public get isAimingDownSights(): boolean { return this.rig.isAimingDownSights; }
  public get adsBlend(): number { return this.rig.adsBlend; }
  public get sightKind(): 'IRON' | 'HOLO' | 'SCOPE' { return this.rig.sight.profile.sightKind; }
  public get isScopeOpticActive(): boolean { return this.rig.isScopeOpticActive; }
  public get sightState(): PlayerSightState { return this.rig.sightState; }
  public get isTriggerHeld(): boolean { return this.input.isTriggerHeld; }
  public get recoilPitch(): number { return this.rig.recoilPitch; }
  public get recoilOffsetZ(): number { return this.rig.recoilOffsetZ; }
  public get moveBobPhase(): number { return this.rig.moveBobPhase; }
  public get keysPressed(): Record<string, boolean> { return this.input.keysPressed; }
  public get resolveHorizontalMovement(): ((prev: pc.Vec3, next: pc.Vec3) => void) | undefined {
    return this.movement.resolveHorizontalMovement;
  }
  public set resolveHorizontalMovement(fn: ((prev: pc.Vec3, next: pc.Vec3) => void) | undefined) {
    this.movement.resolveHorizontalMovement = fn;
  }

  public syncCameraTransform(): void {
    this.cameraEntity.setPosition(
      this.playerPos.x,
      this.playerPos.y + this.rig.lastCamHeadBobY,
      this.playerPos.z
    );
    this.cameraEntity.setEulerAngles(
      this.rig.cameraPitch + this.rig.recoilPitch + this.rig.lastShakePitchOffset + this.rig.punch.pitch.value,
      this.rig.cameraYaw + this.rig.lastShakeYawOffset + this.rig.punch.yaw.value,
      this.rig.lastShakeRollOffset + this.rig.punch.roll.value + this.rig.strafeLeanRoll
    );
  }

  public getAimDirection(): pc.Vec3 {
    const effectivePitch = Math.max(-89.5, Math.min(89.5, this.rig.cameraPitch + this.rig.recoilPitch + this.rig.lastShakePitchOffset + this.rig.punch.pitch.value));
    const effectiveYaw = this.rig.cameraYaw + this.rig.lastShakeYawOffset + this.rig.punch.yaw.value;
    const pitchRad = (effectivePitch * Math.PI) / 180;
    const yawRad = (effectiveYaw * Math.PI) / 180;
    const x = -Math.sin(yawRad) * Math.cos(pitchRad);
    const y = Math.sin(pitchRad);
    const z = -Math.cos(yawRad) * Math.cos(pitchRad);
    return new pc.Vec3(x, y, z).normalize();
  }

  /**
   * Where the next round leaves: the sight line when fully aimed, and somewhere inside the
   * hip-fire cone otherwise.
   */
  public getFireDirection(): pc.Vec3 {
    const aim = this.getAimDirection();
    const spreadRad = this.rig.currentAimSpreadRad;
    if (spreadRad <= 0) return aim;
    const fired = deflectWithinCone(aim, spreadRad, Math.random(), Math.random());
    return aim.set(fired.x, fired.y, fired.z);
  }

  public getEyePosition(): pc.Vec3 {
    return new pc.Vec3(this.playerPos.x, this.playerPos.y + this.rig.lastCamHeadBobY, this.playerPos.z);
  }

  public applyRecoilKick(recoilKickDeg: number, applyViewmodelKick = true, weaponId?: string): void {
    this.rig.applyRecoilKick(recoilKickDeg, applyViewmodelKick, weaponId);
  }

  /** Being hit: view snap and roll away from the shooter, and the aim is knocked off. */
  public applyHitFlinch(rightness: number, damageNorm: number): void {
    this.rig.applyHitFlinch(rightness, damageNorm);
  }

  public applyBump(strength: number): void {
    this.rig.applyBump(strength);
  }

  public applyCameraShake(intensityDeg: number, durationS = 0.36): void {
    this.rig.applyCameraShake(intensityDeg, durationS);
  }

  /** Call after the active weapon changes: the new weapon comes up from the hip. */
  public onWeaponSwitched(): void {
    this.rig.sight.resetForWeaponSwitch(this.hudController);
  }

  public update(
    dt: number,
    currentWeapon: WeaponSpec,
    reloadTimerS: number,
    weaponViewmodelEntity: pc.Entity,
    hands: ViewmodelHandsState = { aimBlocked: reloadTimerS > 0, firing: false, weaponGlb: null }
  ): void {
    const aimedSpeedScale = 1 + (this.rig.sight.profile.moveSpeedScale - 1) * this.rig.adsBlend;
    const { moving, strafeSign } = this.movement.updateMovement(
      dt,
      this.rig.cameraYaw,
      this.input.keysPressed,
      aimedSpeedScale
    );

    this.rig.updateRig(
      dt,
      currentWeapon,
      reloadTimerS,
      hands,
      moving,
      strafeSign,
      this.cameraEntity.camera,
      weaponViewmodelEntity,
      this.hudController
    );

    this.syncCameraTransform();

    if (this.input.isTriggerHeld && isFullAuto(currentWeapon)) {
      this.callbacks.onTriggerPull();
    }
  }

  public destroy(): void {
    this.input.destroy();
    this.cameraEntity.destroy();
  }
}
