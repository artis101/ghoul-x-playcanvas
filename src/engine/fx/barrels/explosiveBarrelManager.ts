import * as pc from 'playcanvas';
import type { BallisticPenetrationResult, BallisticSegmentImpact, BlastEvent, IDestructibleSubsystem } from '../../../contracts/destruction.ts';
import { add, distance, length, normalize, scale, vec3 } from '../../../core/ballistics/vec3.ts';
import type { HardwareInstancedPool } from '../../physics/instancedPool.ts';
import type { RapierPhysicsWorld } from '../../physics/rapierWorld.ts';
import {
  BARREL_FUSE_DURATION_S,
  DEFAULT_HAZARD_BARREL_POSITIONS,
  ExplosiveBarrelHitInput,
  ExplosiveBarrelManagerOptions,
  HazardBarrelInstance,
} from './barrelTypes.ts';
import { createBarrelStaticCollider, createHazardBarrelEntity } from './barrelSpawner.ts';
import { BarrelResources, createBarrelResources, destroyBarrelResources } from './barrelResources.ts';
import { executeBarrelDetonation } from './barrelDetonation.ts';

export class ExplosiveBarrelManager implements IDestructibleSubsystem {
  public readonly id = 'explosive_hazard_barrels';
  public readonly barrels: HazardBarrelInstance[] = [];

  private readonly app: pc.Application | null;
  private readonly rapierWorld: RapierPhysicsWorld;
  private readonly shrapnelPool: HardwareInstancedPool | null;
  private readonly sympatheticChainFuseS: number;

  public onBarrelIgnited?: (barrel: HazardBarrelInstance) => void;
  public onBarrelDetonated?: (barrel: HazardBarrelInstance, blast: BlastEvent) => void;

  private readonly rootContainer: pc.Entity | null = null;
  private readonly resources: BarrelResources | null = null;
  private emberSpawnAccumS = 0;
  private flickerClockS = 0;
  private destroyed = false;

  public constructor(options: ExplosiveBarrelManagerOptions) {
    this.app = options.app ?? null;
    this.rapierWorld = options.rapierWorld;
    this.shrapnelPool = options.shrapnelPool ?? null;
    this.sympatheticChainFuseS = Math.max(0, options.sympatheticChainFuseS ?? 0.08);
    this.onBarrelIgnited = options.onBarrelIgnited;
    this.onBarrelDetonated = options.onBarrelDetonated;

    if (this.app) {
      this.rootContainer = new pc.Entity('HazardBarrelsRoot');
      this.app.root.addChild(this.rootContainer);
      this.resources = createBarrelResources(this.app.graphicsDevice);
    }

    const ctx = { app: this.app, rootContainer: this.rootContainer, rapierWorld: this.rapierWorld, resources: this.resources };
    const positions = options.barrelPositions ?? DEFAULT_HAZARD_BARREL_POSITIONS;
    for (let i = 0; i < positions.length; i++) {
      this.barrels.push(createHazardBarrelEntity(ctx, i, positions[i]));
    }
    this.flushRapierBroadPhaseQueries();
  }

  public getBarrelByObjectId(objectId: string): HazardBarrelInstance | undefined {
    return this.barrels.find((b) => b.objectId === objectId);
  }

  public registerBarrelHit(barrelOrId: HazardBarrelInstance | string | number, hit: ExplosiveBarrelHitInput = {}): boolean {
    if (this.destroyed) return false;
    const barrel = typeof barrelOrId === 'number' ? this.barrels[barrelOrId] : typeof barrelOrId === 'string' ? this.getBarrelByObjectId(barrelOrId) : barrelOrId;
    if (!barrel || barrel.state !== 'INTACT') return false;

    const isBuckshot = hit.ammoType === 'BUCKSHOT_00' || (hit.pelletCount !== undefined && hit.pelletCount > 1) || (hit.ammoType === undefined && !hit.isArmorPiercing && hit.kineticEnergyJ !== undefined && hit.kineticEnergyJ < 650);
    barrel.hitCount += 1;
    barrel.ignitionDamage += isBuckshot ? 0.5 : 1.0;

    if (hit.hitPointWorld) {
      barrel.leakOffsetLocal = {
        x: Math.max(-0.28, Math.min(0.28, hit.hitPointWorld.x - barrel.basePosition.x)),
        y: Math.max(0.18, Math.min(0.82, hit.hitPointWorld.y - barrel.basePosition.y)),
        z: Math.max(-0.28, Math.min(0.28, hit.hitPointWorld.z - barrel.basePosition.z)),
      };
    }
    if (hit.hitNormalWorld && length(hit.hitNormalWorld) > 1e-4) {
      barrel.leakNormalWorld = normalize(hit.hitNormalWorld);
    }
    if (barrel.ignitionDamage >= 1.0 - 1e-6) {
      this.igniteBarrel(barrel, BARREL_FUSE_DURATION_S);
      return true;
    }
    return false;
  }

  public handleRaySegment(seg: BallisticSegmentImpact): BallisticPenetrationResult | null {
    if (this.destroyed || seg.maxDistanceM <= 0 || seg.kineticEnergyJ <= 0) return null;
    const hits = this.rapierWorld.castPenetrationRay(seg.originWorld, seg.directionWorld, seg.maxDistanceM);
    for (const hit of hits) {
      if (!hit.surface.objectId.startsWith('hazard_barrel_')) continue;
      const barrel = this.getBarrelByObjectId(hit.surface.objectId);
      if (!barrel || barrel.state === 'DETONATED') continue;
      this.registerBarrelHit(barrel, { kineticEnergyJ: seg.kineticEnergyJ, isArmorPiercing: seg.isArmorPiercing, hitPointWorld: hit.pointWorld, hitNormalWorld: hit.normalWorld });
      const absorbedJ = Math.min(seg.kineticEnergyJ, hit.surface.penetrationResistanceJ);
      const remEnergy = Math.max(0, seg.kineticEnergyJ - absorbedJ);
      const speedRatio = seg.kineticEnergyJ > 1e-6 ? Math.sqrt(remEnergy / seg.kineticEnergyJ) : 0;
      return { remainingEnergyJ: remEnergy, remainingSpeedMs: seg.speedMs * speedRatio, stopped: remEnergy < 45, impactPointWorld: hit.pointWorld, impactNormalWorld: hit.normalWorld, hitMaterial: 'STEEL' };
    }
    return null;
  }

  public applyBlast(blast: BlastEvent): void {
    if (this.destroyed || blast.radiusM <= 0 || blast.peakEnergyJ <= 0) return;
    for (const barrel of this.barrels) {
      if (barrel.state !== 'INTACT') continue;
      const drumCenter = { x: barrel.basePosition.x, y: barrel.basePosition.y + 0.45, z: barrel.basePosition.z };
      const distM = distance(blast.centerWorld, drumCenter);
      if (distM > blast.radiusM) continue;
      const falloff = Math.max(0, 1 - distM / blast.radiusM);
      if (blast.peakEnergyJ * falloff < 450) continue;
      barrel.ignitionDamage = Math.max(1.0, barrel.ignitionDamage + 1.0);
      if (this.sympatheticChainFuseS <= 0) this.detonateBarrel(barrel);
      else this.igniteBarrel(barrel, this.sympatheticChainFuseS);
    }
  }

  public update(dt: number): void {
    if (this.destroyed || !Number.isFinite(dt) || dt <= 0) return;
    this.flickerClockS += dt;
    this.emberSpawnAccumS += dt;
    const emitEmbers = this.emberSpawnAccumS >= 0.03;
    if (emitEmbers) this.emberSpawnAccumS = 0;

    for (const barrel of this.barrels) {
      if (barrel.state !== 'IGNITED_HISSING') continue;
      if (barrel.flameJetEntity) {
        const pulse = 1.0 + Math.sin(this.flickerClockS * 95 + barrel.index) * 0.28;
        barrel.flameJetEntity.setLocalScale(0.12 * pulse, 0.46 * pulse, 0.12 * pulse);
      }
      if (emitEmbers && this.shrapnelPool) {
        const jetWorld = add(barrel.basePosition, barrel.leakOffsetLocal);
        const jetVel = add(scale(barrel.leakNormalWorld, 3.8), vec3((Math.random() - 0.5) * 1.6, 2.8 + Math.random() * 1.8, (Math.random() - 0.5) * 1.6));
        this.shrapnelPool.spawnKinematicParticle(jetWorld, jetVel, vec3(14, 18, -12), vec3(0.022, 0.022, 0.022), -6.5, 0.35, 0.26);
      }
      barrel.fuseRemainingS -= dt;
      if (barrel.fuseRemainingS <= 0) this.detonateBarrel(barrel);
    }
  }

  public resetBarrels(): void {
    if (this.destroyed) return;
    for (const barrel of this.barrels) {
      if (barrel.colliderHandle >= 0) this.rapierWorld.removeCollider(barrel.colliderHandle);
      barrel.colliderHandle = createBarrelStaticCollider(this.rapierWorld, barrel.index, barrel.basePosition);
      barrel.state = 'INTACT';
      barrel.ignitionDamage = 0;
      barrel.hitCount = 0;
      barrel.fuseRemainingS = 0;
      barrel.leakOffsetLocal = { x: 0, y: 0.62, z: 0.28 };
      barrel.leakNormalWorld = { x: 0, y: 0.35, z: 0.94 };
      if (barrel.intactDrumEntity) barrel.intactDrumEntity.enabled = true;
      if (barrel.flameJetEntity) barrel.flameJetEntity.enabled = false;
      if (barrel.crumpledBaseEntity) barrel.crumpledBaseEntity.enabled = false;
      if (barrel.scorchDecalEntity) barrel.scorchDecalEntity.enabled = false;
    }
    this.flushRapierBroadPhaseQueries();
  }

  private flushRapierBroadPhaseQueries(): void {
    const prevDt = this.rapierWorld.world.timestep;
    this.rapierWorld.world.timestep = 0;
    this.rapierWorld.world.step();
    this.rapierWorld.world.timestep = prevDt;
  }

  public reset(): void { this.resetBarrels(); }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const barrel of this.barrels) {
      if (barrel.colliderHandle >= 0) {
        this.rapierWorld.removeCollider(barrel.colliderHandle);
        barrel.colliderHandle = -1;
      }
    }
    this.barrels.length = 0;
    if (this.rootContainer) this.rootContainer.destroy();
    destroyBarrelResources(this.resources);
  }

  private igniteBarrel(barrel: HazardBarrelInstance, fuseDurationS: number): void {
    if (barrel.state !== 'INTACT') return;
    barrel.state = 'IGNITED_HISSING';
    barrel.fuseRemainingS = Math.max(0.01, fuseDurationS);
    if (barrel.flameJetEntity) {
      barrel.flameJetEntity.setLocalPosition(barrel.leakOffsetLocal.x, barrel.leakOffsetLocal.y, barrel.leakOffsetLocal.z);
      barrel.flameJetEntity.enabled = true;
    }
    this.onBarrelIgnited?.(barrel);
  }

  private detonateBarrel(barrel: HazardBarrelInstance): void {
    if (barrel.state === 'DETONATED') return;
    const blast = executeBarrelDetonation(barrel, this.rapierWorld, this.shrapnelPool);
    this.onBarrelDetonated?.(barrel, blast);
    this.applyBlast(blast);
  }
}
