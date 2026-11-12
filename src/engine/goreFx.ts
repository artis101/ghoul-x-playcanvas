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

export * from './fx/gore/goreTypes.ts';
export { GoreFxScript } from './fx/gore/goreFxScript.ts';

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
  private cachedCameraPos: pc.Vec3 | null = null;
  private cachedCameraEntity: pc.Entity | null = null;

  constructor(app: pc.AppBase, materials: EngineMaterialPalette, glbRegistry?: GlbModelRegistry | null) {
    this.app = app;
    this.materials = materials;
    this.glbRegistry = glbRegistry ?? null;
    this.goreSuite = createWetGoreMaterialSuite(this.app.graphicsDevice ?? null);
    this.fxRoot = new pc.Entity('GoreAndBallisticsFxRoot');
    this.app.root.addChild(this.fxRoot);
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
    return spawnFlyingProjectile(this.fxRoot, this.materials, this.goreSuite, this.activeProjectiles, trajectorySamples, isShotgunPellet);
  }

  public spawnDetachedHeadgearProp(archetype: EnemyArchetypeId, worldPos: Vec3Like, shotDir: Vec3Like): void {
    spawnDetachedHeadgearProp(this.fxRoot, this.gibChunks, this.glbRegistry, archetype, worldPos, shotDir);
  }

  public spawnDroppedWeaponProp(archetype: EnemyArchetypeId, worldPos: Vec3Like, inheritedVel: Vec3Like): void {
    spawnDroppedWeaponProp(this.fxRoot, this.gibChunks, this.glbRegistry, archetype, worldPos, inheritedVel);
  }

  public spawnArmorImpactSparks(worldPos: Vec3Like, normalDir: Vec3Like): void {
    spawnArmorImpactSparks(this.fxRoot, this.materials, this.goreSuite, this.boneShards, worldPos, normalDir);
  }

  public spawnBloodBurst(worldPos: Vec3Like, normalDir: Vec3Like, energyJ: number, count = 16): void {
    spawnBloodBurst(this.fxRoot, this.goreSuite, this.bloodDrops, this.mistPuffs, worldPos, normalDir, energyJ, count);
  }

  /** A small floor stain, such as one left by a body dragged along the ground. */
  public spawnBloodSmear(worldPos: Vec3Like, radius: number): void {
    spawnBloodPool(
      this.fxRoot, this.goreSuite, this.bloodPools, this.poolCounter,
      new pc.Vec3(worldPos.x, worldPos.y, worldPos.z), radius,
    );
  }

  public spawnDismembermentGibs(event: DismembermentEvent): void {
    spawnDismembermentGibs(this.fxRoot, this.goreSuite, this.gibChunks, event, {
      spawnBloodBurst: (pos, dir, e, cnt) => this.spawnBloodBurst(pos, dir, e, cnt),
      spawnBloodPool: (pos, rad) => spawnBloodPool(this.fxRoot, this.goreSuite, this.bloodPools, this.poolCounter, pos, rad),
    });
  }

  public attachArterialFountain(target: TargetHealthState, event: DismembermentEvent): void {
    attachArterialFountain(this.arterialFountains, target, event);
  }

  public spawnBoneShatterSparks(worldPos: Vec3Like, dir: Vec3Like): void {
    spawnBoneShatterSparks(this.fxRoot, this.goreSuite, this.boneShards, worldPos, dir);
  }

  public update(dt: number, showTrails = true): void {
    const gravity = -9.81;
    updateProjectiles(this.app, this.activeProjectiles, dt, showTrails);
    updateArterialFountains(this.arterialFountains, dt, (pos, dir, e, cnt) => this.spawnBloodBurst(pos, dir, e, cnt));
    updateBloodDrops(this.bloodDrops, dt, gravity, (pos, rad) => spawnBloodPool(this.fxRoot, this.goreSuite, this.bloodPools, this.poolCounter, pos, rad));

    const camPos =
      this.cachedCameraPos ??
      (this.cachedCameraEntity && this.cachedCameraEntity.parent
        ? this.cachedCameraEntity.getPosition()
        : null);
    updateMistPuffs(this.mistPuffs, dt, camPos);

    updateGibChunks(this.gibChunks, dt, gravity, (pos, rad) => spawnBloodPool(this.fxRoot, this.goreSuite, this.bloodPools, this.poolCounter, pos, rad));
    updateBoneShards(this.boneShards, dt, gravity);
    updateBloodPools(this.bloodPools, dt);
  }

  public clearAll(): void {
    for (const p of this.activeProjectiles) p.entity.destroy();
    for (const d of this.bloodDrops) d.entity.destroy();
    for (const m of this.mistPuffs) m.entity.destroy();
    for (const g of this.gibChunks) g.entity.destroy();
    for (const s of this.boneShards) s.entity.destroy();
    for (const b of this.bloodPools) b.entity.destroy();

    this.activeProjectiles = [];
    this.bloodDrops = [];
    this.mistPuffs = [];
    this.gibChunks = [];
    this.boneShards = [];
    this.bloodPools = [];
    this.arterialFountains = [];
  }
}
