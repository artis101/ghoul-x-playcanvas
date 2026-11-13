import type { EnemyArchetypeId } from '../../../contracts/ballistics/ghoulZoneContracts';

/**
 * Body-build morph targets baked into the combatant GLB (see scripts/blender/combatant_body.py).
 * Each spawn mixes them, so one mesh gives a lean, a brute or a heavy-bellied body.
 */
export const BODY_BUILD_MORPHS = ['Build_Lean', 'Build_Brute', 'Build_Belly'] as const;
export type BodyBuildMorph = (typeof BODY_BUILD_MORPHS)[number];

export type BodyBuildWeights = Readonly<Record<BodyBuildMorph, number>>;

type Range = readonly [min: number, max: number];

/** Per-archetype weight ranges. The base mesh is the heavy build from the character sheets. */
export const ARCHETYPE_BUILD_RANGES: Readonly<Record<EnemyArchetypeId, Readonly<Record<BodyBuildMorph, Range>>>> = {
  // Wiry street fighter.
  SKINHEAD_PUNK: { Build_Lean: [0.35, 0.75], Build_Brute: [0, 0], Build_Belly: [0, 0.2] },
  // "The Muscle": the heaviest of them.
  MILITIA_GUNNER: { Build_Lean: [0, 0], Build_Brute: [0.15, 0.55], Build_Belly: [0, 0.15] },
  // "Bear": heavy, sometimes thick round the middle.
  MASKED_BRUISER: { Build_Lean: [0, 0], Build_Brute: [0, 0.35], Build_Belly: [0, 0.35] },
  // Stays near the base so the plate carrier keeps fitting.
  HEAVY_ENFORCER: { Build_Lean: [0, 0.15], Build_Brute: [0, 0.2], Build_Belly: [0, 0.15] },
  // Lean operative.
  SNIPER_OPERATIVE: { Build_Lean: [0.5, 0.9], Build_Brute: [0, 0], Build_Belly: [0, 0.1] },
};

/** Deterministic per-target weights: the same id always gets the same body. */
export function pickBodyBuild(archetype: EnemyArchetypeId, seed: number): BodyBuildWeights {
  const ranges = ARCHETYPE_BUILD_RANGES[archetype] ?? ARCHETYPE_BUILD_RANGES.MILITIA_GUNNER;
  let state = (seed >>> 0) || 1;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  const out = {} as Record<BodyBuildMorph, number>;
  for (const morph of BODY_BUILD_MORPHS) {
    const [min, max] = ranges[morph];
    out[morph] = min + (max - min) * next();
  }
  return out;
}
