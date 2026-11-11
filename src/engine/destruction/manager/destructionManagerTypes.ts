import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { ImportedVoronoiChunkMesh } from '../../../core/destruction/voronoiWallGenerator.ts';
import type { GlbModelRegistry } from '../../assets/glbLoader.ts';
import type { CombatAudioEngine } from '../../audio/combatAudioEngine.ts';
import type { ExplosiveBarrelManager } from '../../fx/mayhemDirector.ts';
import type { EngineMaterialPalette } from '../../materials.ts';
import type { BrickWallSystemOptions } from '../brickWallSystem.ts';
import type { WoodWallSystemOptions } from '../woodWallSystem.ts';

export interface DestructionManagerOptions {
  readonly materials?: EngineMaterialPalette;
  readonly barrelManager?: ExplosiveBarrelManager | null;
  readonly combatAudio?: CombatAudioEngine | null;
  readonly getListenerPos?: () => Vec3Like;
  readonly woodOptions?: WoodWallSystemOptions;
  readonly brickOptions?: BrickWallSystemOptions;
  /** Automatically build default breaching arena cover stations on construction (default true) */
  readonly buildDefaultArena?: boolean;
  /** Optional preloaded GLB registry for Voronoi concrete wall assets. */
  readonly glbRegistry?: GlbModelRegistry | null;
}

export interface StaticCoverFixture {
  readonly objectId: string;
  readonly colliderHandle: number;
  readonly entity: pc.Entity;
}

export function extractImportedVoronoiChunkMesh(
  mesh: pc.Mesh,
  name: string
): ImportedVoronoiChunkMesh {
  const rawPos: number[] = [];
  const rawNorm: number[] = [];
  const rawUv: number[] = [];
  const rawIdx: number[] = [];

  mesh.getPositions(rawPos);
  mesh.getNormals(rawNorm);
  mesh.getUvs(0, rawUv);
  mesh.getIndices(rawIdx);

  const vertCount = Math.floor(rawPos.length / 3);
  const positions = new Float32Array(rawPos);
  const normals =
    rawNorm.length === rawPos.length
      ? new Float32Array(rawNorm)
      : new Float32Array(vertCount * 3);
  if (rawNorm.length !== rawPos.length) {
    for (let i = 1; i < normals.length; i += 3) {
      normals[i] = 1;
    }
  }

  const uvs =
    rawUv.length === vertCount * 2 ? new Float32Array(rawUv) : undefined;
  const indices = new Uint32Array(rawIdx);

  return {
    name,
    positions,
    normals,
    uvs,
    indices,
    positionsAreWallLocal: false,
  };
}
