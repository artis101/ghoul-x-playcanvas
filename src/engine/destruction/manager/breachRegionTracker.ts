import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { PenetrationRayHit } from '../../../contracts/destruction.ts';
import type { RapierPhysicsWorld, SphereRegion } from '../../physics/rapierWorld.ts';
import type { PomCraterDecalSystem } from '../pomCraterDecals.ts';

/** Radius around a bullet-driven breach whose craters and resting debris are re-checked. */
export const BULLET_BREACH_RADIUS_M = 2.5;
/** Extra reach past a blast radius for the same re-check. */
export const BLAST_BREACH_MARGIN_M = 1.5;
const MAX_PENDING_REGIONS = 32;
const REGION_MERGE_DIST_SQ = 0.5 * 0.5;

export type SurfaceOpenPredicate = (
  hit: PenetrationRayHit,
  origin: Vec3Like,
  dir: Vec3Like,
  maxDistM: number
) => boolean;

/**
 * Tracks changes to which paths through destructible cover are open.
 * `version` bumps on every change; the changed spheres are kept until processed once.
 */
export class BreachRegionTracker {
  public version = 0;
  private processedVersion = 0;
  private readonly regions: SphereRegion[] = [];
  private global = false;

  public get hasPending(): boolean {
    return this.version !== this.processedVersion;
  }

  /** Without a center the whole world counts as changed. */
  public note(centerWorld?: Vec3Like, radiusM = BULLET_BREACH_RADIUS_M): void {
    this.version++;
    if (this.global) return;
    if (!centerWorld) {
      this.global = true;
      this.regions.length = 0;
      return;
    }
    const r = Math.max(0.1, radiusM);
    for (let i = 0; i < this.regions.length; i++) {
      const e = this.regions[i];
      const dx = e.x - centerWorld.x;
      const dy = e.y - centerWorld.y;
      const dz = e.z - centerWorld.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq <= REGION_MERGE_DIST_SQ) {
        e.radiusM = Math.max(e.radiusM, r);
        return;
      }
      // A center inside the inner half of an existing sphere grows that sphere to cover the new one.
      if (distSq <= e.radiusM * e.radiusM * 0.25) {
        e.radiusM = Math.max(e.radiusM, Math.sqrt(distSq) + r);
        return;
      }
    }
    if (this.regions.length >= MAX_PENDING_REGIONS) {
      this.global = true;
      this.regions.length = 0;
      return;
    }
    this.regions.push({ x: centerWorld.x, y: centerWorld.y, z: centerWorld.z, radiusM: r });
  }

  public process(
    rapierWorld: RapierPhysicsWorld,
    pomDecals: PomCraterDecalSystem,
    isSurfaceOpen: SurfaceOpenPredicate
  ): void {
    if (!this.hasPending) return;
    this.processedVersion = this.version;
    if (this.global) {
      pomDecals.pruneUnsupportedCraters(rapierWorld, isSurfaceOpen);
      rapierWorld.wakeAllSleepingDynamicBodies();
    } else if (this.regions.length > 0) {
      pomDecals.pruneUnsupportedCraters(rapierWorld, isSurfaceOpen, this.regions);
      rapierWorld.wakeDynamicBodiesInRegions(this.regions);
    }
    this.regions.length = 0;
    this.global = false;
  }
}
