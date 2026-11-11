import * as pc from 'playcanvas';
import {
  applyRetroEnvironmentTextures,
  createProceduralNormalAndGlossMaps,
} from '../retroTextures.ts';
import type { EngineMaterialPalette } from './materialTypes.ts';

const upgradedDevices = new WeakSet<pc.GraphicsDevice>();

/**
 * Attaches procedural tangent-space normal maps and gloss/roughness maps to the arena concrete,
 * floor slabs, sandbags, structural steel, and visceral GHOUL gore/organ shaders.
 */
export function upgradePaletteWithProceduralPbrMaps(
  device: pc.GraphicsDevice,
  palette: EngineMaterialPalette
): void {
  applyRetroEnvironmentTextures(device, palette.floorGridMat, palette.barrierConcreteMat);

  if (upgradedDevices.has(device)) return;
  upgradedDevices.add(device);

  const { normalMap: goreNormal, glossMap: goreGloss } = createProceduralNormalAndGlossMaps(
    device,
    'visceral_gore_tissue',
    64,
    (_x, _y, u, v) => {
      const fibers =
        Math.sin(u * Math.PI * 12 + Math.sin(v * Math.PI * 6) * 1.4) * 0.32 +
        Math.cos(v * Math.PI * 10 - Math.sin(u * Math.PI * 8) * 1.2) * 0.24;
      const wetFilm = 0.78 + (Math.sin(u * Math.PI * 8) * Math.cos(v * Math.PI * 8) * 0.5 + 0.5) * 0.20;
      return { height: fibers, gloss: wetFilm };
    },
    2.2
  );

  for (const goreMat of [
    palette.goreStumpMat,
    palette.woundGoreMat,
    palette.gibChunkMat,
    palette.brainMat,
    palette.heartMat,
    palette.liverGutMat,
  ]) {
    goreMat.normalMap = goreNormal;
    goreMat.bumpiness = goreMat === palette.brainMat ? 1.35 : 1.05;
    goreMat.glossMap = goreGloss;
    goreMat.glossMapChannel = 'g';
    goreMat.update();
  }

  palette.bloodPoolMat.normalMap = goreNormal;
  palette.bloodPoolMat.bumpiness = 0.25;
  palette.bloodPoolMat.update();

  const { normalMap: burlapNormal, glossMap: burlapGloss } = createProceduralNormalAndGlossMaps(
    device,
    'burlap_sandbag_weave',
    64,
    (x, y) => {
      const weave = Math.sin(x * Math.PI * 0.5) * 0.28 + Math.sin(y * Math.PI * 0.5) * 0.28;
      const gloss = 0.16 + ((x + y) % 4 === 0 ? 0.08 : 0.0);
      return { height: weave, gloss };
    },
    1.8
  );

  palette.sandbagMat.normalMap = burlapNormal;
  palette.sandbagMat.normalMapTiling = new pc.Vec2(4, 4);
  palette.sandbagMat.bumpiness = 0.95;
  palette.sandbagMat.glossMap = burlapGloss;
  palette.sandbagMat.glossMapChannel = 'g';
  palette.sandbagMat.glossMapTiling = new pc.Vec2(4, 4);
  palette.sandbagMat.update();
}
