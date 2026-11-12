import * as pc from 'playcanvas';
import { describe, expect, it } from 'vitest';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import type { GhoulZoneId } from '../src/contracts/ballistics.ts';
import type { GlbModelRegistry } from '../src/engine/assets/glbLoader.ts';
import type { CombatantGlbInstance } from '../src/engine/assets/glbTypes.ts';
import { CombatantWeaponMount } from '../src/engine/mannequin/combatantWeaponMount.ts';
import { readAndParseGlb } from './blenderGlbFixtures.ts';

const { gltf, binChunk } = readAndParseGlb('ghoul_combatant.glb');

function readFloats(accessorIndex: number, size: number): number[] {
  const accessor = gltf.accessors![accessorIndex];
  const view = gltf.bufferViews![accessor.bufferView!];
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = view.byteStride ?? size * 4;
  return Array.from({ length: accessor.count * size }, (_, i) =>
    binChunk.readFloatLE(start + Math.floor(i / size) * stride + i % size * 4));
}

function createIdlePose(clip: string) {
  const nodes = gltf.nodes!.map((source) => {
    const node = new pc.GraphNode(source.name);
    if (source.translation) node.setLocalPosition(...source.translation);
    if (source.rotation) node.setLocalRotation(...source.rotation);
    if (source.scale) node.setLocalScale(...source.scale);
    return node;
  });
  const root = new pc.GraphNode('Combatant');
  gltf.nodes!.forEach((source, index) => {
    for (const child of source.children ?? []) nodes[index].addChild(nodes[child]);
  });
  for (const node of nodes) {
    if (!node.parent) root.addChild(node);
  }

  const animation = gltf.animations!.find((entry) => entry.name === clip)!;
  const inputs: pc.AnimData[] = [];
  const outputs: pc.AnimData[] = [];
  const curves: pc.AnimCurve[] = [];
  const times = new Set<number>();
  const properties = { translation: 'localPosition', rotation: 'localRotation', scale: 'localScale' } as const;
  for (const { sampler, target } of animation.channels) {
    const { input, output } = animation.samplers[sampler];
    const property = properties[target.path as keyof typeof properties];
    const size = property === 'localRotation' ? 4 : 3;
    const keys = readFloats(input, 1);
    keys.forEach((time) => times.add(time));
    const index = inputs.length;
    inputs.push(new pc.AnimData(1, keys));
    outputs.push(new pc.AnimData(size, readFloats(output, size)));
    const path = nodes[target.node!].path.split('/').slice(1);
    curves.push(new pc.AnimCurve([{ entityPath: path, component: 'graph', propertyPath: [property] }], index, index, pc.INTERPOLATION_LINEAR));
  }
  const frames = Array.from(times).sort((a, b) => a - b);
  const track = new pc.AnimTrack(clip, frames[frames.length - 1], inputs, outputs, curves);
  const evaluator = new pc.AnimEvaluator(new pc.DefaultAnimBinder(root));
  const idle = new pc.AnimClip(track, 0, 1, false, false);
  evaluator.addClip(idle);
  const boneNodes = new Map<GhoulZoneId, pc.GraphNode>(nodes
    .filter((node) => node.name.startsWith('Bone_'))
    .map((node) => [node.name.slice(5) as GhoulZoneId, node]));
  return {
    glb: { boneNodes, rootEntity: root, animComponent: { baseLayer: { activeState: clip } } } as CombatantGlbInstance,
    frames,
    sample(time: number) {
      idle.time = time;
      evaluator.update(0);
    },
  };
}

function expectM4Grip(
  holder: pc.Entity, hand: pc.GraphNode, side: 'RIGHT' | 'LEFT', trigger: boolean, time: number,
): void {
  const inverse = new pc.Mat4().invert(holder.getWorldTransform());
  const palm = hand.up.clone().mulScalar(trigger ? 0.052 : 0.05).add(hand.getPosition());
  const expectedPalm = new pc.Vec3(side === 'RIGHT' ? 0.027 : -0.027, trigger ? -0.05 : -0.054, trigger ? 0.023 : -0.272);
  const thumb = inverse.transformVector(hand.getRotation().transformVector(pc.Vec3.BACK)).normalize();
  const expectedThumb = trigger ? new pc.Vec3(0, 0.94, -0.342) : pc.Vec3.UP;
  const actualPalm = inverse.transformPoint(palm);
  if (!trigger) {
    // The support palm slides along the handguard to wherever the arm reaches comfortably.
    expect(actualPalm.z, `${side} rail, t=${time}`).toBeGreaterThan(-0.36);
    expect(actualPalm.z, `${side} rail, t=${time}`).toBeLessThan(-0.2);
    expectedPalm.z = actualPalm.z;
  }
  expect(actualPalm.distance(expectedPalm), `${side} palm, t=${time}`).toBeLessThan(0.01);
  expect(thumb.dot(expectedThumb), `${side} thumb, t=${time}`).toBeGreaterThan(0.99);
}

describe('Combat Ready Idle held prop', () => {
  it.each(['CombatReadyIdle', 'CombatReadyIdle_Southpaw'])('keeps the gun stable across every authored frame of %s', (clip) => {
    const pose = createIdlePose(clip);
    const canvas = { width: 1, height: 1 };
    const app = new pc.Application(canvas as HTMLCanvasElement, {
      graphicsDevice: new pc.NullGraphicsDevice(canvas),
    });
    try {
      const mount = new CombatantWeaponMount();
      const state = createTargetHealthState('idle', 'Idle', pc.Vec3.ZERO, 0, 'MILITIA_GUNNER', clip.endsWith('_Southpaw'));
      expect(pose.frames.length).toBe(75);
      for (const weaponId of ['m4a1_carbine', 'm590_shotgun', 'msg90_sniper', 'silver_talon_50ae'] as const) {
        const holder = new pc.Entity('Held item', app);
        const registry = {
          isLoaded: () => true,
          instantiateWeapon: () => ({
            weaponId, rootEntity: holder, boneNodes: new Map(), fireClipName: null, destroy: () => holder.destroy(),
          }),
        } as unknown as GlbModelRegistry;
        mount.attachGlbWeaponIfReady(registry, state, app.root, weaponId);
        const supportSide = state.isLeftHanded ? 'RIGHT' : 'LEFT';
        const triggerSide = state.isLeftHanded ? 'LEFT' : 'RIGHT';
        const chest = pose.glb.boneNodes.get('TORSO_UPPER_THORAX')!;
        const elbow = pose.glb.boneNodes.get(`FOREARM_${supportSide}`)!;
        const supportHand = pose.glb.boneNodes.get(`HAND_${supportSide}`)!;
        const triggerHand = pose.glb.boneNodes.get(`HAND_${triggerSide}`)!;
        const barrelPoint = new pc.Vec3(0, 0, -0.5);
        const positions = pose.frames.map((time) => {
          pose.sample(time);
          mount.syncWeaponPosition(state, pose.glb);
          if (weaponId !== 'silver_talon_50ae') {
            // The support elbow stays clear of the vest: either ahead of it or out beside it.
            const ahead = elbow.getPosition().z - chest.getPosition().z;
            const beside = Math.abs(elbow.getPosition().x - chest.getPosition().x);
            expect(Math.max(ahead - 0.15, beside - 0.2), `${weaponId}, t=${time}`).toBeGreaterThan(0);
          }
          if (weaponId === 'm4a1_carbine') {
            expectM4Grip(holder, supportHand, supportSide, false, time);
            expectM4Grip(holder, triggerHand, triggerSide, true, time);
          }
          return holder.getWorldTransform().transformPoint(barrelPoint);
        });
        for (const [index, position] of positions.entries()) {
          const next = positions[(index + 1) % positions.length];
          expect(position.distance(next), `${weaponId}, frame ${index}`).toBeLessThan(0.03);
        }
        mount.destroy();
      }
    } finally {
      app.destroy();
    }
  });
});
