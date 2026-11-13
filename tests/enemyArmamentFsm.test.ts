import { describe, expect, it } from 'vitest';
import {
  stepEnemyArmamentState,
  type EnemyArmamentState,
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

function drawFully(input: EnemyArmamentTransitionInput): EnemyArmamentState {
  let state: EnemyArmamentState = { kind: 'PRIMARY_ARMED', hand: 'RIGHT' };
  for (let i = 0; i < 60; i++) state = stepEnemyArmamentState(state, input).state;
  return state;
}

describe('enemy armament while downed', () => {
  it('draws the backup sidearm on the floor rather than having it appear in the hand', () => {
    const first = stepEnemyArmamentState({ kind: 'PRIMARY_ARMED', hand: 'RIGHT' }, downed);
    expect(first.state.kind).toBe('SIDEARM_DRAWING');
    expect(first.events).toContain('SIDEARM_DRAW_START');
    const drawn = drawFully(downed);
    expect(drawn).toEqual({ kind: 'SIDEARM_ACTIVE', hand: 'RIGHT' });
    expect(stepEnemyArmamentState(drawn, downed).statusTag).toBe('LAST_STAND');
  });

  it('never fires the long gun from the floor: no sidearm means disarmed', () => {
    const result = stepEnemyArmamentState(
      { kind: 'PRIMARY_ARMED', hand: 'RIGHT' }, { ...downed, carriesBackupSidearm: false, weaponDropped: false },
    );
    expect(result.state.kind).toBe('DISARMED');
    expect(result.dropPrimaryWeapon).toBe(true);
    // Letting go of the rifle on the floor is not an arm wound.
    expect(result.markPrimaryArmDisarmed).toBe(false);
  });

  it('keeps the pistol holstered while the wounded sequence says HOLSTER, and puts back a half-drawn one', () => {
    const held = stepEnemyArmamentState({ kind: 'PRIMARY_ARMED', hand: 'RIGHT' }, { ...downed, sidearmRule: 'HOLSTER' });
    expect(held.state).toEqual({ kind: 'DISARMED', sidearmDropped: false });
    expect(held.events).not.toContain('SIDEARM_DRAW_START');
    const putBack = stepEnemyArmamentState(
      { kind: 'SIDEARM_DRAWING', hand: 'RIGHT', remainingS: 0.3 }, { ...downed, sidearmRule: 'HOLSTER' },
    );
    expect(putBack.state).toEqual({ kind: 'DISARMED', sidearmDropped: false });
    // Once allowed again it can still come out.
    const later = stepEnemyArmamentState(putBack.state, downed);
    expect(later.state.kind).toBe('SIDEARM_DRAWING');
  });

  it('lets go of a drawn pistol for good when the sequence says DROP (face down, crawling)', () => {
    const drawn = drawFully(downed);
    const dropped = stepEnemyArmamentState(drawn, { ...downed, sidearmRule: 'DROP' });
    expect(dropped.state).toEqual({ kind: 'DISARMED', sidearmDropped: true });
    expect(stepEnemyArmamentState(dropped.state, downed).state).toEqual({ kind: 'DISARMED', sidearmDropped: true });
  });

  it('keeps the sidearm when the downed body is knocked into the air again', () => {
    const grounded = drawFully(downed);
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

  it('a standing mortally wounded fighter keeps its rifle: LAST STAND is only a label', () => {
    const standing = stepEnemyArmamentState(
      { kind: 'PRIMARY_ARMED', hand: 'RIGHT' },
      { ...downed, isRagdollActive: false, weaponDropped: false },
    );
    expect(standing.state.kind).toBe('PRIMARY_ARMED');
    expect(standing.statusTag).toBe('LAST_STAND');
  });
});
