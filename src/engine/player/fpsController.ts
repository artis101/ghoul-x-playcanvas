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

  // Smooth ADS interpolation & scope transition state
  private adsBlend = 0;
  private currentFov = 68;
  private sniperScopeVisible = false;

  // Weighty multi-axis recoil & rifling torsion state
  private recoilYaw = 0;
  private recoilCameraRoll = 0;
  private vmRecoilPitchDeg = 0;
  private vmRecoilRollDeg = 0;
  private vmRecoilOffsetY = 0;
  private recoilShotSign = 1;

  // Physiological breathing & mouse-look inertia micro-sway
  private breathClockS = 0;
  private moveBobBlend = 0;
  private swayYawOffset = 0;
  private swayPitchOffset = 0;

  // Blast camera shake state
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
      nearClip: 0.05,
      farClip: 400,
      toneMapping: pc.TONEMAP_ACES,
      gammaCorrection: pc.GAMMA_SRGB,
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
      const deltaYaw = e.movementX * sensitivity;
      const deltaPitch = e.movementY * sensitivity;

      this.cameraYaw -= deltaYaw;
      this.cameraPitch -= deltaPitch;
      this.cameraPitch = Math.max(-85, Math.min(85, this.cameraPitch));

      // Impart subtle rotational inertia lag to the first-person weapon rig
      const swayScale = this.isAimingDownSights ? 0.32 : 1.0;
      this.swayYawOffset = Math.max(
        -2.6,
        Math.min(2.6, this.swayYawOffset - deltaYaw * 0.28 * swayScale)
      );
      this.swayPitchOffset = Math.max(
        -2.2,
        Math.min(2.2, this.swayPitchOffset - deltaPitch * 0.24 * swayScale)
      );
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
    const adsBrace = this.isAimingDownSights ? 0.68 : 1.0;
    this.recoilShotSign = -this.recoilShotSign;

    this.recoilPitch = Math.min(8.0, this.recoilPitch + recoilKickDeg * 0.72 * adsBrace);
    this.recoilYaw = Math.max(
      -2.2,
      Math.min(2.2, this.recoilYaw + this.recoilShotSign * recoilKickDeg * 0.11 * adsBrace)
    );
    this.recoilCameraRoll = Math.max(
      -2.4,
      Math.min(2.4, this.recoilCameraRoll + this.recoilShotSign * recoilKickDeg * 0.16 * adsBrace)
    );

    const kickNorm = Math.min(1.6, Math.max(0.45, recoilKickDeg / 3.2));
    this.recoilOffsetZ = Math.min(0.105, Math.max(this.recoilOffsetZ, 0.058 * kickNorm * adsBrace));
    this.vmRecoilPitchDeg = Math.min(11.5, this.vmRecoilPitchDeg + recoilKickDeg * 1.18 * adsBrace);
    this.vmRecoilRollDeg = Math.max(
      -6.5,
      Math.min(6.5, this.vmRecoilRollDeg + this.recoilShotSign * recoilKickDeg * 0.55 * adsBrace)
    );
    this.vmRecoilOffsetY = Math.min(0.022, this.vmRecoilOffsetY + 0.0065 * kickNorm * adsBrace);
  }

  public applyCameraShake(intensityDeg: number, durationS = 0.36): void {
    if (intensityDeg <= 0 || durationS <= 0) return;
    this.shakeIntensityDeg = Math.min(6.5, Math.max(this.shakeIntensityDeg, intensityDeg));
    this.shakeDurationS = Math.max(0.05, durationS);
    this.shakeTimerS = Math.max(this.shakeTimerS, durationS);
  }

  public setAimDownSights(active: boolean, weapon: WeaponSpec): void {
    this.isAimingDownSights = active;
    if (!active && this.sniperScopeVisible) {
      this.sniperScopeVisible = false;
      this.hudController.setScopeOverlay(false);
    } else if (active && weapon.role !== 'SNIPER') {
      this.sniperScopeVisible = false;
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

    // Smooth ADS Blend & Dynamic FOV Transition
    const targetAds = this.isAimingDownSights ? 1.0 : 0.0;
    const adsLerp = 1 - Math.exp(-15.5 * dt);
    this.adsBlend += (targetAds - this.adsBlend) * adsLerp;
    if (Math.abs(targetAds - this.adsBlend) < 0.002) {
      this.adsBlend = targetAds;
    }

    const zoom = currentWeapon.scopeZoomLevels[0] || 1.6;
    const targetFov = this.isAimingDownSights ? 68 / Math.max(1.25, zoom) : 68;
    this.currentFov += (targetFov - this.currentFov) * (1 - Math.exp(-16.5 * dt));
    if (this.cameraEntity.camera) {
      this.cameraEntity.camera.fov = this.currentFov;
    }

    const isSniper = currentWeapon.role === 'SNIPER';
    const shouldShowScope = this.isAimingDownSights && isSniper && this.adsBlend >= 0.74;
    if (shouldShowScope !== this.sniperScopeVisible) {
      this.sniperScopeVisible = shouldShowScope;
      if (shouldShowScope) {
        this.hudController.setScopeOverlay(true, zoom, 42.0, 0);
      } else {
        this.hudController.setScopeOverlay(false);
      }
    }

    // Weighty Dual-Stage Exponential Recoil & Sway Recovery
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
    const moveSpeed = (this.isAimingDownSights ? 3.4 : 5.0) * dt;
    const yawRad = (this.cameraYaw * Math.PI) / 180;
    const fwdX = -Math.sin(yawRad);
    const fwdZ = -Math.cos(yawRad);
    const rightX = Math.cos(yawRad);
    const rightZ = -Math.sin(yawRad);

    let moving = false;
    let strafeSign = 0;
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
      strafeSign -= 1;
    }
    if (this.keysPressed['KeyD']) {
      this.playerPos.x += rightX * moveSpeed;
      this.playerPos.z += rightZ * moveSpeed;
      moving = true;
      strafeSign += 1;
    }

    if (this.resolveHorizontalMovement) {
      this.resolveHorizontalMovement(this.scratchPrevPos, this.playerPos);
    }

    // Keep player inside tactical depot bounds
    this.playerPos.x = Math.max(-8.2, Math.min(8.2, this.playerPos.x));
    this.playerPos.z = Math.max(-52.0, Math.min(6.0, this.playerPos.z));

    this.breathClockS += dt;
    if (moving) {
      this.moveBobPhase += dt * (this.isAimingDownSights ? 8.2 : 10.5);
    }
    const targetBobBlend = moving ? 1.0 : 0.0;
    this.moveBobBlend += (targetBobBlend - this.moveBobBlend) * (1 - Math.exp(-11.0 * dt));

    // Subtle headstride vertical micro-bob on eye camera
    const camHeadBobY =
      Math.sin(this.moveBobPhase * 2.0) * 0.008 * this.moveBobBlend * (1 - this.adsBlend * 0.65);

    this.cameraEntity.setPosition(
      this.playerPos.x,
      this.playerPos.y + camHeadBobY,
      this.playerPos.z
    );
    this.cameraEntity.setEulerAngles(
      this.cameraPitch + this.recoilPitch + shakePitchOffset,
      this.cameraYaw + this.recoilYaw + shakeYawOffset,
      this.recoilCameraRoll + shakeRollOffset
    );

    // Smooth hip-to-ADS cheek-weld pose + shoulder transition arc
    const baseVmX = 0.24 * (1 - this.adsBlend);
    const transitionArcDipY = Math.sin(this.adsBlend * Math.PI) * -0.014;
    const baseVmY = -0.22 + (-0.145 - -0.22) * this.adsBlend + transitionArcDipY;
    const baseVmZ = -0.48 + (-0.32 - -0.48) * this.adsBlend;

    // Physiological Lissajous respiratory breathing micro-sway
    const breathAtten = 1 - this.adsBlend * 0.76;
    const breathX = Math.cos(this.breathClockS * 0.92) * 0.0022 * breathAtten;
    const breathY = Math.sin(this.breathClockS * 1.84) * 0.0028 * breathAtten;
    const breathPitchDeg = Math.sin(this.breathClockS * 1.84 - 0.4) * 0.22 * breathAtten;

    // Figure-8 stride weapon bob + strafe tilt
    const strideAtten = this.moveBobBlend * (1 - this.adsBlend * 0.78);
    const bobX = Math.cos(this.moveBobPhase) * 0.0085 * strideAtten;
    const bobY = Math.abs(Math.sin(this.moveBobPhase)) * -0.0095 * strideAtten;
    const bobRollDeg = Math.sin(this.moveBobPhase) * 0.85 * strideAtten - strafeSign * 1.15 * strideAtten;

    // Reload dip & cant
    const reloadPhase = reloadTimerS > 0 ? Math.sin((reloadTimerS / 0.65) * Math.PI) : 0;
    const reloadDipY = -reloadPhase * 0.135;
    const reloadRollDeg = reloadPhase * 14.0;
    const reloadPitchDeg = -reloadPhase * 9.5;

    // Mouse-look inertia translation & subtle tactical hip cant (-1.75 deg -> 0 deg in ADS)
    const swayTransX = this.swayYawOffset * 0.0045;
    const swayTransY = -this.swayPitchOffset * 0.004;
    const hipCantRollDeg = -1.75 * (1 - this.adsBlend);

    weaponViewmodelEntity.setLocalPosition(
      baseVmX + breathX + bobX + swayTransX,
      baseVmY + breathY + bobY + swayTransY + reloadDipY - this.vmRecoilOffsetY,
      baseVmZ + this.recoilOffsetZ
    );
    weaponViewmodelEntity.setLocalEulerAngles(
      this.vmRecoilPitchDeg + breathPitchDeg + this.swayPitchOffset * 0.65 + reloadPitchDeg,
      this.swayYawOffset * 0.85,
      hipCantRollDeg + bobRollDeg + this.vmRecoilRollDeg - this.swayYawOffset * 0.55 + reloadRollDeg
    );
    weaponViewmodelEntity.enabled = !this.sniperScopeVisible;

    // Dynamic Crosshair Bloom
    const bloom = 1.0 + this.recoilPitch * 0.08 + this.moveBobBlend * 0.16 * (1 - this.adsBlend * 0.5);
    this.hudController.setCrosshairBloom(bloom, this.sniperScopeVisible);
  }
}
