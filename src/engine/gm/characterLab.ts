import * as pc from 'playcanvas';
import type { EnemyArchetypeId } from '../../contracts/ballistics.ts';
import {
  getArchetypeWeaponAssetId, GlbModelRegistry, WEAPON_ASSET_IDS, type WeaponAssetId,
} from '../assets/glbLoader.ts';
import { WoundPreview, type LostLimb } from './woundPreview.ts';
import { characters, items } from './characterLabOptions.ts';
import { createCharacterLabView } from './characterLabView.ts';
import {
  canRaiseGun, isPistol, MOTION_LABELS, motionsFor, normalizeState, STANCE_LABELS, stancesFor, type BodyState,
} from './labBodyStates.ts';
import { LabStandingBody } from './labStandingBody.ts';
import { createPreviewStage } from './previewStage.ts';
import { WoundSequenceController } from './woundSequenceController.ts';

type LabView = ReturnType<typeof createCharacterLabView>;

function stateButtons<T extends string>(
  host: HTMLElement, values: readonly T[], labels: Record<T, string>, current: T,
): void {
  host.replaceChildren(...values.map((value) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = labels[value];
    button.dataset.value = value;
    button.setAttribute('aria-pressed', String(value === current));
    return button;
  }));
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
  let cleanupStage: (() => void) | undefined;
  let body: LabStandingBody | null = null;

  function cleanup(): void {
    listeners.abort();
    cleanupStage?.();
    body?.destroy();
    registry.destroy();
    app.destroy();
  }

  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) cleanup();
  }, options);

  try {
    await Promise.all(['ghoul_combatant' as const, ...WEAPON_ASSET_IDS].map((id) => registry.loadContainer(id)));
    let downed: WoundPreview | null = null;
    cleanupStage = createPreviewStage(app, view.canvas, undefined, () => downed?.focus ?? sequences.current?.focus ?? null);
    let state: BodyState = { stance: 'READY', motion: 'STAND', aim: false };
    let weapon: WeaponAssetId | null = null;
    let playing = true;
    const camera = app.root.findByName('Preview Camera');
    const archetype = () => view.model.value as EnemyArchetypeId;
    const sequences = new WoundSequenceController(app, registry, view, archetype, () => {
      // A sequence brings its own combatant, so the standing body and the wound preview step aside.
      downed?.destroy();
      downed = null;
      view.woundReadout.value = '';
      if (body) body.enabled = false;
      setPlaying(true);
    }, listeners.signal);

    /** Applies the picked weapon, handedness and state to the body, then redraws the buttons. */
    function refresh(): void {
      if (!body) return;
      state = normalizeState(state, weapon, body.availableClips);
      body.southpaw = view.southpaw.checked;
      body.supportArmDead = view.supportDead.checked && isPistol(weapon);
      body.setState(state);
      body.setGear(view.headgear.checked, view.armor.checked);
      view.supportRow.hidden = !isPistol(weapon);
      stateButtons(view.stances, stancesFor(weapon), STANCE_LABELS, state.stance);
      stateButtons(view.motions, motionsFor(state.stance, body.availableClips), MOTION_LABELS, state.motion);
      view.aim.disabled = !canRaiseGun(weapon, state.stance);
      view.aim.setAttribute('aria-pressed', String(state.aim));
    }

    function createBody(): void {
      body?.destroy();
      body = new LabStandingBody(app, registry, archetype());
      body.setWeapon(weapon);
      refresh();
    }

    function selectWeapon(next: WeaponAssetId | null): void {
      if (weapon === null && next !== null && state.stance === 'UNARMED') state = { ...state, stance: 'READY' };
      weapon = next;
      body?.setWeapon(next);
      refresh();
    }

    function selectWounds(): void {
      sequences.stop();
      downed?.destroy();
      downed = null;
      const checked = new Set(Array.from(
        view.wounds.querySelectorAll<HTMLInputElement>('input:checked'), (input) => input.dataset.wound,
      ));
      const lostLimbs = (['ARM_RIGHT', 'ARM_LEFT', 'LEG_RIGHT', 'LEG_LEFT'] as const)
        .filter((limb: LostLimb) => checked.has(limb));
      const wounded = checked.has('downed') || lostLimbs.length > 0;
      if (body) body.enabled = !wounded;
      view.woundReadout.value = '';
      if (!wounded) return;
      downed = new WoundPreview(app, registry, archetype(), {
        downed: checked.has('downed'), lostLimbs, backupSidearm: checked.has('sidearm'), bleeding: checked.has('bleeding'),
      }, camera);
      setPlaying(true);
    }

    function setPlaying(value: boolean): void {
      playing = value;
      view.play.textContent = value ? 'Pause' : 'Play';
    }

    view.model.replaceChildren(...Object.entries(characters).map(([id, label]) => new Option(label, id)));
    view.item.replaceChildren(new Option('None (unarmed)', ''), ...WEAPON_ASSET_IDS.map((id) => new Option(items[id], id)));
    weapon = getArchetypeWeaponAssetId(archetype());
    view.item.value = weapon;
    createBody();

    view.model.addEventListener('change', () => {
      sequences.stop();
      // Each character starts with the gun the game gives it.
      weapon = getArchetypeWeaponAssetId(archetype());
      view.item.value = weapon;
      createBody();
      selectWounds();
    }, options);
    view.item.addEventListener('change', () => selectWeapon((view.item.value || null) as WeaponAssetId | null), options);
    for (const input of [view.southpaw, view.supportDead, view.headgear, view.armor]) {
      input.addEventListener('change', refresh, options);
    }
    view.stances.addEventListener('click', (event) => {
      const value = (event.target as HTMLElement).closest('button')?.dataset.value;
      if (value) state = { ...state, stance: value as BodyState['stance'] };
      refresh();
    }, options);
    view.motions.addEventListener('click', (event) => {
      const value = (event.target as HTMLElement).closest('button')?.dataset.value;
      if (value) state = { ...state, motion: value as BodyState['motion'] };
      refresh();
    }, options);
    view.aim.addEventListener('click', () => {
      state = { ...state, aim: !state.aim };
      refresh();
    }, options);
    view.wounds.addEventListener('change', selectWounds, options);
    view.speed.addEventListener('change', () => { app.timeScale = Number(view.speed.value); }, options);
    view.play.addEventListener('click', () => setPlaying(!playing), options);
    view.restart.addEventListener('click', () => {
      if (downed) selectWounds();
      else if (sequences.current) sequences.replay();
      else createBody();
    }, options);

    app.on('update', (dt: number) => {
      if (sequences.current) {
        if (playing) sequences.update(dt);
        return;
      }
      if (downed) {
        if (!playing) return;
        downed.consciousness = view.consciousness.valueAsNumber;
        downed.update(dt);
        view.woundReadout.value = downed.statusLine;
        return;
      }
      body?.update(dt, !playing);
      updateReadout(view, body);
    });

    // Console handles for inspecting the wounded combatant's live health state.
    Object.assign(window, {
      gmLab: { get wound() { return downed; }, get sequence() { return sequences.current; }, get body() { return body; } },
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

function updateReadout(view: LabView, body: LabStandingBody | null): void {
  const text = body ? `Plays: ${body.activeClip}` : '';
  if (view.clipReadout.value !== text) view.clipReadout.value = text;
}
