import * as pc from 'playcanvas';
import { Vec3Like } from '../../contracts/ballistics.ts';
import {
  CharacterTransform,
  PHYSIOLOGY_CONSTANTS,
  PhysiologicalEntityState,
  VascularWoundRecord,
  VesselKind,
} from '../../contracts/physiology.ts';
import {
  characterLocalDirectionToWorld,
  characterLocalPointToWorld,
} from '../../core/ghoul/bvhVolumes.ts';
import { normalize } from '../../core/ballistics/vec3.ts';
import { EngineMaterialPalette } from '../materials.ts';

export interface VascularBloodMaterials {
  readonly arterialJetMat: pc.StandardMaterial;
  readonly arterialPoolMat: pc.StandardMaterial;
  readonly venousOozeMat: pc.StandardMaterial;
  readonly venousPoolMat: pc.StandardMaterial;
}

export interface ActiveVascularParticle {
  readonly entity: pc.Entity;
  readonly vesselKind: VesselKind;
  readonly position: pc.Vec3;
  readonly velocity: pc.Vec3;
  ageS: number;
  readonly maxLifeS: number;
}

export interface ActiveVascularFloorPool {
  readonly entity: pc.Entity;
  readonly vesselKind: VesselKind;
  readonly centerX: number;
  readonly centerZ: number;
  currentRadiusM: number;
  targetRadiusM: number;
  growthRateMPerSec: number;
}

interface BoundPhysiologyEmitter {
  readonly state: PhysiologicalEntityState;
  readonly getTransform?: () => CharacterTransform;
  readonly woundTimers: Map<string, number>;
}

/**
 * Builds distinct oxygenated bright-crimson arterial vs deoxygenated dark-maroon venous PlayCanvas materials.
 */
export function createVascularBloodMaterials(
  palette?: EngineMaterialPalette
): VascularBloodMaterials {
  const [ar, ag, ab] = PHYSIOLOGY_CONSTANTS.ARTERIAL_CRIMSON_RGB;
  const [vr, vg, vb] = PHYSIOLOGY_CONSTANTS.VENOUS_MAROON_RGB;

  const arterialJetMat = new pc.StandardMaterial();
  arterialJetMat.name = 'vascularArterialJetMat';
  arterialJetMat.diffuse = new pc.Color(ar, ag, ab);
  arterialJetMat.emissive = new pc.Color(ar * 0.36, ag * 0.25, ab * 0.25);
  arterialJetMat.specular = new pc.Color(0.55, 0.14, 0.14);
  arterialJetMat.shininess = palette ? palette.bloodDropMat.shininess : 82;
  arterialJetMat.update();

  const arterialPoolMat = new pc.StandardMaterial();
  arterialPoolMat.name = 'vascularArterialPoolMat';
  arterialPoolMat.diffuse = new pc.Color(ar * 0.72, ag * 0.6, ab * 0.6);
  arterialPoolMat.specular = new pc.Color(0.62, 0.12, 0.12);
  arterialPoolMat.opacity = 0.9;
  arterialPoolMat.blendType = pc.BLEND_NORMAL;
  arterialPoolMat.shininess = palette ? palette.bloodPoolMat.shininess : 90;
  arterialPoolMat.update();

  const venousOozeMat = new pc.StandardMaterial();
  venousOozeMat.name = 'vascularVenousOozeMat';
  venousOozeMat.diffuse = new pc.Color(vr, vg, vb);
  venousOozeMat.emissive = new pc.Color(vr * 0.08, 0, vb * 0.08);
  venousOozeMat.specular = new pc.Color(0.38, 0.05, 0.06);
  venousOozeMat.shininess = 74;
  venousOozeMat.update();

  const venousPoolMat = new pc.StandardMaterial();
  venousPoolMat.name = 'vascularVenousPoolMat';
  venousPoolMat.diffuse = new pc.Color(vr * 0.85, vg * 0.8, vb * 0.85);
  venousPoolMat.specular = new pc.Color(0.52, 0.06, 0.08);
  venousPoolMat.opacity = 0.92;
  venousPoolMat.blendType = pc.BLEND_NORMAL;
  venousPoolMat.shininess = palette ? palette.bloodPoolMat.shininess : 92;
  venousPoolMat.update();

  return {
    arterialJetMat,
    arterialPoolMat,
    venousOozeMat,
    venousPoolMat,
  };
}

/**
 * Pure helper computing instantaneous systolic pulse intensity [0..1] synced to `heartRateBpm`.
 */
export function evaluateSystolicPulseWave(elapsedTimeS: number, heartRateBpm: number): number {
  if (heartRateBpm <= 0) return 0;
  const freqHz = heartRateBpm / 60;
  const phase = ((elapsedTimeS * freqHz) % 1 + 1) % 1;
  // Crisp systolic ejection peak over first 26% of cardiac cycle followed by dicrotic diastolic decay
  if (phase < 0.26) {
    return Math.sin((phase / 0.26) * Math.PI * 0.5);
  }
  return Math.exp(-(phase - 0.26) * 4.6);
}

/**
 * Renders distinct systolic-pulsed bright crimson arterial jets vs dark maroon venous oozing & floor pools
 * driven directly by `PhysiologicalEntityState` vascular wounds.
 */
export class VascularBloodFxEmitter {
  public readonly app: pc.AppBase;
  public readonly palette: EngineMaterialPalette;
  public readonly vascularMaterials: VascularBloodMaterials;
  public readonly fxRoot: pc.Entity;

  private readonly maxParticles: number;
  private readonly maxPools: number;
  private readonly particles: ActiveVascularParticle[] = [];
  private readonly pools: ActiveVascularFloorPool[] = [];
  private readonly boundEntities = new Map<string, BoundPhysiologyEmitter>();

  constructor(
    app: pc.AppBase,
    palette: EngineMaterialPalette,
    maxParticles = 160,
    maxPools = 48
  ) {
    this.app = app;
    this.palette = palette;
    this.vascularMaterials = createVascularBloodMaterials(palette);
    this.maxParticles = maxParticles;
    this.maxPools = maxPools;

    this.fxRoot = new pc.Entity('VascularBloodFxRoot', this.app);
    this.app.root.addChild(this.fxRoot);
  }

  public bindEntity(
    state: PhysiologicalEntityState,
    getTransform?: () => CharacterTransform
  ): void {
    this.boundEntities.set(state.entityId, {
      state,
      getTransform,
      woundTimers: new Map(),
    });
  }

  public unbindEntity(entityId: string): boolean {
    return this.boundEntities.delete(entityId);
  }

  public getActiveCounts(): {
    particles: number;
    arterialParticles: number;
    venousParticles: number;
    floorPools: number;
  } {
    let arterialParticles = 0;
    let venousParticles = 0;
    for (const p of this.particles) {
      if (p.vesselKind === 'ARTERIAL') arterialParticles++;
      else venousParticles++;
    }
    return {
      particles: this.particles.length,
      arterialParticles,
      venousParticles,
      floorPools: this.pools.length,
    };
  }

  /**
   * Emits systolic arterial jets or dark venous ooze droplets for a single entity over `dt`.
   */
  public emitFromEntityState(
    state: PhysiologicalEntityState,
    dt: number,
    transform?: CharacterTransform,
    woundTimers?: Map<string, number>
  ): void {
    if (state.vascularWounds.length === 0 || dt <= 0) return;

    const mapRatio = state.alive
      ? Math.max(0, state.meanArterialPressureMmHg / PHYSIOLOGY_CONSTANTS.BASELINE_MAP_MMHG)
      : 0;
    const systolicWave = evaluateSystolicPulseWave(state.elapsedTimeS, state.heartRateBpm);

    for (let i = 0; i < state.vascularWounds.length; i++) {
      const wound = state.vascularWounds[i];
      const key = `${wound.vesselId}_${wound.vesselKind}_${i}`;
      const prevTimer = woundTimers ? (woundTimers.get(key) ?? 0) : 0;
      let timer = prevTimer + dt;

      const worldOrigin = transform
        ? characterLocalPointToWorld(wound.positionLocal, transform, wound.ghoulZone)
        : wound.positionWorld;
      const worldDir = transform
        ? characterLocalDirectionToWorld(wound.sprayDirectionWorld, transform)
        : normalize(wound.sprayDirectionWorld);

      if (wound.vesselKind === 'ARTERIAL' && state.alive && mapRatio > 0.12) {
        // Systolic-pulsed high-velocity bright crimson arterial jet (3.5–6.5 m/s)
        const pulseGate = 0.22 + 0.78 * systolicWave;
        const intervalS = Math.max(0.022, 0.075 / Math.max(0.25, pulseGate * mapRatio));

        while (timer >= intervalS) {
          timer -= intervalS;
          if (systolicWave >= 0.25) {
            const jetSpeed =
              (3.5 + Math.min(3.0, (wound.baseBleedMlPerSec / 95) * 3.0)) *
              (0.45 + 0.55 * mapRatio) *
              (0.55 + 0.45 * systolicWave);
            this.spawnArterialJetDroplet(worldOrigin, worldDir, jetSpeed);
          }
        }
      } else if (state.alive || mapRatio > 0 || wound.vesselKind === 'VENOUS') {
        // Steady low-pressure deoxygenated dark-maroon venous drip + floor pool expansion
        const oozeFactor = state.alive ? Math.max(0.25, mapRatio) : 0.12;
        const intervalS = Math.max(0.065, 0.18 / Math.max(0.2, (wound.baseBleedMlPerSec / 14) * oozeFactor));
        while (timer >= intervalS) {
          timer -= intervalS;
          this.spawnVenousOozeDrip(worldOrigin, worldDir, 0.38 + 0.35 * oozeFactor);
        }
      }

      if (woundTimers) {
        woundTimers.set(key, timer);
      }
    }
  }

  public spawnArterialJetDroplet(
    originWorld: Vec3Like,
    sprayDirWorld: Vec3Like,
    jetSpeedMs: number
  ): ActiveVascularParticle {
    this.enforceParticleCap();
    const dir = normalize(sprayDirWorld);

    const drop = new pc.Entity('ArterialJetDrop', this.app);
    if (this.app.systems?.render) {
      drop.addComponent('render', {
        type: 'box',
        material: this.vascularMaterials.arterialJetMat,
      });
    }
    drop.setLocalScale(0.014, 0.014, 0.032);
    drop.setPosition(originWorld.x, originWorld.y, originWorld.z);
    this.fxRoot.addChild(drop);

    const jitter = 0.24;
    const vx = dir.x * jetSpeedMs + (Math.random() - 0.5) * jitter * jetSpeedMs;
    const vy = dir.y * jetSpeedMs + 0.55 + (Math.random() - 0.5) * jitter * jetSpeedMs;
    const vz = dir.z * jetSpeedMs + (Math.random() - 0.5) * jitter * jetSpeedMs;

    const p: ActiveVascularParticle = {
      entity: drop,
      vesselKind: 'ARTERIAL',
      position: new pc.Vec3(originWorld.x, originWorld.y, originWorld.z),
      velocity: new pc.Vec3(vx, vy, vz),
      ageS: 0,
      maxLifeS: 2.2,
    };
    this.particles.push(p);
    return p;
  }

  public spawnVenousOozeDrip(
    originWorld: Vec3Like,
    oozeDirWorld: Vec3Like,
    dripSpeedMs = 0.52
  ): ActiveVascularParticle {
    this.enforceParticleCap();
    const dir = normalize(oozeDirWorld);

    const drip = new pc.Entity('VenousOozeDrip', this.app);
    if (this.app.systems?.render) {
      drip.addComponent('render', {
        type: 'sphere',
        material: this.vascularMaterials.venousOozeMat,
      });
    }
    drip.setLocalScale(0.020, 0.024, 0.020);
    drip.setPosition(originWorld.x, originWorld.y, originWorld.z);
    this.fxRoot.addChild(drip);

    const vx = dir.x * dripSpeedMs * 0.45 + (Math.random() - 0.5) * 0.14;
    const vy = -Math.abs(dripSpeedMs) * 0.65;
    const vz = dir.z * dripSpeedMs * 0.45 + (Math.random() - 0.5) * 0.14;

    const p: ActiveVascularParticle = {
      entity: drip,
      vesselKind: 'VENOUS',
      position: new pc.Vec3(originWorld.x, originWorld.y, originWorld.z),
      velocity: new pc.Vec3(vx, vy, vz),
      ageS: 0,
      maxLifeS: 2.6,
    };
    this.particles.push(p);
    return p;
  }

  private spawnOrGrowFloorPool(x: number, z: number, vesselKind: VesselKind): void {
    // Coalesce into nearby pool of same vesselKind within 18 cm to prevent z-fighting decal spam
    for (const pool of this.pools) {
      if (pool.vesselKind !== vesselKind) continue;
      const dx = pool.centerX - x;
      const dz = pool.centerZ - z;
      if (dx * dx + dz * dz <= 0.18 * 0.18) {
        pool.targetRadiusM = Math.min(0.68, pool.targetRadiusM + 0.032);
        return;
      }
    }

    if (this.pools.length >= this.maxPools) {
      const oldest = this.pools.shift();
      if (oldest) oldest.entity.destroy();
    }

    const poolEnt = new pc.Entity(
      vesselKind === 'ARTERIAL' ? 'ArterialBloodPool' : 'VenousBloodPool',
      this.app
    );
    if (this.app.systems?.render) {
      poolEnt.addComponent('render', {
        type: 'cylinder',
        material:
          vesselKind === 'ARTERIAL'
            ? this.vascularMaterials.arterialPoolMat
            : this.vascularMaterials.venousPoolMat,
      });
    }
    const yHeight = vesselKind === 'ARTERIAL' ? 0.0085 : 0.0075;
    poolEnt.setLocalScale(0.045, 0.003, 0.045);
    poolEnt.setPosition(x, yHeight, z);
    this.fxRoot.addChild(poolEnt);

    this.pools.push({
      entity: poolEnt,
      vesselKind,
      centerX: x,
      centerZ: z,
      currentRadiusM: 0.045,
      targetRadiusM: vesselKind === 'ARTERIAL' ? 0.26 : 0.34,
      growthRateMPerSec: vesselKind === 'ARTERIAL' ? 0.28 : 0.16,
    });
  }

  private enforceParticleCap(): void {
    if (this.particles.length >= this.maxParticles) {
      const oldest = this.particles.shift();
      if (oldest) oldest.entity.destroy();
    }
  }

  /**
   * Steps bound emitters, airborne arterial/venous droplets, and expanding floor pools.
   */
  public update(dt: number): void {
    if (dt <= 0 || !Number.isFinite(dt)) return;

    for (const bound of this.boundEntities.values()) {
      const transform = bound.getTransform ? bound.getTransform() : undefined;
      this.emitFromEntityState(bound.state, dt, transform, bound.woundTimers);
    }

    const gravityY = -9.81;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.ageS += dt;
      p.velocity.y += gravityY * dt;

      p.position.x += p.velocity.x * dt;
      p.position.y += p.velocity.y * dt;
      p.position.z += p.velocity.z * dt;
      p.entity.setPosition(p.position.x, p.position.y, p.position.z);

      if (p.position.y <= 0.012) {
        this.spawnOrGrowFloorPool(p.position.x, p.position.z, p.vesselKind);
        p.entity.destroy();
        this.particles.splice(i, 1);
        continue;
      }

      if (p.ageS >= p.maxLifeS) {
        p.entity.destroy();
        this.particles.splice(i, 1);
      }
    }

    for (const pool of this.pools) {
      if (pool.currentRadiusM < pool.targetRadiusM) {
        pool.currentRadiusM = Math.min(
          pool.targetRadiusM,
          pool.currentRadiusM + pool.growthRateMPerSec * dt
        );
        pool.entity.setLocalScale(pool.currentRadiusM, 0.003, pool.currentRadiusM);
      }
    }
  }

  public clearAll(): void {
    for (const p of this.particles) p.entity.destroy();
    for (const pool of this.pools) pool.entity.destroy();
    this.particles.length = 0;
    this.pools.length = 0;
    for (const b of this.boundEntities.values()) {
      b.woundTimers.clear();
    }
  }

  public destroy(): void {
    this.clearAll();
    this.boundEntities.clear();
    this.fxRoot.destroy();
  }
}

export type { VascularWoundRecord };
