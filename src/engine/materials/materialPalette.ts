import * as pc from 'playcanvas';
import type { EngineMaterialPalette } from './materialTypes.ts';

let cachedPalette: EngineMaterialPalette | null = null;

export function configurePbrDielectric(
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

export function configurePbrMetal(
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

function createMat(name: string, config: (m: pc.StandardMaterial) => void): pc.StandardMaterial {
  const m = new pc.StandardMaterial();
  m.name = name;
  config(m);
  m.update();
  return m;
}

export function getOrCreateMaterials(): EngineMaterialPalette {
  if (cachedPalette) return cachedPalette;

  const tacticalOlive = createMat('tacticalOlive', (m) => configurePbrDielectric(m, [0.22, 0.26, 0.17], 0.26));
  const tacticalArmorVest = createMat('tacticalArmorVest', (m) => configurePbrMetal(m, [0.15, 0.17, 0.18], 0.35, 0.44));
  const skinTone = createMat('skinTone', (m) => configurePbrDielectric(m, [0.76, 0.58, 0.46], 0.36));
  const bootsDark = createMat('bootsDark', (m) => configurePbrMetal(m, [0.11, 0.12, 0.13], 0.55, 0.48));

  const xraySkinMat = createMat('xraySkinMat', (m) => {
    m.diffuse = new pc.Color(0.05, 0.25, 0.45);
    m.emissive = new pc.Color(0.02, 0.22, 0.38);
    m.opacity = 0.22;
    m.blendType = pc.BLEND_NORMAL;
    m.depthWrite = false;
    m.cull = pc.CULLFACE_BACK;
    m.enableGGXSpecular = true;
    m.fresnelModel = pc.FRESNEL_SCHLICK;
    m.gloss = 0.78;
  });

  const boneMat = createMat('boneMat', (m) => configurePbrDielectric(m, [0.91, 0.88, 0.77], 0.54, [0.14, 0.14, 0.12]));
  const shatteredBoneMat = createMat('shatteredBoneMat', (m) => {
    configurePbrDielectric(m, [0.94, 0.24, 0.15], 0.68, [0.22, 0.16, 0.14]);
    m.emissive = new pc.Color(0.75, 0.12, 0.04);
  });

  const brainMat = createMat('brainMat', (m) => {
    configurePbrDielectric(m, [0.78, 0.36, 0.46], 0.84, [0.20, 0.14, 0.16]);
    m.emissive = new pc.Color(0.18, 0.03, 0.06);
  });
  const heartMat = createMat('heartMat', (m) => {
    configurePbrDielectric(m, [0.72, 0.04, 0.07], 0.90, [0.28, 0.12, 0.14]);
    m.emissive = new pc.Color(0.24, 0.01, 0.02);
  });
  const lungMat = createMat('lungMat', (m) => {
    configurePbrDielectric(m, [0.82, 0.42, 0.46], 0.72, [0.18, 0.12, 0.14]);
    m.emissive = new pc.Color(0.14, 0.04, 0.05);
  });
  const liverGutMat = createMat('liverGutMat', (m) => {
    configurePbrDielectric(m, [0.46, 0.10, 0.12], 0.86, [0.22, 0.08, 0.09]);
    m.emissive = new pc.Color(0.16, 0.02, 0.03);
  });
  const arteryMat = createMat('arteryMat', (m) => {
    configurePbrDielectric(m, [0.92, 0.03, 0.04], 0.94, [0.35, 0.10, 0.12]);
    m.emissive = new pc.Color(0.40, 0.01, 0.02);
  });

  const goreStumpMat = createMat('goreStumpMat', (m) => {
    configurePbrDielectric(m, [0.55, 0.04, 0.05], 0.86, [0.24, 0.06, 0.08]);
    m.emissive = new pc.Color(0.18, 0.01, 0.02);
  });
  // Raw meat on a severed end: dark and matte, so it reads as a cut rather than a glossy ball.
  const stumpFleshMat = createMat('stumpFleshMat', (m) => {
    configurePbrDielectric(m, [0.3, 0.035, 0.04], 0.35, [0.05, 0.02, 0.02]);
    m.emissive = new pc.Color(0.05, 0.0, 0.005);
  });
  const exposedBoneMat = createMat('exposedBoneMat', (m) => configurePbrDielectric(m, [0.74, 0.66, 0.56], 0.42, [0.12, 0.12, 0.10]));
  const bloodPoolMat = createMat('bloodPoolMat', (m) => {
    configurePbrDielectric(m, [0.28, 0.01, 0.02], 0.96, [0.40, 0.08, 0.10]);
    m.opacity = 0.94;
    m.blendType = pc.BLEND_NORMAL;
    m.cull = pc.CULLFACE_BACK;
  });
  const bloodDropMat = createMat('bloodDropMat', (m) => {
    configurePbrDielectric(m, [0.85, 0.02, 0.03], 0.95, [0.36, 0.06, 0.08]);
    m.emissive = new pc.Color(0.32, 0.01, 0.02);
  });
  const gibChunkMat = createMat('gibChunkMat', (m) => {
    configurePbrDielectric(m, [0.48, 0.05, 0.07], 0.82, [0.22, 0.08, 0.10]);
    m.emissive = new pc.Color(0.12, 0.01, 0.02);
  });
  const woundGoreMat = createMat('woundGoreMat', (m) => {
    configurePbrDielectric(m, [0.62, 0.02, 0.04], 0.88, [0.28, 0.06, 0.08]);
    m.emissive = new pc.Color(0.25, 0.01, 0.02);
  });

  const brassBulletMat = createMat('brassBulletMat', (m) => configurePbrMetal(m, [0.88, 0.72, 0.32], 0.88, 0.82));
  const copperPelletMat = createMat('copperPelletMat', (m) => configurePbrMetal(m, [0.82, 0.48, 0.28], 0.85, 0.78));

  const shockwaveRingMat = createMat('shockwaveRingMat', (m) => {
    m.diffuse = new pc.Color(0.85, 0.95, 1.0);
    m.emissive = new pc.Color(0.4, 0.7, 1.0);
    m.opacity = 0.45;
    m.blendType = pc.BLEND_NORMAL;
    m.cull = pc.CULLFACE_NONE;
    m.depthWrite = false;
  });

  const pelletTrailMat = createMat('pelletTrailMat', (m) => {
    m.diffuse = new pc.Color(1.0, 0.8, 0.3);
    m.emissive = new pc.Color(0.95, 0.7, 0.15);
    m.opacity = 0.6;
    m.blendType = pc.BLEND_NORMAL;
    m.depthWrite = false;
  });

  const floorGridMat = createMat('floorGridMat', (m) => configurePbrMetal(m, [0.11, 0.13, 0.16], 0.06, 0.48));
  const rangeDistanceMarkerMat = createMat('rangeDistanceMarkerMat', (m) => {
    configurePbrDielectric(m, [0.92, 0.70, 0.16], 0.45, [0.10, 0.10, 0.08]);
    m.emissive = new pc.Color(0.24, 0.16, 0.03);
  });
  const barrierConcreteMat = createMat('barrierConcreteMat', (m) => configurePbrMetal(m, [0.34, 0.36, 0.38], 0.04, 0.28));
  const sandbagMat = createMat('sandbagMat', (m) => configurePbrDielectric(m, [0.44, 0.38, 0.26], 0.22, [0.04, 0.04, 0.04]));
  const targetStandMat = createMat('targetStandMat', (m) => configurePbrMetal(m, [0.22, 0.24, 0.27], 0.82, 0.58));

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
    stumpFleshMat,
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
