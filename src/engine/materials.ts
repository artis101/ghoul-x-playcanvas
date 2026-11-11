import * as pc from 'playcanvas';
import {
  applyRetroEnvironmentTextures,
  createProceduralNormalAndGlossMaps,
} from './retroTextures.ts';

export interface EngineMaterialPalette {
  // Tactical intact flesh & gear
  tacticalOlive: pc.StandardMaterial;
  tacticalArmorVest: pc.StandardMaterial;
  skinTone: pc.StandardMaterial;
  bootsDark: pc.StandardMaterial;

  // X-Ray silhouette
  xraySkinMat: pc.StandardMaterial;

  // Internal skeleton
  boneMat: pc.StandardMaterial;
  shatteredBoneMat: pc.StandardMaterial;

  // Vital organs
  brainMat: pc.StandardMaterial;
  heartMat: pc.StandardMaterial;
  lungMat: pc.StandardMaterial;
  liverGutMat: pc.StandardMaterial;
  arteryMat: pc.StandardMaterial;

  // Early-2000s Soldier of Fortune Gore
  goreStumpMat: pc.StandardMaterial;
  exposedBoneMat: pc.StandardMaterial;
  bloodPoolMat: pc.StandardMaterial;
  bloodDropMat: pc.StandardMaterial;
  gibChunkMat: pc.StandardMaterial;
  woundGoreMat: pc.StandardMaterial;

  // Ballistics & Projectiles
  brassBulletMat: pc.StandardMaterial;
  copperPelletMat: pc.StandardMaterial;
  shockwaveRingMat: pc.StandardMaterial;
  pelletTrailMat: pc.StandardMaterial;

  // Environment & Range
  floorGridMat: pc.StandardMaterial;
  rangeDistanceMarkerMat: pc.StandardMaterial;
  barrierConcreteMat: pc.StandardMaterial;
  sandbagMat: pc.StandardMaterial;
  targetStandMat: pc.StandardMaterial;
}

let cachedPalette: EngineMaterialPalette | null = null;
const upgradedDevices = new WeakSet<pc.GraphicsDevice>();

function configurePbrDielectric(
  mat: pc.StandardMaterial,
  diffuse: [number, number, number],
  gloss: number,
  specular: [number, number, number] = [0.06, 0.06, 0.06]
): void {
  mat.diffuse = new pc.Color(diffuse[0], diffuse[1], diffuse[2]);
  mat.specular = new pc.Color(specular[0], specular[1], specular[2]);
  mat.gloss = gloss;
  mat.enableGGXSpecular = true;
  mat.fresnelModel = pc.FRESNEL_SCHLICK;
}

function configurePbrMetal(
  mat: pc.StandardMaterial,
  diffuse: [number, number, number],
  metalness: number,
  gloss: number
): void {
  mat.diffuse = new pc.Color(diffuse[0], diffuse[1], diffuse[2]);
  mat.useMetalness = true;
  mat.metalness = metalness;
  mat.gloss = gloss;
  mat.enableGGXSpecular = true;
  mat.fresnelModel = pc.FRESNEL_SCHLICK;
}

/**
 * Creates and caches the complete PlayCanvas 2.4 PBR material palette for GHOUL-X rendering.
 */
export function getOrCreateMaterials(): EngineMaterialPalette {
  if (cachedPalette) {
    return cachedPalette;
  }

  // 1. Tactical outer gear & skin
  const tacticalOlive = new pc.StandardMaterial();
  tacticalOlive.name = 'tacticalOlive';
  configurePbrDielectric(tacticalOlive, [0.22, 0.26, 0.17], 0.26, [0.05, 0.05, 0.05]);
  tacticalOlive.update();

  const tacticalArmorVest = new pc.StandardMaterial();
  tacticalArmorVest.name = 'tacticalArmorVest';
  configurePbrMetal(tacticalArmorVest, [0.15, 0.17, 0.18], 0.35, 0.44);
  tacticalArmorVest.update();

  const skinTone = new pc.StandardMaterial();
  skinTone.name = 'skinTone';
  configurePbrDielectric(skinTone, [0.76, 0.58, 0.46], 0.36, [0.05, 0.045, 0.04]);
  skinTone.update();

  const bootsDark = new pc.StandardMaterial();
  bootsDark.name = 'bootsDark';
  configurePbrMetal(bootsDark, [0.11, 0.12, 0.13], 0.55, 0.48);
  bootsDark.update();

  // 2. Translucent X-Ray outer silhouette
  const xraySkinMat = new pc.StandardMaterial();
  xraySkinMat.name = 'xraySkinMat';
  xraySkinMat.diffuse = new pc.Color(0.05, 0.25, 0.45);
  xraySkinMat.emissive = new pc.Color(0.02, 0.22, 0.38);
  xraySkinMat.opacity = 0.22;
  xraySkinMat.blendType = pc.BLEND_NORMAL;
  xraySkinMat.depthWrite = false;
  xraySkinMat.cull = pc.CULLFACE_BACK;
  xraySkinMat.enableGGXSpecular = true;
  xraySkinMat.fresnelModel = pc.FRESNEL_SCHLICK;
  xraySkinMat.gloss = 0.78;
  xraySkinMat.update();

  // 3. Cortical Bone & Fractured Bone
  const boneMat = new pc.StandardMaterial();
  boneMat.name = 'boneMat';
  configurePbrDielectric(boneMat, [0.91, 0.88, 0.77], 0.54, [0.14, 0.14, 0.12]);
  boneMat.update();

  const shatteredBoneMat = new pc.StandardMaterial();
  shatteredBoneMat.name = 'shatteredBoneMat';
  configurePbrDielectric(shatteredBoneMat, [0.94, 0.24, 0.15], 0.68, [0.22, 0.16, 0.14]);
  shatteredBoneMat.emissive = new pc.Color(0.75, 0.12, 0.04);
  shatteredBoneMat.update();

  // 4. Vital Organs (wet serous membrane sheen under IBL)
  const brainMat = new pc.StandardMaterial();
  brainMat.name = 'brainMat';
  configurePbrDielectric(brainMat, [0.78, 0.36, 0.46], 0.84, [0.20, 0.14, 0.16]);
  brainMat.emissive = new pc.Color(0.18, 0.03, 0.06);
  brainMat.update();

  const heartMat = new pc.StandardMaterial();
  heartMat.name = 'heartMat';
  configurePbrDielectric(heartMat, [0.72, 0.04, 0.07], 0.90, [0.28, 0.10, 0.10]);
  heartMat.emissive = new pc.Color(0.24, 0.015, 0.018);
  heartMat.update();

  const lungMat = new pc.StandardMaterial();
  lungMat.name = 'lungMat';
  configurePbrDielectric(lungMat, [0.74, 0.40, 0.46], 0.76, [0.14, 0.10, 0.11]);
  lungMat.opacity = 0.86;
  lungMat.blendType = pc.BLEND_NORMAL;
  lungMat.update();

  const liverGutMat = new pc.StandardMaterial();
  liverGutMat.name = 'liverGutMat';
  configurePbrDielectric(liverGutMat, [0.40, 0.09, 0.10], 0.88, [0.24, 0.10, 0.10]);
  liverGutMat.update();

  const arteryMat = new pc.StandardMaterial();
  arteryMat.name = 'arteryMat';
  configurePbrDielectric(arteryMat, [0.88, 0.02, 0.03], 0.88, [0.25, 0.08, 0.08]);
  arteryMat.emissive = new pc.Color(0.55, 0.01, 0.01);
  arteryMat.update();

  // 5. Visceral GHOUL Gore & Arterial Blood
  const goreStumpMat = new pc.StandardMaterial();
  goreStumpMat.name = 'goreStumpMat';
  configurePbrDielectric(goreStumpMat, [0.38, 0.02, 0.035], 0.91, [0.28, 0.09, 0.09]);
  goreStumpMat.emissive = new pc.Color(0.03, 0.002, 0.003);
  goreStumpMat.update();

  const exposedBoneMat = new pc.StandardMaterial();
  exposedBoneMat.name = 'exposedBoneMat';
  configurePbrMetal(exposedBoneMat, [0.95, 0.93, 0.89], 0.18, 0.72);
  exposedBoneMat.update();

  const bloodPoolMat = new pc.StandardMaterial();
  bloodPoolMat.name = 'bloodPoolMat';
  configurePbrDielectric(bloodPoolMat, [0.24, 0.008, 0.015], 0.95, [0.34, 0.09, 0.09]);
  bloodPoolMat.opacity = 0.90;
  bloodPoolMat.blendType = pc.BLEND_NORMAL;
  bloodPoolMat.update();

  const bloodDropMat = new pc.StandardMaterial();
  bloodDropMat.name = 'bloodDropMat';
  configurePbrDielectric(bloodDropMat, [0.52, 0.015, 0.028], 0.92, [0.28, 0.08, 0.08]);
  bloodDropMat.emissive = new pc.Color(0.08, 0.002, 0.004);
  bloodDropMat.update();

  const gibChunkMat = new pc.StandardMaterial();
  gibChunkMat.name = 'gibChunkMat';
  configurePbrDielectric(gibChunkMat, [0.42, 0.035, 0.05], 0.88, [0.24, 0.08, 0.08]);
  gibChunkMat.update();

  const woundGoreMat = new pc.StandardMaterial();
  woundGoreMat.name = 'woundGoreMat';
  configurePbrDielectric(woundGoreMat, [0.32, 0.015, 0.025], 0.89, [0.24, 0.07, 0.07]);
  woundGoreMat.update();

  // 6. Ballistics & Projectiles
  const brassBulletMat = new pc.StandardMaterial();
  brassBulletMat.name = 'brassBulletMat';
  configurePbrMetal(brassBulletMat, [0.90, 0.71, 0.30], 0.92, 0.84);
  brassBulletMat.update();

  const copperPelletMat = new pc.StandardMaterial();
  copperPelletMat.name = 'copperPelletMat';
  configurePbrMetal(copperPelletMat, [0.80, 0.46, 0.28], 0.90, 0.78);
  copperPelletMat.update();

  const shockwaveRingMat = new pc.StandardMaterial();
  shockwaveRingMat.name = 'shockwaveRingMat';
  shockwaveRingMat.diffuse = new pc.Color(0.85, 0.95, 1.0);
  shockwaveRingMat.emissive = new pc.Color(0.4, 0.7, 1.0);
  shockwaveRingMat.opacity = 0.45;
  shockwaveRingMat.blendType = pc.BLEND_NORMAL;
  shockwaveRingMat.cull = pc.CULLFACE_NONE;
  shockwaveRingMat.depthWrite = false;
  shockwaveRingMat.update();

  const pelletTrailMat = new pc.StandardMaterial();
  pelletTrailMat.name = 'pelletTrailMat';
  pelletTrailMat.diffuse = new pc.Color(1.0, 0.8, 0.3);
  pelletTrailMat.emissive = new pc.Color(0.95, 0.7, 0.15);
  pelletTrailMat.opacity = 0.6;
  pelletTrailMat.blendType = pc.BLEND_NORMAL;
  pelletTrailMat.depthWrite = false;
  pelletTrailMat.update();

  // 7. Environment & Tactical Firing Range
  const floorGridMat = new pc.StandardMaterial();
  floorGridMat.name = 'floorGridMat';
  configurePbrMetal(floorGridMat, [0.11, 0.13, 0.16], 0.06, 0.48);
  floorGridMat.update();

  const rangeDistanceMarkerMat = new pc.StandardMaterial();
  rangeDistanceMarkerMat.name = 'rangeDistanceMarkerMat';
  configurePbrDielectric(rangeDistanceMarkerMat, [0.92, 0.70, 0.16], 0.45, [0.10, 0.10, 0.08]);
  rangeDistanceMarkerMat.emissive = new pc.Color(0.24, 0.16, 0.03);
  rangeDistanceMarkerMat.update();

  const barrierConcreteMat = new pc.StandardMaterial();
  barrierConcreteMat.name = 'barrierConcreteMat';
  configurePbrMetal(barrierConcreteMat, [0.34, 0.36, 0.38], 0.04, 0.28);
  barrierConcreteMat.update();

  const sandbagMat = new pc.StandardMaterial();
  sandbagMat.name = 'sandbagMat';
  configurePbrDielectric(sandbagMat, [0.44, 0.38, 0.26], 0.22, [0.04, 0.04, 0.04]);
  sandbagMat.update();

  const targetStandMat = new pc.StandardMaterial();
  targetStandMat.name = 'targetStandMat';
  configurePbrMetal(targetStandMat, [0.22, 0.24, 0.27], 0.82, 0.58);
  targetStandMat.update();

  cachedPalette = {
    tacticalOlive,
    tacticalArmorVest,
    skinTone,
    bootsDark,
    xraySkinMat,
    boneMat,
    shatteredBoneMat,
    brainMat,
    heartMat,
    lungMat,
    liverGutMat,
    arteryMat,
    goreStumpMat,
    exposedBoneMat,
    bloodPoolMat,
    bloodDropMat,
    gibChunkMat,
    woundGoreMat,
    brassBulletMat,
    copperPelletMat,
    shockwaveRingMat,
    pelletTrailMat,
    floorGridMat,
    rangeDistanceMarkerMat,
    barrierConcreteMat,
    sandbagMat,
    targetStandMat,
  };

  return cachedPalette;
}

/**
 * Attaches procedural tangent-space normal maps and gloss/roughness maps to the arena concrete,
 * floor slabs, sandbags, structural steel, and visceral GHOUL gore/organ shaders.
 */
export function upgradePaletteWithProceduralPbrMaps(
  device: pc.GraphicsDevice,
  palette: EngineMaterialPalette
): void {
  applyRetroEnvironmentTextures(device, palette.floorGridMat, palette.barrierConcreteMat);

  if (upgradedDevices.has(device)) {
    return;
  }
  upgradedDevices.add(device);

  // 1. Visceral muscle-fascia & cerebral sulci micro-normal + wet gloss map for gore/organs
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

  // 2. Coarse burlap weave normal + gloss map for sandbags & ballistic cover
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
