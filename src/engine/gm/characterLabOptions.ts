import type { EnemyArchetypeId } from '../../contracts/ballistics.ts';
import type { WeaponAssetId } from '../assets/glbLoader.ts';

/** Display names for the lab's model and held-item pickers. */
export const characters: Record<EnemyArchetypeId, string> = {
  MILITIA_GUNNER: 'Militia Gunner (the Muscle)',
  MASKED_BRUISER: 'Masked Bruiser (Bear)',
  SKINHEAD_PUNK: 'Skinhead Punk',
  HEAVY_ENFORCER: 'Heavy Enforcer',
  SNIPER_OPERATIVE: 'Sniper Operative',
};

export const items: Record<WeaponAssetId, string> = {
  m4a1_carbine: 'M4A1 Carbine',
  m590_shotgun: 'M590 Shotgun',
  msg90_sniper: 'MSG90 Sniper',
  silver_talon_50ae: 'Silver Talon .50 AE',
  frag_grenade: 'Frag Grenade',
};
