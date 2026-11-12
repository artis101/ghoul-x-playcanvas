import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConnectivityGraphJson } from '../src/engine/assets/glbLoader.ts';
import { MODELS_DIR, readAndParseGlb } from './blenderGlbFixtures.ts';

describe('Blender destruction assets', () => {
  it('concrete_wall_fractured.glb + connectivity JSON match 1-to-1 with symmetric Voronoi edges & anchored base', () => {
    const { gltf } = readAndParseGlb('concrete_wall_fractured.glb');
    const connPath = path.join(MODELS_DIR, 'concrete_wall_connectivity.json');
    expect(fs.existsSync(connPath)).toBe(true);

    const rawJson: unknown = JSON.parse(fs.readFileSync(connPath, 'utf8'));
    const graph = parseConnectivityGraphJson(rawJson);

    expect(graph.version).toBe(1);
    expect(graph.wallId).toBe('concrete_barrier_v1');
    // Requirement: 32-40 seeded 3D Voronoi cells
    expect(graph.nodes.length).toBeGreaterThanOrEqual(32);
    expect(graph.nodes.length).toBeLessThanOrEqual(40);

    const nodes = gltf.nodes ?? [];
    const meshes = gltf.meshes ?? [];
    const accessors = gltf.accessors ?? [];
    const nodeByName = new Map(nodes.map((n) => [n.name ?? '', n]));
    const meshByName = new Map(meshes.map((m) => [m.name ?? '', m]));

    expect(nodeByName.has('IntactConcreteWall')).toBe(true);
    expect(meshByName.has('IntactConcreteWall')).toBe(true);

    const chunkGltfNodes = nodes.filter((n) => (n.name ?? '').startsWith('Chunk_'));
    expect(chunkGltfNodes.length).toBe(graph.nodes.length);

    let anchoredCount = 0;
    let totalMassKg = 0;

    for (const cNode of graph.nodes) {
      const gltfNode = nodeByName.get(cNode.name);
      const gltfMesh = meshByName.get(cNode.name);
      expect(gltfNode, `Missing GLB node ${cNode.name}`).toBeDefined();
      expect(gltfMesh, `Missing GLB mesh ${cNode.name}`).toBeDefined();

      // Single primitive per Voronoi chunk for single-draw HardwareInstancedPool compatibility
      expect(gltfMesh!.primitives.length).toBe(1);
      const prim = gltfMesh!.primitives[0];
      expect(prim.attributes.POSITION).toBeDefined();
      expect(prim.attributes.NORMAL).toBeDefined();
      expect(prim.attributes.TEXCOORD_0).toBeDefined();
      expect(prim.attributes.COLOR_0).toBeDefined();

      // Verify local chunk vertices are centered around (0, 0, 0)
      const posAcc = accessors[prim.attributes.POSITION];
      expect(posAcc.min).toBeDefined();
      expect(posAcc.max).toBeDefined();
      const midX = 0.5 * (posAcc.min![0] + posAcc.max![0]);
      const midY = 0.5 * (posAcc.min![1] + posAcc.max![1]);
      const midZ = 0.5 * (posAcc.min![2] + posAcc.max![2]);
      expect(Math.abs(midX)).toBeLessThan(1e-3);
      expect(Math.abs(midY)).toBeLessThan(1e-3);
      expect(Math.abs(midZ)).toBeLessThan(1e-3);

      // Verify GLB node translation matches JSON localCenter
      const tr = gltfNode!.translation ?? [0, 0, 0];
      expect(tr[0]).toBeCloseTo(cNode.localCenter.x, 3);
      expect(tr[1]).toBeCloseTo(cNode.localCenter.y, 3);
      expect(tr[2]).toBeCloseTo(cNode.localCenter.z, 3);

      const minY = cNode.localCenter.y - cNode.halfExtents.y;
      if (minY <= 0.05) {
        expect(cNode.isAnchored).toBe(true);
      }
      if (cNode.isAnchored) {
        anchoredCount++;
      }

      totalMassKg += cNode.massKg;
      expect(cNode.edges.length).toBeGreaterThan(0);

      // Verify 100% symmetric undirected neighbor edges
      for (const edge of cNode.edges) {
        expect(edge.severed).toBe(false);
        expect(edge.neighborIndex).not.toBe(cNode.index);
        const neighbor = graph.nodes[edge.neighborIndex];
        expect(neighbor).toBeDefined();
        const reverseEdge = neighbor.edges.find((e) => e.neighborIndex === cNode.index);
        expect(reverseEdge, `Missing symmetric edge ${neighbor.name} -> ${cNode.name}`).toBeDefined();
        expect(reverseEdge!.breakThresholdJ).toBeCloseTo(edge.breakThresholdJ, 3);
      }
    }

    expect(anchoredCount).toBeGreaterThanOrEqual(5);
    // 3.6m * 2.4m * 0.28m * 2400 kg/m^3 = 5,806.08 kg
    expect(totalMassKg).toBeGreaterThan(5700);
    expect(totalMassKg).toBeLessThan(5900);

    // Verify full structural BFS reachability from anchored ground chunks
    const visited = new Set<number>();
    const queue: number[] = [];
    for (const n of graph.nodes) {
      if (n.isAnchored) {
        visited.add(n.index);
        queue.push(n.index);
      }
    }
    while (queue.length > 0) {
      const curr = queue.shift()!;
      for (const e of graph.nodes[curr].edges) {
        if (!visited.has(e.neighborIndex)) {
          visited.add(e.neighborIndex);
          queue.push(e.neighborIndex);
        }
      }
    }
    expect(visited.size).toBe(graph.nodes.length);
  });

  it('debris_pack.glb exports 3 beveled brick variants and 3 jagged wood-splinter meshes ready for instancing', () => {
    const { gltf } = readAndParseGlb('debris_pack.glb');
    const meshes = gltf.meshes ?? [];
    const accessors = gltf.accessors ?? [];
    const meshByName = new Map(meshes.map((m) => [m.name ?? '', m]));

    for (const expectedName of [
      'Brick_0',
      'Brick_1',
      'Brick_2',
      'Splinter_0',
      'Splinter_1',
      'Splinter_2',
    ]) {
      const mesh = meshByName.get(expectedName);
      expect(mesh, `Missing debris mesh ${expectedName}`).toBeDefined();
      expect(mesh!.primitives.length).toBe(1);

      const prim = mesh!.primitives[0];
      expect(prim.attributes.POSITION).toBeDefined();
      expect(prim.attributes.NORMAL).toBeDefined();
      expect(prim.attributes.TEXCOORD_0).toBeDefined();

      const posAcc = accessors[prim.attributes.POSITION];
      expect(posAcc.count).toBeGreaterThanOrEqual(24);
    }
  });
});
