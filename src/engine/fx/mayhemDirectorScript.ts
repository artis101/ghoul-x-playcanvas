import * as pc from 'playcanvas';
import { MayhemDirector } from './mayhemDirectorCore.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';

/**
 * MayhemDirectorScript attaches the MayhemDirector lifecycle to a PlayCanvas scene Entity.
 *
 * @attribute {number} dynamicLightPoolSize - Max number of pooled omni flash/explosion lights (default 2)
 * @attribute {number} maxBrassCasings - Capacity of brass casing hardware-instanced pool (default 256)
 * @attribute {number} maxShotgunHulls - Capacity of shotgun hull hardware-instanced pool (default 128)
 * @attribute {number} maxBloodSplatters - Capacity of blood splatter decal pool (default 384)
 */
export class MayhemDirectorScript extends pc.ScriptType {
  public dynamicLightPoolSize = 2;
  public maxBrassCasings = 256;
  public maxShotgunHulls = 128;
  public maxBloodSplatters = 384;

  public director: MayhemDirector | null = null;

  public initialize(): void {
    const rapier = (this.app as any).rapierWorld as RapierPhysicsWorld | undefined;
    if (!rapier) return;

    this.director = new MayhemDirector({
      app: this.app as any,
      rapierWorld: rapier,
      dynamicLightPoolSize: this.dynamicLightPoolSize,
      maxBrassCasings: this.maxBrassCasings,
      maxShotgunHulls: this.maxShotgunHulls,
      maxBloodSplatters: this.maxBloodSplatters,
    });
  }

  public update(dt: number): void {
    this.director?.update(dt);
  }

  public resetWave(clearBloodDecals = false): void {
    this.director?.resetWave(clearBloodDecals);
  }

  public destroy(): void {
    this.director?.destroy();
    this.director = null;
  }
}

try {
  pc.registerScript(MayhemDirectorScript, 'mayhemDirectorScript');
} catch {}
