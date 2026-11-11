import { describe, expect, it } from 'vitest';
import {
  type AttackTokenCandidate,
  AttackTokenPool,
  computeSuppressionTargetWorld,
} from '../src/core/ai/attackTokenPool.ts';
import {
  SquadBarkCoordinator,
  type SquadMateSummary,
} from '../src/core/ai/squadBarkCoordinator.ts';
import { distance } from '../src/core/ballistics/vec3.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import {
  createDefaultPlayerVitals,
  grantBrutalKillReward,
  resolveIncomingPlayerShotDamage,
  stepPlayerVitalsRegen,
} from '../src/engine/ai/playerVitalsController.ts';
import { TacticalCombatAiSystem } from '../src/engine/ai/tacticalCombatAi.ts';

function makeCandidate(
  overrides: Partial<AttackTokenCandidate> & { targetId: string }
): AttackTokenCandidate {
  return {
    targetId: overrides.targetId,
    alive: overrides.alive ?? true,
    canReturnFire: overrides.canReturnFire ?? true,
    isPeekingOut: overrides.isPeekingOut ?? true,
    hasLineOfSight: overrides.hasLineOfSight ?? true,
    isOnScreen: overrides.isOnScreen ?? true,
    distanceToPlayerM: overrides.distanceToPlayerM ?? 12.0,
    resolveProfile: overrides.resolveProfile ?? 'GRITTY_REGULAR',
    completedBurstCount: overrides.completedBurstCount ?? 0,
    suppression: overrides.suppression ?? 0,
  };
}

describe('AttackTokenPool & Cinematic Suppression', () => {
  it('assigns maxAggressiveTokens=3 by priority and puts remaining bots into CINEMATIC_SUPPRESSION', () => {
    const pool = new AttackTokenPool(3);
    const candidates: AttackTokenCandidate[] = [
      makeCandidate({ targetId: 'bot_scrapper', resolveProfile: 'PANICKED_SCRAPPER', distanceToPlayerM: 22 }),
      makeCandidate({ targetId: 'bot_berserker', resolveProfile: 'FANATIC_BERSERKER', distanceToPlayerM: 10 }),
      makeCandidate({ targetId: 'bot_veteran', resolveProfile: 'HARDENED_VETERAN', distanceToPlayerM: 14 }),
      makeCandidate({ targetId: 'bot_regular_onscreen', resolveProfile: 'GRITTY_REGULAR', isOnScreen: true }),
      makeCandidate({ targetId: 'bot_regular_offscreen', resolveProfile: 'GRITTY_REGULAR', isOnScreen: false }),
    ];

    const map = pool.assignTokens(candidates);
    expect(map.get('bot_berserker')).toBe('AGGRESSIVE_LETHAL');
    expect(map.get('bot_veteran')).toBe('AGGRESSIVE_LETHAL');
    expect(map.get('bot_regular_onscreen')).toBe('AGGRESSIVE_LETHAL');
    expect(map.get('bot_regular_offscreen')).toBe('CINEMATIC_SUPPRESSION');
    expect(map.get('bot_scrapper')).toBe('CINEMATIC_SUPPRESSION');
  });

  it('rotates tokens when holders complete bursts and releases tokens immediately on death', () => {
    const pool = new AttackTokenPool(2);
    const wave1: AttackTokenCandidate[] = [
      makeCandidate({ targetId: 'bot_a', resolveProfile: 'GRITTY_REGULAR', completedBurstCount: 0 }),
      makeCandidate({ targetId: 'bot_b', resolveProfile: 'GRITTY_REGULAR', completedBurstCount: 0 }),
      makeCandidate({ targetId: 'bot_c', resolveProfile: 'GRITTY_REGULAR', completedBurstCount: 0 }),
    ];

    const firstAssign = pool.assignTokens(wave1);
    expect(firstAssign.get('bot_a')).toBe('AGGRESSIVE_LETHAL');
    expect(firstAssign.get('bot_b')).toBe('AGGRESSIVE_LETHAL');
    expect(firstAssign.get('bot_c')).toBe('CINEMATIC_SUPPRESSION');

    // bot_a completes 2 bursts -> rotates out in favor of waiting bot_c
    const wave2: AttackTokenCandidate[] = [
      makeCandidate({ targetId: 'bot_a', resolveProfile: 'GRITTY_REGULAR', completedBurstCount: 2 }),
      makeCandidate({ targetId: 'bot_b', resolveProfile: 'GRITTY_REGULAR', completedBurstCount: 0 }),
      makeCandidate({ targetId: 'bot_c', resolveProfile: 'GRITTY_REGULAR', completedBurstCount: 0 }),
    ];
    const rotated = pool.assignTokens(wave2);
    expect(rotated.get('bot_b')).toBe('AGGRESSIVE_LETHAL');
    expect(rotated.get('bot_c')).toBe('AGGRESSIVE_LETHAL');
    expect(rotated.get('bot_a')).toBe('CINEMATIC_SUPPRESSION');

    // Release token explicitly on death
    pool.releaseToken('bot_b');
    expect(pool.getFireMode('bot_b')).toBe('AGGRESSIVE_LETHAL'); // default fallback when unassigned
    const afterDeath = pool.assignTokens([
      makeCandidate({ targetId: 'bot_a', completedBurstCount: 2 }),
      makeCandidate({ targetId: 'bot_b', alive: false }),
      makeCandidate({ targetId: 'bot_c', completedBurstCount: 0 }),
    ]);
    expect(afterDeath.has('bot_b')).toBe(false);
    expect(afterDeath.get('bot_a')).toBe('AGGRESSIVE_LETHAL');
    expect(afterDeath.get('bot_c')).toBe('AGGRESSIVE_LETHAL');
  });

  it('computes deterministic suppression and first-shot warning offsets safely outside the 0.36m hit cylinder', () => {
    const playerEye = { x: 0, y: 1.65, z: 0 };
    const shooterPos = { x: 0, y: 1.32, z: -12 };

    for (let seed = 1; seed <= 12; seed++) {
      const suppPt = computeSuppressionTargetWorld(seed, playerEye, shooterPos, false);
      const warnPt = computeSuppressionTargetWorld(seed, playerEye, shooterPos, true);
      expect(distance(suppPt, playerEye)).toBeGreaterThanOrEqual(0.5);
      expect(distance(warnPt, playerEye)).toBeGreaterThanOrEqual(0.55);
      expect(warnPt.z).toBeLessThan(playerEye.z - 0.5); // sparks in front of player toward shooter
    }
  });
});

describe('SquadBarkCoordinator (F.E.A.R. Radio Lock, Call-and-Response & Dead Cancellation)', () => {
  it('enforces 2.2s radio lock and delivers queued 0.85s call-and-response pairs', () => {
    const coord = new SquadBarkCoordinator();
    const emitted: { speakerId: string; category: string; isRadio: boolean; text: string }[] = [];

    const mates: Map<string, SquadMateSummary> = new Map([
      [
        'target_0',
        {
          targetId: 'target_0',
          archetype: 'MILITIA_GUNNER',
          worldPos: { x: -2, y: 0, z: -10 },
          alive: true,
          conscious: true,
          isSuppressing: false,
        },
      ],
      [
        'target_1',
        {
          targetId: 'target_1',
          archetype: 'HEAVY_ENFORCER',
          worldPos: { x: 2, y: 0, z: -11 },
          alive: true,
          conscious: true,
          isSuppressing: true,
        },
      ],
    ]);

    coord.notifyFlankOrPeekShift(
      'target_0',
      'MILITIA_GUNNER',
      -1,
      { x: -2, y: 0, z: -10 },
      Array.from(mates.values()),
      1.0,
      (b) => emitted.push(b)
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0].speakerId).toBe('target_0');
    expect(emitted[0].category).toBe('FLANKING');

    // Immediate second radio bark within 2.2s lock is suppressed
    coord.notifyCoverRetreat('target_1', 'HEAVY_ENFORCER', { x: 2, y: 0, z: -11 }, 1.5, (b) =>
      emitted.push(b)
    );
    expect(emitted).toHaveLength(1);

    // Step past 0.85s delay -> queued suppressor response fires
    coord.step(1.9, (id) => mates.get(id), (b) => emitted.push(b));
    expect(emitted).toHaveLength(2);
    expect(emitted[1].speakerId).toBe('target_1');
    expect(emitted[1].category).toBe('SUPPRESSING');
  });

  it('cancels queued call-and-response if the responder dies before triggerAtS and emits VocalTraumaCue', () => {
    const coord = new SquadBarkCoordinator();
    const emitted: { speakerId: string; category: string; vocalCue?: string }[] = [];

    const mates: Map<string, SquadMateSummary> = new Map([
      [
        'target_0',
        {
          targetId: 'target_0',
          archetype: 'MILITIA_GUNNER',
          worldPos: { x: -2, y: 0, z: -10 },
          alive: true,
          conscious: true,
          isSuppressing: false,
        },
      ],
      [
        'target_1',
        {
          targetId: 'target_1',
          archetype: 'SNIPER_OPERATIVE',
          worldPos: { x: 3, y: 0, z: -12 },
          alive: true,
          conscious: true,
          isSuppressing: true,
        },
      ],
    ]);

    coord.notifyContact(
      'target_0',
      'MILITIA_GUNNER',
      { x: -2, y: 0, z: -10 },
      Array.from(mates.values()),
      5.0,
      (b) => emitted.push(b)
    );
    expect(emitted).toHaveLength(1);

    // Responder target_1 is killed mid-delay
    coord.cancelPendingForAgent('target_1');
    mates.set('target_1', { ...mates.get('target_1')!, alive: false });

    coord.step(6.0, (id) => mates.get(id), (b) => emitted.push(b));
    expect(emitted).toHaveLength(1); // No ghost reply from dead responder!

    // Non-radio VocalTraumaCue bypasses radio channel lock
    coord.notifyWoundedTrauma(
      'target_0',
      'MILITIA_GUNNER',
      { x: -2, y: 0, z: -10 },
      'WET_HEMOTHORAX_COUGH',
      false,
      5.2,
      (b) => emitted.push(b)
    );
    expect(emitted).toHaveLength(2);
    expect(emitted[1].category).toBe('WOUNDED_TRAUMA');
    expect(emitted[1].vocalCue).toBe('WET_HEMOTHORAX_COUGH');
  });
});

describe('PlayerVitalsController (Helmet Pop, Arterial Graze 1-HP Floor & Brutal Kill Staunch)', () => {
  it('deflects heavy head-level shots via HELMET_DEFLECT then triggers NECK_ARTERIAL_GRAZE 1-HP bleed', () => {
    const vitals = createDefaultPlayerVitals({ initialPlayerHealth: 100, initialPlayerArmor: 0 });
    const playerEye = { x: 0, y: 1.65, z: 0 };

    // 1. Sniper head-level hit pops intact helmet
    const hit1 = resolveIncomingPlayerShotDamage(vitals, {
      rawChipDamage: 8.0,
      attackerId: 'sniper_1',
      archetype: 'SNIPER_OPERATIVE',
      hitPointWorld: { x: -0.05, y: 1.62, z: 0 },
      playerEyeWorldPos: playerEye,
    });
    expect(hit1.grazeEvent?.kind).toBe('HELMET_DEFLECT');
    expect(hit1.grazeEvent?.helmetPopped).toBe(true);
    expect(vitals.helmetIntact).toBe(false);
    expect(vitals.health).toBeGreaterThanOrEqual(2);

    // Expire i-frames
    stepPlayerVitalsRegen(vitals, 0.6);

    // 2. Second Sniper head-level hit with helmet gone triggers NECK_ARTERIAL_GRAZE + urgent bleed
    const hit2 = resolveIncomingPlayerShotDamage(vitals, {
      rawChipDamage: 8.0,
      attackerId: 'sniper_1',
      archetype: 'SNIPER_OPERATIVE',
      hitPointWorld: { x: 0.06, y: 1.60, z: 0 },
      playerEyeWorldPos: playerEye,
    });
    expect(hit2.grazeEvent?.kind).toBe('NECK_ARTERIAL_GRAZE');
    expect(vitals.healthGateReady).toBe(false);
    expect(vitals.urgentBleedHpPerSec).toBe(3.5);
    expect(vitals.health).toBe(2);

    // 3. Stepping bleed for 2.0s clamps health at the non-lethal 1.0 HP floor
    stepPlayerVitalsRegen(vitals, 2.0);
    expect(vitals.health).toBe(1);
    expect(vitals.urgentBleedRemainingS).toBeGreaterThan(0);

    // 4. Scoring a brutal kill immediately staunches bleeding and re-arms healthGateReady
    grantBrutalKillReward(vitals, 'MULTI_KILL_BLAST');
    expect(vitals.urgentBleedHpPerSec).toBe(0);
    expect(vitals.urgentBleedRemainingS).toBe(0);
    expect(vitals.health).toBe(19);
    grantBrutalKillReward(vitals, 'CRANIAL_POP');
    expect(vitals.healthGateReady).toBe(true);
  });
});

describe('TacticalCombatAiSystem — Off-Screen Frustum Nerf & Dead Zero-Motion Guarantee', () => {
  it('applies 4.0x spread (0.25x accuracy) off-screen and keeps dead enemies 100% motionless', () => {
    const ai = new TacticalCombatAiSystem();
    const target = createTargetHealthState('target_0', 'Target 0', { x: 0, y: 0, z: -10 }, 0, 'MILITIA_GUNNER');
    ai.registerWaveTargets([target], false);

    // Player looking away (+Z instead of -Z toward target) -> target is off-screen
    ai.update(0.05, [target], { x: 0, y: 1.65, z: 0 }, undefined, { x: 0, y: 0, z: 1 });
    const agent = ai.getAgent('target_0')!;
    expect(agent.isOffScreen).toBe(true);
    const offScreenProfile = ai.computeEnemyAimProfile(target, agent);

    // Player looking directly at target (-Z) -> target is on-screen
    ai.update(0.05, [target], { x: 0, y: 1.65, z: 0 }, undefined, { x: 0, y: 0, z: -1 });
    expect(agent.isOffScreen).toBe(false);
    const onScreenProfile = ai.computeEnemyAimProfile(target, agent);
    expect(offScreenProfile.spreadMultiplier).toBeCloseTo(onScreenProfile.spreadMultiplier * 4.0, 4);

    // Kill target and verify 100% zero mutation of worldPosition, yawRad, posture
    target.alive = false;
    target.currentHp = 0;
    target.isRagdollActive = true;
    target.posture = 'AIRBORNE_RAGDOLL';
    const frozenPos = { ...target.worldPosition };
    const frozenYaw = target.yawRad;

    ai.update(0.05, [target], { x: 0, y: 1.65, z: 0 }, undefined, { x: 0, y: 0, z: -1 });
    expect(agent.state).toBe('DEAD');
    expect(target.worldPosition).toEqual(frozenPos);
    expect(target.yawRad).toBe(frozenYaw);
    expect(target.posture).toBe('AIRBORNE_RAGDOLL');
  });
});
