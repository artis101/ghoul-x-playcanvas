import type { QuatLike } from '../../../contracts/destruction.ts';
import type { GlbModelRegistry } from '../../assets/glbLoader.ts';
import { ARENA_SET_PIECES, type SetPieceSpec } from '../../world/arenaSetPieces.ts';
import { addConcreteStation, type ArenaBuildContext } from './arenaStationBuilder.ts';

const WOOD_HEIGHT_M = 2.4;
const GLASS_HEIGHT_M = 1.7;
const GLASS_CENTER_Y_M = 1.45;

function yawQuat(yawDeg: number): QuatLike {
  const half = (yawDeg * Math.PI) / 360;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

function buildOne(ctx: ArenaBuildContext, glbRegistry: GlbModelRegistry | null | undefined, p: SetPieceSpec): void {
  switch (p.kind) {
    case 'WOOD':
      ctx.woodWalls.createWall({
        id: p.id,
        centerWorld: { x: p.x, y: WOOD_HEIGHT_M / 2, z: p.z },
        widthM: p.widthM ?? 3,
        heightM: WOOD_HEIGHT_M,
        thicknessM: 0.12,
        yawRad: (p.yawDeg * Math.PI) / 180,
        studSpacingM: 0.6,
      });
      return;
    case 'BRICK':
      ctx.brickWalls.addBrickWall({
        wallId: p.id,
        position: { x: p.x, y: 0, z: p.z },
        rotation: yawQuat(p.yawDeg),
        cols: p.cols ?? 13,
        rows: p.rows ?? 26,
        brickW: 0.215,
        brickH: 0.072,
        brickD: 0.18,
        mortarBreakJ: 650,
        mortarGapM: 0.008,
      });
      return;
    case 'CONCRETE':
      addConcreteStation(ctx, glbRegistry, p.id, { x: p.x, y: 0, z: p.z }, yawQuat(p.yawDeg), 3.2, 0.28);
      return;
    case 'GLASS_MARCHING':
      ctx.glassSystem.createMarchingWindow({
        id: p.id,
        centerWorld: { x: p.x, y: GLASS_CENTER_Y_M, z: p.z },
        widthM: p.widthM ?? 2.2,
        heightM: GLASS_HEIGHT_M,
        thicknessM: 0.03,
        rotationQuat: yawQuat(p.yawDeg),
        gridW: 16,
        gridH: 16,
      });
      return;
    case 'GLASS_VORONOI':
      ctx.glassSystem.createVoronoiWindow({
        id: p.id,
        centerWorld: { x: p.x, y: GLASS_CENTER_Y_M, z: p.z },
        widthM: p.widthM ?? 2.2,
        heightM: GLASS_HEIGHT_M,
        thicknessM: 0.03,
        rotationQuat: yawQuat(p.yawDeg),
        voronoiShardCount: 42,
      });
      return;
  }
}

export function buildArenaSetPieces(
  ctx: ArenaBuildContext,
  glbRegistry?: GlbModelRegistry | null
): void {
  for (const piece of ARENA_SET_PIECES) buildOne(ctx, glbRegistry, piece);
}
