import type { Vec3Like } from '../../../contracts/ballistics.ts';

export const BRICK_FULL_MAX_HP = 100;
export const BRICK_CLOSER_MAX_HP = 75;

export type BrickDamageStage = 'INTACT' | 'CHIPPED' | 'CRACKED' | 'DESTROYED';

export interface BrickBedOverlap {
  readonly neighborIndex: number;
  readonly u0: number;
  readonly u1: number;
}

export interface BrickCellSpec {
  readonly index: number;
  readonly row: number;
  readonly col: number;
  readonly u0: number;
  readonly u1: number;
  readonly v0: number;
  readonly v1: number;
  readonly localCenter: Vec3Like;
  readonly halfExtents: Vec3Like;
  readonly isHalfCloser: boolean;
  readonly maxHp: number;
  readonly variantSeed: number;
  readonly neighborLeft: number;
  readonly neighborRight: number;
  readonly overlapsBelow: readonly BrickBedOverlap[];
  readonly overlapsAbove: readonly BrickBedOverlap[];
}

export interface SolidBrickWallGrid {
  readonly wallId: string;
  readonly cols: number;
  readonly rows: number;
  readonly brickW: number;
  readonly brickH: number;
  readonly thicknessM: number;
  readonly mortarGapM: number;
  readonly stepX: number;
  readonly stepY: number;
  readonly widthM: number;
  readonly heightM: number;
  readonly cells: readonly BrickCellSpec[];
  readonly rowOffsets: Int32Array;
  readonly rowCounts: Int32Array;
  readonly hp: Float32Array;
  readonly frontGouge: Float32Array;
  readonly backGouge: Float32Array;
  readonly hitCount: Uint16Array;
  readonly bfsVisitedScratch: Uint8Array;
  readonly bfsQueueScratch: Int32Array;
}

export interface BrickWallMeshBuffers {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly colors: Float32Array;
  readonly indices: Uint16Array | Uint32Array;
}

export interface BrickWallMeshStats {
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly intactBrickCount: number;
  readonly damagedBrickCount: number;
  readonly destroyedBrickCount: number;
}

export interface BrickBallisticHitOutcome {
  readonly hitBrickIndex: number;
  readonly damageAppliedHp: number;
  readonly brickBrokeOut: boolean;
  readonly newlyDestroyedIndices: readonly number[];
  readonly newlyDamagedCount: number;
  readonly remainingEnergyJ: number;
  readonly stopped: boolean;
}

export interface BrickBlastOutcome {
  readonly newlyDestroyedIndices: readonly number[];
  readonly damagedBrickCount: number;
  readonly changed: boolean;
}
