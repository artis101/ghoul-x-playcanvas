import * as pc from 'playcanvas';
import { BulletTimeController } from './bulletTimeController.ts';
import type { KillPunchReason } from './bulletTimeTypes.ts';

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
  private appEventHandles: Array<{ name: string; fn: (...args: unknown[]) => void }> = [];

  public initialize(): void {
    this.controller = new BulletTimeController({
      reflexTargetScale: this.reflexTargetScale,
      drainPctPerRealSec: this.drainPctPerRealSec,
      rechargePctPerRealSec: this.rechargePctPerRealSec,
    });

    this.controller.bindKeyboardShortcut();
    this.controller.mountVignetteOverlay();

    const bind = (name: string, fn: (...args: unknown[]) => void): void => {
      this.app.on(name, fn, this);
      this.appEventHandles.push({ name, fn });
    };

    bind('fx:bulletTimeToggle', () => {
      this.controller.toggleReflex();
    });

    bind('fx:bulletTimeKillPunch', (d: unknown) => {
      const p = d as { reason?: KillPunchReason; durationS?: number };
      this.controller.triggerKillPunch(p.durationS ?? 0.35, 0.16, p.reason ?? 'CRANIAL_POP');
    });

    bind('fx:bulletTimeAdrenaline', (d: unknown) => {
      const p = d as { amountPct: number };
      this.controller.grantReflexEnergy(p.amountPct);
    });
  }

  public update(dt: number): void {
    this.controller.update(dt);
  }

  public swap(old: BulletTimeScript): void {
    this.controller = old.controller;
    this.appEventHandles = old.appEventHandles;
  }

  public destroy(): void {
    for (const h of this.appEventHandles) {
      this.app.off(h.name, h.fn, this);
    }
    this.appEventHandles.length = 0;
    this.controller.destroy();
  }
}
