import * as pc from 'playcanvas';
import type { Vec3Like } from '../../../contracts/ballistics.ts';
import type { QuatLike } from '../../../contracts/destruction.ts';
import type {
  WoodMeshBuildStats,
  WoodMeshScratchBuffers,
  WoodPanelClipperState,
} from '../../../core/destruction/woodPolygonClipper.ts';

export const DEFAULT_WOOD_WALL_MAX_VERTICES = 12_288;
export const DEFAULT_WOOD_WALL_MAX_INDICES = 36_864;
export const DEFAULT_WOOD_STUD_WIDTH_M = 0.045;
export const DEFAULT_WOOD_STUD_DEPTH_M = 0.085;
export const DEFAULT_WOOD_STUD_SPACING_M = 0.60;

export const MAX_STUD_FRAME_VERTICES = 4_096;
export const MAX_STUD_FRAME_INDICES = 6_144;
export const STUD_VERTICAL_SECTION_COUNT = 6;
export const STUD_SECTION_MAX_HP = 1_100;

export const TIGHT_BUCKSHOT_CLUSTER_RADIUS_M = 0.22;
export const MEDIUM_BUCKSHOT_CLUSTER_RADIUS_M = 0.26;
export const BUCKSHOT_VOLLEY_WINDOW_S = 0.025;
export const BUCKSHOT_VOLLEY_WINDOW_MS = 500;
export const MAX_PELLETS_PER_VOLLEY = 9;

export interface WoodWallConfig {
  id: string;
  centerWorld: Vec3Like;
  widthM?: number;
  heightM?: number;
  thicknessM?: number;
  yawRad?: number;
  studSpacingM?: number;
}

export interface WoodWallSystemOptions {
  id?: string;
  splinterMeshes?: readonly pc.Mesh[];
  panelMaterial?: pc.Material;
  studMaterial?: pc.Material;
  splinterMaterial?: pc.Material;
  maxSplinterInstances?: number;
  maxPanelVertices?: number;
  maxPanelIndices?: number;
}

export interface WoodWallInstance {
  readonly id: string;
  readonly centerWorld: Vec3Like;
  readonly widthM: number;
  readonly heightM: number;
  readonly thicknessM: number;
  readonly yawRad: number;
  readonly studSpacingM: number;
  readonly cosYaw: number;
  readonly sinYaw: number;
  readonly rotationQuat: QuatLike;
  readonly studPositionsU: readonly number[];
  readonly drywallColliderHandle: number;
  readonly studColliderHandles: readonly number[];
  readonly rootEntity: pc.Entity;
  readonly panelEntity: pc.Entity;
  readonly studFrameEntity: pc.Entity;
  readonly panelMesh: pc.Mesh;
  readonly studFrameMesh: pc.Mesh;
  readonly panelState: WoodPanelClipperState;
  readonly scratchBuffers: WoodMeshScratchBuffers;
  lastMeshStats: WoodMeshBuildStats;
}

export interface StudSectionState {
  vMin: number;
  vMax: number;
  hp: number;
  broken: boolean;
}

export interface StudColumnState {
  readonly u: number;
  readonly isBorderPost: boolean;
  readonly sections: StudSectionState[];
}

export interface PelletVolleyImpact {
  u: number;
  v: number;
  cutRadiusM: number;
  energyJ: number;
  dirWorld: Vec3Like;
  exitSignZ: number;
}

export interface PelletVolleyState {
  simTimeS: number;
  wallClockMs: number;
  pelletRayCount: number;
  clusterTierApplied: 0 | 1 | 2 | 3;
  impacts: PelletVolleyImpact[];
  clusterCuts: Array<{ u: number; v: number; cutRadiusM: number }>;
}

export interface WallInternalState {
  readonly studColumns: StudColumnState[];
  readonly mutableStudColliderHandles: number[];
  readonly studScratchBuffers: WoodMeshScratchBuffers;
  readonly visualStudDepthM: number;
  readonly plateHeightM: number;
  activeVolley: PelletVolleyState | null;
}
