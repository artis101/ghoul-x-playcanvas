import type * as pc from 'playcanvas';
import type { TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import { stepRagdollPhysics } from '../../core/ballistics/ragdoll/ragdollVerletStep.ts';
import type { GlbModelRegistry } from '../assets/glbLoader.ts';
import { createOffhandSidearmRig, destroyOffhandSidearmRig } from '../combat/offhandSidearmRig.ts';
import { OffhandSidearmSync } from '../combat/offhandSidearmSync.ts';
import type { OffhandSidearmRig } from '../combat/offhandSidearmTypes.ts';
import { GhoulMannequinEntity } from '../mannequin.ts';
import { sidearmAimClip } from '../mannequin/combatantWoundedPhaseClips.ts';
import { getOrCreateMaterials } from '../materials.ts';
import { LabCombatantBrain } from './labCombatantBrain.ts';

/** Longer frames are cut down so a stalled tab does not throw the ragdoll across the room. */
const MAX_STEP_S = 1 / 30;

/**
 * One combatant run through the game loop's wounded-sequence, armament, ragdoll, mannequin and
 * sidearm passes, without the rest of the AI agent around it. The lab previews wound it and watch
 * what the game would do. The player is a stand-in point the lab places.
 */
export class LiveCombatant {
  public readonly mannequin: GhoulMannequinEntity;
  private readonly rig: OffhandSidearmRig;
  private readonly sidearmSync = new OffhandSidearmSync();
  private readonly brain: LabCombatantBrain;
  public clockS = 0;

  public constructor(
    app: pc.AppBase,
    registry: GlbModelRegistry,
    public readonly health: TargetHealthState,
    backupSidearm: boolean,
    /** The player stand-in: where a drawn sidearm points and what the downed fire cone measures. */
    private readonly aimTarget: () => Vec3Like,
  ) {
    this.brain = new LabCombatantBrain(health, backupSidearm, aimTarget);
    this.mannequin = new GhoulMannequinEntity(app, health, getOrCreateMaterials(), undefined, registry);
    app.root.addChild(this.mannequin.rootEntity);
    this.rig = createOffhandSidearmRig(this.mannequin, registry);
    this.sync(0);
  }

  /** Where the preview camera should look. */
  public get focus(): Vec3Like {
    return this.health.ragdollBones.TORSO_LOWER_ABDOMEN.position;
  }

  public get armamentKind(): string {
    return this.brain.armamentKind;
  }

  /** The combatant clip the animation layer is really playing, which may differ from the one asked for. */
  public get activeClip(): string {
    return this.mannequin.combatantGlb?.animComponent?.baseLayer?.activeState ?? '—';
  }

  /** Cuts a long frame down and advances the clock by what is left. */
  public clampStep(dt: number): number {
    const step = Math.min(dt, MAX_STEP_S);
    this.clockS += step;
    return step;
  }

  /** True when the game would let this body fire at the stand-in right now. */
  public get wouldFire(): boolean {
    return this.brain.wouldFire;
  }

  /** Phase, phase clock, fortitude, the stand-in's bearing and the fire verdict. */
  public get woundedStatusLine(): string {
    return this.brain.statusLine;
  }

  /** Runs the per-target passes in the game's order: the AI tick, the ragdoll, then the body. */
  public step(dt: number): void {
    this.brain.step(dt, this.mannequin.isCrawling);
    stepRagdollPhysics(this.health, dt, 0);
    this.sync(dt);
  }

  private sync(dt: number): void {
    const sidearm = this.brain.sidearmState();
    // Same aim clip choice as the game: one-handed once the support arm is gone, on one knee
    // while kneeling to fire.
    const aim = sidearm.visible && sidearm.hand
      ? { clip: sidearmAimClip(this.health, sidearm.hand), hand: sidearm.hand }
      : undefined;
    this.mannequin.syncFromHealthState(dt, this.clockS, false, aim);
    const provider = { getSidearmVisualState: () => sidearm };
    if (this.sidearmSync.sync(this.mannequin, this.aimTarget(), this.rig, provider)) {
      this.mannequin.syncPoseAttachments();
    }
  }

  public destroy(): void {
    destroyOffhandSidearmRig(this.rig);
    this.mannequin.destroy();
  }
}
