import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { ChunkConnectivityEdge } from '../../contracts/destruction.ts';
import type { ConcreteWallConnectivityGraphJson, NamedChunkConnectivityNode } from './glbTypes.ts';

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null;
}

function parseVec3Like(raw: unknown, label: string): Vec3Like {
  if (!isRecord(raw)) throw new Error(`Invalid Vec3Like at ${label}`);
  const x = Number(raw.x), y = Number(raw.y), z = Number(raw.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    throw new Error(`Non-finite Vec3Like coordinates at ${label}`);
  }
  return { x, y, z };
}

/**
 * Validates raw parsed JSON against `ConcreteWallConnectivityGraphJson` (`version: 1`).
 */
export function parseConnectivityGraphJson(raw: unknown): ConcreteWallConnectivityGraphJson {
  if (!isRecord(raw)) throw new Error('Connectivity graph JSON root must be an object');
  if (raw.version !== 1) throw new Error(`Unsupported connectivity graph version: ${String(raw.version)}`);
  if (typeof raw.wallId !== 'string' || raw.wallId.length === 0) {
    throw new Error('Connectivity graph wallId must be a non-empty string');
  }
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    throw new Error('Connectivity graph nodes must be a non-empty array');
  }

  const nodes: NamedChunkConnectivityNode[] = raw.nodes.map((item: unknown, idx: number) => {
    if (!isRecord(item)) throw new Error(`Node at index ${idx} is not an object`);
    const index = Number(item.index);
    if (!Number.isInteger(index) || index !== idx) {
      throw new Error(`Node index mismatch at ${idx}: got ${String(item.index)}`);
    }
    const name = typeof item.name === 'string' && item.name.length > 0
      ? item.name
      : `Chunk_${String(index).padStart(2, '0')}`;
    const isAnchored = Boolean(item.isAnchored);
    const localCenter = parseVec3Like(item.localCenter, `nodes[${idx}].localCenter`);
    const halfExtents = item.halfExtents !== undefined
      ? parseVec3Like(item.halfExtents, `nodes[${idx}].halfExtents`)
      : { x: 0.25, y: 0.2, z: 0.14 };
    const massKg = Number(item.massKg);
    if (!Number.isFinite(massKg) || massKg <= 0) throw new Error(`Invalid massKg at nodes[${idx}]`);
    if (!Array.isArray(item.edges)) throw new Error(`Missing edges array at nodes[${idx}]`);

    const edges: ChunkConnectivityEdge[] = item.edges.map((edgeRaw: unknown, eIdx: number) => {
      if (!isRecord(edgeRaw)) throw new Error(`Invalid edge at nodes[${idx}].edges[${eIdx}]`);
      const neighborIndex = Number(edgeRaw.neighborIndex);
      const breakThresholdJ = Number(edgeRaw.breakThresholdJ);
      if (!Number.isInteger(neighborIndex) || neighborIndex < 0) {
        throw new Error(`Invalid neighborIndex at nodes[${idx}].edges[${eIdx}]`);
      }
      if (!Number.isFinite(breakThresholdJ) || breakThresholdJ <= 0) {
        throw new Error(`Invalid breakThresholdJ at nodes[${idx}].edges[${eIdx}]`);
      }
      return { neighborIndex, breakThresholdJ, severed: Boolean(edgeRaw.severed) };
    });

    const nodeOut: NamedChunkConnectivityNode = {
      index, name, isAnchored, localCenter, halfExtents, massKg, edges,
    };
    if (typeof item.meshVariant === 'number' && Number.isInteger(item.meshVariant)) {
      nodeOut.meshVariant = item.meshVariant;
    }
    return nodeOut;
  });

  return { version: 1, wallId: raw.wallId, nodes };
}

/**
 * Streams and validates `concrete_wall_connectivity.json` over HTTP/Vite dev/prod asset serving.
 */
export async function loadConnectivityGraphJson(
  url = '/models/concrete_wall_connectivity.json'
): Promise<ConcreteWallConnectivityGraphJson> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch connectivity graph (${response.status}) from ${url}`);
  }
  const raw: unknown = await response.json();
  return parseConnectivityGraphJson(raw);
}
