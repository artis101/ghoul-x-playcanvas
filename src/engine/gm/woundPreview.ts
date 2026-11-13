import type * as pc from 'playcanvas';
import type { EnemyArchetypeId, GhoulZoneId, TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import { transitionTargetLifecycle } from '../../core/ballistics/lifecycle/targetLifecycleFsm.ts';
import { stabilizeRagdollPoseForTransition } from '../../core/ballistics/ragdoll/ragdollPoseStabilizer.ts';
import { applyDismembermentTree } from '../../core/ballistics/trauma/dismembermentTreeApplicator.ts';
import { vec3 } from '../../core/ballistics/vec3.ts';
import { createTargetHealthState } from '../../core/ghoul/anatomy.ts';
import type { GlbModelRegistry } from '../assets/glbLoader.ts';
import { LiveCombatant } from './liveCombatant.ts';
import { buildSeverReport } from './woundSequences.ts';

export type LostLimb = 'ARM_RIGHT' | 'ARM_LEFT' | 'LEG_RIGHT' | 'LEG_LEFT';

export interface WoundSpec {
  /** Knocked into the living ragdoll. */
  readonly downed: boolean;
  readonly lostLimbs: readonly LostLimb[];
  readonly backupSidearm: boolean;
  /** Off holds the wounded state instead of letting it bleed out. */
  readonly bleeding: boolean;
}

const SEVER_ZONE: Record<LostLimb, GhoulZoneId> = {
  ARM_LEFT: 'UPPER_ARM_LEFT',
  ARM_RIGHT: 'UPPER_ARM_RIGHT',
  LEG_LEFT: 'THIGH_LEFT',
  LEG_RIGHT: 'THIGH_RIGHT',
};
const STAND_BEFORE_WOUND_S = 0.6;

/**
 * Wounds a combatant and runs it through the same armament, ragdoll, mannequin and sidearm
 * passes as the game loop, so every wounded state can be inspected in the lab.
 */
export class WoundPreview {
  public readonly health: TargetHealthState;
  private readonly body: LiveCombatant;
  private readonly viewer = vec3(0, 1.6, 3);
  private wounded = false;
  /** Drives ragdoll muscle tone. Mortally wounded combatants sit near 0.2–0.5. */
  public consciousness = 1;

  public constructor(
    app: pc.AppBase,
    registry: GlbModelRegistry,
    archetype: EnemyArchetypeId,
    private readonly spec: WoundSpec,
    private readonly camera: pc.GraphNode | null,
  ) {
    this.health = createTargetHealthState('gm-wounded', 'Wounded', { x: 0, y: 0, z: 0 }, 0, archetype);
    this.body = new LiveCombatant(app, registry, this.health, spec.backupSidearm, () => this.viewerPosition());
  }

  /** Where the preview camera should look. */
  public get focus(): Vec3Like {
    return this.body.focus;
  }

  public get statusLine(): string {
    const hs = this.health;
    const body = hs.isRagdollActive ? hs.ragdollPhase.kind : 'ANIMATED';
    const tone = Math.max(0.22, hs.consciousness * (1 - 0.55 * hs.painShock));
    return `${hs.posture} · ${body} · tone ${tone.toFixed(2)} · ${this.body.armamentKind} · ${hs.combatantStatusTag ?? 'no tag'}`;
  }

  public update(dt: number): void {
    const step = this.body.clampStep(dt);
    if (!this.wounded && this.body.clockS >= STAND_BEFORE_WOUND_S) this.applyWounds();
    if (this.wounded && !this.spec.bleeding) this.health.consciousness = this.consciousness;
    this.body.step(step);
  }

  private applyWounds(): void {
    const hs = this.health;
    this.wounded = true;
    applyDismembermentTree(hs, buildSeverReport(hs, this.spec.lostLimbs.map((limb) => SEVER_ZONE[limb])));
    if (!this.spec.bleeding) hs.bloodLossRateMlPerSec = 0;
    // Two lost limbs (other than one arm and one leg) kill it, and it drops whatever was asked.
    if (!this.spec.downed && hs.alive) return;
    if (hs.alive) hs.currentHp = hs.maxHp * 0.25;
    transitionTargetLifecycle(hs, { kind: 'ACTIVATE_RAGDOLL', isOverkillCorpseHit: false });
    stabilizeRagdollPoseForTransition(hs, 0);
    hs.ragdollRootVelocity = vec3(0, 0.3, -2.4);
  }

  private viewerPosition(): Vec3Like {
    const p = this.camera?.getPosition();
    if (p) {
      this.viewer.x = p.x;
      this.viewer.y = p.y;
      this.viewer.z = p.z;
    }
    return this.viewer;
  }

  public destroy(): void {
    this.body.destroy();
  }
}
