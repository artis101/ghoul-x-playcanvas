import * as pc from 'playcanvas';
import type { AmmoSpec, ShotSimulationReport, Vec3Like, WeaponSpec } from '../../contracts/ballistics.ts';
import type { BlastEvent, DestructibleMaterialKind } from '../../contracts/destruction.ts';
import { add, cross, normalize, scale, vec3 } from '../../core/ballistics/vec3.ts';
import type { HardwareInstancedPool } from '../physics/instancedPool.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import { BulletTimeController } from './bulletTime/bulletTimeController.ts';
import type { BulletTimeOptions } from './bulletTime/bulletTimeTypes.ts';
import { ExplosiveBarrelManager } from './barrels/explosiveBarrelManager.ts';
import type { HazardBarrelInstance } from './barrels/barrelTypes.ts';
import { buildUnitQuadZMesh } from './particles/fxMeshBuilders.ts';
import { createMayhemInstancedPools, destroyMayhemPools, MayhemPools } from './particles/mayhemInstancedPools.ts';
import { createExplosionTemplateMaterials, destroyExplosionTemplateMaterials } from './explosions/explosionMaterials.ts';
import type { ExplosionTemplateMaterials, TransientBillowPlume, TransientFireballLobe } from './explosions/explosionTypes.ts';
import { spawnMultiStageExplosion } from './explosions/explosionFxSystem.ts';
import { stepBillowPlumes, stepFireballLobes } from './explosions/transientPlumeSystem.ts';
import {
  activateDynamicOmniLight,
  createDynamicLightPool,
  PooledDynamicOmniLight,
  resetDynamicLights,
  stepDynamicLights,
} from './lighting/dynamicLightPool.ts';
import { CasingBounceEvent, TrackedCasingBuffer } from './casings/casingTypes.ts';
import {
  ejectEnemyShellCasing as ejectEnemyCasing,
  ejectWeaponCasing,
  stepTrackedCasingBounces,
} from './casings/casingEjectionSystem.ts';
import { LingeringGunsmokePool } from './smoke/lingeringGunsmokePool.ts';
import { spawnBulletTracer as spawnTracerStreak } from './tracers/tracerSparkSystem.ts';
import {
  BloodSplatterProjectionParams,
  type BloodSplatterSlotAnchor,
  processShotSimulationReport as processReportDecals,
  projectBloodSplatter as projectSplatterDecals,
  pruneUnsupportedBloodSplatters,
} from './decals/bloodSplatterSystem.ts';
import {
  spawnSurfaceImpact,
  type SurfaceOpenPredicate,
  traceWeaponEnvironmentFire,
} from './impacts/surfaceImpactFx.ts';

export interface MayhemDirectorOptions {
  app: pc.Application;
  rapierWorld: RapierPhysicsWorld;
  barrelPositions?: readonly Vec3Like[];
  sympatheticChainFuseS?: number;
  maxBrassCasings?: number;
  maxShotgunHulls?: number;
  maxBloodSplatters?: number;
  maxShrapnelShards?: number;
  dynamicLightPoolSize?: number;
  bulletTimeOptions?: BulletTimeOptions;
  onCasingBounce?: (event: CasingBounceEvent) => void;
  onExplosionBlast?: (blast: BlastEvent) => void;
  onBarrelIgnited?: (barrel: HazardBarrelInstance) => void;
  isSurfaceOpenAtHit?: SurfaceOpenPredicate;
  getBreachVersion?: () => number;
}

export class MayhemDirector {
  public readonly app: pc.Application;
  public readonly rapierWorld: RapierPhysicsWorld;
  public readonly rootEntity: pc.Entity;

  public readonly bulletTime: BulletTimeController;
  public readonly barrels: ExplosiveBarrelManager;

  public readonly brassCasingPool: HardwareInstancedPool;
  public readonly shotgunHullPool: HardwareInstancedPool;
  public readonly shrapnelPool: HardwareInstancedPool;
  public readonly bloodSplatterPool: HardwareInstancedPool;
  public readonly tracerCorePool: HardwareInstancedPool;
  public readonly tracerHaloPool: HardwareInstancedPool;
  public readonly impactSparkPool: HardwareInstancedPool;
  public readonly lingeringSmokePool: LingeringGunsmokePool;

  public onCasingBounce?: (event: CasingBounceEvent) => void;
  public onExplosionBlast?: (blast: BlastEvent) => void;
  public isSurfaceOpenAtHit?: SurfaceOpenPredicate;
  public getBreachVersion?: () => number;

  private readonly lightPool: PooledDynamicOmniLight[] = [];
  private readonly fireballLobes: TransientFireballLobe[] = [];
  private readonly billowPlumes: TransientBillowPlume[] = [];
  private readonly templates: ExplosionTemplateMaterials;
  private readonly unitQuadMesh: pc.Mesh;
  private readonly trackedBuffer = new TrackedCasingBuffer();
  private readonly pools: MayhemPools;
  private readonly bloodSplatterAnchors: BloodSplatterSlotAnchor[];

  private cachedCameraEntity: pc.Entity | null = null;
  private cachedCameraPos: pc.Vec3 | null = null;
  private readonly _eventCleanups: Array<() => void> = [];
  private readonly splatterRecycleCursor = { value: 0 };
  private readonly splatterSeedCounter = { value: 1 };
  private casingSeedCounter = 1;
  private readonly fxSeedCounter = { value: 1 };
  private lastSyncedBreachVersion = -1;
  private destroyed = false;

  public constructor(options: MayhemDirectorOptions) {
    this.app = options.app;
    this.rapierWorld = options.rapierWorld;
    this.onCasingBounce = options.onCasingBounce;
    this.onExplosionBlast = options.onExplosionBlast;
    this.isSurfaceOpenAtHit = options.isSurfaceOpenAtHit;
    this.getBreachVersion = options.getBreachVersion;

    this.rootEntity = new pc.Entity('MayhemDirectorRoot');
    this.app.root.addChild(this.rootEntity);

    const dev = this.app.graphicsDevice;
    this.unitQuadMesh = buildUnitQuadZMesh(dev);
    this.unitQuadMesh.incRefCount();

    this.pools = createMayhemInstancedPools(this.app, this.unitQuadMesh, options);
    this.brassCasingPool = this.pools.brassCasingPool;
    this.shotgunHullPool = this.pools.shotgunHullPool;
    this.shrapnelPool = this.pools.shrapnelPool;
    this.bloodSplatterPool = this.pools.bloodSplatterPool;
    this.tracerCorePool = this.pools.tracerCorePool;
    this.tracerHaloPool = this.pools.tracerHaloPool;
    this.impactSparkPool = this.pools.impactSparkPool;
    this.lingeringSmokePool = new LingeringGunsmokePool(this.app, this.unitQuadMesh);
    this.bloodSplatterAnchors = Array.from({ length: this.bloodSplatterPool.maxInstances }, () => ({
      active: false,
      isFloor: false,
      pointWorld: { x: 0, y: 0, z: 0 },
      normalWorld: { x: 0, y: 1, z: 0 },
    }));

    this.templates = createExplosionTemplateMaterials(dev);
    this.lightPool = createDynamicLightPool(this.app, this.rootEntity, options.dynamicLightPoolSize ?? 2);

    this.bulletTime = new BulletTimeController(options.bulletTimeOptions);
    this.barrels = new ExplosiveBarrelManager({
      app: this.app,
      rapierWorld: this.rapierWorld,
      shrapnelPool: this.shrapnelPool,
      barrelPositions: options.barrelPositions,
      sympatheticChainFuseS: options.sympatheticChainFuseS,
      onBarrelIgnited: options.onBarrelIgnited,
      onBarrelDetonated: (_b, blast) => {
        this.triggerExplosionLight(blast.centerWorld, Math.max(11.0, blast.radiusM * 4.5));
        this.spawnMultiStageExplosionFx(blast);
        this.lingeringSmokePool.applyBlastSwirl(blast.centerWorld, blast.radiusM, blast.peakImpulseNs);
        this.onExplosionBlast?.(blast);
        this.syncSurfaceBreaches();
      },
    });

    this.cachedCameraEntity =
      (this.app.root?.findByName?.('PlayerCamera') as pc.Entity | null) ?? null;
    if (typeof this.app.on === 'function' && typeof this.app.off === 'function') {
      const onCameraTransform = (data: unknown): void => {
        const p = data as { position?: pc.Vec3; entity?: pc.Entity } | undefined;
        if (p?.entity) {
          this.cachedCameraEntity = p.entity;
        }
        if (p?.position) {
          this.cachedCameraPos = p.position;
        }
      };
      this.app.on('camera:transform', onCameraTransform, this);
      this._eventCleanups.push(() => this.app.off('camera:transform', onCameraTransform, this));
    }
  }

  public setCameraEntity(cameraEntity: pc.Entity | null): void {
    this.cachedCameraEntity = cameraEntity;
  }

  public setCachedCameraPos(pos: pc.Vec3 | null): void {
    this.cachedCameraPos = pos;
  }

  public get activeDynamicLightCount(): number {
    let n = 0;
    for (const l of this.lightPool) if (l.active) n++;
    return n;
  }

  public spawnBulletTracer(originWorld: Vec3Like, directionWorld: Vec3Like, maxDistanceM = 48.0, streakLengthM = 1.65): void {
    if (this.destroyed) return;
    spawnTracerStreak({ tracerCorePool: this.tracerCorePool, tracerHaloPool: this.tracerHaloPool }, originWorld, directionWorld, maxDistanceM, streakLengthM);
  }

  public spawnSurfaceImpactFx(hitPointWorld: Vec3Like, surfaceNormalWorld: Vec3Like, surfaceMaterial: DestructibleMaterialKind = 'CONCRETE_INTACT', kineticEnergyJ = 650): void {
    if (this.destroyed) return;
    spawnSurfaceImpact(
      { rapierWorld: this.rapierWorld, impactSparkPool: this.impactSparkPool, unitQuadMesh: this.unitQuadMesh, rootEntity: this.rootEntity, templates: this.templates, billowPlumes: this.billowPlumes },
      hitPointWorld, surfaceNormalWorld, surfaceMaterial, kineticEnergyJ, this.fxSeedCounter,
    );
  }

  public spawnMultiStageExplosionFx(blast: BlastEvent): void {
    if (this.destroyed) return;
    this.fxSeedCounter.value = spawnMultiStageExplosion(
      { rootEntity: this.rootEntity, unitQuadMesh: this.unitQuadMesh, templates: this.templates, fireballLobes: this.fireballLobes, billowPlumes: this.billowPlumes, impactSparkPool: this.impactSparkPool },
      blast, this.fxSeedCounter.value,
    );
  }

  public ejectWeaponCasing(eyeWorldPos: Vec3Like, aimDirectionWorld: Vec3Like, weapon: Pick<WeaponSpec, 'role'>, ammo?: Pick<AmmoSpec, 'type'>): number {
    if (this.destroyed) return -1;
    const res = ejectWeaponCasing(
      { brassCasingPool: this.brassCasingPool, shotgunHullPool: this.shotgunHullPool, trackedBuffer: this.trackedBuffer, onCasingBounce: this.onCasingBounce },
      eyeWorldPos, aimDirectionWorld, weapon, ammo, this.casingSeedCounter,
    );
    this.casingSeedCounter = res.nextSeed;
    return res.slotId;
  }

  public ejectEnemyShellCasing(originWorld: Vec3Like, rightDirWorld: Vec3Like, isSidearm = false): number {
    if (this.destroyed) return -1;
    const res = ejectEnemyCasing(
      { brassCasingPool: this.brassCasingPool, shotgunHullPool: this.shotgunHullPool, trackedBuffer: this.trackedBuffer, onCasingBounce: this.onCasingBounce },
      originWorld, rightDirWorld, isSidearm, this.casingSeedCounter,
    );
    this.casingSeedCounter = res.nextSeed;
    return res.slotId;
  }

  public injectGunsmoke(originWorld: Vec3Like, directionWorld: Vec3Like, intensity = 1.0): number {
    if (this.destroyed) return -1;
    return this.lingeringSmokePool.injectGunsmoke(originWorld, directionWorld, intensity);
  }

  public triggerMuzzleFlashLight(muzzleWorldPos: Vec3Like): void {
    activateDynamicOmniLight(this.lightPool, muzzleWorldPos, 1.0, 0.72, 0.28, 4.2, 10.5, 0.052, false);
  }

  public triggerExplosionLight(blastCenterWorld: Vec3Like, rangeM = 18.0): void {
    activateDynamicOmniLight(this.lightPool, { x: blastCenterWorld.x, y: Math.max(0.35, blastCenterWorld.y + 0.35), z: blastCenterWorld.z }, 1.0, 0.92, 0.68, 11.5, rangeM, 0.34, true);
  }

  public onPlayerWeaponFired(eyeWorldPos: Vec3Like, aimDirectionWorld: Vec3Like, weapon: WeaponSpec, ammo: AmmoSpec, muzzleWorldPosOverride?: Vec3Like): void {
    const fwd = normalize(aimDirectionWorld);
    const muzzlePos = muzzleWorldPosOverride ?? add(eyeWorldPos, scale(fwd, 0.65));

    this.triggerMuzzleFlashLight(muzzlePos);
    this.ejectWeaponCasing(eyeWorldPos, fwd, weapon, ammo);
    const smokeIntensity = weapon.role === 'SHOTGUN' || weapon.role === 'SNIPER' ? 1.35 : 0.85;
    this.injectGunsmoke(muzzlePos, fwd, smokeIntensity);

    const perProjectileEnergyJ = 0.5 * ammo.massKg * ammo.muzzleVelocityMs * ammo.muzzleVelocityMs;
    const { firstSurfaceHit, tracerStopDistanceM } = traceWeaponEnvironmentFire(
      this.rapierWorld,
      eyeWorldPos,
      fwd,
      72.0,
      perProjectileEnergyJ,
      this.isSurfaceOpenAtHit,
    );
    const maxTracerDist =
      tracerStopDistanceM !== null ? Math.max(1.2, tracerStopDistanceM - 0.35) : 56.0;

    if (ammo.pelletCount > 1) {
      const visualPellets = Math.min(5, ammo.pelletCount);
      const upRef = Math.abs(fwd.y) < 0.96 ? vec3(0, 1, 0) : vec3(1, 0, 0);
      const right = normalize(cross(fwd, upRef));
      const orthoUp = normalize(cross(right, fwd));
      for (let p = 0; p < visualPellets; p++) {
        const ang = (p / visualPellets) * Math.PI * 2 + 0.4;
        const spread = 0.022 + (p % 2) * 0.014;
        const pelletDir = normalize({ x: fwd.x + (right.x * Math.cos(ang) + orthoUp.x * Math.sin(ang)) * spread, y: fwd.y + (right.y * Math.cos(ang) + orthoUp.y * Math.sin(ang)) * spread, z: fwd.z + (right.z * Math.cos(ang) + orthoUp.z * Math.sin(ang)) * spread });
        this.spawnBulletTracer(muzzlePos, pelletDir, maxTracerDist, 1.15);
      }
    } else {
      const streakLen = weapon.role === 'SNIPER' ? 2.35 : weapon.role === 'HEAVY_PISTOL' ? 1.55 : 1.85;
      this.spawnBulletTracer(muzzlePos, fwd, maxTracerDist, streakLen);
    }

    if (firstSurfaceHit) {
      this.spawnSurfaceImpactFx(
        firstSurfaceHit.pointWorld,
        firstSurfaceHit.normalWorld,
        firstSurfaceHit.material,
        perProjectileEnergyJ,
      );
    }
  }

  public projectBloodSplatter(params: BloodSplatterProjectionParams): number {
    if (this.destroyed) return 0;
    return projectSplatterDecals(
      {
        rapierWorld: this.rapierWorld,
        bloodSplatterPool: this.bloodSplatterPool,
        bulletTime: this.bulletTime,
        isSurfaceOpenAtHit: this.isSurfaceOpenAtHit,
        slotAnchors: this.bloodSplatterAnchors,
      },
      params, this.splatterRecycleCursor, this.splatterSeedCounter,
    );
  }

  public processShotSimulationReport(report: ShotSimulationReport): number {
    if (this.destroyed || !report.hitTarget) return 0;
    return processReportDecals(
      {
        rapierWorld: this.rapierWorld,
        bloodSplatterPool: this.bloodSplatterPool,
        bulletTime: this.bulletTime,
        isSurfaceOpenAtHit: this.isSurfaceOpenAtHit,
        slotAnchors: this.bloodSplatterAnchors,
      },
      report, this.splatterRecycleCursor, this.splatterSeedCounter,
    );
  }

  public pruneUnsupportedDecals(): number {
    if (this.destroyed) return 0;
    return pruneUnsupportedBloodSplatters({
      rapierWorld: this.rapierWorld,
      bloodSplatterPool: this.bloodSplatterPool,
      bulletTime: this.bulletTime,
      isSurfaceOpenAtHit: this.isSurfaceOpenAtHit,
      slotAnchors: this.bloodSplatterAnchors,
    });
  }

  public syncSurfaceBreaches(): void {
    if (this.destroyed || !this.getBreachVersion) return;
    const v = this.getBreachVersion();
    if (v === this.lastSyncedBreachVersion) return;
    this.lastSyncedBreachVersion = v;
    this.pruneUnsupportedDecals();
    this.rapierWorld.wakeAllSleepingDynamicBodies();
  }

  public notifyExternalExplosion(blast: BlastEvent, killedEnemyCount = 0): void {
    if (this.destroyed) return;
    this.triggerExplosionLight(blast.centerWorld, Math.max(18.0, blast.radiusM * 2.5));
    this.spawnMultiStageExplosionFx(blast);
    this.lingeringSmokePool.applyBlastSwirl(blast.centerWorld, blast.radiusM, blast.peakImpulseNs);
    this.barrels.applyBlast(blast);
    this.syncSurfaceBreaches();
    if (killedEnemyCount >= 2) this.bulletTime.triggerKillPunch(0.35, 0.16, 'MULTI_KILL_BLAST');
  }

  public update(rawDt: number): number {
    if (this.destroyed || !Number.isFinite(rawDt) || rawDt <= 0) return 0;
    const scaledDt = this.bulletTime.update(rawDt);

    this.barrels.update(scaledDt);
    this.syncSurfaceBreaches();
    stepDynamicLights(this.lightPool, scaledDt);

    stepFireballLobes(this.fireballLobes, scaledDt);
    const camPos =
      this.cachedCameraPos ??
      (this.cachedCameraEntity && this.cachedCameraEntity.parent
        ? this.cachedCameraEntity.getPosition()
        : null);
    stepBillowPlumes(this.billowPlumes, scaledDt, camPos);
    this.lingeringSmokePool.update(scaledDt, camPos);

    stepTrackedCasingBounces(this.trackedBuffer, scaledDt, this.onCasingBounce);

    this.brassCasingPool.syncFromPhysics(this.rapierWorld, scaledDt);
    this.shotgunHullPool.syncFromPhysics(this.rapierWorld, scaledDt);
    this.shrapnelPool.syncFromPhysics(this.rapierWorld, scaledDt);
    this.tracerCorePool.syncFromPhysics(null, scaledDt);
    this.tracerHaloPool.syncFromPhysics(null, scaledDt);
    this.impactSparkPool.syncFromPhysics(null, scaledDt);
    this.bloodSplatterPool.upload();

    return scaledDt;
  }

  public resetWave(clearBloodDecals = false): void {
    if (this.destroyed) return;
    this.bulletTime.reset();
    this.barrels.resetBarrels();
    this.trackedBuffer.reset();
    this.lingeringSmokePool.clear();
    resetDynamicLights(this.lightPool);
    this.clearTransientExplosionAndImpactFx();
    this.lastSyncedBreachVersion = -1;
    if (clearBloodDecals) this.clearBloodDecals();
  }

  public clearBloodDecals(): void {
    for (let slot = 0; slot < this.bloodSplatterPool.maxInstances; slot++) {
      if (this.bloodSplatterPool.isSlotActive(slot)) this.bloodSplatterPool.freeSlot(slot);
      this.bloodSplatterAnchors[slot].active = false;
    }
    this.splatterRecycleCursor.value = 0;
    this.bloodSplatterPool.upload();
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    while (this._eventCleanups.length > 0) {
      const cleanup = this._eventCleanups.pop();
      cleanup?.();
    }
    this.clearTransientExplosionAndImpactFx();
    destroyExplosionTemplateMaterials(this.templates);
    this.bulletTime.destroy();
    this.barrels.destroy();
    this.lingeringSmokePool.destroy();
    destroyMayhemPools(this.pools);
    this.rootEntity.destroy();
    this.unitQuadMesh.destroy();
  }

  private clearTransientExplosionAndImpactFx(): void {
    for (const lobe of this.fireballLobes) lobe.entity.destroy();
    this.fireballLobes.length = 0;
    for (const plume of this.billowPlumes) plume.entity.destroy();
    this.billowPlumes.length = 0;
  }
}
