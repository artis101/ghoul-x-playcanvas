import { describe, expect, it } from 'vitest';
import { createTargetHealthState } from '../src/core/ghoul/anatomy/targetHealthState.ts';
import { DOWNED_RECOVERY_S, stepDownedRecovery } from '../src/core/ballistics/triage/downedRecovery.ts';

function downed(hpFraction: number) {
  const hs = createTargetHealthState('t', 'T', { x: 0, y: 0, z: 0 });
  hs.currentHp = hs.maxHp * hpFraction;
  hs.isRagdollActive = true;
  hs.posture = 'RAGDOLL_GROUNDED';
  hs.woundedPhase = 'DOWNED_AGONY';
  return hs;
}

describe('downed recovery', () => {
  it('a wounded downed fighter gets back up after the timeout', () => {
    const hs = downed(0.6);
    expect(stepDownedRecovery(hs, DOWNED_RECOVERY_S - 1)).toBe(false);
    expect(hs.isRagdollActive).toBe(true);
    expect(stepDownedRecovery(hs, 2)).toBe(true);
    expect(hs.isRagdollActive).toBe(false);
    expect(hs.alive).toBe(true);
    expect(hs.posture).toBe('COMBAT_READY');
    expect(hs.woundedPhase).toBe('NONE');
  });

  it('a mortally wounded downed fighter stays down', () => {
    const hs = downed(0.2);
    expect(stepDownedRecovery(hs, DOWNED_RECOVERY_S * 3)).toBe(false);
    expect(hs.isRagdollActive).toBe(true);
  });
});
