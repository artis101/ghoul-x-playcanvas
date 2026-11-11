import * as pc from 'playcanvas';
import {
  Vec3Like,
  DismembermentEvent,
  TargetHealthState,
  TrajectorySample,
  GhoulZoneId,
  EnemyArchetypeId,
} from '../contracts/ballistics.ts';
import { copyVec3, length, normalize, sub, scale } from '../core/ballistics/vec3.ts';
import { EngineMaterialPalette } from './materials.ts';
import { getArchetypeRetroMaterials } from './retroTextures.ts';
import {
  buildArchetypeHeadgearEntity,
  buildEnemyWeaponEntity,
} from './retroMeshBuilder.ts';
import {
  getArchetypeWeaponAssetId,
  GlbModelRegistry,
} from './assets/glbLoader.ts';

export interface ActiveProjectileFx {
  entity: pc.Entity;
  shockwaveRing?: pc.Entity;
  trajectorySamples: TrajectorySample[];
  currentSampleIndex: number;
  progressTimeS: number;
  totalFlightTimeS: number;
  finished: boolean;
  trailPoints: pc.Vec3[];
}

export interface InFlightBloodDrop {
  entity: pc.Entity;
  position: pc.Vec3;
  velocity: pc.Vec3;
  life: number;
  maxLife: number;
}

export interface BloodPoolDecal {
  entity: pc.Entity;
  currentScale: number;
  targetScale: number;
  growthRate: number;
}

export interface GibChunk {
  entity: pc.Entity;
  position: pc.Vec3;
  velocity: pc.Vec3;
  angularVelocity: pc.Vec3;
  bounces: number;
  life: number;
  maxLife: number;
  leavesBlood: boolean;
  restHeight: number;
}

export interface BoneShardSpark {
  entity: pc.Entity;
  position: pc.Vec3;
  velocity: pc.Vec3;
  life: number;
}

export interface ArterialFountainStream {
  target?: TargetHealthState;
  zone?: GhoulZoneId;
  parentZone?: GhoulZoneId;
  stumpPos: Vec3Like;
  sprayDir: Vec3Like;
  durationS: number;
  elapsedS: number;
  dropTimerS: number;
}

/**
 * Class GoreAndBallisticsFxManager manages:
 * - In-flight 3D spinning bullet models and Mach shockwave rings
 * - Ballistic trajectory trails & impact sparks
 * - High-velocity blood splatter & expanding ground blood pools
 * - Flying Soldier of Fortune dismemberment meat/bone gib chunks
 * - Detached PS1/PS2 physics props (shot-off helmets/berets/shades & dropped AK-47/MP5/SVD weapons!)
 * - Pulsing arterial stump blood fountains
 */
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
  private glbRegistry: GlbModelRegistry | null = null;

  constructor(app: pc.AppBase, materials: EngineMaterialPalette, glbRegistry?: GlbModelRegistry | null) {
    this.app = app;
    this.materials = materials;
    this.glbRegistry = glbRegistry ?? null;
    this.fxRoot = new pc.Entity('GoreAndBallisticsFxRoot');
    this.app.root.addChild(this.fxRoot);
  }

  public attachGlbRegistry(glbRegistry: GlbModelRegistry): void {
    this.glbRegistry = glbRegistry;
  }

  /**
   * Spawns an animated 3D projectile following RK4 trajectory samples.
   */
  public spawnFlyingProjectile(
    trajectorySamples: TrajectorySample[],
    isShotgunPellet = false
  ): ActiveProjectileFx | null {
    if (!trajectorySamples || trajectorySamples.length < 2) return null;

    const pEntity = new pc.Entity(isShotgunPellet ? 'PelletProjectile' : 'RifleProjectile');
    pEntity.addComponent('render', {
      type: isShotgunPellet ? 'sphere' : 'cylinder',
      material: isShotgunPellet ? this.materials.copperPelletMat : this.materials.brassBulletMat,
    });

    if (isShotgunPellet) {
      pEntity.setLocalScale(0.016, 0.016, 0.016);
    } else {
      pEntity.setLocalScale(0.02, 0.06, 0.02);
    }

    const firstPos = trajectorySamples[0].position;
    pEntity.setPosition(firstPos.x, firstPos.y, firstPos.z);
    this.fxRoot.addChild(pEntity);

    let shockwaveRing: pc.Entity | undefined;
    if (!isShotgunPellet && trajectorySamples[0].mach > 1.0) {
      shockwaveRing = new pc.Entity('MachShockwaveRing');
      shockwaveRing.addComponent('render', {
        type: 'cylinder',
        material: this.materials.shockwaveRingMat,
      });
      shockwaveRing.setLocalScale(0.09, 0.005, 0.09);
      pEntity.addChild(shockwaveRing);
    }

    const totalFlightTimeS = Math.max(0.045, trajectorySamples[trajectorySamples.length - 1].timeS);

    const projFx: ActiveProjectileFx = {
      entity: pEntity,
      shockwaveRing,
      trajectorySamples,
      currentSampleIndex: 0,
      progressTimeS: 0,
      totalFlightTimeS,
      finished: false,
      trailPoints: [new pc.Vec3(firstPos.x, firstPos.y, firstPos.z)],
    };

    this.activeProjectiles.push(projFx);
    return projFx;
  }

  /**
   * Spawns a shot-off helmet, beret, watch-cap, or shades spinning through the air!
   */
  public spawnDetachedHeadgearProp(
    archetype: EnemyArchetypeId,
    worldPos: Vec3Like,
    shotDir: Vec3Like
  ): void {
    let prop: pc.Entity | null = null;
    if (this.glbRegistry && this.glbRegistry.isLoaded('ghoul_combatant')) {
      prop = this.glbRegistry.instantiateDetachedHeadgearProp(archetype);
    }
    if (!prop) {
      const mats = getArchetypeRetroMaterials(this.app.graphicsDevice, archetype);
      prop = buildArchetypeHeadgearEntity(this.app.graphicsDevice, archetype, mats);
    }
    prop.setPosition(worldPos.x, worldPos.y, worldPos.z);
    this.fxRoot.addChild(prop);

    const vx = shotDir.x * 4.5 + (Math.random() - 0.5) * 2.2;
    const vy = 3.2 + Math.random() * 2.0;
    const vz = shotDir.z * 4.5 + (Math.random() - 0.5) * 2.2;

    this.gibChunks.push({
      entity: prop,
      position: new pc.Vec3(worldPos.x, worldPos.y, worldPos.z),
      velocity: new pc.Vec3(vx, vy, vz),
      angularVelocity: new pc.Vec3(
        (Math.random() - 0.5) * 18,
        (Math.random() - 0.5) * 18,
        (Math.random() - 0.5) * 18
      ),
      bounces: 0,
      life: 0,
      maxLife: 24.0,
      leavesBlood: false,
      restHeight: 0.03,
    });
  }

  /**
   * Spawns the combatant's dropped 3D weapon clattering onto the concrete floor!
   */
  public spawnDroppedWeaponProp(
    archetype: EnemyArchetypeId,
    worldPos: Vec3Like,
    inheritedVel: Vec3Like
  ): void {
    let gun: pc.Entity | null = null;
    const weaponId = getArchetypeWeaponAssetId(archetype);
    if (this.glbRegistry && this.glbRegistry.isLoaded(weaponId)) {
      const inst = this.glbRegistry.instantiateWeapon(weaponId, {
        castShadows: true,
        receiveShadows: true,
      });
      if (inst.animComponent) {
        inst.animComponent.playing = false;
      }
      gun = inst.rootEntity;
    } else {
      const mats = getArchetypeRetroMaterials(this.app.graphicsDevice, archetype);
      gun = buildEnemyWeaponEntity(this.app.graphicsDevice, archetype, mats);
    }
    gun.setPosition(worldPos.x, worldPos.y, worldPos.z);
    this.fxRoot.addChild(gun);

    const vx = inheritedVel.x * 0.45 + (Math.random() - 0.5) * 2.2;
    const vy = Math.max(1.2, inheritedVel.y * 0.35 + 1.4);
    const vz = inheritedVel.z * 0.45 + (Math.random() - 0.5) * 2.2 + 0.8;

    this.gibChunks.push({
      entity: gun,
      position: new pc.Vec3(worldPos.x, worldPos.y, worldPos.z),
      velocity: new pc.Vec3(vx, vy, vz),
      angularVelocity: new pc.Vec3(
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 12,
        6 + Math.random() * 6
      ),
      bounces: 0,
      life: 0,
      maxLife: 30.0,
      leavesBlood: false,
      restHeight: 0.04,
    });
  }

  /**
   * Spawns grey/amber Kevlar spark/dust burst when ballistic armor stops a round!
   */
  public spawnArmorImpactSparks(worldPos: Vec3Like, normalDir: Vec3Like): void {
    for (let i = 0; i < 10; i++) {
      const spark = new pc.Entity('ArmorSpark');
      spark.addComponent('render', {
        type: 'box',
        material: i % 2 === 0 ? this.materials.rangeDistanceMarkerMat : this.materials.sandbagMat,
      });
      const s = 0.012 + Math.random() * 0.014;
      spark.setLocalScale(s, s, s);
      spark.setPosition(worldPos.x, worldPos.y, worldPos.z);
      this.fxRoot.addChild(spark);

      const spd = 2.4 + Math.random() * 3.8;
      this.boneShards.push({
        entity: spark,
        position: new pc.Vec3(worldPos.x, worldPos.y, worldPos.z),
        velocity: new pc.Vec3(
          normalDir.x * spd + (Math.random() - 0.5) * 3.2,
          normalDir.y * spd + Math.random() * 2.4,
          normalDir.z * spd + (Math.random() - 0.5) * 3.2
        ),
        life: 0,
      });
    }
  }

  /**
   * Spawns high-velocity 3D blood droplets and mist affected by gravity that splat into floor pools.
   */
  public spawnBloodBurst(
    worldPos: Vec3Like,
    normalDir: Vec3Like,
    energyJ: number,
    count = 16
  ): void {
    const burstCount = Math.min(48, Math.max(count, Math.floor(energyJ / 24)));
    const baseSpeed = Math.min(9.5, Math.max(2.6, Math.sqrt(energyJ) * 0.16));

    for (let i = 0; i < burstCount; i++) {
      const dropEnt = new pc.Entity('BloodDrop');
      dropEnt.addComponent('render', {
        type: 'box', // Crisp low-poly PS1 pixel-chunk blood droplets!
        material: this.materials.bloodDropMat,
      });
      const radius = 0.014 + Math.random() * 0.02;
      dropEnt.setLocalScale(radius, radius, radius);
      dropEnt.setPosition(worldPos.x, worldPos.y, worldPos.z);
      this.fxRoot.addChild(dropEnt);

      const vx = normalDir.x * baseSpeed + (Math.random() - 0.5) * baseSpeed * 1.15;
      const vy = normalDir.y * baseSpeed + Math.random() * baseSpeed * 0.7 + 0.6;
      const vz = normalDir.z * baseSpeed + (Math.random() - 0.5) * baseSpeed * 1.15;

      this.bloodDrops.push({
        entity: dropEnt,
        position: new pc.Vec3(worldPos.x, worldPos.y, worldPos.z),
        velocity: new pc.Vec3(vx, vy, vz),
        life: 0,
        maxLife: 2.5,
      });
    }
  }

  /**
   * Spawns spinning 3D meat & skull/bone gib chunks (primarily on CRANIAL_POP or EVISCERATED).
   */
  public spawnDismembermentGibs(event: DismembermentEvent): void {
    const count = Math.max(3, event.gibCount);
    const origin = event.stumpWorldPosition;
    const launchVel = event.severedLimbVelocity;

    for (let i = 0; i < count; i++) {
      const isBone = i % 3 === 0;
      const gib = new pc.Entity('GibChunk');
      gib.addComponent('render', {
        type: isBone ? 'cylinder' : 'box',
        material: isBone ? this.materials.exposedBoneMat : this.materials.gibChunkMat,
      });

      const s = 0.032 + Math.random() * 0.04;
      gib.setLocalScale(s, s * 1.25, s);
      gib.setPosition(origin.x, origin.y, origin.z);
      this.fxRoot.addChild(gib);

      const vx = launchVel.x * 0.65 + (Math.random() - 0.5) * 4.2;
      const vy = Math.max(1.8, launchVel.y * 0.55 + Math.random() * 3.2);
      const vz = launchVel.z * 0.65 + (Math.random() - 0.5) * 4.2;

      this.gibChunks.push({
        entity: gib,
        position: new pc.Vec3(origin.x, origin.y, origin.z),
        velocity: new pc.Vec3(vx, vy, vz),
        angularVelocity: new pc.Vec3(
          (Math.random() - 0.5) * 22,
          (Math.random() - 0.5) * 22,
          (Math.random() - 0.5) * 22
        ),
        bounces: 0,
        life: 0,
        maxLife: 12.0,
        leavesBlood: true,
        restHeight: 0.025,
      });
    }
  }

  /**
   * Attaches a continuous pulsing arterial blood stream spraying from the parent body's severed stump socket!
   */
  public attachArterialFountain(
    target: TargetHealthState,
    event: DismembermentEvent
  ): void {
    this.arterialFountains.push({
      target,
      zone: event.zone,
      parentZone: event.parentZone,
      stumpPos: copyVec3(event.stumpWorldPosition),
      sprayDir: copyVec3(event.arterialSprayDirection),
      durationS: 3.8,
      elapsedS: 0,
      dropTimerS: 0,
    });
  }

  /**
   * Spawns white cortical bone shards when a projectile shatters bone.
   */
  public spawnBoneShatterSparks(worldPos: Vec3Like, dir: Vec3Like): void {
    const shardCount = 10;
    for (let i = 0; i < shardCount; i++) {
      const shard = new pc.Entity('BoneShard');
      shard.addComponent('render', {
        type: 'box',
        material: this.materials.exposedBoneMat,
      });
      const s = 0.012 + Math.random() * 0.016;
      shard.setLocalScale(s, s * 2.0, s * 0.6);
      shard.setPosition(worldPos.x, worldPos.y, worldPos.z);
      this.fxRoot.addChild(shard);

      const spd = 2.2 + Math.random() * 3.8;
      this.boneShards.push({
        entity: shard,
        position: new pc.Vec3(worldPos.x, worldPos.y, worldPos.z),
        velocity: new pc.Vec3(
          dir.x * spd + (Math.random() - 0.5) * 2.6,
          dir.y * spd + Math.random() * 2.2,
          dir.z * spd + (Math.random() - 0.5) * 2.6
        ),
        life: 0,
      });
    }
  }

  /**
   * Spawns a flat circular dark-crimson pool on the floor at y=0.008.
   */
  private spawnBloodPool(pos: pc.Vec3, maxRadius = 0.34): void {
    const pool = new pc.Entity('BloodPoolDecal');
    pool.addComponent('render', {
      type: 'cylinder',
      material: this.materials.bloodPoolMat,
    });
    pool.setLocalScale(0.04, 0.003, 0.04);
    pool.setPosition(pos.x, 0.008, pos.z);
    this.fxRoot.addChild(pool);

    this.bloodPools.push({
      entity: pool,
      currentScale: 0.04,
      targetScale: maxRadius * (0.8 + Math.random() * 0.45),
      growthRate: 0.38,
    });

    if (this.bloodPools.length > 65) {
      const oldest = this.bloodPools.shift();
      if (oldest) oldest.entity.destroy();
    }
  }

  /**
   * Main per-frame update loop.
   */
  public update(dt: number, showTrails = true): void {
    const gravity = -9.81;

    // 1. Update In-Flight Projectiles
    for (let i = this.activeProjectiles.length - 1; i >= 0; i--) {
      const p = this.activeProjectiles[i];
      p.progressTimeS += dt;

      const samples = p.trajectorySamples;
      while (
        p.currentSampleIndex < samples.length - 1 &&
        samples[p.currentSampleIndex + 1].timeS <= p.progressTimeS
      ) {
        p.currentSampleIndex++;
      }

      const curSample = samples[p.currentSampleIndex];
      const nextSample = samples[Math.min(samples.length - 1, p.currentSampleIndex + 1)];

      let px = curSample.position.x;
      let py = curSample.position.y;
      let pz = curSample.position.z;

      const segDt = nextSample.timeS - curSample.timeS;
      if (segDt > 1e-6) {
        const factor = Math.min(1.0, (p.progressTimeS - curSample.timeS) / segDt);
        px += (nextSample.position.x - curSample.position.x) * factor;
        py += (nextSample.position.y - curSample.position.y) * factor;
        pz += (nextSample.position.z - curSample.position.z) * factor;
      }

      p.entity.setPosition(px, py, pz);

      const vel = curSample.velocity;
      const speed = length(vel);
      if (speed > 1e-2) {
        const dir = normalize(vel);
        const lookTarget = new pc.Vec3(px + dir.x, py + dir.y, pz + dir.z);
        p.entity.lookAt(lookTarget);
        p.entity.rotateLocal(90, 0, 0);
      }

      const curPosVec = new pc.Vec3(px, py, pz);
      if (
        p.trailPoints.length === 0 ||
        curPosVec.distance(p.trailPoints[p.trailPoints.length - 1]) > 0.35
      ) {
        p.trailPoints.push(curPosVec);
      }

      if (showTrails && p.trailPoints.length >= 2) {
        for (let ptIdx = 0; ptIdx < p.trailPoints.length - 1; ptIdx++) {
          this.app.drawLine(
            p.trailPoints[ptIdx],
            p.trailPoints[ptIdx + 1],
            pc.Color.YELLOW,
            true
          );
        }
      }

      if (p.progressTimeS >= p.totalFlightTimeS) {
        p.finished = true;
        p.entity.destroy();
        this.activeProjectiles.splice(i, 1);
      }
    }

    // 2. Update Arterial Fountains (tracks the PARENT body stump socket as the ragdoll flies & tumbles!)
    for (let i = this.arterialFountains.length - 1; i >= 0; i--) {
      const f = this.arterialFountains[i];
      f.elapsedS += dt;
      f.dropTimerS += dt;

      if (f.target) {
        const socketZone = f.parentZone || f.zone;
        if (socketZone && f.target.ragdollBones[socketZone]) {
          const b = f.target.ragdollBones[socketZone];
          f.stumpPos = copyVec3(b.distalPosition || b.position);
          // Spray spurts outward from the stump socket!
          const out = sub(b.distalPosition, b.position);
          if (length(out) > 0.02) {
            f.sprayDir = normalize(scale(out, 1));
          } else {
            f.sprayDir = copyVec3(b.basisUp);
          }
        }
      }

      const pulseRate = 1.0 + Math.sin(f.elapsedS * 9.5) * 0.75;
      if (f.dropTimerS >= 0.055 / Math.max(0.3, pulseRate)) {
        f.dropTimerS = 0;
        const sprayDirNorm = normalize(f.sprayDir);
        this.spawnBloodBurst(f.stumpPos, sprayDirNorm, 42 * pulseRate, 3);
      }

      if (f.elapsedS >= f.durationS) {
        this.arterialFountains.splice(i, 1);
      }
    }

    // 3. Update In-Flight Blood Droplets
    for (let i = this.bloodDrops.length - 1; i >= 0; i--) {
      const drop = this.bloodDrops[i];
      drop.life += dt;
      drop.velocity.y += gravity * dt;

      drop.position.x += drop.velocity.x * dt;
      drop.position.y += drop.velocity.y * dt;
      drop.position.z += drop.velocity.z * dt;

      drop.entity.setPosition(drop.position.x, drop.position.y, drop.position.z);

      if (drop.position.y <= 0.015) {
        this.spawnBloodPool(drop.position, 0.24);
        drop.entity.destroy();
        this.bloodDrops.splice(i, 1);
        continue;
      }

      if (drop.life >= drop.maxLife) {
        drop.entity.destroy();
        this.bloodDrops.splice(i, 1);
      }
    }

    // 4. Update Gib Chunks & Detached Physics Props (Helmets / Weapons)
    for (let i = this.gibChunks.length - 1; i >= 0; i--) {
      const gib = this.gibChunks[i];
      gib.life += dt;
      gib.velocity.y += gravity * dt;

      gib.position.x += gib.velocity.x * dt;
      gib.position.y += gib.velocity.y * dt;
      gib.position.z += gib.velocity.z * dt;

      gib.entity.setPosition(gib.position.x, gib.position.y, gib.position.z);
      if (gib.angularVelocity.length() > 0.05) {
        gib.entity.rotate(
          gib.angularVelocity.x * dt * 45,
          gib.angularVelocity.y * dt * 45,
          gib.angularVelocity.z * dt * 45
        );
      }

      if (gib.position.y <= gib.restHeight) {
        gib.position.y = gib.restHeight;
        gib.bounces++;
        if (gib.leavesBlood && gib.bounces <= 2) {
          this.spawnBloodPool(gib.position, 0.28);
        }

        if (gib.bounces <= 2 && Math.abs(gib.velocity.y) > 0.5) {
          gib.velocity.y = -gib.velocity.y * 0.32;
          gib.velocity.x *= 0.58;
          gib.velocity.z *= 0.58;
          gib.angularVelocity.set(
            gib.angularVelocity.x * 0.5,
            gib.angularVelocity.y * 0.5,
            gib.angularVelocity.z * 0.2
          );
        } else {
          gib.velocity.set(0, 0, 0);
          gib.angularVelocity.set(0, 0, 0);
          // Lay dropped firearms flat on their side
          if (!gib.leavesBlood && gib.bounces === 3) {
            const eul = gib.entity.getLocalEulerAngles();
            gib.entity.setLocalEulerAngles(0, eul.y, 88);
          }
        }
      }

      if (gib.life >= gib.maxLife) {
        gib.entity.destroy();
        this.gibChunks.splice(i, 1);
      }
    }

    // 5. Update Bone & Armor Sparks
    for (let i = this.boneShards.length - 1; i >= 0; i--) {
      const shard = this.boneShards[i];
      shard.life += dt;
      shard.velocity.y += gravity * dt;

      shard.position.x += shard.velocity.x * dt;
      shard.position.y += shard.velocity.y * dt;
      shard.position.z += shard.velocity.z * dt;

      shard.entity.setPosition(shard.position.x, shard.position.y, shard.position.z);

      if (shard.position.y <= 0.015) {
        shard.position.y = 0.015;
        shard.velocity.set(0, 0, 0);
      }

      if (shard.life >= 3.2) {
        shard.entity.destroy();
        this.boneShards.splice(i, 1);
      }
    }

    // 6. Expand Ground Blood Pools
    for (const pool of this.bloodPools) {
      if (pool.currentScale < pool.targetScale) {
        pool.currentScale = Math.min(
          pool.targetScale,
          pool.currentScale + pool.growthRate * dt
        );
        pool.entity.setLocalScale(pool.currentScale, 0.003, pool.currentScale);
      }
    }
  }

  /**
   * Resets all active FX when respawning targets.
   */
  public clearAll(): void {
    for (const p of this.activeProjectiles) p.entity.destroy();
    for (const d of this.bloodDrops) d.entity.destroy();
    for (const g of this.gibChunks) g.entity.destroy();
    for (const s of this.boneShards) s.entity.destroy();
    for (const b of this.bloodPools) b.entity.destroy();

    this.activeProjectiles = [];
    this.bloodDrops = [];
    this.gibChunks = [];
    this.boneShards = [];
    this.bloodPools = [];
    this.arterialFountains = [];
  }
}
