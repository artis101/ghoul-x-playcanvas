/**
 * Per-combatant body and nerve, rolled once at spawn so no two enemies take a bullet the same way.
 * Every multiplier is 1.0 for an average person; `NEUTRAL_CONSTITUTION` is that average.
 */
export type ConstitutionTrait =
  /** Nothing unusual. */
  | 'NONE'
  /** Stimulants: pain barely registers; fights on until the body itself gives out. */
  | 'STIM_HEAD'
  /** Folds mentally from a hit that would not stop anyone else. */
  | 'GLASS_JAW'
  /** Big, hard to put down, slow to bleed out. */
  | 'TANK';

export interface CombatantConstitution {
  readonly trait: ConstitutionTrait;
  /** Scales starting HP. */
  readonly toughness: number;
  /** Divides incoming pain; above 1 shrugs hits off, below 1 feels every one. */
  readonly painTolerance: number;
  /** Scales how much adrenaline buffers pain shock. */
  readonly adrenalineResponse: number;
  /** How fast venous and tissue bleeding slows on its own. */
  readonly clotting: number;
  /** Odds and length of fighting on after a wound that will kill them. */
  readonly willToLive: number;
}

export const NEUTRAL_CONSTITUTION: CombatantConstitution = {
  trait: 'NONE',
  toughness: 1,
  painTolerance: 1,
  adrenalineResponse: 1,
  clotting: 1,
  willToLive: 1,
};

/** A wound that will kill, but not yet: the combatant keeps going for `delayS` seconds. */
export interface DelayedLethality {
  readonly delayS: number;
  readonly cause: 'CARDIAC_DESTRUCTION' | 'EXSANGUINATION_CLASS_IV_ARREST';
}

/**
 * What a projectile happened to do inside the body. ICEPICK pencils through, TUMBLE yaws partway in,
 * FRAGMENT breaks up; NOMINAL is the textbook round the solver models without variance.
 */
export type PelletBehavior = 'ICEPICK' | 'NOMINAL' | 'TUMBLE' | 'FRAGMENT';

/** The primary projectile's roll, so the internal organ march can agree with the outer wound. */
export interface TerminalVarianceSummary {
  readonly behavior: PelletBehavior;
  readonly depositScale: number;
  /** The round skated off a rib and never reached the chest cavity. */
  readonly ribGlance: boolean;
}
