import * as pc from 'playcanvas';
import { HALL_LENGTH_M, HALL_SHELL } from '../world/arenaLayout.ts';
import { getOrCreateTileHallTextures } from './tileHallTextures.ts';

/** One floor texture repeat is a 2x2 checker of tiles this many metres across. */
const FLOOR_REPEAT_M = 1.0;

/**
 * Configures a surface the way turn-of-the-millennium shooters shaded their worlds:
 * a painted low-resolution colour map and plain diffuse lighting, with no normal or gloss maps.
 */
export function applyFlatPaintedSurface(
  mat: pc.StandardMaterial,
  diffuseMap: pc.Texture,
  tiling: pc.Vec2,
  sheen = 0
): void {
  mat.diffuse = new pc.Color(1, 1, 1);
  mat.diffuseMap = diffuseMap;
  mat.diffuseMapTiling = tiling;
  mat.normalMap = null;
  mat.glossMap = null;
  mat.useMetalness = false;
  mat.metalness = 0;
  mat.enableGGXSpecular = false;
  mat.specular = new pc.Color(sheen, sheen, sheen * 0.9);
  mat.gloss = sheen > 0 ? 0.5 : 0.1;
  mat.update();
}

/**
 * Dresses the hall floor in worn checker tiles and the barriers/posts in aged concrete.
 */
export function applyRetroEnvironmentTextures(
  device: pc.GraphicsDevice,
  floorMat: pc.StandardMaterial,
  concreteMat: pc.StandardMaterial
): void {
  const textures = getOrCreateTileHallTextures(device);

  const floorTiling = new pc.Vec2(
    (HALL_SHELL.halfWidthM * 2) / FLOOR_REPEAT_M,
    HALL_LENGTH_M / FLOOR_REPEAT_M
  );
  applyFlatPaintedSurface(floorMat, textures.floorTile, floorTiling, 0.1);
  applyFlatPaintedSurface(concreteMat, textures.agedConcrete, new pc.Vec2(3, 1));
}
