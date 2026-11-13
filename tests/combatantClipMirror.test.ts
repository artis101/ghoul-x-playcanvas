import { describe, expect, it } from 'vitest';
import * as pc from 'playcanvas';
import { readAndParseGlb } from './blenderGlbFixtures.ts';
import {
  addMirroredClips, mirrorBoneName, mirrorSources, mirrorTrack, swapClipSide,
} from '../src/engine/assets/combatantClipMirror.ts';
import { COMBATANT_ANIMATION_CLIPS, COMBATANT_SIDED_CLIPS } from '../src/engine/assets/glbTypes.ts';

type Gltf = ReturnType<typeof readAndParseGlb>['gltf'] & {
  animations?: Array<{ name?: string; channels: Array<{ sampler: number; target: { node: number; path: string } }>;
    samplers: Array<{ input: number; output: number }> }>;
  nodes?: Array<{ name?: string; translation?: number[]; rotation?: number[] }>;
};

const PROPERTY: Record<string, string> = { translation: 'localPosition', rotation: 'localRotation', scale: 'localScale' };
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC3: 3, VEC4: 4 };

const glb = readAndParseGlb('ghoul_combatant.glb');
const gltf = glb.gltf as Gltf;

function floats(accessorIndex: number): Float32Array {
  const acc = gltf.accessors![accessorIndex];
  const view = gltf.bufferViews![acc.bufferView!];
  const offset = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const count = acc.count * COMPONENTS[acc.type];
  const out = new Float32Array(count);
  // Rotations are stored as normalized shorts, everything else as floats.
  if (acc.componentType === 5122) {
    for (let i = 0; i < count; i++) out[i] = Math.max(-1, glb.binChunk.readInt16LE(offset + i * 2) / 32767);
  } else {
    for (let i = 0; i < count; i++) out[i] = glb.binChunk.readFloatLE(offset + i * 4);
  }
  return out;
}

/** Builds the AnimTrack the PlayCanvas glTF parser would, with one-name entity paths. */
function trackOf(name: string): pc.AnimTrack {
  const anim = gltf.animations!.find((a) => a.name === name)!;
  const inputs: pc.AnimData[] = [];
  const outputs: pc.AnimData[] = [];
  const curves = anim.channels.map((channel) => {
    const sampler = anim.samplers[channel.sampler];
    inputs.push(new pc.AnimData(1, floats(sampler.input)));
    const outAcc = gltf.accessors![sampler.output];
    outputs.push(new pc.AnimData(COMPONENTS[outAcc.type], floats(sampler.output)));
    const paths = [{
      entityPath: [gltf.nodes![channel.target.node!].name ?? ''], component: 'graph',
      propertyPath: [PROPERTY[channel.target.path]],
    }];
    return new pc.AnimCurve(paths, inputs.length - 1, outputs.length - 1, pc.INTERPOLATION_LINEAR);
  });
  const duration = Math.max(...inputs.map((i) => i.data[i.data.length - 1]));
  return new pc.AnimTrack(name, duration, inputs, outputs, curves);
}

/** Per bone and property, the keyframe values of a track. */
function channelsOf(track: pc.AnimTrack): Map<string, { components: number; data: ArrayLike<number> }> {
  const map = new Map<string, { components: number; data: ArrayLike<number> }>();
  for (const curve of track.curves) {
    const key = `${curve.paths[0].entityPath.at(-1)}:${curve.paths[0].propertyPath[0]}`;
    map.set(key, track.outputs[curve.output]);
  }
  return map;
}

/** Largest rotation gap in degrees and position gap in metres between two tracks, key by key. */
function trackGap(a: pc.AnimTrack, b: pc.AnimTrack): { degrees: number; metres: number } {
  const ca = channelsOf(a);
  const cb = channelsOf(b);
  let degrees = 0;
  let metres = 0;
  for (const [key, va] of ca) {
    const vb = cb.get(key);
    expect(vb, `${b.name} lacks ${key}`).toBeDefined();
    expect(vb!.data.length).toBe(va.data.length);
    for (let i = 0; i < va.data.length; i += va.components) {
      if (va.components === 4) {
        // Normalized first: the shorts the rotations are stored in leave them a little off unit length.
        let dot = 0;
        let na = 0;
        let nb = 0;
        for (let k = 0; k < 4; k++) {
          dot += va.data[i + k] * vb!.data[i + k];
          na += va.data[i + k] ** 2;
          nb += vb!.data[i + k] ** 2;
        }
        dot /= Math.sqrt(na * nb);
        degrees = Math.max(degrees, (2 * Math.acos(Math.min(1, Math.abs(dot))) * 180) / Math.PI);
      } else {
        let d2 = 0;
        for (let k = 0; k < va.components; k++) d2 += (va.data[i + k] - vb!.data[i + k]) ** 2;
        metres = Math.max(metres, Math.sqrt(d2));
      }
    }
  }
  return { degrees, metres };
}

type Quat = [number, number, number, number];
const qmul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
function qrot(q: Quat, v: number[]): number[] {
  const r = qmul(qmul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]);
  return [r[0], r[1], r[2]];
}

/** Model-space bone positions at every keyframe of a track (one-name entity paths). */
function worldPositions(track: pc.AnimTrack): Array<Map<string, number[]>> {
  const channels = channelsOf(track);
  const nodes = gltf.nodes as Array<{ name?: string; translation?: number[]; rotation?: number[]; children?: number[] }>;
  const parent = new Map<number, number>();
  nodes.forEach((n, i) => n.children?.forEach((c) => parent.set(c, i)));
  const bones = nodes.map((n, i) => [n, i] as const).filter(([n]) => n.name?.startsWith('Bone_'));
  const keys = channels.get('Bone_PELVIS_GROIN:localRotation')!.data.length / 4;
  const frames: Array<Map<string, number[]>> = [];
  for (let k = 0; k < keys; k++) {
    const world = new Map<number, { q: Quat; p: number[] }>();
    const visit = (i: number): { q: Quat; p: number[] } => {
      const known = world.get(i);
      if (known) return known;
      const n = nodes[i];
      const rot = channels.get(`${n.name}:localRotation`);
      const pos = channels.get(`${n.name}:localPosition`);
      const lq = (rot ? Array.from(rot.data).slice(k * 4, k * 4 + 4) : n.rotation ?? [0, 0, 0, 1]) as Quat;
      const lp = pos ? Array.from(pos.data).slice(k * 3, k * 3 + 3) : n.translation ?? [0, 0, 0];
      const up = parent.has(i) ? visit(parent.get(i)!) : { q: [0, 0, 0, 1] as Quat, p: [0, 0, 0] };
      const off = qrot(up.q, lp);
      const result = { q: qmul(up.q, lq), p: [up.p[0] + off[0], up.p[1] + off[1], up.p[2] + off[2]] };
      world.set(i, result);
      return result;
    };
    frames.push(new Map(bones.map(([n, i]) => [n.name!, visit(i).p])));
  }
  return frames;
}

const has = (name: string): boolean => gltf.animations!.some((a) => a.name === name);

describe('combatant clip mirroring', () => {
  it('swaps bone and clip sides', () => {
    expect(mirrorBoneName('Bone_HAND_RIGHT')).toBe('Bone_HAND_LEFT');
    expect(mirrorBoneName('Bone_THIGH_LEFT')).toBe('Bone_THIGH_RIGHT');
    expect(mirrorBoneName('Bone_PELVIS_GROIN')).toBe('Bone_PELVIS_GROIN');
    expect(swapClipSide('StrafeLeft')).toBe('StrafeRight');
    expect(swapClipSide('HitFlinchArmRight')).toBe('HitFlinchArmLeft');
    expect(swapClipSide('WalkBackward')).toBe('WalkBackward');
  });

  it('covers every southpaw twin and every mirrored sided clip', () => {
    const sources = mirrorSources();
    for (const clip of COMBATANT_ANIMATION_CLIPS) expect(sources.has(`${clip}_Southpaw`)).toBe(true);
    for (const clip of COMBATANT_SIDED_CLIPS.filter((c) => c.endsWith('Left'))) {
      expect(sources.get(clip), clip).toBe(clip.replace(/Left$/, 'Right'));
    }
    for (const source of sources.values()) {
      expect([...COMBATANT_ANIMATION_CLIPS, ...COMBATANT_SIDED_CLIPS] as string[]).toContain(source);
    }
  });

  it('leaves the symmetric rest pose unchanged', () => {
    const byName = new Map(gltf.nodes!.map((n) => [n.name, n]));
    for (const node of gltf.nodes!) {
      if (!node.name?.startsWith('Bone_')) continue;
      const twin = byName.get(mirrorBoneName(node.name))!;
      const t = node.translation ?? [0, 0, 0];
      const r = node.rotation ?? [0, 0, 0, 1];
      const tw = twin.translation ?? [0, 0, 0];
      const rw = twin.rotation ?? [0, 0, 0, 1];
      expect(-t[0]).toBeCloseTo(tw[0], 3);
      expect(t[1]).toBeCloseTo(tw[1], 3);
      expect(t[2]).toBeCloseTo(tw[2], 3);
      // q and -q are the same rotation (the jaw's rest is a half turn).
      const mirrored = [r[0], -r[1], -r[2], r[3]];
      const dot = mirrored.reduce((sum, v, k) => sum + v * rw[k], 0);
      expect(Math.abs(dot), node.name).toBeCloseTo(1, 3);
    }
  });

  it('mirroring twice gives the clip back', () => {
    const walk = trackOf('Walk');
    const gap = trackGap(walk, mirrorTrack(mirrorTrack(walk, 'x'), 'Walk'));
    expect(gap.degrees).toBeLessThan(0.01);
    expect(gap.metres).toBeLessThan(1e-6);
  });

  // The GLB ships one side only; every clip the game mirrors must have its source baked.
  it('ships each mirror source and none of the mirrors', () => {
    for (const [clip, source] of mirrorSources()) {
      expect(has(source), `${source} (for ${clip})`).toBe(true);
      expect(has(clip), `${clip} is made at load, not baked`).toBe(false);
    }
  });

  // A mirrored clip must be the source's mirror image in model space: every bone where its twin
  // was, reflected across X = 0. Checked by forward kinematics on real clips, every keyframe.
  it('reflects the whole body across the midline', () => {
    for (const clip of ['LongGunAim', 'Walk', 'StumpDrawRight', 'SeatedPistolAim', 'LegLossRight']) {
      const source = worldPositions(trackOf(clip));
      const mirrored = worldPositions(mirrorTrack(trackOf(clip), `${clip}_mirror`));
      let worst = 0;
      for (let key = 0; key < source.length; key++) {
        for (const [bone, p] of source[key]) {
          const q = mirrored[key].get(mirrorBoneName(bone))!;
          worst = Math.max(worst, Math.hypot(-p[0] - q[0], p[1] - q[1], p[2] - q[2]));
        }
      }
      expect(worst, clip).toBeLessThan(1e-4);
    }
  });

  it('only fills in clips the GLB lacks', () => {
    const walk = trackOf('Walk');
    const tracks = new Map([['Walk', walk]]);
    expect(addMirroredClips(tracks)).toEqual(['Walk_Southpaw']);
    const baked = mirrorTrack(walk, 'Walk_Southpaw');
    const withTwin = new Map([['Walk', walk], ['Walk_Southpaw', baked]]);
    expect(addMirroredClips(withTwin)).toEqual([]);
    expect(withTwin.get('Walk_Southpaw')).toBe(baked);
  });
});
