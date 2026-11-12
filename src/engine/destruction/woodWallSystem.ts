import * as pc from 'playcanvas';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import { WoodWallSystem } from './wood/woodWallSystemCore.ts';

export * from './wood/woodWallTypes.ts';
export * from './wood/woodProceduralTextures.ts';
export * from './wood/woodSplinterMeshes.ts';
export * from './wood/woodStudFrameBuilder.ts';
export * from './wood/buckshotVolleyTracker.ts';
export * from './wood/woodStudColliderSync.ts';
export * from './wood/woodSplinterEmitter.ts';
export * from './wood/woodStudDamageSolver.ts';
export * from './wood/woodWallInstanceBuilder.ts';
export * from './wood/woodWallRayBlastSolver.ts';
export * from './wood/woodWallSystemCore.ts';

export type WoodScriptLifecycleState = 'UNINITIALIZED' | 'ACTIVE' | 'SWAPPED_OUT' | 'DESTROYED';

/**
 * PlayCanvas Script Component for declarative Entity attachment of the Wood Wall Destruction Subsystem.
 */
export class WoodWallSystemScript extends pc.Script {
  /**
   * @attribute
   * @type {number}
   * @default 4096
   */
  public maxPanelVertices = 4096;

  /**
   * @attribute
   * @type {number}
   * @default 12288
   */
  public maxPanelIndices = 12288;

  /**
   * @attribute
   * @type {number}
   * @default 768
   */
  public maxSplinterInstances = 768;

  public system: WoodWallSystem | null = null;
  private _lifecycleState: WoodScriptLifecycleState = 'UNINITIALIZED';
  private readonly _eventCleanups: Array<() => void> = [];

  public get lifecycleState(): WoodScriptLifecycleState {
    return this._lifecycleState;
  }

  public initialize(): void {
    if (this._lifecycleState === 'ACTIVE') return;
    const physics = (this.app as any).physicsWorld as RapierPhysicsWorld | undefined;
    if (physics && !this.system) {
      this.system = new WoodWallSystem(this.app as pc.Application, physics, {
        id: this.entity.name,
        maxPanelVertices: this.maxPanelVertices,
        maxPanelIndices: this.maxPanelIndices,
        maxSplinterInstances: this.maxSplinterInstances,
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

  public swap(old: WoodWallSystemScript): void {
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
    this.app.on('destruction:wood:blast', this.onBlast, this);
    this.app.on('destruction:wood:reset', this.onReset, this);
    this._eventCleanups.push(
      () => this.app.off('destruction:wood:blast', this.onBlast, this),
      () => this.app.off('destruction:wood:reset', this.onReset, this),
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
