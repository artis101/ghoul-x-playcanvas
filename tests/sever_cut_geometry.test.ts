import { describe, expect, it } from 'vitest';
import type { RagdollBoneState, SeverCut, WoundChannelEvent } from '../src/contracts/ballistics.ts';
import {
  buildCutCapGeometry,
  buildJaggedRim,
  computeSeverCut,
  createCutSurface,
  CUT_SIDE_DISTAL,
  CUT_SIDE_PROXIMAL,
  cutHeightAt,
  findBoneCrossing,
  partitionMeshByCut,
  severCutWorldPoint,
} from '../src/core/ghoul/severCut/index.ts';

// A forearm hanging straight down: elbow at y=1.2, wrist at y=0.94 (26 cm bone).
const forearm: Pick<RagdollBoneState, 'position' | 'distalPosition' | 'basisRight' | 'basisUp' | 'basisForward'> = {
  position: { x: 0.3, y: 1.2, z: 0 },
  distalPosition: { x: 0.3, y: 0.94, z: 0 },
  basisRight: { x: 1, y: 0, z: 0 },
  basisUp: { x: 0, y: -1, z: 0 },
  basisForward: { x: 0, y: 0, z: -1 },
};

function wound(entry: { x: number; y: number; z: number }, exit: { x: number; y: number; z: number }, extra: Partial<WoundChannelEvent> = {}): WoundChannelEvent {
  return {
    ghoulZone: 'FOREARM_RIGHT',
    entryPointWorld: entry,
    exitPointWorld: exit,
    impactDirectionWorld: { x: exit.x - entry.x, y: exit.y - entry.y, z: exit.z - entry.z },
    entryEnergyJ: 1800,
    armorStopped: false,
    ...extra,
  } as WoundChannelEvent;
}

const sampleCut: SeverCut = {
  alongFraction: 0.5,
  entryLocal: { x: 0, y: 0.13, z: 0.04 },
  shotDirLocal: { x: 0, y: 0, z: -1 },
  seed: 1234567,
};

/** A 12-sided tube of 6 rings along +Y, radius 4.5 cm, 0..0.25 m. */
function tube(): { positions: Float32Array; indices: number[] } {
  const sides = 12;
  const rings = 6;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      positions.push(Math.cos(a) * 0.045, (r / (rings - 1)) * 0.25, Math.sin(a) * 0.045);
    }
  }
  for (let r = 0; r + 1 < rings; r++) {
    for (let s = 0; s < sides; s++) {
      const a = r * sides + s;
      const b = r * sides + ((s + 1) % sides);
      indices.push(a, b, a + sides, b, b + sides, a + sides);
    }
  }
  return { positions: Float32Array.from(positions), indices };
}

describe('sever cut placement', () => {
  it('finds where a wound channel crosses the bone', () => {
    const crossing = findBoneCrossing(forearm.position, forearm.distalPosition, { x: 0.3, y: 1.07, z: 0.2 }, { x: 0.3, y: 1.07, z: -0.2 });
    expect(crossing.boneFraction).toBeCloseTo(0.5, 3);
    expect(crossing.missM).toBeCloseTo(0, 4);
  });

  it('places a mid-forearm cut mid-forearm, not at the elbow', () => {
    const cut = computeSeverCut('FOREARM_RIGHT', forearm, [wound({ x: 0.3, y: 1.07, z: 0.2 }, { x: 0.3, y: 1.07, z: -0.2 })]);
    expect(cut).not.toBeNull();
    expect(cut!.alongFraction).toBeCloseTo(0.5, 2);
    const stump = severCutWorldPoint(forearm, cut!);
    expect(stump.y).toBeCloseTo(1.07, 2);
    // Bullet travelled toward -Z world, which is +Z in this bone's basis.
    expect(cut!.shotDirLocal.z).toBeCloseTo(1, 3);
  });

  it('clamps cuts off the joints and ignores channels that missed or were stopped', () => {
    const nearElbow = computeSeverCut('FOREARM_RIGHT', forearm, [wound({ x: 0.3, y: 1.199, z: 0.2 }, { x: 0.3, y: 1.199, z: -0.2 })]);
    expect(nearElbow!.alongFraction).toBeGreaterThanOrEqual(0.06);
    expect(computeSeverCut('FOREARM_RIGHT', forearm, [wound({ x: 0.6, y: 1.07, z: 0.2 }, { x: 0.6, y: 1.07, z: -0.2 })])).toBeNull();
    expect(computeSeverCut('FOREARM_RIGHT', forearm, [wound({ x: 0.3, y: 1.07, z: 0.2 }, { x: 0.3, y: 1.07, z: -0.2 }, { armorStopped: true })])).toBeNull();
  });

  it('is deterministic for the same impact', () => {
    const w = [wound({ x: 0.31, y: 1.05, z: 0.2 }, { x: 0.29, y: 1.06, z: -0.2 })];
    expect(computeSeverCut('FOREARM_RIGHT', forearm, w)).toEqual(computeSeverCut('FOREARM_RIGHT', forearm, w));
  });
});

describe('jagged cut surface', () => {
  it('tears the rim into irregular Voronoi steps', () => {
    const rim = buildJaggedRim(98765, 0);
    const depths = rim.map((s) => s.depthScale);
    const spread = Math.max(...depths) - Math.min(...depths);
    expect(spread).toBeGreaterThan(0.4);
    for (let i = 1; i < rim.length; i++) expect(rim[i].angle).toBeGreaterThanOrEqual(rim[i - 1].angle);
    for (const s of rim) {
      expect(s.radiusScale).toBeGreaterThan(0.85);
      expect(s.radiusScale).toBeLessThan(1.15);
    }
    expect(buildJaggedRim(98765, 0)).toEqual(rim);
    expect(buildJaggedRim(98766, 0)).not.toEqual(rim);
  });

  it('stays near the cut height in the middle and ragged at the skin', () => {
    const surface = createCutSurface(sampleCut, 0.13, 0, 0, 0.045);
    expect(cutHeightAt(surface, 0, 0)).toBeCloseTo(0.13, 6);
    const atSkin = Array.from({ length: 24 }, (_, i) => {
      const a = (i / 24) * Math.PI * 2;
      return cutHeightAt(surface, Math.cos(a) * 0.045, Math.sin(a) * 0.045);
    });
    expect(Math.max(...atSkin) - Math.min(...atSkin)).toBeGreaterThan(0.015);
    for (const h of atSkin) expect(Math.abs(h - 0.13)).toBeLessThan(0.09);
  });
});

describe('mesh partition along the cut', () => {
  it('splits a limb tube into a stump and a piece without shared vertices', () => {
    const { positions, indices } = tube();
    const surface = createCutSurface(sampleCut, 0.13, 0, 0, 0.045);
    const part = partitionMeshByCut(positions, indices, surface);
    expect(part.proximalTriangles).toBeGreaterThan(0);
    expect(part.distalTriangles).toBeGreaterThan(0);
    expect(part.proximalTriangles + part.distalTriangles).toBe(indices.length / 3);
    expect(part.sourceVertex.length).toBeGreaterThan(positions.length / 3);
    for (let t = 0; t < part.indices.length; t += 3) {
      const side = part.vertexSide[part.indices[t]];
      expect(part.vertexSide[part.indices[t + 1]]).toBe(side);
      expect(part.vertexSide[part.indices[t + 2]]).toBe(side);
    }
    // The bottom ring stays on the stump, the top ring goes with the piece.
    for (let v = 0; v < part.sourceVertex.length; v++) {
      const y = positions[part.sourceVertex[v] * 3 + 1];
      if (y === 0) expect(part.vertexSide[v]).toBe(CUT_SIDE_PROXIMAL);
      if (y === 0.25) expect(part.vertexSide[v]).toBe(CUT_SIDE_DISTAL);
    }
    expect(part.maxStraddleSpanM).toBeGreaterThan(0);
  });
});

describe('wound cap geometry', () => {
  it('builds matching stump and piece caps facing away from each other', () => {
    const surface = createCutSurface(sampleCut, 0.13, 0, 0, 0.045);
    const stump = buildCutCapGeometry(surface, { facing: 1, skirtM: 0.04, boneCount: 2, seed: sampleCut.seed });
    const piece = buildCutCapGeometry(surface, { facing: -1, skirtM: 0.04, boneCount: 2, seed: sampleCut.seed });
    for (const cap of [stump, piece]) {
      expect(cap.meat.indices.length % 3).toBe(0);
      expect(cap.meat.positions.length).toBe(cap.meat.normals.length);
      expect(cap.bone.indices.length).toBeGreaterThan(0);
      for (const v of cap.meat.positions) expect(Number.isFinite(v)).toBe(true);
    }
    const meanNormalY = (n: number[]): number => {
      let sum = 0;
      for (let i = 1; i < n.length; i += 3) sum += n[i];
      return sum / (n.length / 3);
    };
    expect(meanNormalY(stump.meat.normals)).toBeGreaterThan(0.2);
    expect(meanNormalY(piece.meat.normals)).toBeLessThan(-0.2);
    // Bone ends stand proud of the meat on each side.
    const maxY = (p: number[]): number => Math.max(...p.filter((_, i) => i % 3 === 1));
    const minY = (p: number[]): number => Math.min(...p.filter((_, i) => i % 3 === 1));
    expect(maxY(stump.bone.positions)).toBeGreaterThan(0.13);
    expect(minY(piece.bone.positions)).toBeLessThan(0.13);
  });
});
