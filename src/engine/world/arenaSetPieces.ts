/**
 * Extra destructible set pieces layered over the five original range stations.
 *
 * The hall is 24 m wide (x ±12) and runs from z = +9 to z = -64. The jersey barriers at
 * x = ±9.5 leave a 1.5 m flank lane against each side wall; everything here stays at |x| <= 7.7
 * so it never overlaps a barrier or a range-marker post, and keeps clear of the enemy spawns.
 * Yaw is in degrees; a wall at yaw 90 runs along z.
 */
export type SetPieceKind = 'WOOD' | 'BRICK' | 'CONCRETE' | 'GLASS_MARCHING' | 'GLASS_VORONOI';

export interface SetPieceSpec {
  readonly id: string;
  readonly kind: SetPieceKind;
  readonly x: number;
  readonly z: number;
  readonly yawDeg: number;
  /** Wood and glass: panel width in metres. */
  readonly widthM?: number;
  /** Brick: courses of bricks. Low walls (about 14) are chest-high cover, 26 is a full wall. */
  readonly rows?: number;
  /** Brick: bricks per course. */
  readonly cols?: number;
}

const wood = (id: string, x: number, z: number, yawDeg: number, widthM: number): SetPieceSpec =>
  ({ id, kind: 'WOOD', x, z, yawDeg, widthM });
const brick = (id: string, x: number, z: number, yawDeg: number, rows = 26, cols = 13): SetPieceSpec =>
  ({ id, kind: 'BRICK', x, z, yawDeg, rows, cols });
const concrete = (id: string, x: number, z: number, yawDeg = 0): SetPieceSpec =>
  ({ id, kind: 'CONCRETE', x, z, yawDeg });

export const ARENA_SET_PIECES: readonly SetPieceSpec[] = [
  // Spawn pits: chest-high brick to crouch behind while the first wave wakes up.
  brick('spawn_brick_west', -6, -2, 0, 14, 9),
  brick('spawn_brick_east', 6, -2, 0, 14, 9),
  brick('spawn_brick_nw', -7.4, 4, 90, 14, 9),
  brick('spawn_brick_ne', 7.4, 4, 90, 14, 9),

  // Breacher room behind the original shoot-house partition.
  wood('room_west_side_a', -3.8, -9.0, 90, 3.6),
  wood('room_west_side_b', -0.8, -9.0, 90, 3.6),

  // Mid-field chicane: concrete slabs staggered so every lane has to be cracked or flanked.
  concrete('chicane_c1', -6, -20),
  concrete('chicane_c2', 5.5, -22),
  concrete('chicane_c3', 0, -27),
  concrete('chicane_c4', -6, -31),
  concrete('chicane_c5', 6, -33),
  concrete('chicane_c6', 2.2, -37.5),
  concrete('chicane_c7', -3.5, -37),

  // Masonry cover threaded between the slabs.
  brick('mid_brick_a', -2.8, -23.5, 0),
  brick('mid_brick_b', 3, -29, 90),
  brick('mid_brick_c', -6.2, -26.5, 90),
  brick('mid_brick_d', 6.5, -26.5, 90, 14, 9),
  brick('mid_brick_e', -6, -34.5, 0, 14, 9),

  // Glass booth west of the sniper's lane: three panes of two kinds.
  { id: 'booth_front', kind: 'GLASS_MARCHING', x: -5.8, z: -40.9, yawDeg: 0, widthM: 2.2 },
  { id: 'booth_side', kind: 'GLASS_MARCHING', x: -7.4, z: -43, yawDeg: 90, widthM: 2.2 },
  { id: 'booth_back', kind: 'GLASS_VORONOI', x: -5.8, z: -45.1, yawDeg: 0, widthM: 2.2 },

  // Kill house east of the sniper's lane: a wood room with a doorway in the front wall.
  wood('house_front_a', 5.3, -39.5, 0, 1.0),
  wood('house_front_b', 7.5, -39.5, 0, 1.0),
  wood('house_side_west', 4.8, -41.25, 90, 3.5),
  wood('house_side_east', 8.0, -41.25, 90, 3.5),
  wood('house_back', 6.4, -43, 0, 3.2),

  // Last stand: a broken concrete line, then brick and wood behind it.
  concrete('bunker_c1', -6, -53),
  concrete('bunker_c2', 0, -53),
  concrete('bunker_c3', 6, -53),
  brick('bunker_brick_a', -3, -58, 0),
  brick('bunker_brick_b', 3, -58, 0),
  wood('bunker_wood_a', -7, -60, 90, 3.0),
  wood('bunker_wood_b', 7, -60, 90, 3.0),
];
