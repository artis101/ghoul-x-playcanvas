import { describe, expect, it } from 'vitest';
import type { TargetHealthState, Vec3Like, WoundedPhase } from '../src/contracts/ballistics.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { stepLivingTargetVitalsAndFall } from '../src/core/ballistics/lifecycle/targetLifecycleFsm.ts';
import { SIT_TO_CRAWL_S } from '../src/core/ballistics/trauma/woundReactionTimings.ts';
import {
  type CombatantResolveProfile,
  type EnemyTracerFireEvent,
  TacticalCombatAiSystem,
} from '../src/engine/ai/tacticalCombatAi.ts';

/**
 * The wounded sequence driven through the real AI system, headless (docs/wound-movement.md):
 * one thing at a time, and a body on the floor only shoots at a player straight in front of it.
 */

const DT = 0.05;
const IN_FRONT: Vec3Like = { x: 0, y: 1.62, z: 0 };
const OFF_TO_SIDE: Vec3Like = { x: 8, y: 1.62, z: -10 };

interface Rig {
  ai: TacticalCombatAiSystem;
  hs: TargetHealthState;
  shots: EnemyTracerFireEvent[];
}

function setup(id: string, profile: CombatantResolveProfile, fortitude: number): Rig {
  const shots: EnemyTracerFireEvent[] = [];
  const ai = new TacticalCombatAiSystem({
    onEnemyFireTracer: (ev) => shots.push(ev),
    resolveProfileOverrides: { [id]: profile },
    hardenedSidearmOverrides: { [id]: true },
  });
  // Stands 10 m down the arena facing +Z, straight at a player at the origin.
  const hs = createTargetHealthState(id, 'Wounded', { x: 0, y: 0, z: -10 }, 0);
  hs.fortitude = fortitude;
  ai.registerWaveTargets([hs], false);
  ai.notifyGunshotOrExplosion(IN_FRONT, 30);
  return { ai, hs, shots };
}

/** The off arm is gone; the arm-loss clip is taken as already played. */
function loseOffArm(hs: TargetHealthState): void {
  hs.severedZones.add('UPPER_ARM_LEFT');
  hs.leftArmFunctional = false;
  hs.weaponDropped = true;
}

function tick(rig: Rig, player: Vec3Like): void {
  stepLivingTargetVitalsAndFall(rig.hs, DT, 0);
  rig.ai.update(DT, [rig.hs], player);
}

function phase(hs: TargetHealthState): WoundedPhase {
  return hs.woundedPhase ?? 'NONE';
}

/** A body on the floor, seated, facing +Z toward the player, in the given downed phase. */
function lay(rig: Rig, downedPhase: WoundedPhase): void {
  const { hs } = rig;
  hs.isRagdollActive = true;
  hs.posture = 'RAGDOLL_GROUNDED';
  hs.weaponDropped = true;
  hs.downedFacingWorld = { x: 0, y: 0, z: 1 };
  hs.woundedPhase = downedPhase;
  hs.woundedPhaseTimerS = 0;
}

describe('wounded sequence AI', () => {
  it('veteran losing an arm clutches, then draws, then blazes: walking at the player, firing', () => {
    const rig = setup('blaze_vet', 'HARDENED_VETERAN', 0.95);
    loseOffArm(rig.hs);
    const agent = rig.ai.getAgent('blaze_vet')!;
    const seen: WoundedPhase[] = [];
    let drewDuringClutch = false;
    let firedBeforeBlaze = false;
    let drewInBlaze = false;
    for (let i = 0; i < 160; i++) {
      tick(rig, IN_FRONT);
      const p = phase(rig.hs);
      if (seen[seen.length - 1] !== p) seen.push(p);
      if (p === 'CLUTCH' && (agent.sidearmDrawing || agent.sidearmActive)) drewDuringClutch = true;
      if (p !== 'BLAZE' && rig.shots.length > 0) firedBeforeBlaze = true;
      if (p === 'BLAZE' && agent.sidearmDrawing) drewInBlaze = true;
    }
    expect(seen.slice(0, 2)).toEqual(['CLUTCH', 'BLAZE']);
    expect(drewDuringClutch).toBe(false);
    expect(firedBeforeBlaze).toBe(false);
    expect(drewInBlaze).toBe(true);
    expect(agent.sidearmActive).toBe(true);
    expect(rig.shots.length).toBeGreaterThan(0);
    expect(rig.shots.every((s) => s.usedBackupSidearm)).toBe(true);
    // Advancing on the player at a walk.
    expect(rig.hs.worldPosition.z).toBeGreaterThan(-9);
    expect(rig.hs.combatantStatusTag).toBe('RUSHING');
    rig.ai.destroy();
  });

  it('middling fortitude kneels down first, then draws and fires only within the kneel cone', () => {
    const rig = setup('kneel_reg', 'GRITTY_REGULAR', 0.5);
    loseOffArm(rig.hs);
    const agent = rig.ai.getAgent('kneel_reg')!;
    let drewWhileKneelingDown = false;
    for (let i = 0; i < 70 && phase(rig.hs) !== 'KNEEL_FIRE'; i++) {
      tick(rig, IN_FRONT);
      if (phase(rig.hs) === 'KNEEL_DOWN' && (agent.sidearmDrawing || agent.sidearmActive)) drewWhileKneelingDown = true;
    }
    expect(phase(rig.hs)).toBe('KNEEL_FIRE');
    expect(drewWhileKneelingDown).toBe(false);
    expect(rig.shots.length).toBe(0);

    const start = { ...rig.hs.worldPosition };
    for (let i = 0; i < 60; i++) tick(rig, IN_FRONT);
    expect(agent.sidearmActive).toBe(true);
    expect(rig.shots.length).toBeGreaterThan(0);
    expect(rig.hs.worldPosition).toEqual(start);

    // The player steps 90 degrees aside: it shuffles round at kneeling speed and holds fire
    // until the player is back inside its cone.
    const before = rig.shots.length;
    const yawBefore = rig.hs.yawRad;
    for (let i = 0; i < 6; i++) tick(rig, OFF_TO_SIDE);
    expect(rig.shots.length).toBe(before);
    expect(Math.abs(rig.hs.yawRad - yawBefore)).toBeLessThanOrEqual(0.9 * DT * 6 + 1e-6);
    expect(rig.hs.worldPosition).toEqual(start);
    rig.ai.destroy();
  });

  it('low fortitude sits down; downed, it only engages a player straight in front of it', () => {
    const rig = setup('sit_scrap', 'GRITTY_REGULAR', 0.2);
    loseOffArm(rig.hs);
    const agent = rig.ai.getAgent('sit_scrap')!;
    for (let i = 0; i < 80 && phase(rig.hs) !== 'SIT_DOWN' && rig.hs.activeReaction.type !== 'DOWNED_COLLAPSE'; i++) {
      tick(rig, IN_FRONT);
    }
    expect(rig.hs.activeReaction.type).toBe('DOWNED_COLLAPSE');
    // While the collapse plays, nothing draws or fires; the plan for the floor is to engage.
    for (let i = 0; i < 10; i++) {
      tick(rig, IN_FRONT);
      expect(agent.sidearmDrawing || agent.sidearmActive).toBe(false);
    }
    // It shows SIT_DOWN until the collapse ends; the floor plan is kept alongside.
    expect(phase(rig.hs)).toBe('SIT_DOWN');
    expect(rig.hs.plannedDownedPhase).toBe('DOWNED_ENGAGE');
    expect(rig.shots.length).toBe(0);

    // Landed seated, facing the player.
    lay(rig, 'DOWNED_ENGAGE');
    rig.hs.activeReaction.type = 'NONE';
    const yaw = rig.hs.yawRad;
    for (let i = 0; i < 60; i++) rig.ai.update(DT, [rig.hs], IN_FRONT);
    expect(agent.sidearmActive).toBe(true);
    const inFrontShots = rig.shots.length;
    expect(inFrontShots).toBeGreaterThan(0);

    // The player steps to its side: it holds fire and never turns to track.
    for (let i = 0; i < 60; i++) rig.ai.update(DT, [rig.hs], OFF_TO_SIDE);
    expect(rig.shots.length).toBe(inFrontShots);
    expect(rig.hs.yawRad).toBe(yaw);
    rig.ai.destroy();
  });

  it('a body lying in agony engages once the player walks into its front cone', () => {
    const rig = setup('agony_vet', 'HARDENED_VETERAN', 0.5);
    lay(rig, 'DOWNED_AGONY');
    for (let i = 0; i < 40; i++) rig.ai.update(DT, [rig.hs], OFF_TO_SIDE);
    expect(rig.shots.length).toBe(0);
    expect(rig.ai.getAgent('agony_vet')!.sidearmDrawing || rig.ai.getAgent('agony_vet')!.sidearmActive).toBe(false);
    for (let i = 0; i < 60; i++) rig.ai.update(DT, [rig.hs], IN_FRONT);
    expect(phase(rig.hs)).toBe('DOWNED_ENGAGE');
    expect(rig.shots.length).toBeGreaterThan(0);
    rig.ai.destroy();
  });

  it('a falling body planned to engage does not reach for the pistol until it lands', () => {
    const rig = setup('air_vet', 'HARDENED_VETERAN', 0.8);
    lay(rig, 'DOWNED_ENGAGE');
    rig.hs.posture = 'AIRBORNE_RAGDOLL';
    const agent = rig.ai.getAgent('air_vet')!;
    for (let i = 0; i < 30; i++) rig.ai.update(DT, [rig.hs], IN_FRONT);
    expect(agent.sidearmDrawing || agent.sidearmActive).toBe(false);
    expect(rig.shots.length).toBe(0);
    rig.hs.posture = 'RAGDOLL_GROUNDED';
    for (let i = 0; i < 60; i++) rig.ai.update(DT, [rig.hs], IN_FRONT);
    expect(agent.sidearmDrawing || agent.sidearmActive).toBe(true);
    rig.ai.destroy();
  });

  it('a crawler rolls over, then drags itself away from the player, facing away, and never fires', () => {
    const rig = setup('crawl_scrap', 'PANICKED_SCRAPPER', 0.2);
    const { hs } = rig;
    hs.rightLegFunctional = false;
    hs.weaponDropped = true;
    hs.woundedPhase = 'DOWNED_CRAWL';
    hs.woundedPhaseTimerS = 0;
    const start = { ...hs.worldPosition };
    // Still rolling over: no movement yet.
    const rollTicks = Math.floor((SIT_TO_CRAWL_S - 0.2) / DT);
    for (let i = 0; i < rollTicks; i++) rig.ai.update(DT, [hs], IN_FRONT);
    expect(hs.worldPosition.x).toBeCloseTo(start.x, 6);
    expect(hs.worldPosition.z).toBeCloseTo(start.z, 6);

    for (let i = 0; i < 300; i++) rig.ai.update(DT, [hs], IN_FRONT);
    expect(phase(hs)).toBe('DOWNED_CRAWL');
    expect(hs.isRagdollActive).toBe(false);
    // The player is at +Z: it went the other way, its back to the player.
    expect(hs.worldPosition.z).toBeLessThan(start.z - 0.2);
    expect(Math.cos(hs.yawRad)).toBeLessThan(-0.8);
    expect(rig.shots.length).toBe(0);
    rig.ai.destroy();
  });

  it('face down: no gun, no damage, wherever the player stands', () => {
    const rig = setup('face_vet', 'FANATIC_BERSERKER', 0.95);
    lay(rig, 'FACE_DOWN');
    const agent = rig.ai.getAgent('face_vet')!;
    for (let i = 0; i < 80; i++) rig.ai.update(DT, [rig.hs], IN_FRONT);
    expect(phase(rig.hs)).toBe('FACE_DOWN');
    expect(agent.sidearmActive || agent.sidearmDrawing).toBe(false);
    expect(rig.shots.length).toBe(0);
    rig.ai.destroy();
  });
});
