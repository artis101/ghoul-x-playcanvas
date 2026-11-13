import * as pc from 'playcanvas';
import type { TargetHealthState } from '../../contracts/ballistics.ts';
import type { CombatantGlbInstance } from '../assets/glbLoader.ts';
import type { GoreAndBallisticsFxManager } from '../goreFx.ts';

const SMEAR_SPACING_M = 0.3;

/**
 * Leaves a blood trail behind a bleeding crawler. The crawl itself, a dragged leg and a low head
 * included, is all in the clips (`Crawl`, `CrawlDragLegRight`/`Left`); nothing here poses a bone.
 */
export class CombatantCrawlOverlay {
  private readonly lastSmear = new pc.Vec3(Number.NaN, 0, 0);

  public reset(): void {
    this.lastSmear.x = Number.NaN;
  }

  /**
   * `glb`, `dt` and `clockS` are kept so callers need not change; the trail only needs the
   * body's position and how fast it bleeds.
   */
  public sync(
    _glb: CombatantGlbInstance,
    healthState: TargetHealthState,
    crawling: boolean,
    _dt: number,
    _clockS: number,
    fxManager?: GoreAndBallisticsFxManager,
  ): void {
    if (!crawling) {
      this.lastSmear.x = Number.NaN;
      return;
    }
    if (fxManager && healthState.bleedRateHpPerSec > 0) this.leaveTrail(healthState, fxManager);
  }

  private leaveTrail(healthState: TargetHealthState, fxManager: GoreAndBallisticsFxManager): void {
    const { x, z } = healthState.worldPosition;
    if (!Number.isNaN(this.lastSmear.x) && Math.hypot(x - this.lastSmear.x, z - this.lastSmear.z) < SMEAR_SPACING_M) {
      return;
    }
    this.lastSmear.set(x, 0, z);
    fxManager.spawnBloodSmear(healthState.worldPosition, 0.07 + Math.min(0.09, healthState.bleedRateHpPerSec * 0.02));
  }
}
