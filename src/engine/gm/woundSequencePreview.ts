import type * as pc from 'playcanvas';
import type { EnemyArchetypeId, TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import { createTargetHealthState } from '../../core/ghoul/anatomy.ts';
import type { GlbModelRegistry } from '../assets/glbLoader.ts';
import { LiveCombatant } from './liveCombatant.ts';
import { fortitudeOverride, standInPosition, type FortitudeChoice, type PlayerStandIn } from './woundedLabStandIn.ts';
import { applySequenceHit, STAND_READY_S, type WoundSequenceDef } from './woundSequences.ts';

export interface WoundSequenceOptions {
  readonly archetype: EnemyArchetypeId;
  readonly backupSidearm: boolean;
  readonly southpaw: boolean;
  readonly fortitude: FortitudeChoice;
  /**
   * The player stand-in, read every frame: where a drawn sidearm aims and what the downed fire
   * cone and the crawl-away measure. A fixed point, so an orbiting camera does not swing the
   * gun around and every replay aims the same way.
   */
  readonly player: () => Vec3Like;
}

/**
 * Plays one scripted wound sequence on a fresh live combatant: it stands ready with its rifle,
 * then each hit lands at its time through the core wound path, and the lifecycle, clips,
 * ragdoll and armament take it from there exactly as in the game.
 */
export class WoundSequencePreview {
  public readonly health: TargetHealthState;
  private readonly body: LiveCombatant;
  private nextStep = 0;
  /** What has landed so far, newest last, for the status line and the console. */
  public readonly log: string[] = [];
  /** Where a STAND_IN step moved the player; null keeps the panel's choice. */
  public standInOverride: PlayerStandIn | null = null;

  public constructor(
    app: pc.AppBase,
    registry: GlbModelRegistry,
    public readonly def: WoundSequenceDef,
    public readonly options: WoundSequenceOptions,
  ) {
    this.health = createTargetHealthState(
      'gm-sequence', def.label, { x: 0, y: 0, z: 0 }, 0, options.archetype, options.southpaw,
    );
    this.setFortitude(options.fortitude);
    this.body = new LiveCombatant(app, registry, this.health, options.backupSidearm, () => this.player());
  }

  /** The stand-in's eye: where a STAND_IN step moved it, else where the panel puts it. */
  public player(): Vec3Like {
    return this.standInOverride ? standInPosition(this.standInOverride) : this.options.player();
  }

  /** Overrides the rolled fortitude; AUTO clears it so the next step rolls it from the resolve profile. */
  public setFortitude(choice: FortitudeChoice): void {
    this.health.fortitude = fortitudeOverride(choice);
  }

  public get focus(): Vec3Like {
    return this.body.focus;
  }

  /** Seconds since the first hit was due; negative while the combatant is still standing ready. */
  public get sequenceTimeS(): number {
    return this.body.clockS - STAND_READY_S;
  }

  public get activeClip(): string {
    return this.body.activeClip;
  }

  public get wouldFire(): boolean {
    return this.body.wouldFire;
  }

  public get finished(): boolean {
    return this.nextStep >= this.def.steps.length;
  }

  public get statusLine(): string {
    const hs = this.health;
    const r = hs.activeReaction;
    const reaction = r.type === 'NONE' ? 'no reaction' : `${r.type} ${r.timerS.toFixed(2)}/${r.durationS.toFixed(2)} s`;
    const dying = hs.dying && !hs.isRagdollActive
      ? `DYING ${hs.dying.clip} ${hs.dying.timerS.toFixed(2)}/${hs.dying.durationS.toFixed(2)} s`
      : null;
    const body = dying ?? (hs.isRagdollActive ? hs.ragdollPhase.kind : 'ANIMATED');
    const hp = Math.round((hs.currentHp / hs.maxHp) * 100);
    const t = this.sequenceTimeS;
    const last = this.log.length ? this.log[this.log.length - 1] : 'standing ready';
    return [
      `${this.def.label} · t ${t >= 0 ? '+' : ''}${t.toFixed(2)} s · ${last}`,
      `${reaction} · clip ${this.activeClip}${this.seatedLine}`,
      `${hs.alive ? hs.posture : 'DEAD'} · ${body} · HP ${hp} % · ${this.body.armamentKind} · ${hs.combatantStatusTag ?? 'no tag'}`,
      this.body.woundedStatusLine,
    ].join('\n');
  }

  /**
   * The seated last-stand clip asked for, when the body sits on the floor. Until the seated clips
   * are baked the body holds its fall clip, so this says which one it is waiting for.
   */
  private get seatedLine(): string {
    const seated = this.body.mannequin.seatedClip;
    if (!seated) return '';
    const name = `${seated.clip}${seated.southpaw ? '_Southpaw' : ''}`;
    const baked = this.body.mannequin.combatantGlb?.availableClips.has(seated.clip) ?? false;
    return ` · seated ${seated.stage.toLowerCase()}: ${name}${baked ? '' : ' (not baked, holding fall)'}`;
  }

  public update(dt: number): void {
    const step = this.body.clampStep(dt);
    this.landDueHits();
    this.body.step(step);
  }

  private landDueHits(): void {
    const steps = this.def.steps;
    while (this.nextStep < steps.length && this.sequenceTimeS >= steps[this.nextStep].atS) {
      const due = steps[this.nextStep++];
      if (due.hit.kind === 'STAND_IN') this.standInOverride = due.hit.to;
      if (!this.health.alive) continue;
      const line = due.hit.kind === 'ACT' ? this.body.act(due.hit.act) : applySequenceHit(this.health, due.hit);
      this.log.push(`+${due.atS.toFixed(1)} s ${line}`);
    }
  }

  public destroy(): void {
    this.body.destroy();
  }
}
