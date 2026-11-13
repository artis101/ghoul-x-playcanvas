import { describe, expect, it } from 'vitest';
import {
  ARCHETYPE_BUILD_RANGES,
  BODY_BUILD_MORPHS,
  pickBodyBuild,
} from '../src/core/ghoul/anatomy/archetypeBodyBuild';
import type { EnemyArchetypeId } from '../src/contracts/ballistics';

describe('archetype body builds', () => {
  const archetypes = Object.keys(ARCHETYPE_BUILD_RANGES) as EnemyArchetypeId[];

  it('gives the same target the same body every time', () => {
    for (const archetype of archetypes) {
      expect(pickBodyBuild(archetype, 1234)).toEqual(pickBodyBuild(archetype, 1234));
    }
  });

  it('keeps every weight inside its archetype range', () => {
    for (const archetype of archetypes) {
      for (let seed = 0; seed < 200; seed++) {
        const weights = pickBodyBuild(archetype, seed * 7919);
        for (const morph of BODY_BUILD_MORPHS) {
          const [min, max] = ARCHETYPE_BUILD_RANGES[archetype][morph];
          expect(weights[morph]).toBeGreaterThanOrEqual(min);
          expect(weights[morph]).toBeLessThanOrEqual(max);
        }
      }
    }
  });

  it('varies bodies between targets of one archetype', () => {
    const brute = new Set(Array.from({ length: 20 }, (_, i) => pickBodyBuild('MILITIA_GUNNER', i + 1).Build_Brute.toFixed(3)));
    expect(brute.size).toBeGreaterThan(10);
  });
});
