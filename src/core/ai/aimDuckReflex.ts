import type { TacticalResolveKind } from './tacticalDoctrine.ts';

/**
 * A combatant peeking from cover that sees the player's gun settle on it ducks back for a
 * moment, then pops out again. A cooldown keeps it from hiding forever: a player who holds
 * the angle still gets a shot when it re-peeks. Berserkers never flinch from a muzzle.
 */

// Aim threat needed before the reflex starts counting.
const DUCK_THREAT_THRESHOLD = 0.8;
const DUCK_COOLDOWN_S = 2.2;

interface DuckProfile {
  readonly reactionS: number;
  readonly duckS: number;
}

const DUCK_PROFILES: Readonly<Record<TacticalResolveKind, DuckProfile | null>> = {
  HARDENED_VETERAN: { reactionS: 0.12, duckS: 0.55 },
  GRITTY_REGULAR: { reactionS: 0.2, duckS: 0.8 },
  PANICKED_SCRAPPER: { reactionS: 0.26, duckS: 1.1 },
  FANATIC_BERSERKER: null,
};

export interface AimDuckReflexState {
  aimHeldS: number;
  duckS: number;
  cooldownS: number;
}

export interface AimDuckReflexInput {
  readonly dt: number;
  readonly aimThreat: number;
  readonly resolveProfile: TacticalResolveKind;
  /** Only a combatant with real cover to duck behind uses the reflex. */
  readonly hasCoverToDuckBehind: boolean;
  /** A combatant mid-burst finishes its burst rather than flinching. */
  readonly midBurst: boolean;
}

export function createAimDuckReflexState(): AimDuckReflexState {
  return { aimHeldS: 0, duckS: 0, cooldownS: 0 };
}

/** Advances the reflex and returns true while the combatant should stay tucked in cover. */
export function stepAimDuckReflex(state: AimDuckReflexState, input: AimDuckReflexInput): boolean {
  state.cooldownS = Math.max(0, state.cooldownS - input.dt);
  if (state.duckS > 0) {
    state.duckS = Math.max(0, state.duckS - input.dt);
    if (state.duckS === 0) state.cooldownS = DUCK_COOLDOWN_S;
    return state.duckS > 0 && input.hasCoverToDuckBehind;
  }

  const profile = DUCK_PROFILES[input.resolveProfile];
  if (!profile || !input.hasCoverToDuckBehind || input.midBurst || state.cooldownS > 0) {
    state.aimHeldS = 0;
    return false;
  }

  state.aimHeldS = input.aimThreat >= DUCK_THREAT_THRESHOLD ? state.aimHeldS + input.dt : 0;
  if (state.aimHeldS >= profile.reactionS) {
    state.aimHeldS = 0;
    state.duckS = profile.duckS;
    return true;
  }
  return false;
}
