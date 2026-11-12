import * as pc from 'playcanvas';
import { ExplosiveBarrelManager } from './explosiveBarrelManager.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import type { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import type { BlastEvent } from '../../../contracts/destruction.ts';

export type HazardBarrelsScriptLifecycleState =
  | 'UNINITIALIZED'
  | 'ACTIVE'
  | 'SWAPPED_OUT'
  | 'DESTROYED';

/**
 * HazardBarrelsScript attaches ExplosiveBarrelManager lifecycle to a PlayCanvas Entity.
 */
export class HazardBarrelsScript extends pc.Script {
  /**
   * @attribute
   * @type {number}
   * @default 0.08
   * @range [0, 1]
   * @title Sympathetic Chain Fuse (s)
   */
  public sympatheticChainFuseS = 0.08;

  public barrelManager: ExplosiveBarrelManager | null = null;
  private _lifecycleState: HazardBarrelsScriptLifecycleState = 'UNINITIALIZED';
  private readonly _eventCleanups: Array<() => void> = [];

  public get lifecycleState(): HazardBarrelsScriptLifecycleState {
    return this._lifecycleState;
  }

  public initialize(): void {
    if (this._lifecycleState === 'ACTIVE') return;
    const rapier = (this.app as unknown as { rapierWorld?: RapierPhysicsWorld }).rapierWorld;
    const pool = (this.app as unknown as { shrapnelPool?: HardwareInstancedPool }).shrapnelPool;
    if (rapier && !this.barrelManager) {
      this.barrelManager = new ExplosiveBarrelManager({
        app: this.app as pc.Application,
        rapierWorld: rapier,
        shrapnelPool: pool,
        sympatheticChainFuseS: this.sympatheticChainFuseS,
      });
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

    bind('fx:barrels:blast', (data: unknown) => {
      this.barrelManager?.applyBlast(data as BlastEvent);
    });

    bind('fx:barrels:reset', () => {
      this.barrelManager?.reset();
    });
  }

  private unbindEvents(): void {
    while (this._eventCleanups.length > 0) {
      const cleanup = this._eventCleanups.pop();
      cleanup?.();
    }
  }

  public update(dt: number): void {
    if (this._lifecycleState !== 'ACTIVE') return;
    this.barrelManager?.update(dt);
  }

  public reset(): void {
    this.barrelManager?.reset();
  }

  public swap(old: HazardBarrelsScript): void {
    old.unbindEvents();
    old._lifecycleState = 'SWAPPED_OUT';

    if (this.barrelManager && this.barrelManager !== old.barrelManager) {
      this.barrelManager.destroy();
    }
    this.barrelManager = old.barrelManager;
    old.barrelManager = null;

    this.bindEvents();
    this._lifecycleState = 'ACTIVE';
  }

  public destroy(): void {
    if (this._lifecycleState === 'DESTROYED') return;
    this.unbindEvents();
    if (this._lifecycleState !== 'SWAPPED_OUT') {
      this.barrelManager?.destroy();
    }
    this.barrelManager = null;
    this._lifecycleState = 'DESTROYED';
  }
}

try {
  (pc.registerScript as (script: typeof pc.Script, name?: string) => void)(
    HazardBarrelsScript,
    'hazardBarrelsScript',
  );
} catch {}
