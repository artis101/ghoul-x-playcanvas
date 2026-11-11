import type { Vec3Like } from '../../contracts/ballistics.ts';

export interface DestructionStationSpec {
  readonly id: string;
  readonly label: string;
  readonly center: Vec3Like;
  readonly widthM: number;
  readonly heightM: number;
  readonly thicknessM: number;
  readonly halfExtents: Vec3Like;
  readonly yawDeg: number;
}

export interface DestructionZoneLayout {
  readonly woodShootHouseWall: DestructionStationSpec;
  readonly glassMarchingWindow: DestructionStationSpec;
  readonly glassVoronoiWindow: DestructionStationSpec;
  readonly instancedBrickWall: DestructionStationSpec;
  readonly voronoiConcreteWall: DestructionStationSpec;
}

/**
 * Structured range station coordinates for destructible tactical cover stations.
 * Positioned along clear firing lanes and aligned with downrange GHOUL combatants.
 */
export const DESTRUCTION_ZONE_LAYOUT: DestructionZoneLayout = {
  woodShootHouseWall: {
    id: 'wood_shoot_house_wall',
    label: 'Wood & Drywall Shoot-House Partition',
    center: { x: -2.3, y: 1.2, z: -7.2 },
    widthM: 3.0,
    heightM: 2.4,
    thicknessM: 0.12,
    halfExtents: { x: 1.5, y: 1.2, z: 0.06 },
    yawDeg: 0,
  },
  glassMarchingWindow: {
    id: 'glass_marching_window',
    label: 'Marching-Squares 256 Tactical Window',
    center: { x: -5.5, y: 1.45, z: -6.5 },
    widthM: 2.2,
    heightM: 1.7,
    thicknessM: 0.03,
    halfExtents: { x: 1.1, y: 0.85, z: 0.015 },
    yawDeg: 0,
  },
  glassVoronoiWindow: {
    id: 'glass_voronoi_window',
    label: 'Runtime Voronoi Tempered Glass Window',
    center: { x: 5.5, y: 1.45, z: -6.5 },
    widthM: 2.2,
    heightM: 1.7,
    thicknessM: 0.03,
    halfExtents: { x: 1.1, y: 0.85, z: 0.015 },
    yawDeg: 0,
  },
  instancedBrickWall: {
    id: 'instanced_brick_wall',
    label: 'Instanced Masonry Brick Cover Wall',
    center: { x: -3.8, y: 1.05, z: -12.5 },
    widthM: 3.0,
    heightM: 2.1,
    thicknessM: 0.2,
    halfExtents: { x: 1.5, y: 1.05, z: 0.1 },
    yawDeg: 0,
  },
  voronoiConcreteWall: {
    id: 'voronoi_concrete_wall',
    label: 'MultiDraw Voronoi Concrete Barrier Wall',
    center: { x: 2.3, y: 1.15, z: -13.5 },
    widthM: 3.2,
    heightM: 2.3,
    thicknessM: 0.28,
    halfExtents: { x: 1.6, y: 1.15, z: 0.14 },
    yawDeg: 0,
  },
};

export const RANGE_MARKER_DISTANCES_M: readonly number[] = [5, 10, 15, 25, 42];
export const PERIMETER_BARRIER_Z_OFFSETS_M: readonly number[] = [-8, -20, -34, -48];
