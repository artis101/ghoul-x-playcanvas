import type { Path64, Paths64 } from 'clipper2-js';

/**
 * Fixed-point integer scale for Clipper2 (`100,000` units = `1.0` meter -> `0.01 mm` precision).
 * Keeps coordinates for walls up to hundreds of meters well inside JS 53-bit safe integers.
 */
export const WOOD_CLIPPER_SCALE = 100_000;
export const INV_WOOD_CLIPPER_SCALE = 1 / WOOD_CLIPPER_SCALE;
export const INV_WOOD_CLIPPER_AREA_SCALE = INV_WOOD_CLIPPER_SCALE * INV_WOOD_CLIPPER_SCALE;

/** Minimum polygon shell area (`25 mm^2`) retained after boolean subtraction to prune micro-slivers. */
export const MIN_SHELL_AREA_M2 = 0.005 * 0.005;
/** Minimum interior hole area (`9 mm^2`) retained for triangulation. */
export const MIN_HOLE_AREA_M2 = 0.003 * 0.003;
/** Maximum unanchored floating wood island area (`0.14 m^2` ~ `37cm x 37cm`) auto-dropped inside holes. */
export const MAX_FLOATING_ISLAND_DROP_AREA_M2 = 0.14;
/** Ramer-Douglas-Peucker simplification epsilon (`1.2 mm`) to clean grazing multi-shot slivers. */
export const SIMPLIFY_EPSILON_M = 0.0012;

/** Cross-grain vertical bridge-snap gap (`2.4 cm`) between nearby bullet holes. */
export const BRIDGE_SNAP_VERTICAL_GAP_M = 0.024;
/** Extra along-grain horizontal bridge-snap reach (`+1.6 cm` -> `4.0 cm` total along plank grain). */
export const BRIDGE_SNAP_HORIZONTAL_EXTRA_M = 0.016;
/** Thin outer-edge board sliver threshold (`2.2 cm`) that snaps cleanly to the panel edge. */
export const EDGE_SLIVER_SNAP_GAP_M = 0.022;

export interface Point2D {
  u: number;
  v: number;
}

export type WoodStampProfile =
  | 'RIFLE_FMJ_AP'
  | 'RIFLE_JHP'
  | 'HEAVY_50AE_SLUG'
  | 'BUCKSHOT_PELLET'
  | 'BUCKSHOT_CLUSTER'
  | 'BLAST_BREACH';

export interface JaggedHoleStampOptions {
  /** Local horizontal coordinate in `[0, widthM]` (meters) */
  u: number;
  /** Local vertical coordinate in `[0, heightM]` (meters) */
  v: number;
  /** Projectile radius in meters (e.g. `0.0039` for 7.62mm, `0.00825` for 12G slug) */
  caliberRadiusM: number;
  /** Projectile impact kinetic energy in Joules */
  kineticEnergyJ: number;
  /** Ballistic fracture silhouette profile */
  profile?: WoodStampProfile;
  /** Whether projectile is hardened armor-piercing (tighter exit cone vs wide JHP/slug blowout) */
  isArmorPiercing?: boolean;
  /** Optional deterministic variation seed (e.g. shot index) */
  seed?: number;
  /** Optional explicit base hole radius override in meters (e.g. explosive blast / shotgun cluster breach) */
  overrideRadiusM?: number;
  /** Optional explicit horizontal wood-grain stretch factor (`>= 1.0`) */
  grainStretchOverride?: number;
}

export interface SplinterSpawnDescriptor {
  /** 2D local coordinates (meters) on the freshly cut hole rim */
  u: number;
  v: number;
  /** Unit 2D tangent vector along the cut perimeter */
  tangentU: number;
  tangentV: number;
  /** Unit 2D outward radial direction from stamp center toward rim */
  radialU: number;
  radialV: number;
  /** Suggested splinter length in meters */
  lengthM: number;
}

export interface WoodShellContour {
  outer: Path64;
  holes: Path64[];
}

export interface WoodStudAnchorSpan {
  /** Horizontal center `u` of the interior vertical stud in `[0, widthM]` */
  u: number;
  /** Half-width of the stud in meters (e.g. `0.0225`) */
  halfWidthM: number;
  /** Bottom `v` of intact vertical stud span in `[0, heightM]` */
  vMin: number;
  /** Top `v` of intact vertical stud span in `[0, heightM]` */
  vMax: number;
}

export interface WoodPanelClipperState {
  readonly widthM: number;
  readonly heightM: number;
  readonly thicknessM: number;
  paths: Paths64;
  shells: WoodShellContour[];
  shotCount: number;
  /** Optional live intact interior stud spans used to determine whether split wood islands remain anchored */
  studAnchors?: WoodStudAnchorSpan[];
}

export interface WoodMeshScratchBuffers {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array | Uint16Array;
}

export interface WoodMeshBuildStats {
  vertexCount: number;
  indexCount: number;
  frontFaceTriangleCount: number;
  backFaceTriangleCount: number;
  holeRimTriangleCount: number;
  outerRimTriangleCount: number;
  remainingAreaM2: number;
  holeCount: number;
  shellCount: number;
}

export interface WoodStampSubtractionResult {
  cutAnyWood: boolean;
  removedAreaM2: number;
  droppedIslandAreaM2: number;
  snappedBridgeCount: number;
  splinters: SplinterSpawnDescriptor[];
  meshStats: WoodMeshBuildStats;
}
