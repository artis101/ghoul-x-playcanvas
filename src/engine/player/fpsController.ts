import * as pc from 'playcanvas';
import type { WeaponSpec } from '../../contracts/ballistics.ts';
import type { HudController } from '../hudController.ts';
import type { FpsInputCallbacks } from './fpsTypes.ts';
import { PlayerCameraRig, type PlayerSightState } from './playerCameraRig.ts';
import { PlayerInputManager } from './playerInput.ts';
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
      (active) => this.setAimDownSights(active, this.getCurrentWeapon()),
      () => this.rig.isAimingDownSights
    );

    this.cameraEntity = new pc.Entity('PlayerCamera');
    this.cameraEntity.addComponent('camera', {
      clearColor: new pc.Color(0.05, 0.07, 0.1),
      fov: 68,
      nearClip: 0.05,
      farClip: 400,
      toneMapping: pc.TONEMAP_ACES,
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
      this.rig.cameraPitch + this.rig.recoilPitch + this.rig.lastShakePitchOffset,
      this.rig.cameraYaw + this.rig.lastShakeYawOffset,
      this.rig.lastShakeRollOffset
    );
  }

  public getAimDirection(): pc.Vec3 {
    const effectivePitch = Math.max(-89.5, Math.min(89.5, this.rig.cameraPitch + this.rig.recoilPitch + this.rig.lastShakePitchOffset));
    const effectiveYaw = this.rig.cameraYaw + this.rig.lastShakeYawOffset;
    const pitchRad = (effectivePitch * Math.PI) / 180;
    const yawRad = (effectiveYaw * Math.PI) / 180;
    const x = -Math.sin(yawRad) * Math.cos(pitchRad);
    const y = Math.sin(pitchRad);
    const z = -Math.cos(yawRad) * Math.cos(pitchRad);
    return new pc.Vec3(x, y, z).normalize();
  }

  public getEyePosition(): pc.Vec3 {
    return new pc.Vec3(this.playerPos.x, this.playerPos.y + this.rig.lastCamHeadBobY, this.playerPos.z);
  }

  public applyRecoilKick(recoilKickDeg: number, applyViewmodelKick = true): void {
    this.rig.applyRecoilKick(recoilKickDeg, applyViewmodelKick);
  }

  public applyCameraShake(intensityDeg: number, durationS = 0.36): void {
    this.rig.applyCameraShake(intensityDeg, durationS);
  }

  public setAimDownSights(active: boolean, weapon: WeaponSpec): void {
    this.rig.setAimDownSights(active, weapon, this.hudController);
  }

  public update(dt: number, currentWeapon: WeaponSpec, reloadTimerS: number, weaponViewmodelEntity: pc.Entity): void {
    const { moving, strafeSign } = this.movement.updateMovement(
      dt,
      this.rig.cameraYaw,
      this.input.keysPressed,
      this.rig.isAimingDownSights
    );

    this.rig.updateRig(
      dt,
      currentWeapon,
      reloadTimerS,
      moving,
      strafeSign,
      this.cameraEntity.camera,
      weaponViewmodelEntity,
      this.hudController
    );

    this.syncCameraTransform();

    if (this.input.isTriggerHeld && currentWeapon.role === 'ASSAULT_RIFLE') {
      this.callbacks.onTriggerPull();
    }
  }

  public destroy(): void {
    this.input.destroy();
    this.cameraEntity.destroy();
  }
}
