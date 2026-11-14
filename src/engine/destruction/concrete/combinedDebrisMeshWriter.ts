import * as pc from 'playcanvas';

/** Largest change of any pose-matrix element (metres for translation) that keeps a piece's written vertices. */
export const DEBRIS_POSE_EPSILON = 1e-5;

/** True when the rotation/scale and translation elements of two column-major 4x4 matrices differ by at most DEBRIS_POSE_EPSILON. */
export function isPoseWithinEpsilon(current: Float32Array, uploaded: Float32Array): boolean {
  const e = DEBRIS_POSE_EPSILON;
  return (
    Math.abs(current[0] - uploaded[0]) <= e &&
    Math.abs(current[1] - uploaded[1]) <= e &&
    Math.abs(current[2] - uploaded[2]) <= e &&
    Math.abs(current[4] - uploaded[4]) <= e &&
    Math.abs(current[5] - uploaded[5]) <= e &&
    Math.abs(current[6] - uploaded[6]) <= e &&
    Math.abs(current[8] - uploaded[8]) <= e &&
    Math.abs(current[9] - uploaded[9]) <= e &&
    Math.abs(current[10] - uploaded[10]) <= e &&
    Math.abs(current[12] - uploaded[12]) <= e &&
    Math.abs(current[13] - uploaded[13]) <= e &&
    Math.abs(current[14] - uploaded[14]) <= e
  );
}

/** Transforms a piece's local positions and normals by `mat` into the destination arrays at `baseVertex`. */
export function writeTransformedPieceVertices(
  mat: Float32Array,
  normalScale: number,
  srcPositions: ArrayLike<number>,
  srcNormals: ArrayLike<number>,
  vertexCount: number,
  dstPositions: Float32Array,
  dstNormals: Float32Array,
  baseVertex: number,
): void {
  const m00 = mat[0];
  const m01 = mat[1];
  const m02 = mat[2];
  const m10 = mat[4];
  const m11 = mat[5];
  const m12 = mat[6];
  const m20 = mat[8];
  const m21 = mat[9];
  const m22 = mat[10];
  const tx = mat[12];
  const ty = mat[13];
  const tz = mat[14];

  const r00 = m00 * normalScale;
  const r01 = m01 * normalScale;
  const r02 = m02 * normalScale;
  const r10 = m10 * normalScale;
  const r11 = m11 * normalScale;
  const r12 = m12 * normalScale;
  const r20 = m20 * normalScale;
  const r21 = m21 * normalScale;
  const r22 = m22 * normalScale;

  const dstOffset = baseVertex * 3;
  const vLen3 = vertexCount * 3;

  for (let k = 0; k < vLen3; k += 3) {
    const lx = srcPositions[k];
    const ly = srcPositions[k + 1];
    const lz = srcPositions[k + 2];

    const d = dstOffset + k;
    dstPositions[d] = m00 * lx + m10 * ly + m20 * lz + tx;
    dstPositions[d + 1] = m01 * lx + m11 * ly + m21 * lz + ty;
    dstPositions[d + 2] = m02 * lx + m12 * ly + m22 * lz + tz;

    const nx = srcNormals[k];
    const ny = srcNormals[k + 1];
    const nz = srcNormals[k + 2];

    dstNormals[d] = r00 * nx + r10 * ny + r20 * nz;
    dstNormals[d + 1] = r01 * nx + r11 * ny + r21 * nz;
    dstNormals[d + 2] = r02 * nx + r12 * ny + r22 * nz;
  }
}

/**
 * Owns one dynamic mesh that many debris pieces share. Pieces write their world-space vertices
 * straight into the vertex buffer's storage, and only the written vertex range is uploaded.
 */
export class CombinedDebrisMeshWriter {
  public readonly mesh: pc.Mesh;
  private readonly maxVertices: number;
  private boundStorage: ArrayBuffer | ArrayBufferView | null = null;
  private posView: Float32Array = new Float32Array(0);
  private normView: Float32Array = new Float32Array(0);
  private posByteOffset = 0;
  private normByteOffset = 0;
  private dirtyStartVertex = Number.POSITIVE_INFINITY;
  private dirtyEndVertex = 0;

  public constructor(
    device: pc.GraphicsDevice,
    maxVertices: number,
    maxIndices: number,
    uvs: Float32Array,
    indices: Uint32Array,
  ) {
    this.maxVertices = maxVertices;
    this.mesh = new pc.Mesh(device);
    this.mesh.clear(true, true, maxVertices, maxIndices);
    this.mesh.setPositions(new Float32Array(maxVertices * 3), 3, 0);
    this.mesh.setNormals(new Float32Array(maxVertices * 3), 3, 0);
    this.mesh.setUvs(0, uvs, 2, 0);
    this.mesh.setIndices(indices, 0);
    this.mesh.update(pc.PRIMITIVE_TRIANGLES, false);
  }

  public get positions(): Float32Array {
    this.ensureViews();
    return this.posView;
  }

  public get normals(): Float32Array {
    this.ensureViews();
    return this.normView;
  }

  public markVerticesWritten(baseVertex: number, vertexCount: number): void {
    if (vertexCount <= 0) return;
    this.dirtyStartVertex = Math.min(this.dirtyStartVertex, baseVertex);
    this.dirtyEndVertex = Math.max(this.dirtyEndVertex, baseVertex + vertexCount);
  }

  /** Uploads the written vertex range of the position and normal blocks; false when nothing was written. */
  public uploadWrittenVertices(): boolean {
    if (this.dirtyEndVertex <= this.dirtyStartVertex) return false;
    this.ensureViews();
    const byteStart = this.dirtyStartVertex * 12;
    const byteLength = (this.dirtyEndVertex - this.dirtyStartVertex) * 12;
    const vb = this.mesh.vertexBuffer;
    vb.unlock(this.posByteOffset + byteStart, byteLength);
    vb.unlock(this.normByteOffset + byteStart, byteLength);
    this.resetDirtyRange();
    return true;
  }

  /** Re-uploads the whole mesh after a topology change; callers pass vertexCount > 0 and indexCount > 0. */
  public commitTopology(uvs: Float32Array, indices: Uint32Array, vertexCount: number, indexCount: number): void {
    this.mesh.setUvs(0, uvs, 2, vertexCount);
    this.mesh.setIndices(indices, indexCount);
    this.mesh.update(pc.PRIMITIVE_TRIANGLES, false);
    this.resetDirtyRange();
  }

  public destroy(): void {
    this.mesh.destroy();
  }

  private ensureViews(): void {
    const vb = this.mesh.vertexBuffer;
    const storage = vb.lock();
    if (storage === this.boundStorage) return;

    const buffer = ArrayBuffer.isView(storage) ? storage.buffer : storage;
    const base = ArrayBuffer.isView(storage) ? storage.byteOffset : 0;
    let pos: { offset: number; stride: number } | undefined;
    let norm: { offset: number; stride: number } | undefined;
    for (const el of vb.getFormat().elements) {
      if (el.name === pc.SEMANTIC_POSITION) pos = el;
      else if (el.name === pc.SEMANTIC_NORMAL) norm = el;
    }
    if (!pos || !norm || pos.stride !== 12 || norm.stride !== 12) {
      throw new Error('CombinedDebrisMeshWriter: the debris mesh needs non-interleaved float3 position and normal streams.');
    }

    this.posByteOffset = pos.offset;
    this.normByteOffset = norm.offset;
    this.posView = new Float32Array(buffer, base + pos.offset, this.maxVertices * 3);
    this.normView = new Float32Array(buffer, base + norm.offset, this.maxVertices * 3);
    this.boundStorage = storage;
  }

  private resetDirtyRange(): void {
    this.dirtyStartVertex = Number.POSITIVE_INFINITY;
    this.dirtyEndVertex = 0;
  }
}
