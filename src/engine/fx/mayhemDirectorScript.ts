import * as pc from 'playcanvas';
import { MayhemDirector } from './mayhemDirectorCore.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';

export type MayhemDirectorScriptLifecycleState =
  | 'UNINITIALIZED'
  | 'ACTIVE'
  | 'SWAPPED_OUT'
  | 'DESTROYED';

/**
 * MayhemDirectorScript attaches the MayhemDirector lifecycle to a PlayCanvas scene Entity.
 */
export class MayhemDirectorScript extends pc.Script {
  /**
   * @attribute
   * @type {number}
   * @default 2
   * @range [1, 8]
   * @title Dynamic Light Pool Size
   */
  public dynamicLightPoolSize = 2;

  /**
   * @attribute
   * @type {number}
   * @default 256
   * @range [32, 1024]
   * @title Max Brass Casings
   */
  public maxBrassCasings = 256;

  /**
   * @attribute
   * @type {number}
   * @default 128
   * @range [16, 512]
   * @title Max Shotgun Hulls
   */
  public maxShotgunHulls = 128;

  /**
   * @attribute
   * @type {number}
   * @default 384
   * @range [64, 1024]
   * @title Max Blood Splatters
   */
  public maxBloodSplatters = 384;

  public director: MayhemDirector | null = null;
  private _lifecycleState: MayhemDirectorScriptLifecycleState = 'UNINITIALIZED';
  private readonly _eventCleanups: Array<() => void> = [];

  public get lifecycleState(): MayhemDirectorScriptLifecycleState {
    return this._lifecycleState;
  }

  public initialize(): void {
    if (this._lifecycleState === 'ACTIVE') return;
    const rapier = (this.app as unknown as { rapierWorld?: RapierPhysicsWorld }).rapierWorld;
    if (rapier && !this.director) {
      this.director = new MayhemDirector({
        app: this.app as pc.Application,
        rapierWorld: rapier,
        dynamicLightPoolSize: this.dynamicLightPoolSize,
        maxBrassCasings: this.maxBrassCasings,
        maxShotgunHulls: this.maxShotgunHulls,
        maxBloodSplatters: this.maxBloodSplatters,
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

    bind('fx:mayhem:resetWave', (data: unknown) => {
      const p = data as { clearBloodDecals?: boolean } | undefined;
      this.director?.resetWave(Boolean(p?.clearBloodDecals));
    });

    bind('camera:transform', (data: unknown) => {
      const p = data as { position?: pc.Vec3; entity?: pc.Entity } | undefined;
      if (p?.entity) this.director?.setCameraEntity(p.entity);
      if (p?.position) this.director?.setCachedCameraPos(p.position);
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
    this.director?.update(dt);
  }

  public resetWave(clearBloodDecals = false): void {
    this.director?.resetWave(clearBloodDecals);
  }

  public swap(old: MayhemDirectorScript): void {
    old.unbindEvents();
    old._lifecycleState = 'SWAPPED_OUT';

    if (this.director && this.director !== old.director) {
      this.director.destroy();
    }
    this.director = old.director;
    old.director = null;

    this.bindEvents();
    this._lifecycleState = 'ACTIVE';
  }

  public destroy(): void {
    if (this._lifecycleState === 'DESTROYED') return;
    this.unbindEvents();
    if (this._lifecycleState !== 'SWAPPED_OUT') {
      this.director?.destroy();
    }
    this.director = null;
    this._lifecycleState = 'DESTROYED';
  }
}

try {
  (pc.registerScript as (script: typeof pc.Script, name?: string) => void)(
    MayhemDirectorScript,
    'mayhemDirectorScript',
  );
} catch {}
