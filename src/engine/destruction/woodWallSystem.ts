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

  public initialize(): void {
    const physics = (this.app as any).physicsWorld as RapierPhysicsWorld | undefined;
    if (physics) {
      this.system = new WoodWallSystem(this.app as pc.Application, physics, {
        id: this.entity.name,
        maxPanelVertices: this.maxPanelVertices,
        maxPanelIndices: this.maxPanelIndices,
        maxSplinterInstances: this.maxSplinterInstances,
      });
    }

    this.app.on('destruction:wood:blast', this.onBlast, this);
    this.app.on('destruction:wood:reset', this.onReset, this);
  }

  public update(dt: number): void {
    this.system?.update(dt);
  }

  public destroy(): void {
    this.app.off('destruction:wood:blast', this.onBlast, this);
    this.app.off('destruction:wood:reset', this.onReset, this);
    this.system?.destroy();
    this.system = null;
  }

  public swap(old: WoodWallSystemScript): void {
    this.system = old.system;
  }

  private onBlast(blast: any): void {
    this.system?.applyBlast(blast);
  }

  private onReset(): void {
    this.system?.reset();
  }
}
