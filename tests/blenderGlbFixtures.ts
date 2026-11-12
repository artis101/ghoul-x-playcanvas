import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect } from 'vitest';

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
  normalTexture?: { index: number };
  pbrMetallicRoughness?: Record<string, unknown>;
}

interface ParsedGltfJson {
  asset: { version: string; generator?: string };
  nodes?: GltfNode[];
  meshes?: GltfMesh[];
  skins?: GltfSkin[];
  animations?: GltfAnimation[];
  materials?: GltfMaterial[];
  textures?: Array<{ sampler?: number; source?: number }>;
  samplers?: Array<{ magFilter?: number; minFilter?: number }>;
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

export const MODELS_DIR = path.resolve(process.cwd(), 'public', 'models');
export const BLEND_SOURCES_DIR = path.join(MODELS_DIR, 'blend_sources');

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_TYPE_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_TYPE_BIN = 0x004e4942; // 'BIN\0'

export function readAndParseGlb(filename: string): ParsedGlbFile {
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

export function readVec4AccessorRow(
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
