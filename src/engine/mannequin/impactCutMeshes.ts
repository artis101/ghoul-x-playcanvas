import * as pc from 'playcanvas';
import type { CapMeshData, CutMeshPartition } from '../../core/ghoul/severCut/index.ts';
import { CUT_SIDE_PROXIMAL } from '../../core/ghoul/severCut/index.ts';
import type { BoneBindPose } from '../assets/glbLoader.ts';

/** A zone mesh's triangle list and its vertex positions in a bone's bind-pose frame. */
export interface BoneLocalMesh {
  positions: Float32Array;
  indices: number[];
}

/** Reads `mesh` into the local frame of a bone at its bind pose (bone axis = +Y). */
export function readBoneLocalMesh(mesh: pc.Mesh, bind: BoneBindPose): BoneLocalMesh | null {
  const model: number[] = [];
  const allIndices: number[] = [];
  if (!mesh.getPositions(model) || !mesh.getIndices(allIndices)) return null;
  const primitive = mesh.primitive[0];
  const base = primitive?.base ?? 0;
  const count = primitive?.count ?? allIndices.length;
  const toBone = new pc.Quat().copy(bind.modelRot).invert();
  const v = new pc.Vec3();
  const positions = new Float32Array(model.length);
  for (let i = 0; i + 2 < model.length; i += 3) {
    v.set(model[i] - bind.modelPos.x, model[i + 1] - bind.modelPos.y, model[i + 2] - bind.modelPos.z);
    toBone.transformVector(v, v);
    positions[i] = v.x;
    positions[i + 1] = v.y;
    positions[i + 2] = v.z;
  }
  return { positions, indices: allIndices.slice(base, base + count) };
}

function fullWeight(format: pc.VertexFormat): number {
  const element = format.elements.find((entry) => entry.name === pc.SEMANTIC_BLENDWEIGHT);
  if (!element?.normalize) return 1;
  if (element.dataType === pc.TYPE_UINT8) return 255;
  return element.dataType === pc.TYPE_UINT16 ? 65535 : 1;
}

function sourceBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  return data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Copies a skinned zone mesh torn in two: the proximal triangles bound wholly to the parent
 * bone (they stay on the body as the stump) and the distal ones to the zone's own bone (they
 * fly off with it). Needs an interleaved vertex buffer; returns null otherwise.
 */
export function createSplitCopy(
  mesh: pc.Mesh,
  partition: CutMeshPartition,
  proximalBone: number,
  distalBone: number
): pc.Mesh | null {
  const source = mesh.vertexBuffer;
  const format = source?.format;
  if (!source || !format?.interleaved || partition.indices.length === 0) return null;
  const stride = format.size;
  const src = sourceBytes(source.lock());
  const count = partition.sourceVertex.length;
  const bytes = new Uint8Array(count * stride);
  for (let i = 0; i < count; i++) {
    const from = partition.sourceVertex[i] * stride;
    bytes.set(src.subarray(from, from + stride), i * stride);
  }
  const vertices = new pc.VertexBuffer(mesh.device, format, count, { usage: source.usage, data: bytes.buffer });
  const iterator = new pc.VertexIterator(vertices);
  const joints = iterator.element[pc.SEMANTIC_BLENDINDICES];
  const weights = iterator.element[pc.SEMANTIC_BLENDWEIGHT];
  if (!joints || !weights) {
    iterator.end();
    vertices.destroy();
    return null;
  }
  const full = fullWeight(format);
  for (let i = 0; i < count; i++) {
    joints.set(partition.vertexSide[i] === CUT_SIDE_PROXIMAL ? proximalBone : distalBone, 0, 0, 0);
    weights.set(full, 0, 0, 0);
    iterator.next();
  }
  iterator.end();

  const wide = count > 0xffff;
  const indexData = wide ? Uint32Array.from(partition.indices) : Uint16Array.from(partition.indices);
  const split = new pc.Mesh(mesh.device);
  split.vertexBuffer = vertices;
  split.indexBuffer[0] = new pc.IndexBuffer(
    mesh.device,
    wide ? pc.INDEXFORMAT_UINT32 : pc.INDEXFORMAT_UINT16,
    indexData.length,
    pc.BUFFER_STATIC,
    indexData.buffer
  );
  split.primitive[0] = {
    ...mesh.primitive[0],
    type: pc.PRIMITIVE_TRIANGLES,
    base: 0,
    baseVertex: 0,
    count: indexData.length,
    indexed: true,
  };
  split.aabb = mesh.aabb.clone();
  split.skin = mesh.skin;
  return split;
}

/** Turns flat-shaded cap data into a render entity with `material`. */
export function createCapPart(
  device: pc.GraphicsDevice,
  name: string,
  data: CapMeshData,
  material: pc.Material
): pc.Entity | null {
  if (data.indices.length === 0) return null;
  const mesh = new pc.Mesh(device);
  mesh.setPositions(data.positions);
  mesh.setNormals(data.normals);
  mesh.setIndices(data.indices);
  mesh.update(pc.PRIMITIVE_TRIANGLES);
  const part = new pc.Entity(name);
  part.addComponent('render', {
    meshInstances: [new pc.MeshInstance(mesh, material)],
    castShadows: true,
    receiveShadows: true,
  });
  return part;
}
