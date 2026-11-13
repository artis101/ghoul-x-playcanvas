import * as pc from 'playcanvas';
import type { GhoulZoneId, SeverCut } from '../../contracts/ballistics.ts';
import { ALL_GHOUL_ZONES, GHOUL_ZONE_HIERARCHY } from '../../core/ghoul/anatomy.ts';
import {
  buildCutCapGeometry,
  createCutSurface,
  partitionMeshByCut,
  type CutSurface,
} from '../../core/ghoul/severCut/index.ts';
import type { CombatantGlbInstance } from '../assets/glbLoader.ts';
import type { EngineMaterialPalette } from '../materials.ts';
import { seatCap } from './combatantStumpCaps.ts';
import { createCapPart, createSplitCopy, readBoneLocalMesh, type BoneLocalMesh } from './impactCutMeshes.ts';
import type { StumpCap } from './types.ts';

/** Below this far down the bone a cut is at the joint, where the fitted joint caps do better. */
const MIN_CUT_Y_M = 0.035;
const RING_HALF_HEIGHT_M = 0.025;
const TWIN_BONE_ZONES: ReadonlySet<GhoulZoneId> = new Set<GhoulZoneId>([
  'FOREARM_RIGHT', 'FOREARM_LEFT', 'SHIN_RIGHT', 'SHIN_LEFT',
]);

export type MeshSwap = (meshInstance: pc.MeshInstance, mesh: pc.Mesh) => void;

function boneLength(glb: CombatantGlbInstance, zone: GhoulZoneId, meshes: BoneLocalMesh[]): number {
  const bind = glb.boneBindPoses.get(zone)!;
  for (const child of ALL_GHOUL_ZONES) {
    const childBind = GHOUL_ZONE_HIERARCHY[child].parent === zone ? glb.boneBindPoses.get(child) : undefined;
    if (childBind) return childBind.modelPos.distance(bind.modelPos);
  }
  let maxY = 0;
  for (const m of meshes) for (let i = 1; i < m.positions.length; i += 3) maxY = Math.max(maxY, m.positions[i]);
  return maxY;
}

/** Measures the limb's cross-section around `cutY` and builds the torn surface there. */
function planSurface(cut: SeverCut, cutY: number, meshes: BoneLocalMesh[], fallbackRadius: number): CutSurface {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const m of meshes) {
    for (let i = 0; i + 2 < m.positions.length; i += 3) {
      if (Math.abs(m.positions[i + 1] - cutY) > RING_HALF_HEIGHT_M) continue;
      minX = Math.min(minX, m.positions[i]);
      maxX = Math.max(maxX, m.positions[i]);
      minZ = Math.min(minZ, m.positions[i + 2]);
      maxZ = Math.max(maxZ, m.positions[i + 2]);
    }
  }
  if (!Number.isFinite(minX)) return createCutSurface(cut, cutY, 0, 0, fallbackRadius);
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  let radius = 0;
  for (const m of meshes) {
    for (let i = 0; i + 2 < m.positions.length; i += 3) {
      if (Math.abs(m.positions[i + 1] - cutY) > RING_HALF_HEIGHT_M) continue;
      radius = Math.max(radius, Math.hypot(m.positions[i] - cx, m.positions[i + 2] - cz));
    }
  }
  return createCutSurface(cut, cutY, cx, cz, pc.math.clamp(radius || fallbackRadius, 0.025, 0.14));
}

/**
 * Tears a severed zone's skinned mesh where the bullet crossed it, and fits ragged wound caps
 * to both halves. The GLB mesh itself is only re-bound and re-indexed, never replaced; the
 * caps are the only new geometry.
 */
export class CombatantImpactCuts {
  private caps: Map<GhoulZoneId, StumpCap> | null = null;
  private materials: EngineMaterialPalette | null = null;
  private readonly replaced = new Map<GhoulZoneId, StumpCap>();

  public bind(caps: Map<GhoulZoneId, StumpCap>, materials: EngineMaterialPalette): void {
    this.reset();
    this.caps = caps;
    this.materials = materials;
  }

  /** Returns false when the cut can't be placed on this mesh (the caller falls back to the joint). */
  public apply(glb: CombatantGlbInstance, zone: GhoulZoneId, cut: SeverCut, swap: MeshSwap): boolean {
    const parent = GHOUL_ZONE_HIERARCHY[zone].parent;
    const bind = glb.boneBindPoses.get(zone);
    const node = glb.boneNodes.get(zone);
    const parentBind = parent && glb.boneBindPoses.get(parent);
    const parentNode = parent && glb.boneNodes.get(parent);
    const jointCap = this.caps?.get(zone);
    if (!this.caps || !this.materials || !parent || !bind || !node || !parentBind || !parentNode || !jointCap) {
      return false;
    }

    const instances = (glb.zoneEntities.get(zone)?.render?.meshInstances ?? []).filter((mi) => mi.skinInstance && mi.mesh);
    const locals = instances.map((mi) => readBoneLocalMesh(mi.mesh!, bind));
    if (instances.length === 0 || locals.some((m) => !m)) return false;
    const meshes = locals as BoneLocalMesh[];
    let maxY = 0;
    for (const m of meshes) for (let i = 1; i < m.positions.length; i += 3) maxY = Math.max(maxY, m.positions[i]);
    const cutY = Math.min(cut.alongFraction * boneLength(glb, zone, meshes), maxY - 0.03);
    if (cutY < MIN_CUT_Y_M) return false;

    const surface = planSurface(cut, cutY, meshes, 0.05);
    const splits: Array<{ mi: pc.MeshInstance; mesh: pc.Mesh }> = [];
    let straddle = 0;
    for (let k = 0; k < instances.length; k++) {
      const mi = instances[k];
      const boneNames = mi.skinInstance!.skin.boneNames;
      const proximalBone = boneNames.indexOf(`Bone_${parent}`);
      const distalBone = boneNames.indexOf(`Bone_${zone}`);
      if (proximalBone < 0 || distalBone < 0) return false;
      const partition = partitionMeshByCut(meshes[k].positions, meshes[k].indices, surface);
      const mesh = createSplitCopy(mi.mesh!, partition, proximalBone, distalBone);
      if (!mesh) return false;
      splits.push({ mi, mesh });
      straddle = Math.max(straddle, partition.maxStraddleSpanM);
    }
    const device = instances[0].mesh!.device;
    for (const { mi, mesh } of splits) swap(mi, mesh);

    const skirtM = pc.math.clamp(straddle * 0.8 + 0.01, 0.02, 0.09);
    const boneCount = TWIN_BONE_ZONES.has(zone) ? 2 : 1;
    const socket = this.buildCap(device, `${zone}_ImpactStump`, surface, 1, skirtM, boneCount, cut.seed);
    const limb = this.buildCap(device, `${zone}_ImpactPiece`, surface, -1, skirtM, boneCount, cut.seed);
    // The stump rides the parent bone, held where the zone's bone sat in the bind pose.
    seatCap(socket, parentNode, parentBind, bind.modelPos, bind.modelRot);
    seatCap(limb, node, bind, bind.modelPos, bind.modelRot);

    jointCap.socket.enabled = false;
    jointCap.limb.enabled = false;
    if (!this.replaced.has(zone)) this.replaced.set(zone, jointCap);
    this.caps.set(zone, { zone, parent, socket, limb });
    return true;
  }

  /** Puts the joint caps back and drops the impact caps. */
  public reset(): void {
    if (!this.caps) return;
    for (const [zone, jointCap] of this.replaced) {
      const impact = this.caps.get(zone);
      if (impact && impact !== jointCap) {
        impact.socket.destroy();
        impact.limb.destroy();
      }
      this.caps.set(zone, jointCap);
    }
    this.replaced.clear();
  }

  private buildCap(
    device: pc.GraphicsDevice,
    name: string,
    surface: CutSurface,
    facing: 1 | -1,
    skirtM: number,
    boneCount: 1 | 2,
    seed: number
  ): pc.Entity {
    const geometry = buildCutCapGeometry(surface, { facing, skirtM, boneCount, seed });
    const root = new pc.Entity(name);
    const meat = createCapPart(device, 'TornMeat', geometry.meat, this.materials!.stumpFleshMat);
    const bone = createCapPart(device, 'BoneBreak', geometry.bone, this.materials!.exposedBoneMat);
    if (meat) root.addChild(meat);
    if (bone) root.addChild(bone);
    root.enabled = false;
    return root;
  }
}
