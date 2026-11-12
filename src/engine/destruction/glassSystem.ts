import * as pc from 'playcanvas';
import { GlassSystem } from './glass/glassSystemCore.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';

export * from './glass/glassSystemTypes.ts';
export * from './glass/glassPaneTexture.ts';
export * from './glass/marchingGlassAtlas.ts';
export * from './glass/glassShardMeshes.ts';
export * from './glass/marchingTileWindow.ts';
export * from './glass/voronoiGlassWindow.ts';
export * from './glass/glassRayBlastSolver.ts';
export * from './glass/glassSystemCore.ts';

export type GlassScriptLifecycleState = 'UNINITIALIZED' | 'ACTIVE' | 'SWAPPED_OUT' | 'DESTROYED';

/**
 * PlayCanvas Script Component for declarative Entity attachment of the Glass Destruction Subsystem.
 */
export class GlassSystemScript extends pc.Script {
  /**
   * @attribute
   * @type {number}
   * @default 512
   */
  public atlasSizePx = 512;

  /**
   * @attribute
   * @type {number}
   * @default 256
   */
  public windowTextureSizePx = 256;

  /**
   * @attribute
   * @type {number}
   * @default 512
   */
  public maxInstancedTriangles = 512;

  /**
   * @attribute
   * @type {number}
   * @default 640
   */
  public maxVoronoiShards = 640;

  public system: GlassSystem | null = null;
  private _lifecycleState: GlassScriptLifecycleState = 'UNINITIALIZED';
  private readonly _eventCleanups: Array<() => void> = [];

  public get lifecycleState(): GlassScriptLifecycleState {
    return this._lifecycleState;
  }

  public initialize(): void {
    if (this._lifecycleState === 'ACTIVE') return;
    const physics = (this.app as any).physicsWorld as RapierPhysicsWorld | undefined;
    if (physics && !this.system) {
      this.system = new GlassSystem(this.app as pc.Application, physics, {
        id: this.entity.name,
        atlasSizePx: this.atlasSizePx,
        windowTextureSizePx: this.windowTextureSizePx,
        maxInstancedTriangles: this.maxInstancedTriangles,
        maxVoronoiShards: this.maxVoronoiShards,
      });
    }

    this.bindEvents();
    this._lifecycleState = 'ACTIVE';
  }

  public update(dt: number): void {
    if (this._lifecycleState !== 'ACTIVE') return;
    this.system?.update(dt);
  }

  public destroy(): void {
    if (this._lifecycleState === 'DESTROYED') return;
    this.unbindEvents();
    if (this._lifecycleState !== 'SWAPPED_OUT') {
      this.system?.destroy();
    }
    this.system = null;
    this._lifecycleState = 'DESTROYED';
  }

  public swap(old: GlassSystemScript): void {
    old.unbindEvents();
    old._lifecycleState = 'SWAPPED_OUT';

    if (this.system && this.system !== old.system) {
      this.system.destroy();
    }
    this.system = old.system;
    old.system = null;

    this.bindEvents();
    this._lifecycleState = 'ACTIVE';
  }

  private bindEvents(): void {
    this.unbindEvents();
    this.app.on('destruction:glass:blast', this.onBlast, this);
    this.app.on('destruction:glass:reset', this.onReset, this);
    this._eventCleanups.push(
      () => this.app.off('destruction:glass:blast', this.onBlast, this),
      () => this.app.off('destruction:glass:reset', this.onReset, this),
    );
  }

  private unbindEvents(): void {
    while (this._eventCleanups.length > 0) {
      const cleanup = this._eventCleanups.pop();
      cleanup?.();
    }
  }

  private onBlast(blast: any): void {
    this.system?.applyBlast(blast);
  }

  private onReset(): void {
    this.system?.reset();
  }
}
