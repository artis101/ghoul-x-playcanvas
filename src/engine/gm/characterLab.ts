import * as pc from 'playcanvas';
import type { EnemyArchetypeId } from '../../contracts/ballistics.ts';
import { createTargetHealthState } from '../../core/ghoul/anatomy.ts';
import { GlbModelRegistry, WEAPON_ASSET_IDS, type WeaponAssetId } from '../assets/glbLoader.ts';
import { getOrCreateMaterials } from '../materials.ts';
import { CombatantDismemberment } from '../mannequin/combatantDismemberment.ts';
import { setupCombatantGlbInstance } from '../mannequin/combatantGlbSetup.ts';
import { CombatantWeaponMount } from '../mannequin/combatantWeaponMount.ts';
import { createCharacterLabView } from './characterLabView.ts';
import { createPreviewStage } from './previewStage.ts';
import { PreviewTimeline } from './previewTimeline.ts';

const characters: Record<EnemyArchetypeId, string> = {
  MILITIA_GUNNER: 'Militia Gunner',
  SKINHEAD_PUNK: 'Skinhead Punk',
  HEAVY_ENFORCER: 'Heavy Enforcer',
  SNIPER_OPERATIVE: 'Sniper Operative',
};

const items: Record<WeaponAssetId, string> = {
  m4a1_carbine: 'M4A1 Carbine',
  m590_shotgun: 'M590 Shotgun',
  msg90_sniper: 'MSG90 Sniper',
  silver_talon_50ae: 'Silver Talon .50 AE',
  frag_grenade: 'Frag Grenade',
};

function clipLabel(clip: string): string {
  return clip.replace('_Southpaw', ' (left hand)').replace(/([a-z])([A-Z])/g, '$1 $2');
}

function setClipOptions(select: HTMLSelectElement, clips: Iterable<string>, empty: string): void {
  const previous = select.value;
  const options = Array.from(clips, (clip) => new Option(clipLabel(clip), clip));
  select.replaceChildren(...(options.length ? options : [new Option(empty, '')]));
  if (options.some((option) => option.value === previous)) select.value = previous;
  select.disabled = !options.length;
}

export async function openCharacterLab(): Promise<void> {
  const root = document.getElementById('app-root');
  if (!root) throw new Error('Character Lab root missing');
  document.title = 'Character Lab · GHOUL-X';
  const view = createCharacterLabView(root);
  const app = new pc.Application(view.canvas, { graphicsDeviceOptions: { antialias: true } });
  const registry = new GlbModelRegistry(app);
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  const mount = new CombatantWeaponMount();
  let cleanupStage: (() => void) | undefined;

  function cleanup(): void {
    listeners.abort();
    cleanupStage?.();
    mount.destroy();
    registry.destroy();
    app.destroy();
  }

  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) cleanup();
  }, options);

  try {
    await Promise.all(['ghoul_combatant' as const, ...WEAPON_ASSET_IDS].map((id) => registry.loadContainer(id)));
    cleanupStage = createPreviewStage(app, view.canvas);
    const characterTimeline = new PreviewTimeline(view.characterTime, view.characterReadout);
    const itemTimeline = new PreviewTimeline(view.itemTime, view.itemReadout);
    const dismemberment = new CombatantDismemberment();
    const materials = getOrCreateMaterials();
    let health = newHealth('MILITIA_GUNNER');
    let character = createCharacter();
    let playing = true;
    let speed = 1;

    function newHealth(archetype: EnemyArchetypeId) {
      return createTargetHealthState('gm-preview', characters[archetype], { x: 0, y: 0, z: 0 }, 0, archetype);
    }

    function createCharacter() {
      const model = setupCombatantGlbInstance(registry, health, materials, new Map(), new Map());
      if (!model) throw new Error('Unable to instantiate the combatant');
      app.root.addChild(model.rootEntity);
      return model;
    }

    function syncGear(): void {
      dismemberment.syncGearVisibility(character, health, false, view.headgear.checked);
      if (character.esapiPlateCarrier && !view.armor.checked) character.esapiPlateCarrier.enabled = false;
    }

    function syncGrip(): void {
      mount.syncWeaponPosition(health, character, undefined, view.characterClip.value.startsWith('UnsuspectingIdle'));
    }

    function selectCharacterClip(): void {
      const clip = view.characterClip.value;
      health.isLeftHanded = clip.endsWith('_Southpaw');
      health.posture = clip.includes('Idle') ? 'COMBAT_READY' : 'STAGGERED';
      characterTimeline.select(character.animComponent, clip);
      syncGrip();
    }

    function selectItem(): void {
      itemTimeline.select(null, '');
      mount.destroy();
      if (view.item.value) mount.attachGlbWeaponIfReady(registry, health, app.root, view.item.value as WeaponAssetId);
      const weapon = mount.heldWeaponGlb;
      setClipOptions(view.itemClip, weapon?.availableClips ?? [], weapon ? 'No clips' : 'Unarmed');
      itemTimeline.select(weapon?.animComponent ?? null, view.itemClip.value);
      syncGrip();
    }

    function setPlaying(value: boolean): void {
      playing = value;
      view.play.textContent = value ? 'Pause' : 'Play';
    }

    view.model.replaceChildren(...Object.entries(characters).map(([id, label]) => new Option(label, id)));
    view.item.replaceChildren(new Option('Unarmed', ''), ...WEAPON_ASSET_IDS.map((id) => new Option(items[id], id)));
    view.item.value = 'm4a1_carbine';
    setClipOptions(view.characterClip, character.availableClips, 'No clips');
    selectCharacterClip();
    selectItem();
    syncGear();

    view.model.addEventListener('change', () => {
      characterTimeline.select(null, '');
      character.destroy();
      health = newHealth(view.model.value as EnemyArchetypeId);
      character = createCharacter();
      setClipOptions(view.characterClip, character.availableClips, 'No clips');
      selectCharacterClip();
      syncGear();
    }, options);
    view.headgear.addEventListener('change', syncGear, options);
    view.armor.addEventListener('change', syncGear, options);
    view.characterClip.addEventListener('change', selectCharacterClip, options);
    view.item.addEventListener('change', selectItem, options);
    view.itemClip.addEventListener('change', () => {
      itemTimeline.select(mount.heldWeaponGlb?.animComponent ?? null, view.itemClip.value);
    }, options);
    view.speed.addEventListener('change', () => { speed = Number(view.speed.value); }, options);

    function bindScrubber(input: HTMLInputElement, timeline: PreviewTimeline): void {
      input.addEventListener('input', () => {
        setPlaying(false);
        timeline.seek(input.valueAsNumber);
        if (timeline === characterTimeline) syncGrip();
      }, options);
    }

    function rewind(): void {
      characterTimeline.seek(0);
      itemTimeline.seek(0);
      syncGrip();
    }

    bindScrubber(view.characterTime, characterTimeline);
    bindScrubber(view.itemTime, itemTimeline);
    view.play.addEventListener('click', () => {
      if (!playing && !characterTimeline.canAdvance && !itemTimeline.canAdvance) rewind();
      setPlaying(!playing);
    }, options);
    view.restart.addEventListener('click', rewind, options);
    app.on('update', (dt: number) => {
      if (!playing) return;
      const elapsed = dt * speed;
      const loop = view.loop.checked;
      if (characterTimeline.advance(elapsed, loop)) syncGrip();
      itemTimeline.advance(elapsed, loop);
      if (!loop && !characterTimeline.canAdvance && !itemTimeline.canAdvance) setPlaying(false);
    });

    app.start();
    view.status.hidden = true;
    view.controls.disabled = false;
  } catch (error) {
    cleanup();
    view.status.textContent = 'Could not load the preview. Reload the page to try again.';
    console.error('Character Lab preview failed:', error);
  }
}
