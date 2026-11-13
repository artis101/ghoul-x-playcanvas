import * as pc from 'playcanvas';
import { hash2d, valueNoise2d } from './proceduralNoise.ts';
import { createTacticalAlbedoTexture, type RGB } from './proceduralAlbedo.ts';

export interface TileHallTextures {
  readonly wallTile: pc.Texture;
  readonly floorTile: pc.Texture;
  readonly ceilingPanel: pc.Texture;
  readonly agedConcrete: pc.Texture;
}

/** Wall texture is one full wall height tall: 32 rows of square ceramic tiles. */
export const WALL_TILE_ROWS = 32;
const WALL_TEX_SIZE = 256;
const WALL_TILE_PX = WALL_TEX_SIZE / WALL_TILE_ROWS;
const WALL_BAND_ROWS: readonly number[] = [8, 9];

const cachedByDevice = new WeakMap<pc.GraphicsDevice, TileHallTextures>();

function paintWallTile(x: number, y: number, u: number, v: number): RGB {
  const col = Math.floor(x / WALL_TILE_PX);
  const row = Math.floor(y / WALL_TILE_PX);
  const lx = x % WALL_TILE_PX;
  const ly = y % WALL_TILE_PX;

  // Soot settles at the skirting and under the ceiling; damp streaks run down the wall.
  const skirting = Math.max(0, 1 - v * 9);
  const underCeiling = Math.max(0, (v - 0.8) * 5);
  const blotch = valueNoise2d(u * 6, v * 6, 6, 311);
  const streak = valueNoise2d(u * 48, v * 3, 48, 317) > 0.68 ? 1 : 0;
  const grime = skirting * 40 + underCeiling * 22 + blotch * 22 + streak * 10;

  if (lx === 0 || ly === 0) {
    const g = 108 - grime * 0.5;
    return [g, g - 4, g - 20];
  }

  const tileTone = (hash2d(col, row, 331) - 0.5) * 18;
  const bevel = lx === 1 || ly === WALL_TILE_PX - 1 ? 9 : lx === WALL_TILE_PX - 1 || ly === 1 ? -9 : 0;
  const shade = tileTone + bevel - grime;

  if (WALL_BAND_ROWS.includes(row)) {
    return [74 + shade * 0.7, 96 + shade * 0.7, 124 + shade * 0.7];
  }
  const chipped = hash2d(col, row, 337) > 0.965 ? -34 : 0;
  // Nicotine-yellow ageing: the blue channel fades fastest.
  const yellowing = blotch * 16;
  return [206 + shade + chipped, 200 + shade + chipped, 162 + shade + chipped - yellowing];
}

function paintFloorTile(x: number, y: number, u: number, v: number): RGB {
  const S = 128;
  const half = S >> 1;
  const lx = x % half;
  const ly = y % half;
  if (lx === 0 || ly === 0) return [26, 24, 20];

  const isLightTile = (Math.floor(x / half) + Math.floor(y / half)) % 2 === 0;
  const mottling = (valueNoise2d(u * 10, v * 10, 10, 401) - 0.5) * 22;
  const vein = valueNoise2d(u * 4, v * 22, 22, 409) > 0.8 ? 10 : 0;
  const scuff = valueNoise2d(u * 14, v * 14, 14, 419) > 0.74 ? -9 : 0;
  const edgeWear = lx === 1 || ly === 1 ? 10 : 0;
  const shade = mottling + vein + scuff + edgeWear;
  return isLightTile ? [98 + shade, 92 + shade, 80 + shade] : [66 + shade, 63 + shade, 58 + shade];
}

function paintCeilingPanel(x: number, y: number, u: number, v: number): RGB {
  const S = 128;
  const half = S >> 1;
  const lx = x % half;
  const ly = y % half;
  if (lx === 0 || ly === 0) return [104, 100, 84];

  const stain = valueNoise2d(u * 5, v * 5, 5, 503);
  const waterMark = stain > 0.7 ? (stain - 0.7) * 120 : 0;
  const speckle = (hash2d(x, y, 509) - 0.5) * 10;
  const base = 162 + speckle - stain * 14 - (lx === 1 || ly === 1 ? 10 : 0);
  return [base - waterMark * 0.6, base - 4 - waterMark * 0.8, base - 20 - waterMark * 1.3];
}

function paintAgedConcrete(x: number, y: number, u: number, v: number): RGB {
  const fine = (hash2d(x, y, 919) - 0.5) * 12;
  const mottling = (valueNoise2d(u * 8, v * 8, 8, 923) - 0.5) * 26;
  const formLine = y % 32 === 0 ? -18 : y % 32 === 1 ? 8 : 0;
  const footGrime = Math.max(0, 1 - v * 5) * 24;
  const base = 122 + fine + mottling + formLine - footGrime;
  return [base, base - 5, base - 22];
}

export function getOrCreateTileHallTextures(device: pc.GraphicsDevice): TileHallTextures {
  let textures = cachedByDevice.get(device);
  if (!textures) {
    textures = {
      wallTile: createTacticalAlbedoTexture(device, 'hall_wall_ceramic_tile', WALL_TEX_SIZE, paintWallTile),
      floorTile: createTacticalAlbedoTexture(device, 'hall_floor_checker_tile', 128, paintFloorTile),
      ceilingPanel: createTacticalAlbedoTexture(device, 'hall_ceiling_panel', 128, paintCeilingPanel),
      agedConcrete: createTacticalAlbedoTexture(device, 'hall_aged_concrete', 128, paintAgedConcrete),
    };
    cachedByDevice.set(device, textures);
  }
  return textures;
}
