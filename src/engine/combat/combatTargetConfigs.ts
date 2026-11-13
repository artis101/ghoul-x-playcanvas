import type { AmmoSpec, EnemyArchetypeId } from '../../contracts/ballistics.ts';

export interface RangeTargetConfig {
  id: string;
  name: string;
  archetype: EnemyArchetypeId;
  position: { x: number; y: number; z: number };
  yawDeg: number;
}

export const TARGET_CONFIGS: RangeTargetConfig[] = [
  {
    id: 'target_0',
    name: 'NYC SKINHEAD PUNK (5m CQB)',
    archetype: 'SKINHEAD_PUNK',
    position: { x: 0.9, y: 0, z: -5.2 },
    yawDeg: 0,
  },
  {
    id: 'target_1',
    name: 'SHOOT-HOUSE BREACHER (8m WOOD)',
    archetype: 'MILITIA_GUNNER',
    position: { x: -2.3, y: 0, z: -8.35 },
    yawDeg: 6,
  },
  {
    id: 'target_2',
    name: 'WEST GALLERY SENTRY (8m GLASS)',
    archetype: 'SKINHEAD_PUNK',
    position: { x: -5.5, y: 0, z: -7.9 },
    yawDeg: 14,
  },
  {
    id: 'target_3',
    name: 'EAST GALLERY GUNNER (8m VORONOI)',
    archetype: 'MILITIA_GUNNER',
    position: { x: 5.5, y: 0, z: -8.1 },
    yawDeg: -14,
  },
  {
    id: 'target_4',
    name: 'MASONRY BUNKER BRUISER (14m BRICK)',
    archetype: 'MASKED_BRUISER',
    position: { x: -3.8, y: 0, z: -13.75 },
    yawDeg: 10,
  },
  {
    id: 'target_5',
    name: 'KOSOVO HEAVY ENFORCER (15m CONCRETE)',
    archetype: 'HEAVY_ENFORCER',
    position: { x: 2.3, y: 0, z: -14.85 },
    yawDeg: -8,
  },
  {
    id: 'target_6',
    name: 'SPETSNAZ SNIPER (42m OVERWATCH)',
    archetype: 'SNIPER_OPERATIVE',
    position: { x: 0.4, y: 0, z: -42.0 },
    yawDeg: 0,
  },
];

export const SYNTHETIC_SHRAPNEL_AMMO: AmmoSpec = {
  id: 'comp_b_shrapnel',
  name: 'HE Steel Shrapnel',
  caliber: '6mm Fragment',
  type: 'FMJ',
  massKg: 0.0042,
  diameterM: 0.0062,
  muzzleVelocityMs: 560,
  dragCoefficient: 0.42,
  tissueExpansionFactor: 1.2,
  armorPenetrationFactor: 1.15,
  pelletCount: 1,
  spreadRadians: 0,
  ragdollImpulseMultiplier: 1.25,
  goreFactor: 1.35,
};
