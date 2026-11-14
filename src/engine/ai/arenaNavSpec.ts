import type { Vec3Like } from '../../contracts/ballistics.ts';
import { DESTRUCTION_ZONE_LAYOUT } from '../world/arenaLayout.ts';

export interface TacticalCoverStation {
  readonly stationId: string;
  readonly coverAnchorWorld: Vec3Like;
  readonly peekSign: -1 | 1;
  readonly peekStrideM: number;
  readonly guardYawDeg: number;
}

export const TACTICAL_COVER_STATIONS: readonly TacticalCoverStation[] = [
  {
    stationId: DESTRUCTION_ZONE_LAYOUT.woodShootHouseWall.id,
    coverAnchorWorld: { x: -2.3, y: 0, z: -8.35 },
    peekSign: 1,
    peekStrideM: 1.72,
    guardYawDeg: 6,
  },
  {
    stationId: DESTRUCTION_ZONE_LAYOUT.instancedBrickWall.id,
    coverAnchorWorld: { x: -3.8, y: 0, z: -13.75 },
    peekSign: 1,
    peekStrideM: 1.72,
    guardYawDeg: 10,
  },
  {
    stationId: DESTRUCTION_ZONE_LAYOUT.voronoiConcreteWall.id,
    coverAnchorWorld: { x: 2.3, y: 0, z: -14.85 },
    peekSign: -1,
    peekStrideM: 1.82,
    guardYawDeg: -8,
  },
  {
    stationId: DESTRUCTION_ZONE_LAYOUT.glassVoronoiWindow.id,
    coverAnchorWorld: { x: 5.5, y: 0, z: -8.1 },
    peekSign: -1,
    peekStrideM: 0.75,
    guardYawDeg: -14,
  },
];

/** The navigation facts of one arena that the tactical AI moves and takes cover by. */
export interface ArenaNavSpec {
  readonly id: string;
  /** Movement goals are clamped to this floor rectangle. */
  readonly walkMinX: number;
  readonly walkMaxX: number;
  readonly walkMinZ: number;
  readonly walkMaxZ: number;
  /** Peek and shelter spots outside this x range are never considered. */
  readonly peekSpotMinX: number;
  readonly peekSpotMaxX: number;
  /** Half-width of floor, centred on x = 0, that the close-quarters juke keeps inside. */
  readonly jukeHalfWidthM: number;
  /** Enemies advance toward +z; a backpedal or panic scramble never retreats past this z. */
  readonly retreatLimitZ: number;
  readonly coverStations: readonly TacticalCoverStation[];
}

export const HALL_ARENA_NAV_SPEC: ArenaNavSpec = {
  id: 'hall',
  walkMinX: -8.1,
  walkMaxX: 8.1,
  walkMinZ: -46.0,
  walkMaxZ: -3.2,
  peekSpotMinX: -8.05,
  peekSpotMaxX: 8.05,
  jukeHalfWidthM: 7.7,
  retreatLimitZ: -21.5,
  coverStations: TACTICAL_COVER_STATIONS,
};
