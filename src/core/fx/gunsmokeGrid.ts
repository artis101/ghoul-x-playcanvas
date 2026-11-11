import type { Vec3Like } from '../../contracts/ballistics.ts';

export interface GunsmokeCellPuff {
  slotIndex: number;
  active: boolean;
  posX: number;
  posY: number;
  posZ: number;
  velX: number;
  velY: number;
  velZ: number;
  radiusM: number;
  density: number;
  ageS: number;
  maxLifetimeS: number;
  rollRad: number;
  rollVelRad: number;
}

export interface GunsmokeGridOptions {
  maxPuffs?: number;
  mergeRadiusM?: number;
  ceilingHeightM?: number;
  floorHeightM?: number;
}

/**
 * Pure TypeScript 2.5D hallway cordite gunsmoke advection, thermal buoyancy,
 * and explosion blast-swirl simulation (12-22s linger).
 * Zero PlayCanvas / DOM imports.
 */
export class GunsmokeGrid {
  public readonly maxPuffs: number;
  public readonly mergeRadiusM: number;
  public readonly ceilingHeightM: number;
  public readonly floorHeightM: number;

  private readonly puffs: GunsmokeCellPuff[];
  private writeCursor = 0;
  private rngSeed = 0x51f15e1d;

  public constructor(options: GunsmokeGridOptions = {}) {
    this.maxPuffs = Math.max(16, Math.min(512, options.maxPuffs ?? 192));
    this.mergeRadiusM = options.mergeRadiusM ?? 0.85;
    this.ceilingHeightM = options.ceilingHeightM ?? 3.45;
    this.floorHeightM = options.floorHeightM ?? 0.22;

    this.puffs = new Array<GunsmokeCellPuff>(this.maxPuffs);
    for (let i = 0; i < this.maxPuffs; i++) {
      this.puffs[i] = {
        slotIndex: i,
        active: false,
        posX: 0,
        posY: 0,
        posZ: 0,
        velX: 0,
        velY: 0,
        velZ: 0,
        radiusM: 0.45,
        density: 0,
        ageS: 0,
        maxLifetimeS: 16.0,
        rollRad: 0,
        rollVelRad: 0,
      };
    }
  }

  public get activeCount(): number {
    let count = 0;
    for (let i = 0; i < this.maxPuffs; i++) {
      if (this.puffs[i].active) count++;
    }
    return count;
  }

  public getPuffs(): readonly GunsmokeCellPuff[] {
    return this.puffs;
  }

  public injectGunsmoke(
    originWorld: Vec3Like,
    dirWorld: Vec3Like,
    intensity = 1.0
  ): number {
    const clampedIntensity = Math.max(0.15, Math.min(4.0, intensity));
    const dirLen = Math.hypot(dirWorld.x, dirWorld.y, dirWorld.z);
    const dx = dirLen > 1e-5 ? dirWorld.x / dirLen : 0;
    const dy = dirLen > 1e-5 ? dirWorld.y / dirLen : 0;
    const dz = dirLen > 1e-5 ? dirWorld.z / dirLen : 1;

    const spawnX = originWorld.x + dx * 0.48 + (this.nextRandom() - 0.5) * 0.18;
    const spawnY = Math.max(
      this.floorHeightM + 0.15,
      Math.min(this.ceilingHeightM - 0.2, originWorld.y + dy * 0.35 + 0.06)
    );
    const spawnZ = originWorld.z + dz * 0.48 + (this.nextRandom() - 0.5) * 0.18;

    // Coalesce into an existing nearby gunsmoke cell if within mergeRadiusM
    const mergeSq = this.mergeRadiusM * this.mergeRadiusM;
    for (let i = 0; i < this.maxPuffs; i++) {
      const p = this.puffs[i];
      if (!p.active || p.ageS > p.maxLifetimeS * 0.72) continue;
      const rx = p.posX - spawnX;
      const ry = p.posY - spawnY;
      const rz = p.posZ - spawnZ;
      if (rx * rx + ry * ry + rz * rz <= mergeSq) {
        const addDensity = 0.28 * clampedIntensity;
        p.density = Math.min(1.6, p.density + addDensity);
        p.radiusM = Math.min(2.15, p.radiusM + 0.08 * clampedIntensity);
        p.velX = p.velX * 0.78 + dx * (0.45 * clampedIntensity);
        p.velY = Math.min(0.65, p.velY + 0.08 * clampedIntensity);
        p.velZ = p.velZ * 0.78 + dz * (0.45 * clampedIntensity);
        p.maxLifetimeS = Math.min(22.0, Math.max(p.maxLifetimeS, p.ageS + 14.0));
        return i;
      }
    }

    let slot = -1;
    for (let i = 0; i < this.maxPuffs; i++) {
      const idx = (this.writeCursor + i) % this.maxPuffs;
      if (!this.puffs[idx].active) {
        slot = idx;
        this.writeCursor = (idx + 1) % this.maxPuffs;
        break;
      }
    }
    if (slot < 0) {
      // Evict oldest puff
      let oldestIdx = 0;
      let oldestAge = -1;
      for (let i = 0; i < this.maxPuffs; i++) {
        if (this.puffs[i].ageS > oldestAge) {
          oldestAge = this.puffs[i].ageS;
          oldestIdx = i;
        }
      }
      slot = oldestIdx;
    }

    const puff = this.puffs[slot];
    puff.active = true;
    puff.posX = spawnX;
    puff.posY = spawnY;
    puff.posZ = spawnZ;
    const speed = (0.75 + this.nextRandom() * 0.65) * Math.min(1.8, clampedIntensity);
    puff.velX = dx * speed + (this.nextRandom() - 0.5) * 0.35;
    puff.velY = dy * speed * 0.35 + 0.18 + this.nextRandom() * 0.14;
    puff.velZ = dz * speed + (this.nextRandom() - 0.5) * 0.35;
    puff.radiusM = 0.42 + Math.min(0.55, clampedIntensity * 0.22);
    puff.density = Math.min(1.5, 0.42 + clampedIntensity * 0.32);
    puff.ageS = 0;
    puff.maxLifetimeS = 12.5 + this.nextRandom() * 9.0;
    puff.rollRad = this.nextRandom() * Math.PI * 2;
    puff.rollVelRad = (this.nextRandom() - 0.5) * 0.45;
    return slot;
  }

  public applyBlastSwirl(
    centerWorld: Vec3Like,
    radiusM: number,
    peakImpulseNs = 120
  ): number {
    const affectRadius = Math.max(2.5, radiusM * 1.65);
    const affectSq = affectRadius * affectRadius;
    const strength = Math.max(1.5, Math.min(14.0, peakImpulseNs / 32.0));
    let affected = 0;

    for (let i = 0; i < this.maxPuffs; i++) {
      const p = this.puffs[i];
      if (!p.active) continue;
      const rx = p.posX - centerWorld.x;
      const ry = p.posY - centerWorld.y;
      const rz = p.posZ - centerWorld.z;
      const distSq = rx * rx + ry * ry + rz * rz;
      if (distSq > affectSq) continue;

      const dist = Math.sqrt(distSq);
      const falloff = 1.0 - dist / affectRadius;
      const invDist = dist > 1e-4 ? 1.0 / dist : 0;
      const nx = dist > 1e-4 ? rx * invDist : 0;
      const ny = dist > 1e-4 ? ry * invDist : 1;
      const nz = dist > 1e-4 ? rz * invDist : 0;

      // Radial blast push + tangential vortex swirl
      const swirlX = -nz;
      const swirlZ = nx;
      const push = strength * falloff;
      p.velX += (nx * 0.78 + swirlX * 0.42) * push;
      p.velY += Math.max(0.25, ny * 0.55) * push * 0.5;
      p.velZ += (nz * 0.78 + swirlZ * 0.42) * push;
      p.rollVelRad += (falloff * 1.8) * (i % 2 === 0 ? 1 : -1);
      p.radiusM = Math.min(2.6, p.radiusM + falloff * 0.35);
      affected++;
    }
    return affected;
  }

  public step(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const stepDt = Math.min(0.1, dt);
    const drag = Math.exp(-1.55 * stepDt);

    for (let i = 0; i < this.maxPuffs; i++) {
      const p = this.puffs[i];
      if (!p.active) continue;

      p.ageS += stepDt;
      if (p.ageS >= p.maxLifetimeS) {
        p.active = false;
        p.density = 0;
        continue;
      }

      const lifeFrac = p.ageS / p.maxLifetimeS;
      // Thermal buoyancy fades as cordite cools and stratifies near hallway ceiling
      const buoyancy = Math.max(0.02, (1.0 - lifeFrac * 0.85) * 0.16);
      p.velY += buoyancy * stepDt;

      // Subtle turbulent hallway draft
      const phase = p.ageS * 0.85 + i * 0.73;
      p.velX += Math.sin(phase) * 0.08 * stepDt;
      p.velZ += Math.cos(phase * 0.91) * 0.08 * stepDt;

      p.velX *= drag;
      p.velY *= drag;
      p.velZ *= drag;

      p.posX += p.velX * stepDt;
      p.posY += p.velY * stepDt;
      p.posZ += p.velZ * stepDt;

      if (p.posY > this.ceilingHeightM) {
        p.posY = this.ceilingHeightM;
        if (p.velY > 0) {
          // Spread laterally along ceiling soffit
          p.velX += (this.nextRandom() - 0.5) * p.velY * 0.6;
          p.velZ += (this.nextRandom() - 0.5) * p.velY * 0.6;
          p.velY = 0;
        }
      } else if (p.posY < this.floorHeightM) {
        p.posY = this.floorHeightM;
        if (p.velY < 0) p.velY = 0;
      }

      p.radiusM = Math.min(2.65, p.radiusM + (0.095 * (1.0 - lifeFrac * 0.5)) * stepDt);
      p.rollRad += p.rollVelRad * stepDt;
      p.rollVelRad *= Math.exp(-0.9 * stepDt);
    }
  }

  public clear(): void {
    for (let i = 0; i < this.maxPuffs; i++) {
      this.puffs[i].active = false;
      this.puffs[i].density = 0;
      this.puffs[i].ageS = 0;
    }
    this.writeCursor = 0;
  }

  private nextRandom(): number {
    let x = this.rngSeed >>> 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngSeed = x >>> 0;
    return (this.rngSeed >>> 0) / 4294967296;
  }
}
