import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_GHOUL_ZONES } from '../src/core/ghoul/anatomy.ts';
import {
  ALL_GLB_ASSET_KEYS,
  COMBATANT_ANIMATION_CLIPS,
  parseConnectivityGraphJson,
} from '../src/engine/assets/glbLoader.ts';

interface GltfAccessor {
  bufferView?: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}

interface GltfMeshPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
}

interface GltfMesh {
  name?: string;
  primitives: GltfMeshPrimitive[];
}

interface GltfNode {
  name?: string;
  mesh?: number;
  skin?: number;
  children?: number[];
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}

interface GltfSkin {
  name?: string;
  joints: number[];
  inverseBindMatrices?: number;
}

interface GltfAnimation {
  name?: string;
  channels: Array<{ sampler: number; target: { node?: number; path: string } }>;
  samplers: Array<{ input: number; output: number; interpolation?: string }>;
}

interface GltfMaterial {
  name?: string;
  pbrMetallicRoughness?: Record<string, unknown>;
}

interface ParsedGltfJson {
  asset: { version: string; generator?: string };
  nodes?: GltfNode[];
  meshes?: GltfMesh[];
  skins?: GltfSkin[];
  animations?: GltfAnimation[];
  materials?: GltfMaterial[];
  accessors?: GltfAccessor[];
}

interface ParsedGlbFile {
  byteLength: number;
  jsonChunkByteLength: number;
  binChunkByteLength: number;
  gltf: ParsedGltfJson;
}

const MODELS_DIR = path.resolve(process.cwd(), 'public', 'models');
const BLEND_SOURCES_DIR = path.join(MODELS_DIR, 'blend_sources');

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_TYPE_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_TYPE_BIN = 0x004e4942; // 'BIN\0'

function readAndParseGlb(filename: string): ParsedGlbFile {
  const fullPath = path.join(MODELS_DIR, filename);
  expect(fs.existsSync(fullPath), `Missing GLB file: ${fullPath}`).toBe(true);

  const buf = fs.readFileSync(fullPath);
  expect(buf.byteLength).toBeGreaterThan(28);

  const magic = buf.readUInt32LE(0);
  const version = buf.readUInt32LE(4);
  const totalLength = buf.readUInt32LE(8);

  expect(magic).toBe(GLB_MAGIC);
  expect(version).toBe(2);
  expect(totalLength).toBe(buf.byteLength);

  const jsonChunkLen = buf.readUInt32LE(12);
  const jsonChunkType = buf.readUInt32LE(16);
  expect(jsonChunkType).toBe(CHUNK_TYPE_JSON);
  expect(20 + jsonChunkLen).toBeLessThanOrEqual(buf.byteLength);

  const jsonText = buf.subarray(20, 20 + jsonChunkLen).toString('utf8');
  const gltf = JSON.parse(jsonText) as ParsedGltfJson;
  expect(gltf.asset.version).toBe('2.0');

  const binOffset = 20 + jsonChunkLen;
  expect(binOffset + 8).toBeLessThanOrEqual(buf.byteLength);
  const binChunkLen = buf.readUInt32LE(binOffset);
  const binChunkType = buf.readUInt32LE(binOffset + 4);
  expect(binChunkType).toBe(CHUNK_TYPE_BIN);
  expect(binChunkLen).toBeGreaterThan(0);

  return {
    byteLength: buf.byteLength,
    jsonChunkByteLength: jsonChunkLen,
    binChunkByteLength: binChunkLen,
    gltf,
  };
}

describe('Headless Blender 5.2.1 LTS GLB & Voronoi Fracture Asset Pipeline', () => {
  it('exports all 8 valid glTF 2.0 binaries within runtime budgets plus native .blend sources', () => {
    for (const key of ALL_GLB_ASSET_KEYS) {
      const parsed = readAndParseGlb(`${key}.glb`);
      expect(parsed.byteLength).toBeGreaterThan(15 * 1024);
      expect(parsed.byteLength).toBeLessThan(2 * 1024 * 1024);
      expect((parsed.gltf.meshes ?? []).length).toBeGreaterThan(0);
      expect((parsed.gltf.materials ?? []).length).toBeGreaterThan(0);
    }

    for (const blendName of [
      'ghoul_combatant.blend',
      'weapons_arsenal.blend',
      'concrete_wall_fractured.blend',
    ]) {
      const blendPath = path.join(BLEND_SOURCES_DIR, blendName);
      expect(fs.existsSync(blendPath), `Missing .blend file: ${blendPath}`).toBe(true);
      const stat = fs.statSync(blendPath);
      expect(stat.size).toBeGreaterThan(50 * 1024);
    }
  });

  it('ghoul_combatant.glb contains 22 sculpted Zone_* submeshes, armor/X-ray organs, 22-bone skin, and 5 NLA animations', () => {
    const { gltf } = readAndParseGlb('ghoul_combatant.glb');
    const nodes = gltf.nodes ?? [];
    const meshes = gltf.meshes ?? [];
    const accessors = gltf.accessors ?? [];
    const skins = gltf.skins ?? [];
    const animations = gltf.animations ?? [];

    const nodeNames = new Set(nodes.map((n) => n.name ?? ''));
    const meshByName = new Map(meshes.map((m) => [m.name ?? '', m]));

    let globalMinY = Number.POSITIVE_INFINITY;
    let globalMaxY = Number.NEGATIVE_INFINITY;

    // 1. All 22 GHOUL Zone submeshes exist, are skinned, UV-mapped, and sculpted (not 8-vert / 24-vert unit cubes)
    for (const zone of ALL_GHOUL_ZONES) {
      const zoneMeshName = `Zone_${zone}`;
      expect(nodeNames.has(zoneMeshName), `Missing node ${zoneMeshName}`).toBe(true);
      const mesh = meshByName.get(zoneMeshName);
      expect(mesh, `Missing mesh ${zoneMeshName}`).toBeDefined();
      expect(mesh!.primitives.length).toBeGreaterThanOrEqual(1);

      let totalVertsInZone = 0;
      for (const prim of mesh!.primitives) {
        expect(prim.attributes.POSITION).toBeDefined();
        expect(prim.attributes.NORMAL).toBeDefined();
        expect(prim.attributes.TEXCOORD_0).toBeDefined();
        expect(prim.attributes.JOINTS_0).toBeDefined();
        expect(prim.attributes.WEIGHTS_0).toBeDefined();

        const posAcc = accessors[prim.attributes.POSITION];
        totalVertsInZone += posAcc.count;
        if (posAcc.min && posAcc.max) {
          globalMinY = Math.min(globalMinY, posAcc.min[1]);
          globalMaxY = Math.max(globalMaxY, posAcc.max[1]);
        }
      }
      expect(totalVertsInZone, `${zoneMeshName} must be sculpted (>40 verts)`).toBeGreaterThan(40);
    }

    // Grounded at y ≈ 0.00m and ~1.80m tall
    expect(globalMinY).toBeGreaterThanOrEqual(-0.02);
    expect(globalMinY).toBeLessThanOrEqual(0.03);
    expect(globalMaxY).toBeGreaterThan(1.76);
    expect(globalMaxY).toBeLessThan(1.86);

    // 2. Toggleable Gear & Internal X-Ray Anatomy submeshes
    const requiredExtraMeshes = [
      'Gear_ESAPI_PlateCarrier',
      'Gear_PASGT_Helmet',
      'Organ_Brain',
      'Organ_Heart',
      'Organ_Lungs',
      'Organ_Liver',
      'Skelet_Skull',
      'Skelet_RibcageSpine',
      'Skelet_Pelvis',
    ];
    for (const extraName of requiredExtraMeshes) {
      expect(nodeNames.has(extraName), `Missing node ${extraName}`).toBe(true);
      expect(meshByName.has(extraName), `Missing mesh ${extraName}`).toBe(true);
    }

    // 3. 22-Bone Armature skinning
    expect(skins.length).toBeGreaterThanOrEqual(1);
    const ghoulSkin = skins[0];
    expect(ghoulSkin.joints.length).toBe(22);
    for (const zone of ALL_GHOUL_ZONES) {
      expect(nodeNames.has(`Bone_${zone}`), `Missing joint Bone_${zone}`).toBe(true);
    }

    // 4. All 5 Baked NLA Animation Clips
    const animNames = new Set(animations.map((a) => a.name ?? ''));
    for (const expectedClip of COMBATANT_ANIMATION_CLIPS) {
      expect(animNames.has(expectedClip), `Missing animation clip ${expectedClip}`).toBe(true);
      const clip = animations.find((a) => a.name === expectedClip)!;
      expect(clip.channels.length).toBeGreaterThan(10);
      expect(clip.samplers.length).toBeGreaterThan(10);
    }
  });

  it('weapon GLBs contain expected armature bones, -Z viewmodel muzzle alignment, and Idle/Fire*/Reload* clips', () => {
    const weaponExpectations: Array<{
      file: string;
      requiredBones: string[];
      fireClip: string;
      reloadClip: string;
      expectMuzzleSocket: boolean;
    }> = [
      {
        file: 'm590_shotgun.glb',
        requiredBones: ['Bone_Root', 'Bone_Pump', 'Bone_Bolt', 'Bone_Shell'],
        fireClip: 'FirePump',
        reloadClip: 'ReloadShell',
        expectMuzzleSocket: true,
      },
      {
        file: 'silver_talon_50ae.glb',
        requiredBones: ['Bone_Root', 'Bone_Slide', 'Bone_Mag', 'Bone_Hammer'],
        fireClip: 'FireBlowback',
        reloadClip: 'ReloadMag',
        expectMuzzleSocket: true,
      },
      {
        file: 'msg90_sniper.glb',
        requiredBones: ['Bone_Root', 'Bone_Mag', 'Bone_ChargingHandle', 'Bone_Bolt'],
        fireClip: 'FireRecoil',
        reloadClip: 'ReloadMag',
        expectMuzzleSocket: true,
      },
      {
        file: 'm4a1_carbine.glb',
        requiredBones: ['Bone_Root', 'Bone_Mag', 'Bone_Bolt', 'Bone_ChargingHandle'],
        fireClip: 'FireCycle',
        reloadClip: 'ReloadMag',
        expectMuzzleSocket: true,
      },
      {
        file: 'frag_grenade.glb',
        requiredBones: ['Bone_Body', 'Bone_Spoon', 'Bone_PinRing'],
        fireClip: 'FirePinPull',
        reloadClip: 'ReloadReady',
        expectMuzzleSocket: false,
      },
    ];

    for (const spec of weaponExpectations) {
      const { gltf } = readAndParseGlb(spec.file);
      const nodes = gltf.nodes ?? [];
      const animations = gltf.animations ?? [];
      const nodeByName = new Map(nodes.map((n) => [n.name ?? '', n]));

      for (const boneName of spec.requiredBones) {
        expect(nodeByName.has(boneName), `${spec.file} missing ${boneName}`).toBe(true);
      }

      const meshes = gltf.meshes ?? [];
      const accessors = gltf.accessors ?? [];
      let minMeshZ = Number.POSITIVE_INFINITY;
      for (const m of meshes) {
        for (const p of m.primitives) {
          const posAcc = accessors[p.attributes.POSITION];
          if (posAcc?.min) {
            minMeshZ = Math.min(minMeshZ, posAcc.min[2]);
          }
        }
      }

      if (spec.expectMuzzleSocket) {
        const muzzle = nodeByName.get('Bone_Muzzle');
        expect(muzzle, `${spec.file} missing Bone_Muzzle`).toBeDefined();
        expect(muzzle!.translation).toBeDefined();
        const [mx, my, mz] = muzzle!.translation!;
        // Bone_Muzzle sits at the barrel tip (>0.25m along Bone_Root's forward axis),
        // and the skinned weapon barrel geometry extends down PlayCanvas -Z (minMeshZ < -0.25m)!
        expect(Math.hypot(mx, my, mz)).toBeGreaterThan(0.25);
        expect(minMeshZ).toBeLessThan(-0.25);
      }

      const animNames = new Set(animations.map((a) => a.name ?? ''));
      expect(animNames.has('Idle'), `${spec.file} missing Idle`).toBe(true);
      expect(animNames.has(spec.fireClip), `${spec.file} missing ${spec.fireClip}`).toBe(true);
      expect(animNames.has(spec.reloadClip), `${spec.file} missing ${spec.reloadClip}`).toBe(true);
    }
  });

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
