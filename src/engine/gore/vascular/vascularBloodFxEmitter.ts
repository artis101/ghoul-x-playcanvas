import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import {
  CharacterTransform,
  PHYSIOLOGY_CONSTANTS,
  PhysiologicalEntityState,
  VascularWoundRecord,
  VesselKind,
} from '../../../contracts/physiology.ts';
import { characterLocalDirectionToWorld, characterLocalPointToWorld } from '../../../core/ghoul/bvhVolumes.ts';
import { normalize } from '../../../core/ballistics/vec3.ts';
import type { EngineMaterialPalette } from '../../materials.ts';
import { getOrCreateWetBloodMaps } from './vascularBloodMaps.ts';
import { createVascularBloodMaterials } from './vascularBloodMaterials.ts';
import { evaluateSystolicPulseWave } from './vascularSystolicWave.ts';
import type {
  ActiveVascularFloorPool,
  ActiveVascularMistPuff,
  ActiveVascularParticle,
  BoundPhysiologyEmitter,
  VascularBloodMaterials,
} from './vascularBloodTypes.ts';

export class VascularBloodFxEmitter {
  public readonly app: pc.AppBase;
  public readonly palette: EngineMaterialPalette;
  public readonly vascularMaterials: VascularBloodMaterials;
  public readonly fxRoot: pc.Entity;

  private readonly maxParticles: number;
  private readonly maxPools: number;
  private readonly particles: ActiveVascularParticle[] = [];
  private readonly pools: ActiveVascularFloorPool[] = [];
  private readonly mistPuffs: ActiveVascularMistPuff[] = [];
  private readonly boundEntities = new Map<string, BoundPhysiologyEmitter>();
  private readonly mistMaterial: pc.StandardMaterial | null = null;
  private readonly scratchLookAt = new pc.Vec3();

  constructor(app: pc.AppBase, palette: EngineMaterialPalette, maxParticles = 160, maxPools = 48) {
    this.app = app;
    this.palette = palette;
    const device = app.graphicsDevice ?? null;
    this.vascularMaterials = createVascularBloodMaterials(palette, device);
    this.maxParticles = maxParticles;
    this.maxPools = maxPools;

    if (device) {
      const maps = getOrCreateWetBloodMaps(device);
      const mistMat = new pc.StandardMaterial();
      mistMat.name = 'vascularBacklitMistMat';
      mistMat.diffuse = new pc.Color(0.44, 0.016, 0.026);
      mistMat.emissive = new pc.Color(0.11, 0.006, 0.01);
      mistMat.opacityMap = maps.mistAlphaMap;
      mistMat.opacityMapChannel = 'a';
      mistMat.opacity = 0.44;
      mistMat.blendType = pc.BLEND_NORMAL;
      mistMat.depthWrite = false;
      mistMat.cull = pc.CULLFACE_NONE;
      mistMat.useLighting = true;
      mistMat.update();
      this.mistMaterial = mistMat;
    }

    this.fxRoot = new pc.Entity('VascularBloodFxRoot', this.app);
    this.app.root.addChild(this.fxRoot);
  }

  public bindEntity(state: PhysiologicalEntityState, getTransform?: () => CharacterTransform): void {
    this.boundEntities.set(state.entityId, { state, getTransform, woundTimers: new Map() });
  }

  public unbindEntity(entityId: string): boolean { return this.boundEntities.delete(entityId); }

  public getActiveCounts(): { particles: number; arterialParticles: number; venousParticles: number; floorPools: number } {
    let arterialParticles = 0, venousParticles = 0;
    for (const p of this.particles) {
      if (p.vesselKind === 'ARTERIAL') arterialParticles++; else venousParticles++;
    }
    return { particles: this.particles.length, arterialParticles, venousParticles, floorPools: this.pools.length };
  }

  public emitFromEntityState(
    state: PhysiologicalEntityState,
    dt: number,
    transform?: CharacterTransform,
    woundTimers?: Map<string, number>
  ): void {
    if (state.vascularWounds.length === 0 || dt <= 0) return;
    const mapRatio = state.alive ? Math.max(0, state.meanArterialPressureMmHg / PHYSIOLOGY_CONSTANTS.BASELINE_MAP_MMHG) : 0;
    const systolicWave = evaluateSystolicPulseWave(state.elapsedTimeS, state.heartRateBpm);

    for (let i = 0; i < state.vascularWounds.length; i++) {
      const wound = state.vascularWounds[i];
      const key = `${wound.vesselId}_${wound.vesselKind}_${i}`;
      let timer = (woundTimers ? (woundTimers.get(key) ?? 0) : 0) + dt;

      const origin = transform ? characterLocalPointToWorld(wound.positionLocal, transform, wound.ghoulZone) : wound.positionWorld;
      const dir = transform ? characterLocalDirectionToWorld(wound.sprayDirectionWorld, transform) : normalize(wound.sprayDirectionWorld);

      if (wound.vesselKind === 'ARTERIAL' && state.alive && mapRatio > 0.12) {
        const pulseGate = 0.22 + 0.78 * systolicWave;
        const intervalS = Math.max(0.022, 0.075 / Math.max(0.25, pulseGate * mapRatio));
        while (timer >= intervalS) {
          timer -= intervalS;
          if (systolicWave >= 0.25) {
            const spd = (3.5 + Math.min(3.0, (wound.baseBleedMlPerSec / 95) * 3.0)) * (0.45 + 0.55 * mapRatio) * (0.55 + 0.45 * systolicWave);
            this.spawnArterialJetDroplet(origin, dir, spd);
            if (systolicWave >= 0.65 && this.mistPuffs.length < 24) this.spawnArterialMistWisp(origin, dir, spd * 0.36);
          }
        }
      } else if (state.alive || mapRatio > 0 || wound.vesselKind === 'VENOUS') {
        const factor = state.alive ? Math.max(0.25, mapRatio) : 0.12;
        const intervalS = Math.max(0.065, 0.18 / Math.max(0.2, (wound.baseBleedMlPerSec / 14) * factor));
        while (timer >= intervalS) {
          timer -= intervalS;
          this.spawnVenousOozeDrip(origin, dir, 0.38 + 0.35 * factor);
        }
      }
      if (woundTimers) woundTimers.set(key, timer);
    }
  }

  public spawnArterialJetDroplet(originWorld: Vec3Like, sprayDirWorld: Vec3Like, jetSpeedMs: number): ActiveVascularParticle {
    this.enforceParticleCap();
    const dir = normalize(sprayDirWorld);
    const drop = new pc.Entity('ArterialJetDrop', this.app);
    if (this.app.systems?.render) {
      drop.addComponent('render', { type: 'sphere', material: this.vascularMaterials.arterialJetMat, castShadows: false });
    }
    const streakLen = Math.min(0.068, Math.max(0.028, jetSpeedMs * 0.009));
    drop.setLocalScale(0.013, 0.013, streakLen);
    drop.setPosition(originWorld.x, originWorld.y, originWorld.z);
    this.fxRoot.addChild(drop);

    const jitter = 0.22;
    const vx = dir.x * jetSpeedMs + (Math.random() - 0.5) * jitter * jetSpeedMs;
    const vy = dir.y * jetSpeedMs + 0.58 + (Math.random() - 0.5) * jitter * jetSpeedMs;
    const vz = dir.z * jetSpeedMs + (Math.random() - 0.5) * jitter * jetSpeedMs;
    if (Math.hypot(vx, vy, vz) > 1e-3) drop.lookAt(originWorld.x + vx, originWorld.y + vy, originWorld.z + vz);

    const p: ActiveVascularParticle = {
      entity: drop, vesselKind: 'ARTERIAL',
      position: new pc.Vec3(originWorld.x, originWorld.y, originWorld.z),
      velocity: new pc.Vec3(vx, vy, vz), ageS: 0, maxLifeS: 2.2,
    };
    this.particles.push(p);
    return p;
  }

  public spawnVenousOozeDrip(originWorld: Vec3Like, oozeDirWorld: Vec3Like, dripSpeedMs = 0.52): ActiveVascularParticle {
    this.enforceParticleCap();
    const dir = normalize(oozeDirWorld);
    const drip = new pc.Entity('VenousOozeDrip', this.app);
    if (this.app.systems?.render) {
      drip.addComponent('render', { type: 'sphere', material: this.vascularMaterials.venousOozeMat, castShadows: false });
    }
    drip.setLocalScale(0.018, 0.026, 0.018);
    drip.setPosition(originWorld.x, originWorld.y, originWorld.z);
    this.fxRoot.addChild(drip);

    const vx = dir.x * dripSpeedMs * 0.45 + (Math.random() - 0.5) * 0.14;
    const vy = -Math.abs(dripSpeedMs) * 0.65;
    const vz = dir.z * dripSpeedMs * 0.45 + (Math.random() - 0.5) * 0.14;

    const p: ActiveVascularParticle = {
      entity: drip, vesselKind: 'VENOUS',
      position: new pc.Vec3(originWorld.x, originWorld.y, originWorld.z),
      velocity: new pc.Vec3(vx, vy, vz), ageS: 0, maxLifeS: 2.6,
    };
    this.particles.push(p);
    return p;
  }

  private spawnArterialMistWisp(originWorld: Vec3Like, sprayDirWorld: Vec3Like, driftSpeedMs: number): void {
    if (!this.app.systems?.render || !this.mistMaterial) return;
    const dir = normalize(sprayDirWorld);
    const wisp = new pc.Entity('ArterialMistWisp', this.app);
    wisp.addComponent('render', { type: 'plane', material: this.mistMaterial, castShadows: false });
    wisp.setPosition(originWorld.x, originWorld.y, originWorld.z);
    wisp.setLocalEulerAngles(90, Math.random() * 360, (Math.random() - 0.5) * 45);
    const startScale = 0.065 + Math.random() * 0.035;
    wisp.setLocalScale(startScale, 1, startScale);
    this.fxRoot.addChild(wisp);

    this.mistPuffs.push({
      entity: wisp, position: new pc.Vec3(originWorld.x, originWorld.y, originWorld.z),
      velocity: new pc.Vec3(dir.x * driftSpeedMs + (Math.random() - 0.5) * 0.45, dir.y * driftSpeedMs + 0.18 + Math.random() * 0.25, dir.z * driftSpeedMs + (Math.random() - 0.5) * 0.45),
      ageS: 0, maxLifeS: 0.46 + Math.random() * 0.22, startScale, endScale: startScale * (2.6 + Math.random() * 0.8),
    });
  }

  private spawnOrGrowFloorPool(x: number, z: number, vesselKind: VesselKind): void {
    for (const pool of this.pools) {
      if (pool.vesselKind !== vesselKind) continue;
      const dx = pool.centerX - x, dz = pool.centerZ - z;
      if (dx * dx + dz * dz <= 0.18 * 0.18) {
        pool.targetRadiusM = Math.min(0.74, pool.targetRadiusM + 0.036);
        return;
      }
    }
    if (this.pools.length >= this.maxPools) {
      const oldest = this.pools.shift();
      if (oldest) oldest.entity.destroy();
    }
    const poolEnt = new pc.Entity(vesselKind === 'ARTERIAL' ? 'ArterialBloodPool' : 'VenousBloodPool', this.app);
    if (this.app.systems?.render) {
      poolEnt.addComponent('render', {
        type: 'cylinder',
        material: vesselKind === 'ARTERIAL' ? this.vascularMaterials.arterialPoolMat : this.vascularMaterials.venousPoolMat,
        castShadows: false, receiveShadows: true,
      });
    }
    const slotBias = (this.pools.length % 12) * 0.00012;
    const yHeight = (vesselKind === 'ARTERIAL' ? 0.0086 : 0.0074) + slotBias;
    poolEnt.setLocalScale(0.05, 0.0024, 0.05);
    poolEnt.setPosition(x, yHeight, z);
    poolEnt.setLocalEulerAngles(0, Math.random() * 360, 0);
    this.fxRoot.addChild(poolEnt);

    this.pools.push({
      entity: poolEnt, vesselKind, centerX: x, centerZ: z, currentRadiusM: 0.05,
      targetRadiusM: vesselKind === 'ARTERIAL' ? 0.3 : 0.38, growthRateMPerSec: vesselKind === 'ARTERIAL' ? 0.32 : 0.18,
    });
  }

  private enforceParticleCap(): void {
    if (this.particles.length >= this.maxParticles) {
      const oldest = this.particles.shift();
      if (oldest) oldest.entity.destroy();
    }
  }

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
      if (p.vesselKind === 'ARTERIAL') {
        const drag = Math.max(0.85, 1 - dt * 1.35);
        p.velocity.x *= drag; p.velocity.z *= drag;
      }
      p.position.x += p.velocity.x * dt;
      p.position.y += p.velocity.y * dt;
      p.position.z += p.velocity.z * dt;
      p.entity.setPosition(p.position.x, p.position.y, p.position.z);

      if (p.vesselKind === 'ARTERIAL') {
        const spd = p.velocity.length();
        if (spd > 0.15) {
          this.scratchLookAt.set(p.position.x + p.velocity.x, p.position.y + p.velocity.y, p.position.z + p.velocity.z);
          p.entity.lookAt(this.scratchLookAt);
          p.entity.setLocalScale(0.012, 0.012, Math.min(0.075, Math.max(0.022, spd * 0.0085)));
        }
      }
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

    for (let i = this.mistPuffs.length - 1; i >= 0; i--) {
      const m = this.mistPuffs[i];
      m.ageS += dt;
      if (m.ageS >= m.maxLifeS) {
        m.entity.destroy();
        this.mistPuffs.splice(i, 1);
        continue;
      }
      const t = m.ageS / m.maxLifeS;
      m.velocity.scale(Math.max(0.7, 1 - dt * 3.8));
      m.velocity.y -= 1.15 * dt;
      m.position.x += m.velocity.x * dt;
      m.position.y += m.velocity.y * dt;
      m.position.z += m.velocity.z * dt;
      m.entity.setPosition(m.position.x, m.position.y, m.position.z);
      const curS = m.startScale + (m.endScale - m.startScale) * (1 - (1 - t) * (1 - t));
      m.entity.setLocalScale(curS, 1, curS);
    }

    for (const pool of this.pools) {
      if (pool.currentRadiusM < pool.targetRadiusM) {
        pool.currentRadiusM = Math.min(pool.targetRadiusM, pool.currentRadiusM + pool.growthRateMPerSec * dt);
        pool.entity.setLocalScale(pool.currentRadiusM * 2, 0.0024, pool.currentRadiusM * 2);
      }
    }
  }

  public clearAll(): void {
    for (const p of this.particles) p.entity.destroy();
    for (const pool of this.pools) pool.entity.destroy();
    for (const m of this.mistPuffs) m.entity.destroy();
    this.particles.length = 0;
    this.pools.length = 0;
    this.mistPuffs.length = 0;
    for (const b of this.boundEntities.values()) b.woundTimers.clear();
  }

  public destroy(): void {
    this.clearAll();
    this.boundEntities.clear();
    this.fxRoot.destroy();
  }
}

export type { VascularWoundRecord };
