import * as pc from 'playcanvas';
import { BulletTimeController } from './bulletTimeController.ts';
import type { KillPunchReason } from './bulletTimeTypes.ts';

export type BulletTimeScriptLifecycleState =
  | 'UNINITIALIZED'
  | 'ACTIVE'
  | 'SWAPPED_OUT'
  | 'DESTROYED';

export class BulletTimeScript extends pc.Script {
  /**
   * @attribute
   * @type {number}
   * @default 0.22
   * @range [0.08, 0.85]
   * @title Reflex Target Scale
   */
  public reflexTargetScale = 0.22;

  /**
   * @attribute
   * @type {number}
   * @default 20.0
   * @range [1, 100]
   * @title Drain Pct Per Sec
   */
  public drainPctPerRealSec = 20.0;

  /**
   * @attribute
   * @type {number}
   * @default 15.0
   * @range [1, 100]
   * @title Recharge Pct Per Sec
   */
  public rechargePctPerRealSec = 15.0;

  public controller!: BulletTimeController;
  private _lifecycleState: BulletTimeScriptLifecycleState = 'UNINITIALIZED';
  private readonly _eventCleanups: Array<() => void> = [];

  public get lifecycleState(): BulletTimeScriptLifecycleState {
    return this._lifecycleState;
  }

  public initialize(): void {
    if (this._lifecycleState === 'ACTIVE') return;
    if (!this.controller) {
      this.controller = new BulletTimeController({
        reflexTargetScale: this.reflexTargetScale,
        drainPctPerRealSec: this.drainPctPerRealSec,
        rechargePctPerRealSec: this.rechargePctPerRealSec,
      });
      this.controller.bindKeyboardShortcut();
      this.controller.mountVignetteOverlay();
    }

    this.bindEvents();
    this._lifecycleState = 'ACTIVE';
  }

  private bindEvents(): void {
    this.unbindEvents();
    const bind = (name: string, fn: (...args: unknown[]) => void): void => {
      this.app.on(name, fn, this);
      this._eventCleanups.push(() => this.app.off(name, fn, this));
    };

    bind('fx:bulletTimeToggle', () => {
      this.controller?.toggleReflex();
    });

    bind('fx:bulletTimeKillPunch', (d: unknown) => {
      const p = d as { reason?: KillPunchReason; durationS?: number };
      this.controller?.triggerKillPunch(p.durationS ?? 0.35, 0.16, p.reason ?? 'CRANIAL_POP');
    });

    bind('fx:bulletTimeAdrenaline', (d: unknown) => {
      const p = d as { amountPct: number };
      this.controller?.grantReflexEnergy(p.amountPct);
    });

    bind('fx:bulletTimeReset', () => {
      this.controller?.reset();
    });
  }

  private unbindEvents(): void {
    while (this._eventCleanups.length > 0) {
      const cleanup = this._eventCleanups.pop();
      cleanup?.();
    }
  }

  public update(dt: number): void {
    if (this._lifecycleState !== 'ACTIVE' || !this.controller) return;
    this.controller.update(dt);
  }

  public swap(old: BulletTimeScript): void {
    old.unbindEvents();
    old._lifecycleState = 'SWAPPED_OUT';

    if (this.controller && this.controller !== old.controller) {
      this.controller.destroy();
    }
    this.controller = old.controller;
    old.controller = undefined as unknown as BulletTimeController;

    this.bindEvents();
    this._lifecycleState = 'ACTIVE';
  }

  public destroy(): void {
    if (this._lifecycleState === 'DESTROYED') return;
    this.unbindEvents();
    if (this._lifecycleState !== 'SWAPPED_OUT') {
      this.controller?.destroy();
    }
    this.controller = undefined as unknown as BulletTimeController;
    this._lifecycleState = 'DESTROYED';
  }
}

try {
  (pc.registerScript as (script: typeof pc.Script, name?: string) => void)(
    BulletTimeScript,
    'bulletTimeScript',
  );
} catch {}
