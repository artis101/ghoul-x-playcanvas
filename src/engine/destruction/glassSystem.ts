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

  public initialize(): void {
    const physics = (this.app as any).physicsWorld as RapierPhysicsWorld | undefined;
    if (physics) {
      this.system = new GlassSystem(this.app as pc.Application, physics, {
        id: this.entity.name,
        atlasSizePx: this.atlasSizePx,
        windowTextureSizePx: this.windowTextureSizePx,
        maxInstancedTriangles: this.maxInstancedTriangles,
        maxVoronoiShards: this.maxVoronoiShards,
      });
    }

    this.app.on('destruction:glass:blast', this.onBlast, this);
    this.app.on('destruction:glass:reset', this.onReset, this);
  }

  public update(dt: number): void {
    this.system?.update(dt);
  }

  public destroy(): void {
    this.app.off('destruction:glass:blast', this.onBlast, this);
    this.app.off('destruction:glass:reset', this.onReset, this);
    this.system?.destroy();
    this.system = null;
  }

  public swap(old: GlassSystemScript): void {
    this.system = old.system;
  }

  private onBlast(blast: any): void {
    this.system?.applyBlast(blast);
  }

  private onReset(): void {
    this.system?.reset();
  }
}
