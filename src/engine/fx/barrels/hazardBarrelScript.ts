import * as pc from 'playcanvas';
import { ExplosiveBarrelManager } from './explosiveBarrelManager.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import type { HardwareInstancedPool } from '../../physics/instancedPool.ts';

/**
 * HazardBarrelsScript attaches ExplosiveBarrelManager lifecycle to a PlayCanvas Entity.
 *
 * @attribute {number} sympatheticChainFuseS - Delay in seconds when an adjacent blast sympathetically ignites a neighbor
 */
export class HazardBarrelsScript extends pc.ScriptType {
  public sympatheticChainFuseS = 0.08;

  public barrelManager: ExplosiveBarrelManager | null = null;

  public initialize(): void {
    const rapier = (this.app as any).rapierWorld as RapierPhysicsWorld | undefined;
    const pool = (this.app as any).shrapnelPool as HardwareInstancedPool | undefined;
    if (!rapier) return;

    this.barrelManager = new ExplosiveBarrelManager({
      app: this.app as any,
      rapierWorld: rapier,
      shrapnelPool: pool,
      sympatheticChainFuseS: this.sympatheticChainFuseS,
    });
  }

  public update(dt: number): void {
    this.barrelManager?.update(dt);
  }

  public reset(): void {
    this.barrelManager?.reset();
  }

  public destroy(): void {
    this.barrelManager?.destroy();
    this.barrelManager = null;
  }
}

try {
  pc.registerScript(HazardBarrelsScript, 'hazardBarrelsScript');
} catch {}
