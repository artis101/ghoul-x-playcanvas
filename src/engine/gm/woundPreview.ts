import type * as pc from 'playcanvas';
import type {
  EnemyArchetypeId, GhoulZoneId, ShotSimulationReport, TargetHealthState, Vec3Like,
} from '../../contracts/ballistics.ts';
import {
  applyArmamentStateToRuntime, createPrimaryArmedState, reconcileEnemyArmamentState,
  stepEnemyArmamentState, type SyncedArmamentRuntimeFields,
} from '../../core/ai/enemyArmamentFsm.ts';
import { transitionTargetLifecycle } from '../../core/ballistics/lifecycle/targetLifecycleFsm.ts';
import { stabilizeRagdollPoseForTransition } from '../../core/ballistics/ragdoll/ragdollPoseStabilizer.ts';
import { stepRagdollPhysics } from '../../core/ballistics/ragdoll/ragdollVerletStep.ts';
import { applyDismembermentTree } from '../../core/ballistics/trauma/dismembermentTreeApplicator.ts';
import { vec3 } from '../../core/ballistics/vec3.ts';
import { createTargetHealthState } from '../../core/ghoul/anatomy.ts';
import { getSubtreeZones } from '../../core/ghoul/anatomy/ghoulHierarchy.ts';
import {
  getPreferredPrimaryHand, isArmChainIntactAndFunctional, selectIntactFiringHand,
} from '../ai/combatantArmEvaluation.ts';
import { SIDEARM_DRAW_DURATION_S, type EnemySidearmVisualState } from '../ai/tacticalAiTypes.ts';
import type { GlbModelRegistry } from '../assets/glbLoader.ts';
import { createOffhandSidearmRig, destroyOffhandSidearmRig } from '../combat/offhandSidearmRig.ts';
import { OffhandSidearmSync } from '../combat/offhandSidearmSync.ts';
import type { OffhandSidearmRig } from '../combat/offhandSidearmTypes.ts';
import { GhoulMannequinEntity } from '../mannequin.ts';
import { getOrCreateMaterials } from '../materials.ts';

export type LostLimb = 'ARM_LEFT' | 'ARM_RIGHT' | 'LEG_LEFT' | 'LEG_RIGHT';

export interface WoundSpec {
  /** Knocked into the living ragdoll. */
  readonly downed: boolean;
  readonly lostLimbs: readonly LostLimb[];
  readonly backupSidearm: boolean;
  /** Off holds the wounded state instead of letting it bleed out. */
  readonly bleeding: boolean;
}

// LostLimb names the character's own left and right. Zone ids are named the other way round:
// the body faces +z with its `_LEFT` zones at -x, which is the character's right-hand side.
const SEVER_ZONE: Record<LostLimb, GhoulZoneId> = {
  ARM_LEFT: 'UPPER_ARM_RIGHT',
  ARM_RIGHT: 'UPPER_ARM_LEFT',
  LEG_LEFT: 'THIGH_RIGHT',
  LEG_RIGHT: 'THIGH_LEFT',
};
const STAND_BEFORE_WOUND_S = 0.6;
const MAX_STEP_S = 1 / 30;

/**
 * Wounds a combatant and runs it through the same armament, ragdoll, mannequin and sidearm
 * passes as the game loop, so every wounded state can be inspected in the lab.
 */
export class WoundPreview {
  public readonly health: TargetHealthState;
  private readonly mannequin: GhoulMannequinEntity;
  private readonly rig: OffhandSidearmRig;
  private readonly sidearmSync = new OffhandSidearmSync();
  private readonly armament: SyncedArmamentRuntimeFields;
  private readonly viewer = vec3(0, 1.6, 3);
  private clockS = 0;
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
    const hand = getPreferredPrimaryHand(this.health);
    this.armament = {
      activeFiringHand: hand,
      sidearmDrawTimerS: 0,
      sidearmDrawing: false,
      sidearmActive: false,
      sidearmDropped: false,
      armamentState: createPrimaryArmedState(hand),
    };
    this.mannequin = new GhoulMannequinEntity(app, this.health, getOrCreateMaterials(), undefined, registry);
    app.root.addChild(this.mannequin.rootEntity);
    this.rig = createOffhandSidearmRig(this.mannequin, registry);
    this.sync(0);
  }

  /** Where the preview camera should look. */
  public get focus(): Vec3Like {
    return this.health.ragdollBones.TORSO_LOWER_ABDOMEN.position;
  }

  public get statusLine(): string {
    const hs = this.health;
    const body = hs.isRagdollActive ? hs.ragdollPhase.kind : 'ANIMATED';
    const tone = Math.max(0.22, hs.consciousness * (1 - 0.55 * hs.painShock));
    return `${hs.posture} · ${body} · tone ${tone.toFixed(2)} · ${this.armament.armamentState?.kind ?? '—'} · ${hs.combatantStatusTag ?? 'no tag'}`;
  }

  public update(dt: number): void {
    const step = Math.min(dt, MAX_STEP_S);
    this.clockS += step;
    if (!this.wounded && this.clockS >= STAND_BEFORE_WOUND_S) this.applyWounds();
    if (this.wounded && !this.spec.bleeding) this.health.consciousness = this.consciousness;
    this.stepArmament(step);
    stepRagdollPhysics(this.health, step, 0);
    this.sync(step);
  }

  private applyWounds(): void {
    const hs = this.health;
    this.wounded = true;
    const dismembermentEvents = this.spec.lostLimbs.map((limb) => {
      const zone = SEVER_ZONE[limb];
      return {
        zone,
        goreMode: 'CLEAN_SEVER' as const,
        detachedSubtree: getSubtreeZones(zone),
        stumpWorldPosition: hs.ragdollBones[zone].position,
        arterialSprayDirection: vec3(0, 1, 0),
        // Thrown outward, away from the side of the body it came off.
        severedLimbVelocity: vec3(zone.endsWith('LEFT') ? -1.6 : 1.6, 1.8, -0.6),
        severedLimbAngularVelocity: vec3(3, 2, -4),
        gibCount: 0,
      };
    });
    applyDismembermentTree(hs, { dismembermentEvents } as unknown as ShotSimulationReport);
    if (!this.spec.bleeding) hs.bloodLossRateMlPerSec = 0;
    if (!this.spec.downed) return;
    hs.currentHp = hs.maxHp * 0.25;
    transitionTargetLifecycle(hs, { kind: 'ACTIVATE_RAGDOLL', isOverkillCorpseHit: false });
    stabilizeRagdollPoseForTransition(hs, 0);
    hs.ragdollRootVelocity = vec3(0, 0.3, -2.4);
  }

  /** The combat loop's armament step, without the AI agent around it. */
  private stepArmament(dt: number): void {
    const hs = this.health;
    const preferred = getPreferredPrimaryHand(hs);
    const result = stepEnemyArmamentState(reconcileEnemyArmamentState(this.armament), {
      dt,
      alive: hs.alive && hs.currentHp > 0,
      leftArmIntact: isArmChainIntactAndFunctional(hs, 'LEFT'),
      rightArmIntact: isArmChainIntactAndFunctional(hs, 'RIGHT'),
      preferredPrimaryHand: preferred,
      intactHand: selectIntactFiringHand(hs, preferred),
      weaponDropped: hs.weaponDropped,
      primaryArmDisarmed: hs.primaryArmDisarmed === true,
      isRagdollActive: hs.isRagdollActive,
      isAirborneRagdoll: hs.isRagdollActive && hs.posture === 'AIRBORNE_RAGDOLL',
      carriesBackupSidearm: this.spec.backupSidearm,
      isGuarding: false,
      isLastStandVital: hs.currentHp <= hs.maxHp * 0.32,
      sidearmDrawDurationS: SIDEARM_DRAW_DURATION_S,
    });
    applyArmamentStateToRuntime(this.armament, result.state);
    if (result.dropPrimaryWeapon) hs.weaponDropped = true;
    if (result.markPrimaryArmDisarmed) hs.primaryArmDisarmed = true;
    if (result.forceDisarmedPosture) hs.posture = 'DISARMED';
    hs.combatantStatusTag = result.statusTag;
  }

  private sidearmState(): EnemySidearmVisualState {
    const state = reconcileEnemyArmamentState(this.armament);
    const visible = state.kind === 'SIDEARM_ACTIVE' || state.kind === 'SIDEARM_DRAWING';
    return {
      visible,
      drawing: state.kind === 'SIDEARM_DRAWING',
      drawProgress: state.kind === 'SIDEARM_DRAWING' ? 1 - state.remainingS / SIDEARM_DRAW_DURATION_S : visible ? 1 : 0,
      hand: visible ? state.hand : null,
      dropped: state.kind === 'DISARMED' && state.sidearmDropped,
      aimTargetWorld: this.viewerPosition(),
      weaponId: 'silver_talon_50ae',
    };
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

  private sync(dt: number): void {
    const sidearm = this.sidearmState();
    this.mannequin.syncFromHealthState(
      dt, this.clockS, false, sidearm.visible && sidearm.hand ? { clip: 'PistolAim', hand: sidearm.hand } : undefined,
    );
    const provider = { getSidearmVisualState: () => sidearm };
    if (this.sidearmSync.sync(this.mannequin, this.viewerPosition(), this.rig, provider)) {
      this.mannequin.syncPoseAttachments();
    }
  }

  public destroy(): void {
    destroyOffhandSidearmRig(this.rig);
    this.mannequin.destroy();
  }
}
