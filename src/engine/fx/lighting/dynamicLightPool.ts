import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';

export interface PooledDynamicOmniLight {
  entity: pc.Entity;
  active: boolean;
  elapsedS: number;
  durationS: number;
  peakIntensity: number;
  isExplosion: boolean;
}

export function createDynamicLightPool(
  app: pc.Application,
  rootEntity: pc.Entity,
  size: number,
): PooledDynamicOmniLight[] {
  const pool: PooledDynamicOmniLight[] = [];
  const lightPoolCount = Math.max(2, size);
  for (let i = 0; i < lightPoolCount; i++) {
    const lightEnt = new pc.Entity(`MayhemDynamicOmniLight_${i}`);
    lightEnt.addComponent('light', {
      type: 'omni',
      color: new pc.Color(1.0, 0.72, 0.3),
      intensity: 0,
      range: 0.05,
      castShadows: false,
    });
    lightEnt.setPosition(0, -500, 0);
    lightEnt.enabled = true;
    rootEntity.addChild(lightEnt);
    pool.push({
      entity: lightEnt,
      active: false,
      elapsedS: 0,
      durationS: 0.052,
      peakIntensity: 3.8,
      isExplosion: false,
    });
  }
  return pool;
}

export function activateDynamicOmniLight(
  pool: PooledDynamicOmniLight[],
  pos: Vec3Like,
  r: number,
  g: number,
  b: number,
  intensity: number,
  rangeM: number,
  durationS: number,
  isExplosion: boolean,
): void {
  if (pool.length === 0) return;

  let chosen = pool.find((slot) => !slot.active);
  if (!chosen) {
    chosen = pool[0];
    let bestProgress = -1;
    for (const slot of pool) {
      const prog = slot.elapsedS / Math.max(1e-4, slot.durationS);
      if (prog > bestProgress) {
        bestProgress = prog;
        chosen = slot;
      }
    }
  }

  chosen.active = true;
  chosen.elapsedS = 0;
  chosen.durationS = Math.max(0.015, durationS);
  chosen.peakIntensity = intensity;
  chosen.isExplosion = isExplosion;

  chosen.entity.setPosition(pos.x, pos.y, pos.z);
  if (chosen.entity.light) {
    chosen.entity.light.color.set(r, g, b);
    chosen.entity.light.intensity = intensity;
    chosen.entity.light.range = rangeM;
  }
  chosen.entity.enabled = true;
}

export function stepDynamicLights(pool: PooledDynamicOmniLight[], dt: number): void {
  for (const slot of pool) {
    if (!slot.active) continue;
    slot.elapsedS += dt;
    if (slot.elapsedS >= slot.durationS) {
      slot.active = false;
      slot.entity.setPosition(0, -500, 0);
      if (slot.entity.light) {
        slot.entity.light.intensity = 0;
        slot.entity.light.range = 0.05;
      }
      continue;
    }

    const t = slot.elapsedS / slot.durationS;
    const rem = 1 - t;
    if (slot.entity.light) {
      slot.entity.light.intensity = slot.peakIntensity * rem * rem;
      if (slot.isExplosion) {
        const cool = Math.min(1, t * 3.2);
        slot.entity.light.color.set(
          1.0,
          0.92 * (1 - cool) + 0.44 * cool,
          0.68 * (1 - cool) + 0.1 * cool,
        );
      }
    }
  }
}

export function resetDynamicLights(pool: PooledDynamicOmniLight[]): void {
  for (const light of pool) {
    light.active = false;
    light.entity.setPosition(0, -500, 0);
    if (light.entity.light) {
      light.entity.light.intensity = 0;
      light.entity.light.range = 0.05;
    }
  }
}
