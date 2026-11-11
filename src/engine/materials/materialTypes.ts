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

  // Soldier of Fortune Gore
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
