import type { ShotSimulationReport, TargetHealthState } from '../../../contracts/ballistics.ts';

/**
 * How a killed combatant goes down. Mostly they just drop; now and then one goes with a bit of
 * theatre. Anatomy decides first: a destroyed brain or spine switches the body off on the spot,
 * and a contact-range blast throws it.
 * - CRUMPLE: legs fold and the body drops where it stood.
 * - KNOCKBACK: the shot's own momentum carries it over.
 * - DRAMATIC: a twisting, spinning fall.
 */
export type DeathFallStyle = 'CRUMPLE' | 'KNOCKBACK' | 'DRAMATIC';

/** Horizontal shot impulse (N·s) above which the blast itself decides the fall. */
const HEAVY_KNOCKBACK_IMPULSE = 230;

export function chooseDeathFallStyle(target: TargetHealthState, report: ShotSimulationReport): DeathFallStyle {
  const cnsDestroyed =
    report.rupturedOrgans.includes('Brain (Cerebrum & Brainstem)') ||
    report.shatteredBones.includes('Cervical Spine (C1-C7)') ||
    report.dismembermentEvents.some((d) => d.goreMode === 'CRANIAL_POP');
  if (cnsDestroyed) return 'CRUMPLE';

  const imp = report.ragdollPlan.netRootImpulseWorld;
  if (Math.hypot(imp.x, imp.z) >= HEAVY_KNOCKBACK_IMPULSE) return 'KNOCKBACK';

  // Deterministic per combatant and per wound count, so replays and tests are stable.
  const roll = hashString(`${target.targetId}:${target.surfaceWounds.length}`) % 100;
  if (roll < 55) return 'CRUMPLE';
  if (roll < 85) return 'KNOCKBACK';
  return 'DRAMATIC';
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
