import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pc from 'playcanvas';
import { describe, expect, it } from 'vitest';
import { AmmoSpec, GhoulZoneId } from '../src/contracts/ballistics.ts';
import { applyShotReportToTarget, simulateShot } from '../src/core/ballistics/solver.ts';
import { add, normalize, sub, vec3 } from '../src/core/ballistics/vec3.ts';
import {
  AMMO_50AE_FMJ_SOLID,
  AMMO_556_NATO_M855,
  DEFAULT_ENVIRONMENT,
  WEAPON_M4A1,
  WEAPON_SILVER_TALON,
} from '../src/core/ballistics/weapons.ts';
import {
  ALL_GHOUL_ZONES,
  createTargetHealthState,
  LEFT_HANDED_PROBABILITY,
  updateStandingCombatPose,
} from '../src/core/ghoul/anatomy.ts';
import {
  ALL_GLB_ASSET_KEYS,
  COMBATANT_ANIMATION_CLIPS,
  GlbModelRegistry,
  parseConnectivityGraphJson,
  WEAPON_ASSET_IDS,
} from '../src/engine/assets/glbLoader.ts';
import { GoreAndBallisticsFxManager } from '../src/engine/goreFx.ts';
import { GhoulMannequinEntity } from '../src/engine/mannequin.ts';
import { getOrCreateMaterials } from '../src/engine/materials.ts';

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}

interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
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
  bufferViews?: GltfBufferView[];
}

interface ParsedGlbFile {
  byteLength: number;
  jsonChunkByteLength: number;
  binChunkByteLength: number;
  binChunk: Buffer;
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
  const binChunk = buf.subarray(binOffset + 8, binOffset + 8 + binChunkLen);

  return {
    byteLength: buf.byteLength,
    jsonChunkByteLength: jsonChunkLen,
    binChunkByteLength: binChunkLen,
    binChunk,
    gltf,
  };
}

function readVec4AccessorRow(
  binChunk: Buffer,
  bufferViews: GltfBufferView[],
  acc: GltfAccessor,
  rowIndex: number
): [number, number, number, number] {
  const bv = bufferViews[acc.bufferView!];
  const baseOffset = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  if (acc.componentType === 5126) {
    // FLOAT (4 bytes * 4)
    const stride = bv.byteStride ?? 16;
    const off = baseOffset + rowIndex * stride;
    return [
      binChunk.readFloatLE(off),
      binChunk.readFloatLE(off + 4),
      binChunk.readFloatLE(off + 8),
      binChunk.readFloatLE(off + 12),
    ];
  }
  if (acc.componentType === 5121) {
    // UNSIGNED_BYTE (1 byte * 4)
    const stride = bv.byteStride ?? 4;
    const off = baseOffset + rowIndex * stride;
    const norm = acc.type === 'VEC4' ? 1 : 1;
    return [
      binChunk.readUInt8(off) * norm,
      binChunk.readUInt8(off + 1) * norm,
      binChunk.readUInt8(off + 2) * norm,
      binChunk.readUInt8(off + 3) * norm,
    ];
  }
  if (acc.componentType === 5123) {
    // UNSIGNED_SHORT (2 bytes * 4)
    const stride = bv.byteStride ?? 8;
    const off = baseOffset + rowIndex * stride;
    return [
      binChunk.readUInt16LE(off),
      binChunk.readUInt16LE(off + 2),
      binChunk.readUInt16LE(off + 4),
      binChunk.readUInt16LE(off + 6),
    ];
  }
  throw new Error(`Unsupported VEC4 componentType ${acc.componentType}`);
}

describe('Headless Blender 5.2.1 LTS GLB & Voronoi Fracture Asset Pipeline', () => {
  it('exports valid glTF 2.0 binaries within runtime budgets plus native .blend sources', () => {
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

  it('exports a baked viewmodel arm for each grip used by the runtime', () => {
    const { gltf } = readAndParseGlb('viewmodel_arms.glb');
    const expected = WEAPON_ASSET_IDS.flatMap((weapon) =>
      weapon === 'frag_grenade' ? [`${weapon}_r`] : [`${weapon}_r`, `${weapon}_l`]
    );
    const armNodes = (gltf.nodes ?? []).filter((node) => node.mesh !== undefined);
    expect(armNodes.map((node) => node.name).sort()).toEqual(expected.sort());
    expect(armNodes.every((node) => node.skin === undefined)).toBe(true);
  });

  it('ghoul_combatant.glb contains 35 sculpted submeshes, single-bone severable weights, and 10 right-handed + southpaw NLA animations', () => {
    const { gltf, binChunk } = readAndParseGlb('ghoul_combatant.glb');
    const nodes = gltf.nodes ?? [];
    const meshes = gltf.meshes ?? [];
    const accessors = gltf.accessors ?? [];
    const bufferViews = gltf.bufferViews ?? [];
    const skins = gltf.skins ?? [];
    const animations = gltf.animations ?? [];

    const nodeNames = new Set(nodes.map((n) => n.name ?? ''));
    const meshByName = new Map(meshes.map((m) => [m.name ?? '', m]));

    expect(skins.length).toBeGreaterThanOrEqual(1);
    const ghoulSkin = skins[0];
    expect(ghoulSkin.joints.length).toBe(22);
    const jointNameBySkinIdx = ghoulSkin.joints.map((nodeIdx) => nodes[nodeIdx]?.name ?? '');

    let globalMinY = Number.POSITIVE_INFINITY;
    let globalMaxY = Number.NEGATIVE_INFINITY;

    // 1. All 22 GHOUL Zone submeshes exist, are skinned, UV-mapped, sculpted, and severable zones bind 100% to their own bone
    for (const zone of ALL_GHOUL_ZONES) {
      const zoneMeshName = `Zone_${zone}`;
      expect(nodeNames.has(zoneMeshName), `Missing node ${zoneMeshName}`).toBe(true);
      const mesh = meshByName.get(zoneMeshName);
      expect(mesh, `Missing mesh ${zoneMeshName}`).toBeDefined();
      expect(mesh!.primitives.length).toBeGreaterThanOrEqual(1);

      const isSeverableOrHeadZone =
        zone !== 'PELVIS_GROIN' &&
        zone !== 'TORSO_LOWER_ABDOMEN' &&
        zone !== 'TORSO_UPPER_THORAX' &&
        zone !== 'SHOULDER_LEFT' &&
        zone !== 'SHOULDER_RIGHT';
      let totalVertsInZone = 0;

      for (const prim of mesh!.primitives) {
        expect(prim.attributes.POSITION).toBeDefined();
        expect(prim.attributes.NORMAL).toBeDefined();
        expect(prim.attributes.TEXCOORD_0).toBeDefined();
        expect(prim.attributes.JOINTS_0).toBeDefined();
        expect(prim.attributes.WEIGHTS_0).toBeDefined();

        const posAcc = accessors[prim.attributes.POSITION];
        const jointsAcc = accessors[prim.attributes.JOINTS_0];
        const weightsAcc = accessors[prim.attributes.WEIGHTS_0];

        totalVertsInZone += posAcc.count;
        if (posAcc.min && posAcc.max) {
          globalMinY = Math.min(globalMinY, posAcc.min[1]);
          globalMaxY = Math.max(globalMaxY, posAcc.max[1]);
        }

        // Critical Dismemberment Invariant: every severable Zone_* vertex MUST have 100% weight
        // on `Bone_${zone}` (zero secondary bone weights) so severed GLB limbs never stretch back to BODY!
        if (isSeverableOrHeadZone) {
          for (let vIdx = 0; vIdx < weightsAcc.count; vIdx++) {
            const jRow = readVec4AccessorRow(binChunk, bufferViews, jointsAcc, vIdx);
            const wRow = readVec4AccessorRow(binChunk, bufferViews, weightsAcc, vIdx);
            const scaleFactor =
              weightsAcc.componentType === 5121
                ? 1 / 255
                : weightsAcc.componentType === 5123
                  ? 1 / 65535
                  : 1;
            const w0 = wRow[0] * scaleFactor;
            const wSecondary = (wRow[1] + wRow[2] + wRow[3]) * scaleFactor;
            expect(w0, `${zoneMeshName} v${vIdx} primary weight`).toBeGreaterThan(0.999);
            expect(wSecondary, `${zoneMeshName} v${vIdx} secondary bleed`).toBeLessThan(0.001);
            expect(jointNameBySkinIdx[jRow[0]]).toBe(`Bone_${zone}`);
          }
        }
      }
      expect(totalVertsInZone, `${zoneMeshName} must be sculpted (>40 verts)`).toBeGreaterThan(40);
    }

    // Grounded flat at y ≈ 0.00m and ~1.80m tall
    expect(globalMinY).toBeGreaterThanOrEqual(-0.005);
    expect(globalMinY).toBeLessThanOrEqual(0.02);
    expect(globalMaxY).toBeGreaterThan(1.76);
    expect(globalMaxY).toBeLessThan(1.86);

    // 2. Toggleable Gear (Archetype Headgear + Eviscerated Gut) & Internal X-Ray Anatomy submeshes (13 extra = 35 total)
    const requiredExtraMeshes = [
      'Gear_ESAPI_PlateCarrier',
      'Gear_PASGT_Helmet',
      'Gear_TacticalVisor',
      'Gear_SpetsnazBeret',
      'Gear_PunkMohawk',
      'Gear_EvisceratedGut',
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
    expect(meshes.length).toBe(35);

    // 3. 22-Bone Armature skinning
    for (const zone of ALL_GHOUL_ZONES) {
      expect(nodeNames.has(`Bone_${zone}`), `Missing joint Bone_${zone}`).toBe(true);
    }

    // 4. All 10 Baked NLA Animation Clips (5 Right-Handed default + 5 Southpaw left-handed)
    const animNames = new Set(animations.map((a) => a.name ?? ''));
    expect(animations.length).toBe(10);
    for (const expectedClip of COMBATANT_ANIMATION_CLIPS) {
      expect(animNames.has(expectedClip), `Missing right-handed clip ${expectedClip}`).toBe(true);
      const southpawClipName = `${expectedClip}_Southpaw`;
      expect(animNames.has(southpawClipName), `Missing southpaw clip ${southpawClipName}`).toBe(true);

      const rhClip = animations.find((a) => a.name === expectedClip)!;
      const lhClip = animations.find((a) => a.name === southpawClipName)!;
      expect(rhClip.channels.length).toBeGreaterThan(10);
      expect(lhClip.channels.length).toBeGreaterThan(10);
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

  it('enforces ~87.5% right-handed / 12.5% southpaw probability, handedness-aware wound clutching, and trigger-hand disarm', () => {
    expect(LEFT_HANDED_PROBABILITY).toBeGreaterThanOrEqual(0.10);
    expect(LEFT_HANDED_PROBABILITY).toBeLessThanOrEqual(0.15);

    // Deterministic Monte Carlo check over 2,000 draws using LCG
    let seed = 0x5f3759df;
    let southpawCount = 0;
    const totalSamples = 2000;
    for (let i = 0; i < totalSamples; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const u = seed / 0x100000000;
      if (u < LEFT_HANDED_PROBABILITY) {
        southpawCount++;
      }
    }
    const empiricalRate = southpawCount / totalSamples;
    expect(empiricalRate).toBeGreaterThan(0.09);
    expect(empiricalRate).toBeLessThan(0.16);

    // Right-handed default (isLeftHanded = false) vs Southpaw (isLeftHanded = true) wound clutching
    const rhTarget = createTargetHealthState('rh_test', 'RightHanded', vec3(0, 0, 0), 0, 'MILITIA_GUNNER', false);
    const lhTarget = createTargetHealthState('lh_test', 'Southpaw', vec3(0, 0, 0), 0, 'MILITIA_GUNNER', true);
    expect(rhTarget.isLeftHanded).toBe(false);
    expect(lhTarget.isLeftHanded).toBe(true);

    rhTarget.posture = 'THROAT_CLUTCH';
    lhTarget.posture = 'THROAT_CLUTCH';
    updateStandingCombatPose(rhTarget, 1.0);
    updateStandingCombatPose(lhTarget, 1.0);

    // Facing +Z: right-handed holds gun in HAND_LEFT (-X, anatomical right) and clutches throat with HAND_RIGHT (+X, anatomical left);
    // southpaw holds gun in HAND_RIGHT (+X, anatomical left) and clutches throat with HAND_LEFT (-X, anatomical right)!
    expect(rhTarget.ragdollBones.HAND_RIGHT.position.y).toBeGreaterThan(1.48);
    expect(rhTarget.ragdollBones.HAND_LEFT.position.y).toBeLessThan(1.38);
    expect(lhTarget.ragdollBones.HAND_LEFT.position.y).toBeGreaterThan(1.48);
    expect(lhTarget.ragdollBones.HAND_RIGHT.position.y).toBeLessThan(1.38);

    // Trigger-hand disarm: moderate ~190 J pistol round into HAND_LEFT disarms right-handed (trigger hand)
    // without severing, leaving southpaw (whose trigger hand is HAND_RIGHT) still holding their weapon!
    const lightPistolAmmo: AmmoSpec = {
      ...AMMO_556_NATO_M855,
      id: '9mm_subsonic_test',
      massKg: 0.008,
      diameterM: 0.009,
      muzzleVelocityMs: 225, // ~202 J muzzle energy (>65 J disarm, well below hand severing threshold)
      tissueExpansionFactor: 1.35,
      goreFactor: 0.5,
    };
    const rhDisarmTest = createTargetHealthState('rh_disarm', 'RH', vec3(0, 0, -4), 0, 'SKINHEAD_PUNK', false);
    const lhDisarmTest = createTargetHealthState('lh_disarm', 'LH', vec3(0, 0, -4), 0, 'SKINHEAD_PUNK', true);

    const handLeftTargetPt = rhDisarmTest.ragdollBones.HAND_LEFT.position;
    const muzzleLeftOrigin = add(handLeftTargetPt, vec3(0, 0, 1.2));
    const aimToHandLeft = normalize(sub(handLeftTargetPt, muzzleLeftOrigin));

    const rhReport = simulateShot(
      WEAPON_M4A1,
      lightPistolAmmo,
      muzzleLeftOrigin,
      aimToHandLeft,
      rhDisarmTest,
      DEFAULT_ENVIRONMENT
    );
    applyShotReportToTarget(rhDisarmTest, rhReport);

    const lhOffhandReport = simulateShot(
      WEAPON_M4A1,
      lightPistolAmmo,
      muzzleLeftOrigin,
      aimToHandLeft,
      lhDisarmTest,
      DEFAULT_ENVIRONMENT
    );
    applyShotReportToTarget(lhDisarmTest, lhOffhandReport);

    expect(rhReport.hitTarget).toBe(true);
    expect(lhOffhandReport.hitTarget).toBe(true);
    expect(rhDisarmTest.weaponDropped).toBe(true);
    expect(lhDisarmTest.weaponDropped).toBe(false);

    // Hitting HAND_RIGHT disarms the southpaw combatant!
    const handRightTargetPt = lhDisarmTest.ragdollBones.HAND_RIGHT.position;
    const muzzleRightOrigin = add(handRightTargetPt, vec3(0, 0, 1.2));
    const aimToHandRight = normalize(sub(handRightTargetPt, muzzleRightOrigin));
    const lhTriggerReport = simulateShot(
      WEAPON_M4A1,
      lightPistolAmmo,
      muzzleRightOrigin,
      aimToHandRight,
      lhDisarmTest,
      DEFAULT_ENVIRONMENT
    );
    applyShotReportToTarget(lhDisarmTest, lhTriggerReport);
    expect(lhTriggerReport.hitTarget).toBe(true);
    expect(lhDisarmTest.weaponDropped).toBe(true);
  });

  it('keeps sculpted Blender GLB combatant, headgear & weapon models active across LACERATED, EVISCERATED, CRANIAL_POP, living dismemberment & KIA ragdoll with ZERO swap back to old retro skins', () => {
    const canvasStub = { width: 640, height: 480 };
    const device = new pc.NullGraphicsDevice(canvasStub);
    const app = new pc.Application(canvasStub as unknown as HTMLCanvasElement, {
      graphicsDevice: device,
    });

    try {
      const refRest = createTargetHealthState('__bind_ref__', 'BindRef', vec3(0, 0, 0), 0);
      const parentOf: Partial<Record<GhoulZoneId, GhoulZoneId>> = {
        TORSO_LOWER_ABDOMEN: 'PELVIS_GROIN',
        TORSO_UPPER_THORAX: 'TORSO_LOWER_ABDOMEN',
        NECK_CERVICAL: 'TORSO_UPPER_THORAX',
        HEAD_CRANIUM: 'NECK_CERVICAL',
        HEAD_FACE_JAW: 'HEAD_CRANIUM',
        SHOULDER_LEFT: 'TORSO_UPPER_THORAX',
        UPPER_ARM_LEFT: 'SHOULDER_LEFT',
        FOREARM_LEFT: 'UPPER_ARM_LEFT',
        HAND_LEFT: 'FOREARM_LEFT',
        SHOULDER_RIGHT: 'TORSO_UPPER_THORAX',
        UPPER_ARM_RIGHT: 'SHOULDER_RIGHT',
        FOREARM_RIGHT: 'UPPER_ARM_RIGHT',
        HAND_RIGHT: 'FOREARM_RIGHT',
        THIGH_LEFT: 'PELVIS_GROIN',
        KNEE_LEFT: 'THIGH_LEFT',
        SHIN_LEFT: 'KNEE_LEFT',
        FOOT_LEFT: 'SHIN_LEFT',
        THIGH_RIGHT: 'PELVIS_GROIN',
        KNEE_RIGHT: 'THIGH_RIGHT',
        SHIN_RIGHT: 'KNEE_RIGHT',
        FOOT_RIGHT: 'SHIN_RIGHT',
      };

      const unitBoxMesh = pc.Mesh.fromGeometry(device, new pc.BoxGeometry());
      const makeRenderSubmesh = (name: string): pc.Entity => {
        const ent = new pc.Entity(name);
        const mat = new pc.StandardMaterial();
        mat.name = `Mat_${name}`;
        mat.diffuse = new pc.Color(0.35, 0.38, 0.32);
        mat.update();
        ent.addComponent('render', {
          meshInstances: [new pc.MeshInstance(unitBoxMesh, mat)],
        });
        return ent;
      };

      const animAssets: Array<pc.Asset> = [];
      for (const baseClip of COMBATANT_ANIMATION_CLIPS) {
        for (const clipName of [baseClip, `${baseClip}_Southpaw`]) {
          const track = new pc.AnimTrack(clipName, 1.2, [], [], []);
          const a = new pc.Asset(clipName, 'animation');
          a.resource = track;
          animAssets.push(a);
        }
      }

      const combatantContainer: pc.ContainerResource = {
        renders: [],
        materials: [],
        textures: [],
        animations: animAssets as pc.ContainerResource['animations'],
        gsplats: [],
        instantiateModelEntity: () => new pc.Entity('UnusedModel'),
        instantiateRenderEntity: () => {
          const root = new pc.Entity('GhoulCombatantTemplate');
          const armature = new pc.Entity('GhoulArmature');
          root.addChild(armature);

          const boneMap = new Map<GhoulZoneId, pc.Entity>();
          for (const zone of ALL_GHOUL_ZONES) {
            const b = new pc.Entity(`Bone_${zone}`);
            boneMap.set(zone, b);
          }
          for (const zone of ALL_GHOUL_ZONES) {
            const b = boneMap.get(zone)!;
            const pZone = parentOf[zone];
            const restPos = refRest.ragdollBones[zone].position;
            if (pZone) {
              const pPos = refRest.ragdollBones[pZone].position;
              boneMap.get(pZone)!.addChild(b);
              b.setLocalPosition(restPos.x - pPos.x, restPos.y - pPos.y, restPos.z - pPos.z);
            } else {
              armature.addChild(b);
              b.setLocalPosition(restPos.x, restPos.y, restPos.z);
            }
          }

          for (const zone of ALL_GHOUL_ZONES) {
            root.addChild(makeRenderSubmesh(`Zone_${zone}`));
          }
          for (const extra of [
            'Gear_ESAPI_PlateCarrier',
            'Gear_PASGT_Helmet',
            'Gear_TacticalVisor',
            'Gear_SpetsnazBeret',
            'Gear_PunkMohawk',
            'Gear_EvisceratedGut',
            'Organ_Brain',
            'Organ_Heart',
            'Organ_Lungs',
            'Organ_Liver',
            'Skelet_Skull',
            'Skelet_RibcageSpine',
            'Skelet_Pelvis',
          ]) {
            root.addChild(makeRenderSubmesh(extra));
          }
          return root;
        },
        getMaterialVariants: () => [],
        applyMaterialVariant: () => {},
        applyMaterialVariantInstances: () => {},
      };

      const makeWeaponContainer = (label: string): pc.ContainerResource => ({
        renders: [],
        materials: [],
        textures: [],
        animations: [],
        gsplats: [],
        instantiateModelEntity: () => new pc.Entity('UnusedWeaponModel'),
        instantiateRenderEntity: () => {
          const wRoot = new pc.Entity(label);
          wRoot.addChild(makeRenderSubmesh(`${label}_Receiver`));
          const muzzle = new pc.Entity('Bone_Muzzle');
          muzzle.setLocalPosition(0, 0.015, -0.58);
          wRoot.addChild(muzzle);
          return wRoot;
        },
        getMaterialVariants: () => [],
        applyMaterialVariant: () => {},
        applyMaterialVariantInstances: () => {},
      });

      const glbRegistry = new GlbModelRegistry(app);
      glbRegistry.registerContainerResource('ghoul_combatant', combatantContainer);
      glbRegistry.registerContainerResource('m4a1_carbine', makeWeaponContainer('M4A1_GLB'));
      glbRegistry.registerContainerResource('m590_shotgun', makeWeaponContainer('M590_GLB'));
      glbRegistry.registerContainerResource('msg90_sniper', makeWeaponContainer('MSG90_GLB'));
      glbRegistry.registerContainerResource('silver_talon_50ae', makeWeaponContainer('SilverTalon_GLB'));

      const materials = getOrCreateMaterials();
      const fxManager = new GoreAndBallisticsFxManager(app, materials, glbRegistry);

      const assertZeroLegacyFleshEnabled = (m: GhoulMannequinEntity, phaseLabel: string): void => {
        expect(m.combatantGlb, `${phaseLabel}: combatantGlb present`).not.toBeNull();
        expect(m.combatantGlb!.rootEntity.enabled, `${phaseLabel}: GLB rootEntity MUST stay enabled`).toBe(true);
        for (const zone of ALL_GHOUL_ZONES) {
          const legacyFlesh = m.rootEntity.findByName(`Flesh_${zone}`) as pc.Entity | null;
          expect(legacyFlesh, `${phaseLabel}: Flesh_${zone} node must be null`).toBeNull();
        }
        const legacyHeadgear = m.rootEntity.findByName('Headgear_HEAVY_ENFORCER') as pc.Entity | null;
        expect(legacyHeadgear, `${phaseLabel}: Legacy headgear must be null`).toBeNull();
      };

      // Verify Southpaw sniper selects *_Southpaw animation & Spetsnaz beret
      const southpawSniperState = createTargetHealthState(
        'sp_sniper',
        'Southpaw Sniper',
        vec3(2, 0, -10),
        0,
        'SNIPER_OPERATIVE',
        true
      );
      const southpawMannequin = new GhoulMannequinEntity(
        app,
        southpawSniperState,
        materials,
        fxManager,
        glbRegistry
      );
      app.root.addChild(southpawMannequin.rootEntity);
      expect(southpawMannequin.combatantGlb!.spetsnazBeret!.enabled).toBe(true);
      expect(southpawMannequin.combatantGlb!.pasgtHelmet!.enabled).toBe(false);
      expect(southpawMannequin.combatantGlb!.animComponent!.baseLayer!.activeState).toBe(
        'CombatReadyIdle_Southpaw'
      );
      assertZeroLegacyFleshEnabled(southpawMannequin, 'Southpaw Intact');

      // Verify Right-Handed Heavy Enforcer through EVERY gore, dismemberment & KIA transition!
      const enforcerState = createTargetHealthState(
        'rh_enforcer',
        'Heavy Enforcer',
        vec3(-1.5, 0, -8),
        0,
        'HEAVY_ENFORCER',
        false
      );
      const mannequin = new GhoulMannequinEntity(app, enforcerState, materials, fxManager, glbRegistry);
      app.root.addChild(mannequin.rootEntity);

      expect(mannequin.combatantGlb!.animComponent!.baseLayer!.activeState).toBe('CombatReadyIdle');
      expect(mannequin.combatantGlb!.esapiPlateCarrier!.enabled).toBe(true);
      expect(mannequin.combatantGlb!.pasgtHelmet!.enabled).toBe(true);
      expect(mannequin.combatantGlb!.tacticalVisor!.enabled).toBe(true);
      assertZeroLegacyFleshEnabled(mannequin, '1. Healthy Intact');

      // Phase 2: LACERATED + EVISCERATED gut cavity (must stay on Blender GLB, enabling Gear_EvisceratedGut!)
      enforcerState.zoneGoreMode.TORSO_UPPER_THORAX = 'LACERATED';
      enforcerState.zoneGoreMode.TORSO_LOWER_ABDOMEN = 'EVISCERATED';
      enforcerState.posture = 'GUT_HURT';
      mannequin.syncFromHealthState(0.016, 0.5);
      expect(mannequin.combatantGlb!.evisceratedGut!.enabled).toBe(true);
      assertZeroLegacyFleshEnabled(mannequin, '2. Lacerated & Eviscerated');

      // Phase 3: LIVING DISMEMBERMENT — sever entire right trigger arm (.50 AE blowoff) while target is STILL ALIVE!
      const upperArmPos = enforcerState.ragdollBones.UPPER_ARM_LEFT.position;
      const armOrigin = add(upperArmPos, vec3(0.0, 0.0, 0.8));
      const armAimDir = normalize(sub(add(upperArmPos, vec3(-0.08, 0, -0.2)), armOrigin));
      const severArmAmmo: AmmoSpec = {
        ...AMMO_50AE_FMJ_SOLID,
        tissueExpansionFactor: 2.8,
        goreFactor: 2.5,
      };
      const armReport = simulateShot(
        WEAPON_SILVER_TALON,
        severArmAmmo,
        armOrigin,
        armAimDir,
        enforcerState,
        DEFAULT_ENVIRONMENT
      );
      applyShotReportToTarget(enforcerState, armReport);
      expect(enforcerState.severedZones.has('UPPER_ARM_LEFT')).toBe(true);
      expect(enforcerState.alive).toBe(true);

      // Move detached arm component 2.4m away across the arena floor
      for (const z of ['UPPER_ARM_LEFT', 'FOREARM_LEFT', 'HAND_LEFT'] as const) {
        enforcerState.ragdollBones[z].position.x -= 2.4;
        enforcerState.ragdollBones[z].position.y = 0.08;
      }
      mannequin.syncFromHealthState(0.016, 1.0);

      // Living amputee MUST still render sculpted GLB (zero swap to old skin!), keep AnimComponent playing for BODY,
      // move Bone_UPPER_ARM_LEFT in world space to match the severed ragdoll limb, and spawn GLB dropped weapon prop!
      assertZeroLegacyFleshEnabled(mannequin, '3. Living Limb Dismemberment');
      expect(mannequin.combatantGlb!.animComponent!.playing).toBe(true);
      const glbSeveredArmPos = mannequin.combatantGlb!.boneNodes.get('UPPER_ARM_LEFT')!.getPosition();
      expect(glbSeveredArmPos.x).toBeCloseTo(enforcerState.ragdollBones.UPPER_ARM_LEFT.position.x, 2);
      expect(glbSeveredArmPos.y).toBeCloseTo(0.08, 2);
      expect(fxManager.fxRoot.findByName('M590_GLB_Receiver')).not.toBeNull();

      // Phase 4: CRANIAL_POP + Headgear Shoot-Off + Lethal KIA Full Ragdoll + Severed Leg!
      enforcerState.headgearIntact = false;
      enforcerState.zoneGoreMode.HEAD_CRANIUM = 'CRANIAL_POP';
      enforcerState.severedZones.add('THIGH_LEFT');
      enforcerState.ragdollBones.THIGH_LEFT.componentId = 'LIMB_LEG';
      enforcerState.ragdollBones.THIGH_LEFT.position = vec3(-3.2, 0.12, -8.5);
      enforcerState.alive = false;
      enforcerState.isRagdollActive = true;
      enforcerState.ragdollBones.PELVIS_GROIN.position = vec3(-1.5, 0.14, -8.9);

      mannequin.syncFromHealthState(0.016, 1.5);

      assertZeroLegacyFleshEnabled(mannequin, '4. Cranial Pop + KIA Full Ragdoll');
      expect(mannequin.combatantGlb!.animComponent!.playing).toBe(false);
      expect(mannequin.combatantGlb!.zoneEntities.get('HEAD_CRANIUM')!.enabled).toBe(false);
      expect(mannequin.combatantGlb!.internalAnatomyEntities.skeletSkull!.enabled).toBe(true);
      expect(mannequin.combatantGlb!.pasgtHelmet!.enabled).toBe(false);
      expect(mannequin.combatantGlb!.tacticalVisor!.enabled).toBe(false);
      expect(fxManager.fxRoot.findByName('DetachedHeadgear_HEAVY_ENFORCER')).not.toBeNull();

      const glbPelvisPos = mannequin.combatantGlb!.boneNodes.get('PELVIS_GROIN')!.getPosition();
      expect(glbPelvisPos.y).toBeCloseTo(0.14, 2);
      const glbSeveredThighPos = mannequin.combatantGlb!.boneNodes.get('THIGH_LEFT')!.getPosition();
      expect(glbSeveredThighPos.x).toBeCloseTo(-3.2, 2);

      southpawMannequin.destroy();
      mannequin.destroy();
      fxManager.clearAll();
    } finally {
      app.destroy();
    }
  });
});
