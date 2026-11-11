import type * as pc from 'playcanvas';

export interface TransientFireballLobe {
  entity: pc.Entity;
  meshInstance: pc.MeshInstance | null;
  diffuseUniform: Float32Array;
  emissiveUniform: Float32Array;
  position: pc.Vec3;
  velocity: pc.Vec3;
  angularVelocity: pc.Vec3;
  elapsedS: number;
  durationS: number;
  startScale: number;
  endScale: number;
}

export interface TransientBillowPlume {
  entity: pc.Entity;
  meshInstance: pc.MeshInstance;
  position: pc.Vec3;
  velocity: pc.Vec3;
  elapsedS: number;
  durationS: number;
  startScale: number;
  endScale: number;
  baseOpacity: number;
  spinDegPerS: number;
  isGroundRing: boolean;
}

export interface ExplosionTemplateMaterials {
  dustPlumeTemplateMat: pc.StandardMaterial;
  brickDustTemplateMat: pc.StandardMaterial;
  woodDustTemplateMat: pc.StandardMaterial;
  metalDustTemplateMat: pc.StandardMaterial;
  darkSmokeTemplateMat: pc.StandardMaterial;
  shockwaveRingTemplateMat: pc.StandardMaterial;
  flashCoreTemplateMat: pc.StandardMaterial;
  fireballLobeTemplateMat: pc.StandardMaterial;
}
