import * as pc from 'playcanvas';
import {
  Vec3Like,
  DismembermentEvent,
  TargetHealthState,
  TrajectorySample,
  GhoulZoneId,
} from '../contracts/ballistics.ts';
import { vec3, copyVec3, add, sub, scale, length, normalize } from '../core/ballistics/vec3.ts';
import { GHOUL_ZONE_HIERARCHY } from '../core/ghoul/anatomy.ts';
import { EngineMaterialPalette } from './materials.ts';

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
  localOffsetFromParent?: Vec3Like;
  stumpPos: Vec3Like;
  sprayDir: Vec3Like;
  durationS: number;
  elapsedS: number;
  dropTimerS: number;
}

/**
 * Class GoreAndBallisticsFxManager manages:
 * - In-flight 3D spinning bullet models and Mach shockwave rings
 * - Persistent ballistic trajectory trails
 * - High-velocity blood splatter & expanding ground blood pools
 * - Flying Soldier of Fortune dismemberment meat/bone gib chunks
 * - Pulsing arterial stump blood fountains
 * - White cortical bone shatter sparks
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

  constructor(app: pc.AppBase, materials: EngineMaterialPalette) {
    this.app = app;
    this.materials = materials;
    this.fxRoot = new pc.Entity('GoreAndBallisticsFxRoot');
    this.app.root.addChild(this.fxRoot);
  }

  /**
   * Spawns an animated 3D projectile following pre-calculated trajectory samples.
   */
  public spawnFlyingProjectile(
    trajectorySamples: TrajectorySample[],
    isShotgunPellet = false,
    speedMultiplier = 1.0
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

    // Shockwave ring for supersonic projectiles
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

    const totalFlightTimeS = trajectorySamples[trajectorySamples.length - 1].timeS;

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
   * Spawns high-velocity 3D blood droplets and mist affected by gravity that splat into floor pools.
   */
  public spawnBloodBurst(
    worldPos: Vec3Like,
    normalDir: Vec3Like,
    energyJ: number,
    count = 18
  ): void {
    const burstCount = Math.min(60, Math.max(count, Math.floor(energyJ / 20)));
    const baseSpeed = Math.min(12.0, Math.max(3.0, Math.sqrt(energyJ) * 0.18));

    for (let i = 0; i < burstCount; i++) {
      const dropEnt = new pc.Entity('BloodDrop');
      dropEnt.addComponent('render', {
        type: 'sphere',
        material: this.materials.bloodDropMat,
      });
      const radius = 0.012 + Math.random() * 0.018;
      dropEnt.setLocalScale(radius, radius, radius);
      dropEnt.setPosition(worldPos.x, worldPos.y, worldPos.z);
      this.fxRoot.addChild(dropEnt);

      // Random cone velocity along normalDir
      const vx = normalDir.x * baseSpeed + (Math.random() - 0.5) * baseSpeed * 1.2;
      const vy = normalDir.y * baseSpeed + Math.random() * baseSpeed * 0.8 + 0.5;
      const vz = normalDir.z * baseSpeed + (Math.random() - 0.5) * baseSpeed * 1.2;

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
   * Spawns spinning 3D meat & skull/bone gib chunks that bounce off the floor with wet blood splats.
   */
  public spawnDismembermentGibs(event: DismembermentEvent): void {
    const count = Math.max(4, event.gibCount);
    const origin = event.stumpWorldPosition;
    const launchVel = event.severedLimbVelocity;

    for (let i = 0; i < count; i++) {
      const isBone = i % 3 === 0;
      const gib = new pc.Entity('GibChunk');
      gib.addComponent('render', {
        type: isBone ? 'cylinder' : 'box',
        material: isBone ? this.materials.exposedBoneMat : this.materials.gibChunkMat,
      });

      const s = 0.035 + Math.random() * 0.045;
      gib.setLocalScale(s, s * 1.2, s);
      gib.setPosition(origin.x, origin.y, origin.z);
      this.fxRoot.addChild(gib);

      const vx = launchVel.x + (Math.random() - 0.5) * 4.5;
      const vy = launchVel.y + Math.random() * 3.5 + 1.2;
      const vz = launchVel.z + (Math.random() - 0.5) * 4.5;

      const avx = (Math.random() - 0.5) * 25;
      const avy = (Math.random() - 0.5) * 25;
      const avz = (Math.random() - 0.5) * 25;

      this.gibChunks.push({
        entity: gib,
        position: new pc.Vec3(origin.x, origin.y, origin.z),
        velocity: new pc.Vec3(vx, vy, vz),
        angularVelocity: new pc.Vec3(avx, avy, avz),
        bounces: 0,
        life: 0,
      });
    }
  }

  /**
   * Attaches a continuous pulsing arterial blood stream spraying from the severed parent stump on the body.
   */
  public attachArterialFountain(
    target: TargetHealthState,
    event: DismembermentEvent
  ): void {
    const hier = GHOUL_ZONE_HIERARCHY[event.zone];
    const parentZone = hier?.parent;
    let localOffsetFromParent: Vec3Like | undefined;
    let sprayDir = copyVec3(event.arterialSprayDirection);

    if (parentZone) {
      const parentHier = GHOUL_ZONE_HIERARCHY[parentZone];
      localOffsetFromParent = sub(hier.jointLocalPos, parentHier.jointLocalPos);
      // Spray outward from parent toward severed joint + upward arc
      const outLocal = normalize(add(localOffsetFromParent, vec3(0, 0.35, 0)));
      const cosY = Math.cos(target.yawRad);
      const sinY = Math.sin(target.yawRad);
      sprayDir = normalize(
        vec3(
          outLocal.x * cosY + outLocal.z * sinY,
          Math.max(0.35, outLocal.y),
          -outLocal.x * sinY + outLocal.z * cosY
        )
      );
    }

    this.arterialFountains.push({
      target,
      zone: event.zone,
      parentZone,
      localOffsetFromParent,
      stumpPos: copyVec3(event.stumpWorldPosition),
      sprayDir,
      durationS: 3.5, // Sprays for 3.5 seconds
      elapsedS: 0,
      dropTimerS: 0,
    });
  }

  /**
   * Spawns white cortical bone shards inside the X-Ray cavity when a bullet shatters bone.
   */
  public spawnBoneShatterSparks(worldPos: Vec3Like, dir: Vec3Like): void {
    const shardCount = 14;
    for (let i = 0; i < shardCount; i++) {
      const shard = new pc.Entity('BoneShard');
      shard.addComponent('render', {
        type: 'box',
        material: this.materials.exposedBoneMat,
      });
      const s = 0.012 + Math.random() * 0.02;
      shard.setLocalScale(s, s * 2.0, s * 0.6);
      shard.setPosition(worldPos.x, worldPos.y, worldPos.z);
      this.fxRoot.addChild(shard);

      const spd = 2.5 + Math.random() * 4.5;
      const vx = dir.x * spd + (Math.random() - 0.5) * 3.0;
      const vy = dir.y * spd + Math.random() * 2.5;
      const vz = dir.z * spd + (Math.random() - 0.5) * 3.0;

      this.boneShards.push({
        entity: shard,
        position: new pc.Vec3(worldPos.x, worldPos.y, worldPos.z),
        velocity: new pc.Vec3(vx, vy, vz),
        life: 0,
      });
    }
  }

  /**
   * Spawns a flat circular dark-crimson pool on the floor at y=0.01.
   */
  private spawnBloodPool(pos: pc.Vec3, maxRadius = 0.35): void {
    const pool = new pc.Entity('BloodPoolDecal');
    pool.addComponent('render', {
      type: 'cylinder',
      material: this.materials.bloodPoolMat,
    });
    pool.setLocalScale(0.04, 0.003, 0.04);
    pool.setPosition(pos.x, 0.01, pos.z);
    this.fxRoot.addChild(pool);

    this.bloodPools.push({
      entity: pool,
      currentScale: 0.04,
      targetScale: maxRadius * (0.8 + Math.random() * 0.4),
      growthRate: 0.35,
    });

    // Cap total blood pools to 50 for performance
    if (this.bloodPools.length > 50) {
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

      // Find current trajectory sample
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

      // Lerp if within segment
      const segDt = nextSample.timeS - curSample.timeS;
      if (segDt > 1e-6) {
        const factor = Math.min(1.0, (p.progressTimeS - curSample.timeS) / segDt);
        px += (nextSample.position.x - curSample.position.x) * factor;
        py += (nextSample.position.y - curSample.position.y) * factor;
        pz += (nextSample.position.z - curSample.position.z) * factor;
      }

      p.entity.setPosition(px, py, pz);

      // Orient forward along velocity
      const vel = curSample.velocity;
      const speed = length(vel);
      if (speed > 1e-2) {
        const dir = normalize(vel);
        const lookTarget = new pc.Vec3(px + dir.x, py + dir.y, pz + dir.z);
        p.entity.lookAt(lookTarget);
        p.entity.rotateLocal(90, 0, 0); // align cylinder axis
      }

      // Record trail point
      const curPosVec = new pc.Vec3(px, py, pz);
      if (
        p.trailPoints.length === 0 ||
        curPosVec.distance(p.trailPoints[p.trailPoints.length - 1]) > 0.35
      ) {
        p.trailPoints.push(curPosVec);
      }

      // Draw trajectory ribbon
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

    // 2. Update Arterial Fountains
    for (let i = this.arterialFountains.length - 1; i >= 0; i--) {
      const f = this.arterialFountains[i];
      f.elapsedS += dt;
      f.dropTimerS += dt;

      // Track the intact parent stump on the body (e.g. neck on decapitation, shoulder on arm sever)
      if (
        f.target &&
        f.parentZone &&
        !f.target.severedZones.has(f.parentZone) &&
        f.target.ragdollBones[f.parentZone]
      ) {
        const parentBone = f.target.ragdollBones[f.parentZone];
        const off = f.localOffsetFromParent || vec3(0, 0, 0);
        const cosY = Math.cos(parentBone.rotationEuler.y);
        const sinY = Math.sin(parentBone.rotationEuler.y);
        f.stumpPos = vec3(
          parentBone.position.x + (off.x * cosY + off.z * sinY),
          parentBone.position.y + off.y,
          parentBone.position.z + (-off.x * sinY + off.z * cosY)
        );
      } else if (f.target && f.zone && f.target.ragdollBones[f.zone]) {
        const b = f.target.ragdollBones[f.zone];
        f.stumpPos = copyVec3(b.position);
      }

      // Pulse blood drops (simulating systolic heartbeat at 1.4 Hz)
      const pulseRate = 1.0 + Math.sin(f.elapsedS * 9.0) * 0.8;
      if (f.dropTimerS >= 0.05 / pulseRate) {
        f.dropTimerS = 0;
        const sprayDirNorm = normalize(f.sprayDir);
        this.spawnBloodBurst(f.stumpPos, sprayDirNorm, 40 * pulseRate, 3);
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

      // Floor collision at y = 0.01 -> splat into blood pool!
      if (drop.position.y <= 0.015) {
        this.spawnBloodPool(drop.position, 0.25);
        drop.entity.destroy();
        this.bloodDrops.splice(i, 1);
        continue;
      }

      if (drop.life >= drop.maxLife) {
        drop.entity.destroy();
        this.bloodDrops.splice(i, 1);
      }
    }

    // 4. Update Gib Chunks
    for (let i = this.gibChunks.length - 1; i >= 0; i--) {
      const gib = this.gibChunks[i];
      gib.life += dt;
      gib.velocity.y += gravity * dt;

      gib.position.x += gib.velocity.x * dt;
      gib.position.y += gib.velocity.y * dt;
      gib.position.z += gib.velocity.z * dt;

      gib.entity.setPosition(gib.position.x, gib.position.y, gib.position.z);
      gib.entity.rotate(
        gib.angularVelocity.x * dt * 50,
        gib.angularVelocity.y * dt * 50,
        gib.angularVelocity.z * dt * 50
      );

      // Floor bounce & blood splat
      if (gib.position.y <= 0.025) {
        gib.position.y = 0.025;
        gib.bounces++;
        this.spawnBloodPool(gib.position, 0.3);

        if (gib.bounces <= 2) {
          gib.velocity.y = -gib.velocity.y * 0.35;
          gib.velocity.x *= 0.6;
          gib.velocity.z *= 0.6;
        } else {
          // Rest on floor
          gib.velocity.set(0, 0, 0);
          gib.angularVelocity.set(0, 0, 0);
        }
      }

      if (gib.life >= 8.0) {
        gib.entity.destroy();
        this.gibChunks.splice(i, 1);
      }
    }

    // 5. Update Bone Shard Sparks
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

      if (shard.life >= 4.0) {
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
