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
import { setEnemySwayClock } from '../ai/enemyWeaponSway.ts';
import { LabActs, type LabAct } from './labActs.ts';
import { UPPER_BODY_LAYER } from '../mannequin/combatantUpperBodyLayer.ts';
import { setCombatantAimTarget } from '../mannequin/combatantAimDelta.ts';

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
  /** What the AI would do with a standing body: walk it, aim, drop or pick up its gun. */
  private readonly acts = new LabActs();
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
    const anim = this.mannequin.combatantGlb?.animComponent;
    const base = anim?.baseLayer?.activeState ?? '—';
    // While moving, the aim or carry plays on the masked upper-body layer over the gait.
    const upper = anim?.findLayer(UPPER_BODY_LAYER);
    return upper && upper.weight > 0.01 ? `${base} + upper ${upper.activeState}` : base;
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

  /** Starts a scripted act (walk, aim, drop or pick up the gun). Returns a log line. */
  public act(act: LabAct): string {
    return this.acts.start(this.health, act);
  }

  /** Runs the per-target passes in the game's order: the AI tick, the ragdoll, then the body. */
  public step(dt: number): void {
    // The gun back in hand puts the armament back on the primary, as weaponRecovery.ts does.
    if (this.acts.step(this.health, dt)) this.brain.rearm();
    this.brain.step(dt, this.mannequin.isCrawling);
    stepRagdollPhysics(this.health, dt, 0);
    this.sync(dt);
  }

  private sync(dt: number): void {
    // The lab has no AI to run the sway clock, so the pistol would hold still; run it here.
    setEnemySwayClock(this.clockS);
    const sidearm = this.brain.sidearmState();
    // Same aim clip choice as the game: one-handed once the support arm is gone, on one knee
    // while kneeling to fire.
    const aim = sidearm.visible && sidearm.hand
      ? { clip: sidearmAimClip(this.health, sidearm.hand), hand: sidearm.hand }
      : this.acts.aimPose(this.health);
    // The game's AI publishes its aim point each tick; the lab has no AI, so publish the stand-in
    // while aiming. Without it the aim delta has nowhere to turn the gun and only adds sway.
    setCombatantAimTarget(this.health.targetId, aim ? this.aimTarget() : null);
    this.mannequin.syncFromHealthState(dt, this.clockS, false, aim);
    const provider = { getSidearmVisualState: () => sidearm };
    if (this.sidearmSync.sync(this.mannequin, this.aimTarget(), this.rig, provider, undefined, dt)) {
      this.mannequin.syncPoseAttachments();
    }
  }

  public destroy(): void {
    setCombatantAimTarget(this.health.targetId, null);
    destroyOffhandSidearmRig(this.rig);
    this.mannequin.destroy();
  }
}
