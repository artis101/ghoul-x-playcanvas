import { describe, expect, it } from 'vitest';
import {
  AIM_CLIP_BARREL_YAW_DEG, aimClipFacingYawRad, CombatantAimFacing, layeredFacingYawRad,
} from '../src/engine/mannequin/combatantAimFacing.ts';
import { UPPER_BODY_LAYER } from '../src/engine/mannequin/combatantUpperBodyLayer.ts';
import { readAndParseGlb } from './blenderGlbFixtures.ts';

type V3 = [number, number, number];
type Q = [number, number, number, number];

const glb = readAndParseGlb('ghoul_combatant.glb');
const gltf = glb.gltf as unknown as {
  nodes: Array<{ name?: string; children?: number[]; translation?: V3; rotation?: Q }>;
  animations: Array<{ name: string; channels: Array<{ sampler: number; target: { node: number; path: string } }>; samplers: Array<{ input: number; output: number }> }>;
  accessors: Array<{ bufferView: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean }>;
  bufferViews: Array<{ byteOffset?: number; byteStride?: number }>;
};

const COMPONENTS: Record<number, [number, (b: Buffer, o: number) => number, number]> = {
  5126: [4, (b, o) => b.readFloatLE(o), 1],
  5122: [2, (b, o) => b.readInt16LE(o), 32767],
  5120: [1, (b, o) => b.readInt8(o), 127],
};

function readRow(accessor: number, row: number): number[] {
  const a = gltf.accessors[accessor];
  const bv = gltf.bufferViews[a.bufferView];
  const n = a.type === 'SCALAR' ? 1 : a.type === 'VEC3' ? 3 : 4;
  const [size, read, div] = COMPONENTS[a.componentType];
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0) + row * (bv.byteStride ?? size * n);
  return Array.from({ length: n }, (_, k) => Math.max(-1, read(glb.binChunk, base + k * size) / div));
}

const parent = new Map<number, number>();
gltf.nodes.forEach((node, i) => node.children?.forEach((c) => parent.set(c, i)));
const nodeIndex = (name: string): number => gltf.nodes.findIndex((n) => n.name === name);

function qmul(a: Q, b: Q): Q {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function qrot(q: Q, v: V3): V3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** The hand bone's world rotation at the clip's last frame (the held aim). */
function handRotationAtEnd(clip: string, hand: 'RIGHT' | 'LEFT'): Q {
  const anim = gltf.animations.find((a) => a.name === clip);
  expect(anim, clip).toBeDefined();
  const local = gltf.nodes.map((n) => (n.rotation ?? [0, 0, 0, 1]) as Q);
  for (const ch of anim!.channels) {
    if (ch.target.path !== 'rotation') continue;
    const s = anim!.samplers[ch.sampler];
    local[ch.target.node] = readRow(s.output, gltf.accessors[s.output].count - 1) as Q;
  }
  let i = nodeIndex(`Bone_HAND_${hand}`);
  let q = local[i];
  while (parent.has(i)) {
    i = parent.get(i)!;
    q = qmul(local[i], q);
  }
  return q;
}

// The one-handed fist grip's barrel in the right hand bone's frame (sidearmFistGrip.ts).
const ONE_HAND_BARREL: V3 = [0, 0.92, -0.38];

function barrelHeadingDeg(clip: string, hand: 'RIGHT' | 'LEFT'): number {
  const local: V3 = hand === 'RIGHT' ? ONE_HAND_BARREL : [-ONE_HAND_BARREL[0], ONE_HAND_BARREL[1], ONE_HAND_BARREL[2]];
  const d = qrot(handRotationAtEnd(clip, hand), local);
  return (Math.atan2(d[0], d[2]) * 180) / Math.PI;
}

describe('aim clip facing turn', () => {
  it('matches the barrel angle the baked one-handed clips hold', () => {
    for (const [clip, deg] of Object.entries(AIM_CLIP_BARREL_YAW_DEG)) {
      expect(Math.abs(barrelHeadingDeg(clip, 'RIGHT') - deg), clip).toBeLessThan(6);
    }
  });

  it('turns the root so the barrel lands on the facing, for both hands', () => {
    for (const clip of Object.keys(AIM_CLIP_BARREL_YAW_DEG)) {
      // The `_Southpaw` twin is the clip mirrored at load (combatantClipMirror.ts): its barrel
      // heading is the negative of the baked one.
      const baked = barrelHeadingDeg(clip, 'RIGHT');
      for (const [state, heading] of [[clip, baked], [`${clip}_Southpaw`, -baked]] as const) {
        const world = heading + (aimClipFacingYawRad(state) * 180) / Math.PI;
        expect(Math.abs(world), state).toBeLessThan(6);
      }
    }
    expect(aimClipFacingYawRad('PistolAim')).toBe(0);
    expect(aimClipFacingYawRad('LongGunAim_Southpaw')).toBe(0);
    expect(aimClipFacingYawRad(null)).toBe(0);
  });

  it('takes the upper layer turn by its weight and eases the body round', () => {
    const anim = {
      baseLayer: { name: 'Base', activeState: 'Walk', weight: 1 },
      layers: [] as Array<{ name: string; activeState: string; weight: number }>,
    };
    anim.layers = [anim.baseLayer, { name: UPPER_BODY_LAYER, activeState: 'PistolAimOneHand', weight: 0.5 }];
    const fake = { animComponent: anim } as unknown as Parameters<typeof layeredFacingYawRad>[0];
    expect(layeredFacingYawRad(fake)).toBeCloseTo(aimClipFacingYawRad('PistolAimOneHand') * 0.5, 6);

    anim.layers[1].weight = 1;
    const facing = new CombatantAimFacing();
    const first = facing.update(fake, true, 1 / 60);
    expect(Math.abs(first)).toBeGreaterThan(0);
    expect(Math.abs(first)).toBeLessThan(Math.abs(aimClipFacingYawRad('PistolAimOneHand')));
    for (let i = 0; i < 120; i++) facing.update(fake, true, 1 / 60);
    expect(facing.yawRad).toBeCloseTo(aimClipFacingYawRad('PistolAimOneHand'), 3);
    // Dead, the body no longer blades its aim.
    for (let i = 0; i < 120; i++) facing.update(fake, false, 1 / 60);
    expect(facing.yawRad).toBeCloseTo(0, 3);
  });
});
