import * as pc from 'playcanvas';
import type { DismembermentEvent, EnemyArchetypeId, TargetHealthState, TrajectorySample, Vec3Like } from '../contracts/ballistics.ts';
import type { EngineMaterialPalette } from './materials.ts';
import type { GlbModelRegistry } from './assets/glbLoader.ts';
import type {
  ActiveProjectileFx,
  ArterialFountainStream,
  BloodMistPuff,
  BloodPoolDecal,
  BoneShardSpark,
  GibChunk,
  InFlightBloodDrop,
  WetGoreMaterialSuite,
} from './fx/gore/goreTypes.ts';
import { createWetGoreMaterialSuite } from './fx/gore/wetGoreMaterials.ts';
import { spawnFlyingProjectile, updateProjectiles } from './fx/gore/projectileTrailFx.ts';
import { spawnDetachedHeadgearProp, spawnDroppedWeaponProp } from './fx/gore/detachedPropsFx.ts';
import { spawnBloodBurst, updateMistPuffs } from './fx/gore/bloodBurstFx.ts';
import { spawnDismembermentGibs, updateGibChunks } from './fx/gore/dismembermentGibsFx.ts';
import { attachArterialFountain, updateArterialFountains } from './fx/gore/arterialFountainFx.ts';
import { spawnArmorImpactSparks, spawnBoneShatterSparks, updateBoneShards } from './fx/gore/boneShardSparksFx.ts';
import { spawnBloodPool, updateBloodPools } from './fx/gore/bloodPoolDecalFx.ts';
import { updateBloodDrops } from './fx/gore/bloodDropsUpdate.ts';
import { createGoreFxPools, destroyGoreFxPools, releaseAllGoreFxPools, type GoreFxPools } from './fx/gore/goreFxPools.ts';
import { releaseFxEntity } from './fx/particles/fxEntityPool.ts';

export * from './fx/gore/goreTypes.ts';

export class GoreAndBallisticsFxManager {
  public readonly app: pc.AppBase;
  public readonly materials: EngineMaterialPalette;
  public readonly fxRoot: pc.Entity;

  private activeProjectiles: ActiveProjectileFx[] = [];
  private bloodDrops: InFlightBloodDrop[] = [];
  private bloodPools: BloodPoolDecal[] = [];
  private gibChunks: GibChunk[] = [];
  private boneShards: BoneShardSpark[] = [];
  private arterialFountains: ArterialFountainStream[] = [];
  private mistPuffs: BloodMistPuff[] = [];
  private glbRegistry: GlbModelRegistry | null = null;
  private readonly goreSuite: WetGoreMaterialSuite;
  private poolCounter = { val: 0 };
  private readonly pools: GoreFxPools;
  private readonly spawnPoolAt = (pos: pc.Vec3, rad: number): void => {
    spawnBloodPool(this.pools, this.bloodPools, this.poolCounter, pos, rad);
  };
  private cachedCameraPos: pc.Vec3 | null = null;
  private cachedCameraEntity: pc.Entity | null = null;
  private destroyed = false;

  constructor(app: pc.AppBase, materials: EngineMaterialPalette, glbRegistry?: GlbModelRegistry | null) {
    this.app = app;
    this.materials = materials;
    this.glbRegistry = glbRegistry ?? null;
    this.goreSuite = createWetGoreMaterialSuite(this.app.graphicsDevice ?? null);
    this.fxRoot = new pc.Entity('GoreAndBallisticsFxRoot');
    this.app.root.addChild(this.fxRoot);
    this.pools = createGoreFxPools(this.fxRoot, this.materials, this.goreSuite);
    this.cachedCameraEntity = (this.app.root?.findByName?.('PlayerCamera') as pc.Entity | null) ?? null;
  }

  public attachGlbRegistry(glbRegistry: GlbModelRegistry): void {
    this.glbRegistry = glbRegistry;
  }

  public setCachedCameraPos(pos: pc.Vec3): void {
    this.cachedCameraPos = pos;
  }

  public setCameraEntity(cameraEntity: pc.Entity | null): void {
    this.cachedCameraEntity = cameraEntity;
  }

  public spawnFlyingProjectile(trajectorySamples: TrajectorySample[], isShotgunPellet = false): ActiveProjectileFx | null {
    return spawnFlyingProjectile(this.pools, this.activeProjectiles, trajectorySamples, isShotgunPellet);
  }

  public spawnDetachedHeadgearProp(archetype: EnemyArchetypeId, worldPos: Vec3Like, shotDir: Vec3Like): void {
    spawnDetachedHeadgearProp(this.fxRoot, this.gibChunks, this.glbRegistry, archetype, worldPos, shotDir);
  }

  public spawnDroppedWeaponProp(archetype: EnemyArchetypeId, worldPos: Vec3Like, inheritedVel: Vec3Like): pc.Entity {
    return spawnDroppedWeaponProp(this.fxRoot, this.gibChunks, this.glbRegistry, archetype, worldPos, inheritedVel);
  }

  public spawnArmorImpactSparks(worldPos: Vec3Like, normalDir: Vec3Like): void {
    spawnArmorImpactSparks(this.pools, this.boneShards, worldPos, normalDir);
  }

  public spawnBloodBurst(worldPos: Vec3Like, normalDir: Vec3Like, energyJ: number, count = 16): void {
    spawnBloodBurst(this.pools, this.bloodDrops, this.mistPuffs, worldPos, normalDir, energyJ, count);
  }

  /** A small floor stain, such as one left by a body dragged along the ground. */
  public spawnBloodSmear(worldPos: Vec3Like, radius: number): void {
    this.spawnPoolAt(new pc.Vec3(worldPos.x, worldPos.y, worldPos.z), radius);
  }

  public spawnDismembermentGibs(event: DismembermentEvent): void {
    spawnDismembermentGibs(this.fxRoot, this.goreSuite, this.gibChunks, event, {
      spawnBloodBurst: (pos, dir, e, cnt) => this.spawnBloodBurst(pos, dir, e, cnt),
      spawnBloodPool: (pos, rad) => this.spawnPoolAt(pos, rad ?? 0.34),
    });
  }

  public attachArterialFountain(target: TargetHealthState, event: DismembermentEvent): void {
    attachArterialFountain(this.arterialFountains, target, event);
  }

  public spawnBoneShatterSparks(worldPos: Vec3Like, dir: Vec3Like): void {
    spawnBoneShatterSparks(this.pools, this.boneShards, worldPos, dir);
  }

  public update(dt: number, showTrails = true): void {
    if (this.destroyed) return;
    const gravity = -9.81;
    updateProjectiles(this.app, this.activeProjectiles, dt, showTrails);
    updateArterialFountains(this.arterialFountains, dt, (pos, dir, e, cnt) => this.spawnBloodBurst(pos, dir, e, cnt));
    updateBloodDrops(this.bloodDrops, dt, gravity, this.spawnPoolAt);

    const camPos =
      this.cachedCameraPos ??
      (this.cachedCameraEntity && this.cachedCameraEntity.parent
        ? this.cachedCameraEntity.getPosition()
        : null);
    updateMistPuffs(this.mistPuffs, dt, camPos);

    updateGibChunks(this.gibChunks, dt, gravity, this.spawnPoolAt);
    updateBoneShards(this.boneShards, dt, gravity);
    updateBloodPools(this.bloodPools, dt);
  }

  public clearAll(): void {
    for (const p of this.activeProjectiles) releaseFxEntity(p.entity);
    for (const d of this.bloodDrops) releaseFxEntity(d.entity);
    for (const m of this.mistPuffs) releaseFxEntity(m.entity);
    for (const g of this.gibChunks) g.entity.destroy();
    for (const s of this.boneShards) releaseFxEntity(s.entity);
    for (const b of this.bloodPools) releaseFxEntity(b.entity);
    releaseAllGoreFxPools(this.pools);

    this.activeProjectiles = [];
    this.bloodDrops = [];
    this.mistPuffs = [];
    this.gibChunks = [];
    this.boneShards = [];
    this.bloodPools = [];
    this.arterialFountains = [];
  }

  /**
   * Releases the FX entities this manager created. The wet-gore material suite is cached per graphics
   * device and shared with the preloader's shader warm-up, so it stays alive.
   */
  public destroy(): void {
    if (this.destroyed) return;
    this.clearAll();
    this.destroyed = true;
    destroyGoreFxPools(this.pools);
    this.fxRoot.destroy();
    this.cachedCameraEntity = null;
    this.cachedCameraPos = null;
    this.glbRegistry = null;
  }
}
