import * as pc from 'playcanvas';
import type { EngineMaterialPalette } from '../../materials.ts';
import { FxEntityPool } from '../particles/fxEntityPool.ts';
import type { WetGoreMaterialSuite } from './goreTypes.ts';

export const MAX_LIVE_BLOOD_DROPS = 512;
export const MAX_LIVE_SHARDS_AND_SPARKS = 320;
export const MAX_LIVE_PROJECTILES = 192;

export interface GoreFxPools {
  bloodDrop: FxEntityPool;
  mistPuff: FxEntityPool;
  bloodPool: FxEntityPool;
  hotSpark: FxEntityPool;
  armorChip: FxEntityPool;
  boneShardCone: FxEntityPool;
  boneShardBox: FxEntityPool;
  rifleRound: FxEntityPool;
  pellet: FxEntityPool;
}

const shockwaveRingByRound = new WeakMap<pc.Entity, pc.Entity>();

/** The toggled shockwave ring child of a pooled rifle round, or null for any other entity. */
export function getRifleRoundShockwaveRing(round: pc.Entity): pc.Entity | null {
  return shockwaveRingByRound.get(round) ?? null;
}

export function createGoreFxPools(
  fxRoot: pc.Entity,
  materials: EngineMaterialPalette,
  goreSuite: WetGoreMaterialSuite,
): GoreFxPools {
  return {
    bloodDrop: new FxEntityPool(fxRoot, 'BloodDrop', (e) => {
      e.addComponent('render', { type: 'sphere', material: goreSuite.wetBloodDropMat, castShadows: false });
    }),
    mistPuff: new FxEntityPool(fxRoot, 'ArterialMistPuff', (e) => {
      e.addComponent('render', {
        type: 'plane',
        material: goreSuite.wetBloodMistBaseMat,
        castShadows: false,
        receiveShadows: false,
      });
    }),
    bloodPool: new FxEntityPool(fxRoot, 'BloodPoolDecal', (e) => {
      if (goreSuite.floorQuadMesh) {
        const mi = new pc.MeshInstance(goreSuite.floorQuadMesh, goreSuite.wetBloodPoolMat);
        e.addComponent('render', { meshInstances: [mi], castShadows: false, receiveShadows: true });
      } else {
        e.addComponent('render', {
          type: 'cylinder',
          material: goreSuite.wetBloodPoolMat,
          castShadows: false,
          receiveShadows: true,
        });
      }
    }),
    hotSpark: new FxEntityPool(fxRoot, 'ArmorSpark', (e) => {
      e.addComponent('render', { type: 'sphere', material: goreSuite.incandescentSparkMat, castShadows: false });
    }),
    armorChip: new FxEntityPool(fxRoot, 'ArmorSpark', (e) => {
      e.addComponent('render', { type: 'box', material: materials.sandbagMat, castShadows: false });
    }),
    boneShardCone: new FxEntityPool(fxRoot, 'BoneShard', (e) => {
      e.addComponent('render', { type: 'cone', material: goreSuite.wetCorticalBoneMat });
    }),
    boneShardBox: new FxEntityPool(fxRoot, 'BoneShard', (e) => {
      e.addComponent('render', { type: 'box', material: goreSuite.wetCorticalBoneMat });
    }),
    rifleRound: new FxEntityPool(fxRoot, 'RifleProjectile', (e) => {
      e.addComponent('render', { type: 'capsule', material: materials.brassBulletMat });
      const tracerTail = new pc.Entity('ProjectileTracerStreak');
      tracerTail.addComponent('render', { type: 'cone', material: goreSuite.tracerTailMat, castShadows: false });
      tracerTail.setLocalPosition(0, -1.8, 0);
      tracerTail.setLocalEulerAngles(180, 0, 0);
      tracerTail.setLocalScale(0.85, 3.6, 0.85);
      e.addChild(tracerTail);
      const ring = new pc.Entity('MachShockwaveRing');
      ring.addComponent('render', { type: 'cone', material: materials.shockwaveRingMat, castShadows: false });
      ring.setLocalScale(4.8, 1.4, 4.8);
      ring.enabled = false;
      e.addChild(ring);
      shockwaveRingByRound.set(e, ring);
    }),
    pellet: new FxEntityPool(fxRoot, 'PelletProjectile', (e) => {
      e.addComponent('render', { type: 'sphere', material: materials.copperPelletMat });
    }),
  };
}

export function releaseAllGoreFxPools(pools: GoreFxPools): void {
  for (const pool of Object.values(pools)) pool.releaseAll();
}

export function destroyGoreFxPools(pools: GoreFxPools): void {
  for (const pool of Object.values(pools)) pool.destroy();
}
