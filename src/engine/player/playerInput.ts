import type { WeaponSpec } from '../../contracts/ballistics.ts';
import type { FpsInputCallbacks } from './fpsTypes.ts';

export class PlayerInputManager {
  public isPointerLocked = false;
  public isTriggerHeld = false;
  public readonly keysPressed: Record<string, boolean> = {};

  private readonly canvas: HTMLCanvasElement;
  private readonly callbacks: FpsInputCallbacks;
  private readonly getCurrentWeapon: () => WeaponSpec;
  private readonly onLook: (deltaYaw: number, deltaPitch: number) => void;
  private readonly onToggleAds: (active: boolean) => void;
  private isAimingDownSights = false;

  constructor(
    canvas: HTMLCanvasElement,
    callbacks: FpsInputCallbacks,
    getCurrentWeapon: () => WeaponSpec,
    onLook: (deltaYaw: number, deltaPitch: number) => void,
    onToggleAds: (active: boolean) => void
  ) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.getCurrentWeapon = getCurrentWeapon;
    this.onLook = onLook;
    this.onToggleAds = onToggleAds;
    this.bind();
  }

  public setAdsState(ads: boolean): void {
    this.isAimingDownSights = ads;
  }

  private bind(): void {
    document.addEventListener('pointerlockchange', () => {
      this.isPointerLocked = document.pointerLockElement === this.canvas;
      if (!this.isPointerLocked) this.isTriggerHeld = false;
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.isPointerLocked) return;
      const sensitivity = this.isAimingDownSights ? 0.075 : 0.15;
      this.onLook(e.movementX * sensitivity, e.movementY * sensitivity);
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
        this.onToggleAds(!this.isAimingDownSights);
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.isTriggerHeld = false;
    });

    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (e.deltaY > 0) this.callbacks.onCycleWeapon(1);
        else if (e.deltaY < 0) this.callbacks.onCycleWeapon(-1);
      },
      { passive: false }
    );

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      this.keysPressed[e.code] = true;
      if (e.code === 'Digit1') this.callbacks.onSelectWeapon(0);
      else if (e.code === 'Digit2') this.callbacks.onSelectWeapon(1);
      else if (e.code === 'Digit3') this.callbacks.onSelectWeapon(2);
      else if (e.code === 'Digit4') this.callbacks.onSelectWeapon(3);
      else if (e.code === 'KeyB') this.callbacks.onCycleAmmo();
      else if (e.code === 'KeyR') this.callbacks.onReload();
      else if (e.code === 'KeyT' || e.code === 'Backspace') {
        e.preventDefault();
        this.callbacks.onSpawnWave();
      } else if (e.code === 'KeyF') this.callbacks.onTriggerPull();
      else if (e.code === 'KeyG') this.callbacks.onThrowGrenade();
      else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        this.onToggleAds(!this.isAimingDownSights);
      } else if (e.code === 'KeyX') this.callbacks.onToggleXRay();
      else if (e.code === 'KeyZ' && !e.repeat) this.callbacks.onToggleBulletTime?.();
    });

    window.addEventListener('keyup', (e) => {
      this.keysPressed[e.code] = false;
    });
  }
}
