import type { CombatantConstitution, ConstitutionTrait } from '../../contracts/combatantConstitution.ts';
import { rollRange } from '../random/seededRng.ts';

/** Rough share of each standout trait in a squad; the rest are ordinary. */
const TRAIT_ODDS: ReadonlyArray<readonly [ConstitutionTrait, number]> = [
  ['STIM_HEAD', 0.1],
  ['GLASS_JAW', 0.1],
  ['TANK', 0.08],
];

function pickTrait(rng: () => number): ConstitutionTrait {
  let roll = rng();
  for (const [trait, odds] of TRAIT_ODDS) {
    if (roll < odds) return trait;
    roll -= odds;
  }
  return 'NONE';
}

/**
 * Rolls one combatant's body and nerve. Ordinary people spread around 1.0 on every axis;
 * a trait then pushes the axes it is about well past that spread.
 */
export function rollConstitution(rng: () => number): CombatantConstitution {
  const trait = pickTrait(rng);
  let toughness = rollRange(rng, 0.85, 1.2);
  let painTolerance = rollRange(rng, 0.75, 1.3);
  let adrenalineResponse = rollRange(rng, 0.8, 1.25);
  let clotting = rollRange(rng, 0.6, 1.4);
  let willToLive = rollRange(rng, 0.7, 1.3);

  switch (trait) {
    case 'STIM_HEAD':
      painTolerance *= 2.2;
      adrenalineResponse *= 1.4;
      willToLive *= 1.5;
      clotting *= 0.8;
      break;
    case 'GLASS_JAW':
      painTolerance *= 0.45;
      willToLive *= 0.5;
      break;
    case 'TANK':
      toughness *= 1.35;
      painTolerance *= 1.3;
      clotting *= 1.3;
      willToLive *= 1.3;
      break;
    case 'NONE':
      break;
  }

  return { trait, toughness, painTolerance, adrenalineResponse, clotting, willToLive };
}
