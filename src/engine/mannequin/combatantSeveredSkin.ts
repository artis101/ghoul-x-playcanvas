import * as pc from 'playcanvas';
import type { GhoulZoneId, TargetHealthState } from '../../contracts/ballistics.ts';
import { ALL_GHOUL_ZONES, GHOUL_ZONE_HIERARCHY } from '../../core/ghoul/anatomy.ts';
import type { CombatantGlbInstance } from '../assets/glbLoader.ts';

// Zone meshes are shared by every combatant. Hold a reference so swapping one out never frees it.
const pinnedMeshes = new WeakSet<pc.Mesh>();

function fullWeight(format: pc.VertexFormat): number {
  const element = format.elements.find((entry) => entry.name === pc.SEMANTIC_BLENDWEIGHT);
  if (!element?.normalize) return 1;
  if (element.dataType === pc.TYPE_UINT8) return 255;
  return element.dataType === pc.TYPE_UINT16 ? 65535 : 1;
}

function copyStorage(data: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data.slice(0);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
}

/** Copies a skinned mesh with every vertex bound to a single bone. */
function createRigidCopy(mesh: pc.Mesh, boneIndex: number): pc.Mesh | null {
  const source = mesh.vertexBuffer;
  const indices = mesh.indexBuffer[0];
  if (!source || !indices) return null;
  const vertices = new pc.VertexBuffer(mesh.device, source.format, source.numVertices, {
    usage: source.usage,
    data: copyStorage(source.lock()),
  });
  const iterator = new pc.VertexIterator(vertices);
  const joints = iterator.element[pc.SEMANTIC_BLENDINDICES];
  const weights = iterator.element[pc.SEMANTIC_BLENDWEIGHT];
  if (!joints || !weights) {
    vertices.destroy();
    return null;
  }
  const full = fullWeight(source.format);
  for (let i = 0; i < source.numVertices; i++) {
    joints.set(boneIndex, 0, 0, 0);
    weights.set(full, 0, 0, 0);
    iterator.next();
  }
  iterator.end();

  const rigid = new pc.Mesh(mesh.device);
  rigid.vertexBuffer = vertices;
  rigid.indexBuffer[0] = new pc.IndexBuffer(
    mesh.device, indices.format, indices.numIndices, indices.usage, copyStorage(indices.lock()),
  );
  rigid.primitive[0] = { ...mesh.primitive[0] };
  rigid.aabb = mesh.aabb.clone();
  rigid.skin = mesh.skin;
  return rigid;
}

/**
 * The body's zone meshes blend each joint between a zone's bone and its parent's bone.
 * When a zone is cut away from its parent, its mesh is rebound to its own bone alone,
 * so the severed piece keeps its shape instead of stretching back to the body.
 */
export class CombatantSeveredSkin {
  private readonly originals = new Map<pc.MeshInstance, pc.Mesh>();
  private readonly rigidZones = new Set<GhoulZoneId>();

  public sync(glb: CombatantGlbInstance, healthState: TargetHealthState): void {
    if (healthState.severedZones.size === 0) return;
    const bones = healthState.ragdollBones;
    for (const zone of ALL_GHOUL_ZONES) {
      const parent = GHOUL_ZONE_HIERARCHY[zone].parent;
      if (!parent || this.rigidZones.has(zone)) continue;
      if (bones[zone].componentId === bones[parent].componentId) continue;
      this.rigidZones.add(zone);
      this.makeRigid(glb, zone);
    }
  }

  public reset(): void {
    for (const [meshInstance, original] of this.originals) {
      meshInstance.mesh = original;
    }
    this.originals.clear();
    this.rigidZones.clear();
  }

  private makeRigid(glb: CombatantGlbInstance, zone: GhoulZoneId): void {
    for (const meshInstance of glb.zoneEntities.get(zone)?.render?.meshInstances ?? []) {
      const mesh = meshInstance.mesh;
      const boneIndex = meshInstance.skinInstance?.skin.boneNames.indexOf(`Bone_${zone}`) ?? -1;
      if (!mesh || boneIndex < 0) continue;
      const rigid = createRigidCopy(mesh, boneIndex);
      if (!rigid) continue;
      if (!pinnedMeshes.has(mesh)) {
        mesh.incRefCount();
        pinnedMeshes.add(mesh);
      }
      this.originals.set(meshInstance, mesh);
      meshInstance.mesh = rigid;
    }
  }
}
