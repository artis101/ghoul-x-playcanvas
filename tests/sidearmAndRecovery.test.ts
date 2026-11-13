import { describe, expect, it } from 'vitest';
import type { TargetHealthState } from '../src/contracts/ballistics.ts';
import { normalize, sub, vec3 } from '../src/core/ballistics/vec3.ts';
import { AMMO_12G_00_BUCK, DEFAULT_ENVIRONMENT, WEAPON_M590 } from '../src/core/ballistics/weapons.ts';
import { applyShotReportToTarget, simulateShot } from '../src/core/ballistics/solver.ts';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { losesSidearmArm } from '../src/core/ballistics/trauma/limbLossDeathRule.ts';
import {
  stepEnemyArmamentState,
  type EnemyArmamentTransitionInput,
} from '../src/core/ai/enemyArmamentFsm.ts';
import { BACKUP_SIDEARM_TUNING, resolveDefaultCombatantProfile } from '../src/engine/ai/archetypeTuning.ts';
import { BACKUP_SIDEARM_WEAPON_ID } from '../src/engine/ai/tacticalAiTypes.ts';
import { TARGET_CONFIGS } from '../src/engine/combat/combatTargetConfigs.ts';
import { canRecoverDroppedWeapon } from '../src/engine/ai/weaponRecovery.ts';
import type { EnemyAiAgentRuntime } from '../src/engine/ai/tacticalAiTypes.ts';

function standingTarget(id: string): TargetHealthState {
  const t = createTargetHealthState(id, id, vec3(0, 0, -2), 0, 'MILITIA_GUNNER');
  t.bloodLossRateMlPerSec = 0;
  return t;
}

function blastRightForearm(t: TargetHealthState): void {
  const armPt = t.ragdollBones.FOREARM_RIGHT.position;
  const origin = vec3(armPt.x, armPt.y, armPt.z + 1.5);
  const rep = simulateShot(WEAPON_M590, AMMO_12G_00_BUCK, origin, normalize(sub(armPt, origin)), t, DEFAULT_ENVIRONMENT);
  applyShotReportToTarget(t, rep);
}

const RIGHT_ARM = ['HAND_RIGHT', 'FOREARM_RIGHT', 'UPPER_ARM_RIGHT'] as const;

describe('every combatant carries a side piece', () => {
  it('is the Silver Talon .50 AE, the only handgun model in the game', () => {
    expect(BACKUP_SIDEARM_WEAPON_ID).toBe('silver_talon_50ae');
    expect(BACKUP_SIDEARM_TUNING.weaponId).toBe('silver_talon_50ae');
  });

  it('is carried by the whole arena squad and any other spawn', () => {
    for (const cfg of TARGET_CONFIGS) {
      expect(resolveDefaultCombatantProfile(cfg.id, cfg.archetype).carriesBackupSidearm).toBe(true);
    }
    for (const archetype of ['SKINHEAD_PUNK', 'MILITIA_GUNNER', 'MASKED_BRUISER'] as const) {
      for (let i = 0; i < 12; i++) {
        expect(resolveDefaultCombatantProfile(`spawn_${i}`, archetype).carriesBackupSidearm).toBe(true);
      }
    }
  });
});

describe('the handgun goes down with its fighter', () => {
  it('counts only the arm that holds the drawn pistol', () => {
    expect(losesSidearmArm('RIGHT', ['FOREARM_RIGHT'])).toBe(true);
    expect(losesSidearmArm('LEFT', ['HAND_LEFT'])).toBe(true);
    expect(losesSidearmArm('LEFT', ['FOREARM_RIGHT'])).toBe(false);
    expect(losesSidearmArm(null, ['FOREARM_RIGHT'])).toBe(false);
    expect(losesSidearmArm(undefined, ['HAND_RIGHT'])).toBe(false);
  });

  it('shooting off the pistol arm kills; the same wound with the pistol holstered does not', () => {
    const armed = standingTarget('pistol-arm');
    armed.weaponDropped = true;
    armed.sidearmHand = 'RIGHT';
    blastRightForearm(armed);
    expect(RIGHT_ARM.some((z) => armed.severedZones.has(z))).toBe(true);
    expect(armed.alive).toBe(false);

    const holstered = standingTarget('holstered');
    blastRightForearm(holstered);
    expect(RIGHT_ARM.some((z) => holstered.severedZones.has(z))).toBe(true);
    expect(holstered.alive).toBe(true);
  });
});

describe('a dropped long gun is picked back up, not swapped for the pistol', () => {
  const dropped: EnemyArmamentTransitionInput = {
    dt: 1 / 60,
    alive: true,
    rightArmIntact: true,
    leftArmIntact: true,
    preferredPrimaryHand: 'RIGHT',
    intactHand: 'RIGHT',
    weaponDropped: true,
    primaryArmDisarmed: false,
    isRagdollActive: false,
    isAirborneRagdoll: false,
    carriesBackupSidearm: true,
    isGuarding: false,
    isLastStandVital: false,
    sidearmDrawDurationS: 0.6,
  };

  it('does not draw while the gun can be reached, and draws once it cannot', () => {
    const pending = stepEnemyArmamentState({ kind: 'PRIMARY_ARMED', hand: 'RIGHT' }, { ...dropped, primaryPickupPending: true });
    expect(pending.state).toEqual({ kind: 'DISARMED', sidearmDropped: false });
    expect(pending.events).not.toContain('SIDEARM_DRAW_START');

    const out = stepEnemyArmamentState(pending.state, { ...dropped, primaryPickupPending: false });
    expect(out.state.kind).toBe('SIDEARM_DRAWING');
  });

  it('puts back an early draw, but keeps a pistol already out of the holster or drawn', () => {
    const early = stepEnemyArmamentState(
      { kind: 'SIDEARM_DRAWING', hand: 'RIGHT', remainingS: 0.55, totalS: 0.6 },
      { ...dropped, primaryPickupPending: true },
    );
    expect(early.state).toEqual({ kind: 'DISARMED', sidearmDropped: false });

    const late = stepEnemyArmamentState(
      { kind: 'SIDEARM_DRAWING', hand: 'RIGHT', remainingS: 0.2, totalS: 0.6 },
      { ...dropped, primaryPickupPending: true },
    );
    expect(late.state.kind).not.toBe('DISARMED');

    const drawn = stepEnemyArmamentState({ kind: 'SIDEARM_ACTIVE', hand: 'RIGHT' }, { ...dropped, primaryPickupPending: true });
    expect(drawn.state).toEqual({ kind: 'SIDEARM_ACTIVE', hand: 'RIGHT' });
  });

  it('goes for a gun within reach with working limbs, even in the red', () => {
    const t = standingTarget('pickup');
    const agent = {} as EnemyAiAgentRuntime;
    expect(canRecoverDroppedWeapon(t, agent)).toBe(false);
    t.weaponDropped = true;
    // Just dropped, landing spot not yet known: still counts for a moment.
    expect(canRecoverDroppedWeapon(t, agent)).toBe(true);
    agent.droppedGunWaitS = 1;
    expect(canRecoverDroppedWeapon(t, agent)).toBe(false);
    t.droppedWeaponWorld = vec3(t.worldPosition.x + 2, 0, t.worldPosition.z);
    t.currentHp = t.maxHp * 0.1;
    expect(canRecoverDroppedWeapon(t, agent)).toBe(true);
    t.droppedWeaponWorld = vec3(t.worldPosition.x + 9, 0, t.worldPosition.z);
    expect(canRecoverDroppedWeapon(t, agent)).toBe(false);
    t.droppedWeaponWorld = vec3(t.worldPosition.x + 2, 0, t.worldPosition.z);
    t.leftLegFunctional = false;
    expect(canRecoverDroppedWeapon(t, agent)).toBe(false);
  });
});
