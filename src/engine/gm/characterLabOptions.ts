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

/** Clips that show a hurt body, so the held gun is posed as a wounded combatant holds it. */
const WOUNDED_CLIP = new RegExp(
  '^(HitStagger|HitFlinch|Hurt|Crawl|LegShotFall|LegLoss|OneLegHop|ArmLoss|StumpClutch|StumpDraw|KneelStumpDraw|' +
    'StumpKneel|DownedCollapse|SitToCrawl)',
);

export function isWoundedClip(clip: string): boolean {
  return WOUNDED_CLIP.test(clip);
}

export function clipLabel(clip: string): string {
  return clip.replace('UnsuspectingIdle', 'GuardIdle')
    .replace('_Southpaw', ' (left hand)').replace(/([a-z])([A-Z])/g, '$1 $2');
}

export function setClipOptions(select: HTMLSelectElement, clips: Iterable<string>, empty: string): void {
  const previous = select.value;
  const options = Array.from(clips, (clip) => new Option(clipLabel(clip), clip));
  select.replaceChildren(...(options.length ? options : [new Option(empty, '')]));
  if (options.some((option) => option.value === previous)) select.value = previous;
  select.disabled = !options.length;
}
