import { describe, expect, it } from 'vitest';
import {
  stepEnemyArmamentState,
  type EnemyArmamentTransitionInput,
} from '../src/core/ai/enemyArmamentFsm.ts';

const downed: EnemyArmamentTransitionInput = {
  dt: 1 / 60,
  alive: true,
  rightArmIntact: true,
  leftArmIntact: true,
  preferredPrimaryHand: 'RIGHT',
  intactHand: 'RIGHT',
  weaponDropped: true,
  primaryArmDisarmed: false,
  isRagdollActive: true,
  isAirborneRagdoll: false,
  carriesBackupSidearm: true,
  isGuarding: false,
  isLastStandVital: true,
  sidearmDrawDurationS: 0.6,
};

describe('enemy armament while downed', () => {
  it('gives a grounded combatant its backup sidearm', () => {
    const result = stepEnemyArmamentState({ kind: 'PRIMARY_ARMED', hand: 'RIGHT' }, downed);
    expect(result.state).toEqual({ kind: 'SIDEARM_ACTIVE', hand: 'RIGHT' });
    expect(result.statusTag).toBe('LAST_STAND');
  });

  it('keeps the sidearm when the downed body is knocked into the air again', () => {
    const grounded = stepEnemyArmamentState({ kind: 'PRIMARY_ARMED', hand: 'RIGHT' }, downed).state;
    const airborne = stepEnemyArmamentState(grounded, { ...downed, isAirborneRagdoll: true });
    expect(airborne.state).toEqual({ kind: 'SIDEARM_ACTIVE', hand: 'RIGHT' });
    expect(airborne.statusTag).toBe('LAST_STAND');
    const landed = stepEnemyArmamentState(airborne.state, downed);
    expect(landed.state).toEqual({ kind: 'SIDEARM_ACTIVE', hand: 'RIGHT' });
  });

  it('does not hand a sidearm to a body still in its first fall', () => {
    const result = stepEnemyArmamentState(
      { kind: 'PRIMARY_ARMED', hand: 'RIGHT' }, { ...downed, isAirborneRagdoll: true },
    );
    expect(result.state.kind).toBe('PRIMARY_ARMED');
  });
});
