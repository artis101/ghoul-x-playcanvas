import * as pc from 'playcanvas';
import type { GhoulZoneId } from '../src/contracts/ballistics.ts';
import type { CombatantGlbInstance } from '../src/engine/assets/glbTypes.ts';
import { readAndParseGlb } from './blenderGlbFixtures.ts';

const { gltf, binChunk } = readAndParseGlb('ghoul_combatant.glb');

// Animation rotations are baked as normalized int16 (see combatant_glb_animation.py); everything
// else is float. Decode both the way PlayCanvas does.
function readFloats(accessorIndex: number, size: number): number[] {
  const accessor = gltf.accessors![accessorIndex];
  const view = gltf.bufferViews![accessor.bufferView!];
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const short = accessor.componentType === 5122;
  const width = short ? 2 : 4;
  const stride = view.byteStride ?? size * width;
  return Array.from({ length: accessor.count * size }, (_, i) => {
    const offset = start + Math.floor(i / size) * stride + (i % size) * width;
    return short ? Math.max(binChunk.readInt16LE(offset) / 32767, -1) : binChunk.readFloatLE(offset);
  });
}

/**
 * Poses a bare bone hierarchy from the shipped combatant GLB with one of its clips, the way
 * PlayCanvas would, so engine code can be run against real authored frames without WebGL.
 */
export function createClipPose(clip: string) {
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

