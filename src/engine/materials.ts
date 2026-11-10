import * as pc from 'playcanvas';

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

/**
 * Creates and caches the complete material palette for GHOUL-X PlayCanvas rendering.
 */
export function getOrCreateMaterials(): EngineMaterialPalette {
  if (cachedPalette) {
    return cachedPalette;
  }

  // 1. Tactical outer gear & skin
  const tacticalOlive = new pc.StandardMaterial();
  tacticalOlive.name = 'tacticalOlive';
  tacticalOlive.diffuse = new pc.Color(0.24, 0.28, 0.18);
  tacticalOlive.specular = new pc.Color(0.08, 0.08, 0.08);
  tacticalOlive.shininess = 20;
  tacticalOlive.update();

  const tacticalArmorVest = new pc.StandardMaterial();
  tacticalArmorVest.name = 'tacticalArmorVest';
  tacticalArmorVest.diffuse = new pc.Color(0.12, 0.14, 0.13);
  tacticalArmorVest.specular = new pc.Color(0.15, 0.15, 0.15);
  tacticalArmorVest.shininess = 35;
  tacticalArmorVest.update();

  const skinTone = new pc.StandardMaterial();
  skinTone.name = 'skinTone';
  skinTone.diffuse = new pc.Color(0.76, 0.58, 0.46);
  skinTone.specular = new pc.Color(0.06, 0.06, 0.06);
  skinTone.shininess = 15;
  skinTone.update();

  const bootsDark = new pc.StandardMaterial();
  bootsDark.name = 'bootsDark';
  bootsDark.diffuse = new pc.Color(0.09, 0.09, 0.1);
  bootsDark.specular = new pc.Color(0.12, 0.12, 0.12);
  bootsDark.shininess = 25;
  bootsDark.update();

  // 2. Translucent X-Ray outer silhouette
  // Opacity: 0.22, BLEND_NORMAL, cyan/blue rim emissive so internal skeleton & organs shine through
  const xraySkinMat = new pc.StandardMaterial();
  xraySkinMat.name = 'xraySkinMat';
  xraySkinMat.diffuse = new pc.Color(0.05, 0.25, 0.45);
  xraySkinMat.emissive = new pc.Color(0.02, 0.22, 0.38);
  xraySkinMat.opacity = 0.22;
  xraySkinMat.blendType = pc.BLEND_NORMAL;
  xraySkinMat.depthWrite = false;
  xraySkinMat.cull = pc.CULLFACE_BACK;
  xraySkinMat.update();

  // 3. Cortical Bone & Fractured Bone
  const boneMat = new pc.StandardMaterial();
  boneMat.name = 'boneMat';
  boneMat.diffuse = new pc.Color(0.92, 0.89, 0.78); // warm ivory
  boneMat.specular = new pc.Color(0.3, 0.3, 0.28);
  boneMat.shininess = 40;
  boneMat.update();

  const shatteredBoneMat = new pc.StandardMaterial();
  shatteredBoneMat.name = 'shatteredBoneMat';
  shatteredBoneMat.diffuse = new pc.Color(0.95, 0.25, 0.15);
  shatteredBoneMat.emissive = new pc.Color(0.85, 0.15, 0.05);
  shatteredBoneMat.specular = new pc.Color(0.4, 0.4, 0.4);
  shatteredBoneMat.shininess = 50;
  shatteredBoneMat.update();

  // 4. Vital Organs
  const brainMat = new pc.StandardMaterial();
  brainMat.name = 'brainMat';
  brainMat.diffuse = new pc.Color(0.82, 0.38, 0.48); // pulsing rose/magenta
  brainMat.emissive = new pc.Color(0.25, 0.05, 0.1);
  brainMat.shininess = 30;
  brainMat.update();

  const heartMat = new pc.StandardMaterial();
  heartMat.name = 'heartMat';
  heartMat.diffuse = new pc.Color(0.85, 0.04, 0.08); // vivid arterial red
  heartMat.emissive = new pc.Color(0.35, 0.02, 0.02);
  heartMat.specular = new pc.Color(0.4, 0.1, 0.1);
  heartMat.shininess = 65; // wet sheen
  heartMat.update();

  const lungMat = new pc.StandardMaterial();
  lungMat.name = 'lungMat';
  lungMat.diffuse = new pc.Color(0.75, 0.42, 0.48); // vascular pink
  lungMat.opacity = 0.85;
  lungMat.blendType = pc.BLEND_NORMAL;
  lungMat.shininess = 20;
  lungMat.update();

  const liverGutMat = new pc.StandardMaterial();
  liverGutMat.name = 'liverGutMat';
  liverGutMat.diffuse = new pc.Color(0.45, 0.12, 0.12); // deep maroon
  liverGutMat.specular = new pc.Color(0.3, 0.1, 0.1);
  liverGutMat.shininess = 50; // wet sheen
  liverGutMat.update();

  const arteryMat = new pc.StandardMaterial();
  arteryMat.name = 'arteryMat';
  arteryMat.diffuse = new pc.Color(0.95, 0.02, 0.02);
  arteryMat.emissive = new pc.Color(0.65, 0.01, 0.01); // glowing crimson
  arteryMat.update();

  // 5. Soldier of Fortune Gore
  const goreStumpMat = new pc.StandardMaterial();
  goreStumpMat.name = 'goreStumpMat';
  goreStumpMat.diffuse = new pc.Color(0.48, 0.02, 0.04); // deep wet visceral crimson
  goreStumpMat.specular = new pc.Color(0.5, 0.1, 0.1);
  goreStumpMat.shininess = 80;
  goreStumpMat.update();

  const exposedBoneMat = new pc.StandardMaterial();
  exposedBoneMat.name = 'exposedBoneMat';
  exposedBoneMat.diffuse = new pc.Color(0.98, 0.96, 0.93); // stark white bone marrow
  exposedBoneMat.specular = new pc.Color(0.35, 0.35, 0.35);
  exposedBoneMat.shininess = 60;
  exposedBoneMat.update();

  const bloodPoolMat = new pc.StandardMaterial();
  bloodPoolMat.name = 'bloodPoolMat';
  bloodPoolMat.diffuse = new pc.Color(0.32, 0.01, 0.02);
  bloodPoolMat.specular = new pc.Color(0.6, 0.1, 0.1);
  bloodPoolMat.opacity = 0.88;
  bloodPoolMat.blendType = pc.BLEND_NORMAL;
  bloodPoolMat.shininess = 90; // wet pool reflection
  bloodPoolMat.update();

  const bloodDropMat = new pc.StandardMaterial();
  bloodDropMat.name = 'bloodDropMat';
  bloodDropMat.diffuse = new pc.Color(0.65, 0.02, 0.04);
  bloodDropMat.emissive = new pc.Color(0.2, 0.0, 0.01);
  bloodDropMat.shininess = 75;
  bloodDropMat.update();

  const gibChunkMat = new pc.StandardMaterial();
  gibChunkMat.name = 'gibChunkMat';
  gibChunkMat.diffuse = new pc.Color(0.5, 0.06, 0.08);
  gibChunkMat.specular = new pc.Color(0.4, 0.1, 0.1);
  gibChunkMat.shininess = 70;
  gibChunkMat.update();

  const woundGoreMat = new pc.StandardMaterial();
  woundGoreMat.name = 'woundGoreMat';
  woundGoreMat.diffuse = new pc.Color(0.38, 0.02, 0.03);
  woundGoreMat.specular = new pc.Color(0.3, 0.05, 0.05);
  woundGoreMat.shininess = 60;
  woundGoreMat.update();

  // 6. Ballistics & Projectiles
  const brassBulletMat = new pc.StandardMaterial();
  brassBulletMat.name = 'brassBulletMat';
  brassBulletMat.diffuse = new pc.Color(0.85, 0.65, 0.25);
  brassBulletMat.specular = new pc.Color(0.9, 0.75, 0.4);
  brassBulletMat.shininess = 85;
  brassBulletMat.metalness = 0.8;
  brassBulletMat.update();

  const copperPelletMat = new pc.StandardMaterial();
  copperPelletMat.name = 'copperPelletMat';
  copperPelletMat.diffuse = new pc.Color(0.72, 0.42, 0.25);
  copperPelletMat.specular = new pc.Color(0.8, 0.5, 0.3);
  copperPelletMat.shininess = 70;
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

  // 7. Environment & Arena Floor
  const floorGridMat = new pc.StandardMaterial();
  floorGridMat.name = 'floorGridMat';
  floorGridMat.diffuse = new pc.Color(0.08, 0.1, 0.13);
  floorGridMat.specular = new pc.Color(0.05, 0.05, 0.05);
  floorGridMat.shininess = 15;
  floorGridMat.update();

  const rangeDistanceMarkerMat = new pc.StandardMaterial();
  rangeDistanceMarkerMat.name = 'rangeDistanceMarkerMat';
  rangeDistanceMarkerMat.diffuse = new pc.Color(0.92, 0.72, 0.18);
  rangeDistanceMarkerMat.emissive = new pc.Color(0.3, 0.2, 0.05);
  rangeDistanceMarkerMat.update();

  const barrierConcreteMat = new pc.StandardMaterial();
  barrierConcreteMat.name = 'barrierConcreteMat';
  barrierConcreteMat.diffuse = new pc.Color(0.28, 0.3, 0.32);
  barrierConcreteMat.specular = new pc.Color(0.08, 0.08, 0.08);
  barrierConcreteMat.shininess = 10;
  barrierConcreteMat.update();

  const sandbagMat = new pc.StandardMaterial();
  sandbagMat.name = 'sandbagMat';
  sandbagMat.diffuse = new pc.Color(0.42, 0.36, 0.24);
  sandbagMat.specular = new pc.Color(0.04, 0.04, 0.04);
  sandbagMat.shininess = 8;
  sandbagMat.update();

  const targetStandMat = new pc.StandardMaterial();
  targetStandMat.name = 'targetStandMat';
  targetStandMat.diffuse = new pc.Color(0.18, 0.18, 0.2);
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
