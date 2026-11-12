import type { WeaponSpec } from '../../contracts/ballistics.ts';
import type { FpsInputCallbacks } from './fpsTypes.ts';

export type InputCaptureState =
  | { readonly kind: 'UNLOCKED' }
  | { readonly kind: 'POINTER_LOCKED' };

/** Where aim input goes: hold on the right mouse button, toggle on Shift. */
export interface AimInputSink {
  setHeld(held: boolean): void;
  toggle(): void;
  release(): void;
  /** Look-speed multiplier for the current zoom. */
  getLookScale(): number;
}

const BASE_LOOK_DEG_PER_COUNT = 0.15;

export class PlayerInputManager {
  public captureState: InputCaptureState = { kind: 'UNLOCKED' };
  public isTriggerHeld = false;
  public readonly keysPressed: Record<string, boolean> = {};

  private readonly canvas: HTMLCanvasElement;
  private readonly callbacks: FpsInputCallbacks;
  private readonly getCurrentWeapon: () => WeaponSpec;
  private readonly onLook: (deltaYaw: number, deltaPitch: number) => void;
  private readonly aim: AimInputSink;
  private readonly eventCleanups: Array<() => void> = [];

  constructor(
    canvas: HTMLCanvasElement,
    callbacks: FpsInputCallbacks,
    getCurrentWeapon: () => WeaponSpec,
    onLook: (deltaYaw: number, deltaPitch: number) => void,
    aim: AimInputSink
  ) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.getCurrentWeapon = getCurrentWeapon;
    this.onLook = onLook;
    this.aim = aim;
    this.bind();
  }

  public get isPointerLocked(): boolean {
    return this.captureState.kind === 'POINTER_LOCKED';
  }

  public set isPointerLocked(locked: boolean) {
    this.transitionCaptureState(locked ? 'POINTER_LOCKED' : 'UNLOCKED');
  }

  public transitionCaptureState(nextKind: InputCaptureState['kind']): void {
    const prevKind = this.captureState.kind;
    if (prevKind === nextKind) return;

    this.captureState = { kind: nextKind };

    if (prevKind === 'POINTER_LOCKED' && nextKind === 'UNLOCKED') {
      this.isTriggerHeld = false;
      for (const key of Object.keys(this.keysPressed)) {
        delete this.keysPressed[key];
      }
      this.aim.release();
    }
  }

  private bind(): void {
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      const onPointerLockChange = (): void => {
        const locked = document.pointerLockElement === this.canvas;
        this.transitionCaptureState(locked ? 'POINTER_LOCKED' : 'UNLOCKED');
      };
      const onMouseMove = (e: MouseEvent): void => {
        if (this.captureState.kind !== 'POINTER_LOCKED') return;
        const sensitivity = BASE_LOOK_DEG_PER_COUNT * this.aim.getLookScale();
        this.onLook(e.movementX * sensitivity, e.movementY * sensitivity);
      };
      document.addEventListener('pointerlockchange', onPointerLockChange);
      document.addEventListener('mousemove', onMouseMove);
      this.eventCleanups.push(() => {
        document.removeEventListener('pointerlockchange', onPointerLockChange);
        document.removeEventListener('mousemove', onMouseMove);
      });
    }

    if (typeof this.canvas?.addEventListener === 'function') {
      const onMouseDown = (e: MouseEvent): void => {
        if (this.captureState.kind !== 'POINTER_LOCKED') {
          this.canvas.requestPointerLock?.();
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
          this.aim.setHeld(true);
        }
      };

      const onWheel = (e: WheelEvent): void => {
        if (this.captureState.kind !== 'POINTER_LOCKED') return;
        e.preventDefault();
        if (e.deltaY > 0) this.callbacks.onCycleWeapon(1);
        else if (e.deltaY < 0) this.callbacks.onCycleWeapon(-1);
      };

      const onContextMenu = (e: MouseEvent): void => {
        e.preventDefault();
      };

      this.canvas.addEventListener('mousedown', onMouseDown);
      this.canvas.addEventListener('wheel', onWheel, { passive: false });
      this.canvas.addEventListener('contextmenu', onContextMenu);
      this.eventCleanups.push(() => {
        this.canvas.removeEventListener('mousedown', onMouseDown);
        this.canvas.removeEventListener('wheel', onWheel);
        this.canvas.removeEventListener('contextmenu', onContextMenu);
      });
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const onMouseUp = (e: MouseEvent): void => {
        if (e.button === 0) this.isTriggerHeld = false;
        else if (e.button === 2) this.aim.setHeld(false);
      };

      const onKeyDown = (e: KeyboardEvent): void => {
        if (this.captureState.kind !== 'POINTER_LOCKED') return;
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
        else if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight') && !e.repeat) {
          this.aim.toggle();
        } else if (e.code === 'KeyX') this.callbacks.onToggleXRay();
        else if (e.code === 'KeyZ' && !e.repeat) this.callbacks.onToggleBulletTime?.();
      };

      const onKeyUp = (e: KeyboardEvent): void => {
        this.keysPressed[e.code] = false;
      };

      window.addEventListener('mouseup', onMouseUp);
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      this.eventCleanups.push(() => {
        window.removeEventListener('mouseup', onMouseUp);
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
      });
    }
  }

  public destroy(): void {
    this.transitionCaptureState('UNLOCKED');
    for (const cleanup of this.eventCleanups) {
      cleanup();
    }
    this.eventCleanups.length = 0;
  }
}
