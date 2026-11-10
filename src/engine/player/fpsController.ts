import * as pc from 'playcanvas';
import { WeaponSpec } from '../../contracts/ballistics.ts';
import { HudController } from '../hudController.ts';

export interface FpsInputCallbacks {
  onTriggerPull: () => void;
  onSelectWeapon: (idx: number) => void;
  onCycleWeapon: (delta: number) => void;
  onCycleAmmo: () => void;
  onReload: () => void;
  onSpawnWave: () => void;
  onThrowGrenade: () => void;
  onToggleXRay: () => void;
  onToggleBulletTime?: () => void;
}

export class FpsController {
  public readonly cameraEntity: pc.Entity;
  public readonly playerPos = new pc.Vec3(0, 1.62, 0);
  public cameraPitch = -3.5;
  public cameraYaw = 0;
  public isPointerLocked = false;
  public isAimingDownSights = false;
  public isTriggerHeld = false;
  public recoilPitch = 0;
  public recoilOffsetZ = 0;
  public moveBobPhase = 0;
  public readonly keysPressed: Record<string, boolean> = {};

  /**
   * Optional horizontal movement collision resolver (prevPos -> mutates nextPos in place)
   * so solid cover walls and Rapier barriers can block or slide player movement cleanly.
   */
  public resolveHorizontalMovement?: (prev: pc.Vec3, next: pc.Vec3) => void;

  private readonly canvas: HTMLCanvasElement;
  private readonly hudController: HudController;
  private readonly getCurrentWeapon: () => WeaponSpec;
  private readonly callbacks: FpsInputCallbacks;
  private readonly scratchPrevPos = new pc.Vec3();

  private shakeTimerS = 0;
  private shakeDurationS = 0.001;
  private shakeIntensityDeg = 0;
  private shakeClockS = 0;

  constructor(
    app: pc.AppBase,
    canvas: HTMLCanvasElement,
    hudController: HudController,
    getCurrentWeapon: () => WeaponSpec,
    callbacks: FpsInputCallbacks,
    resolveHorizontalMovement?: (prev: pc.Vec3, next: pc.Vec3) => void
  ) {
    this.canvas = canvas;
    this.hudController = hudController;
    this.getCurrentWeapon = getCurrentWeapon;
    this.callbacks = callbacks;
    this.resolveHorizontalMovement = resolveHorizontalMovement;

    this.cameraEntity = new pc.Entity('PlayerCamera');
    this.cameraEntity.addComponent('camera', {
      clearColor: new pc.Color(0.05, 0.07, 0.10),
      fov: 68,
      nearClip: 0.08,
      farClip: 400,
    });
    this.cameraEntity.setPosition(this.playerPos.x, this.playerPos.y, this.playerPos.z);
    app.root.addChild(this.cameraEntity);

    this.bindInputListeners();
  }

  private bindInputListeners(): void {
    document.addEventListener('pointerlockchange', () => {
      this.isPointerLocked = document.pointerLockElement === this.canvas;
      if (!this.isPointerLocked) {
        this.isTriggerHeld = false;
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.isPointerLocked) return;

      const sensitivity = this.isAimingDownSights ? 0.075 : 0.15;
      this.cameraYaw -= e.movementX * sensitivity;
      this.cameraPitch -= e.movementY * sensitivity;
      this.cameraPitch = Math.max(-85, Math.min(85, this.cameraPitch));
    });

    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.isPointerLocked) {
        this.canvas.requestPointerLock();
        return;
      }

      if (e.button === 0) {
        this.isTriggerHeld = true;
        this.callbacks.onTriggerPull();
      } else if (e.button === 1) {
        e.preventDefault();
        this.callbacks.onThrowGrenade();
      } else if (e.button === 2) {
        e.preventDefault();
        this.setAimDownSights(!this.isAimingDownSights, this.getCurrentWeapon());
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) {
        this.isTriggerHeld = false;
      }
    });

    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (e.deltaY > 0) {
          this.callbacks.onCycleWeapon(1);
        } else if (e.deltaY < 0) {
          this.callbacks.onCycleWeapon(-1);
        }
      },
      { passive: false }
    );

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      this.keysPressed[e.code] = true;

      if (e.code === 'Digit1') {
        this.callbacks.onSelectWeapon(0);
      } else if (e.code === 'Digit2') {
        this.callbacks.onSelectWeapon(1);
      } else if (e.code === 'Digit3') {
        this.callbacks.onSelectWeapon(2);
      } else if (e.code === 'Digit4') {
        this.callbacks.onSelectWeapon(3);
      } else if (e.code === 'KeyB') {
        this.callbacks.onCycleAmmo();
      } else if (e.code === 'KeyR') {
        this.callbacks.onReload();
      } else if (e.code === 'KeyT' || e.code === 'Backspace') {
        e.preventDefault();
        this.callbacks.onSpawnWave();
      } else if (e.code === 'KeyF') {
        this.callbacks.onTriggerPull();
      } else if (e.code === 'KeyG') {
        this.callbacks.onThrowGrenade();
      } else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        this.setAimDownSights(!this.isAimingDownSights, this.getCurrentWeapon());
      } else if (e.code === 'KeyX') {
        this.callbacks.onToggleXRay();
      } else if (e.code === 'KeyZ' && !e.repeat) {
        this.callbacks.onToggleBulletTime?.();
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keysPressed[e.code] = false;
    });
  }

  public getAimDirection(): pc.Vec3 {
    const pitchRad = (this.cameraPitch * Math.PI) / 180;
    const yawRad = (this.cameraYaw * Math.PI) / 180;

    const x = -Math.sin(yawRad) * Math.cos(pitchRad);
    const y = Math.sin(pitchRad);
    const z = -Math.cos(yawRad) * Math.cos(pitchRad);

    return new pc.Vec3(x, y, z).normalize();
  }

  public getEyePosition(): pc.Vec3 {
    return this.playerPos.clone();
  }

  public applyRecoilKick(recoilKickDeg: number): void {
    this.recoilPitch = Math.min(8.0, this.recoilPitch + recoilKickDeg * 0.72);
    this.recoilOffsetZ = 0.075;
  }

  public applyCameraShake(intensityDeg: number, durationS = 0.36): void {
    if (intensityDeg <= 0 || durationS <= 0) return;
    this.shakeIntensityDeg = Math.min(6.5, Math.max(this.shakeIntensityDeg, intensityDeg));
    this.shakeDurationS = Math.max(0.05, durationS);
    this.shakeTimerS = Math.max(this.shakeTimerS, durationS);
  }

  public setAimDownSights(active: boolean, weapon: WeaponSpec): void {
    this.isAimingDownSights = active;
    const isSniper = weapon.role === 'SNIPER';
    const vm = this.cameraEntity.findByName('WeaponViewmodel') as pc.Entity | null;

    if (active) {
      const zoom = weapon.scopeZoomLevels[0] || 1.6;
      if (this.cameraEntity.camera) {
        this.cameraEntity.camera.fov = 68 / Math.max(1.25, zoom);
      }
      if (vm) {
        vm.setLocalPosition(0, -0.145, -0.32);
      }
      if (isSniper) {
        this.hudController.setScopeOverlay(true, zoom, 42.0, 0);
      } else {
        this.hudController.setScopeOverlay(false);
      }
    } else {
      if (this.cameraEntity.camera) {
        this.cameraEntity.camera.fov = 68;
      }
      if (vm) {
        vm.setLocalPosition(0.24, -0.22, -0.48);
      }
      this.hudController.setScopeOverlay(false);
    }
  }

  public update(
    dt: number,
    currentWeapon: WeaponSpec,
    reloadTimerS: number,
    weaponViewmodelEntity: pc.Entity
  ): void {
    // Full-Auto Trigger Hold for Assault Rifle
    if (this.isTriggerHeld && currentWeapon.role === 'ASSAULT_RIFLE') {
      this.callbacks.onTriggerPull();
    }

    // Recoil Recovery
    if (this.recoilPitch > 0) {
      this.recoilPitch = Math.max(0, this.recoilPitch - dt * 24);
    }
    if (this.recoilOffsetZ > 0) {
      this.recoilOffsetZ = Math.max(0, this.recoilOffsetZ - dt * 0.45);
    }

    // Blast Camera Shake Decay
    let shakePitchOffset = 0;
    let shakeYawOffset = 0;
    let shakeRollOffset = 0;
    if (this.shakeTimerS > 0) {
      this.shakeTimerS = Math.max(0, this.shakeTimerS - dt);
      this.shakeClockS += dt * 46.0;
      const decay = this.shakeTimerS / this.shakeDurationS;
      const amp = this.shakeIntensityDeg * decay * decay;
      shakePitchOffset = Math.sin(this.shakeClockS * 1.3) * amp;
      shakeYawOffset = Math.cos(this.shakeClockS * 0.95) * amp * 0.75;
      shakeRollOffset = Math.sin(this.shakeClockS * 1.7) * amp * 0.55;
      if (this.shakeTimerS <= 0) {
        this.shakeIntensityDeg = 0;
      }
    }

    // First-Person WASD Movement & Depot Bounds Clamping
    this.scratchPrevPos.copy(this.playerPos);
    const moveSpeed = 5.0 * dt;
    const yawRad = (this.cameraYaw * Math.PI) / 180;
    const fwdX = -Math.sin(yawRad);
    const fwdZ = -Math.cos(yawRad);
    const rightX = Math.cos(yawRad);
    const rightZ = -Math.sin(yawRad);

    let moving = false;
    if (this.keysPressed['KeyW']) {
      this.playerPos.x += fwdX * moveSpeed;
      this.playerPos.z += fwdZ * moveSpeed;
      moving = true;
    }
    if (this.keysPressed['KeyS']) {
      this.playerPos.x -= fwdX * moveSpeed;
      this.playerPos.z -= fwdZ * moveSpeed;
      moving = true;
    }
    if (this.keysPressed['KeyA']) {
      this.playerPos.x -= rightX * moveSpeed;
      this.playerPos.z -= rightZ * moveSpeed;
      moving = true;
    }
    if (this.keysPressed['KeyD']) {
      this.playerPos.x += rightX * moveSpeed;
      this.playerPos.z += rightZ * moveSpeed;
      moving = true;
    }

    if (this.resolveHorizontalMovement) {
      this.resolveHorizontalMovement(this.scratchPrevPos, this.playerPos);
    }

    // Keep player inside tactical depot bounds
    this.playerPos.x = Math.max(-8.2, Math.min(8.2, this.playerPos.x));
    this.playerPos.z = Math.max(-52.0, Math.min(6.0, this.playerPos.z));

    if (moving) {
      this.moveBobPhase += dt * 10.5;
    }

    this.cameraEntity.setPosition(this.playerPos.x, this.playerPos.y, this.playerPos.z);
    this.cameraEntity.setEulerAngles(
      this.cameraPitch + this.recoilPitch + shakePitchOffset,
      this.cameraYaw + shakeYawOffset,
      shakeRollOffset
    );

    const baseVmX = this.isAimingDownSights ? 0 : 0.24;
    const baseVmY = this.isAimingDownSights ? -0.145 : -0.22;
    const baseVmZ = this.isAimingDownSights ? -0.32 : -0.48;
    const reloadDipY = reloadTimerS > 0 ? -Math.sin((reloadTimerS / 0.65) * Math.PI) * 0.14 : 0;
    const bobX = moving && !this.isAimingDownSights ? Math.cos(this.moveBobPhase * 0.5) * 0.008 : 0;
    const bobY =
      moving && !this.isAimingDownSights ? Math.abs(Math.sin(this.moveBobPhase)) * -0.009 : 0;

    weaponViewmodelEntity.setLocalPosition(
      baseVmX + bobX,
      baseVmY + bobY + reloadDipY,
      baseVmZ + this.recoilOffsetZ
    );
    weaponViewmodelEntity.enabled = !(this.isAimingDownSights && currentWeapon.role === 'SNIPER');

    // Dynamic Crosshair Bloom
    const bloom = 1.0 + this.recoilPitch * 0.08 + (moving ? 0.16 : 0);
    const hideCrosshair = this.isAimingDownSights && currentWeapon.role === 'SNIPER';
    this.hudController.setCrosshairBloom(bloom, hideCrosshair);
  }
}
