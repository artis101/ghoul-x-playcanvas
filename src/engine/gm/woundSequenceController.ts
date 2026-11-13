import * as pc from 'playcanvas';
import type { EnemyArchetypeId } from '../../contracts/ballistics.ts';
import type { GlbModelRegistry } from '../assets/glbLoader.ts';
import type { createCharacterLabView } from './characterLabView.ts';
import { WoundSequencePreview } from './woundSequencePreview.ts';
import { findWoundSequence, WOUND_SEQUENCES, type SequencePreset, type WoundSequenceDef } from './woundSequences.ts';
import { standInPosition, type FortitudeChoice, type PlayerStandIn } from './woundedLabStandIn.ts';

type CharacterLabView = ReturnType<typeof createCharacterLabView>;

/**
 * The "Wound sequences" panel: one button per scripted sequence, the sidearm, southpaw,
 * fortitude and player stand-in controls, Replay, and the live readout. Each run spawns a fresh
 * combatant so nothing from the last run (lost limbs, a dropped gun, a ragdoll on the floor)
 * leaks into the next. The stand-in can be moved mid-run, to step in front of a downed body.
 */
export class WoundSequenceController {
  public current: WoundSequencePreview | null = null;
  private last: WoundSequenceDef | null = null;
  /** A post where the player stand-in is, so the cone and the crawl-away read against it. */
  private readonly marker: pc.Entity;

  public constructor(
    private readonly app: pc.AppBase,
    private readonly registry: GlbModelRegistry,
    private readonly view: CharacterLabView,
    private readonly archetype: () => EnemyArchetypeId,
    /** Called before a run starts, so the lab can clear its other previews and start playback. */
    private readonly onStart: () => void,
    signal: AbortSignal,
  ) {
    view.sequenceButtons.replaceChildren(...WOUND_SEQUENCES.map((def) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = def.label;
      button.dataset.sequence = def.id;
      button.setAttribute('aria-pressed', 'false');
      return button;
    }));
    view.sequenceButtons.addEventListener('click', (event) => {
      const id = (event.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.sequence;
      const def = id ? findWoundSequence(id) : undefined;
      if (def) this.run(def);
    }, { signal });
    view.sequenceReplay.addEventListener('click', () => this.replay(), { signal });
    view.sequenceFortitude.addEventListener('change', () => this.current?.setFortitude(this.fortitude), { signal });
    view.sequenceStandIn.addEventListener('change', () => this.placeMarker(), { signal });
    this.marker = new pc.Entity('Player stand-in');
    this.marker.addComponent('render', { type: 'cylinder', castShadows: false });
    this.marker.setLocalScale(0.12, 1.7, 0.12);
    this.marker.enabled = false;
    app.root.addChild(this.marker);
  }

  private get fortitude(): FortitudeChoice {
    return this.view.sequenceFortitude.value as FortitudeChoice;
  }

  private get standIn(): PlayerStandIn {
    return this.view.sequenceStandIn.value as PlayerStandIn;
  }

  /** Sets the panel to what a branch sequence needs; the controls stay editable for Replay. */
  private applyPreset(preset: SequencePreset | undefined): void {
    if (!preset) return;
    if (preset.fortitude) this.view.sequenceFortitude.value = preset.fortitude;
    if (preset.standIn) this.view.sequenceStandIn.value = preset.standIn;
    if (preset.sidearm !== undefined) this.view.sequenceSidearm.checked = preset.sidearm;
  }

  private placeMarker(): void {
    const p = standInPosition(this.standIn);
    this.marker.setPosition(p.x, 0.85, p.z);
  }

  /** Starts a sequence, setting the panel to its preset first. */
  public run(def: WoundSequenceDef): void {
    this.applyPreset(def.preset);
    this.start(def);
  }

  private start(def: WoundSequenceDef): void {
    this.onStart();
    this.stop();
    this.last = def;
    this.current = new WoundSequencePreview(this.app, this.registry, def, {
      archetype: this.archetype(),
      backupSidearm: this.view.sequenceSidearm.checked,
      southpaw: this.view.sequenceSouthpaw.checked,
      fortitude: this.fortitude,
      player: () => standInPosition(this.standIn),
    });
    this.placeMarker();
    this.marker.enabled = true;
    this.view.sequenceReplay.disabled = false;
    this.markPressed(def.id);
  }

  /** Runs the last sequence again, with the switches as they are now. */
  public replay(): void {
    if (this.last) this.start(this.last);
  }

  public stop(): void {
    this.current?.destroy();
    this.current = null;
    this.marker.enabled = false;
    this.view.sequenceReadout.value = '';
    this.markPressed(null);
  }

  public update(dt: number): void {
    if (!this.current) return;
    this.current.update(dt);
    this.view.sequenceReadout.value = this.current.statusLine;
  }

  private markPressed(id: string | null): void {
    for (const button of this.view.sequenceButtons.querySelectorAll<HTMLButtonElement>('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.sequence === id));
    }
  }
}
