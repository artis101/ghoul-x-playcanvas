import * as pc from 'playcanvas';
import { createCharredBarrelMaterial, createHazardBarrelMaterial } from '../materials/hazardBarrelMaterials.ts';
import { createScorchDecalMaterial } from '../materials/decalMaterials.ts';
import { buildLoftedDrumMesh, buildUnitQuadZMesh } from '../particles/fxMeshBuilders.ts';
import { CRUMPLED_BASE_RINGS, INTACT_DRUM_RINGS } from './barrelTypes.ts';

export interface BarrelResources {
  intactMesh: pc.Mesh;
  crumpledMesh: pc.Mesh;
  scorchQuadMesh: pc.Mesh;
  intactMat: pc.StandardMaterial;
  charredMat: pc.StandardMaterial;
  scorchMat: pc.StandardMaterial;
  flameJetMat: pc.StandardMaterial;
}

export function createBarrelFlameJetMaterial(): pc.StandardMaterial {
  const mat = new pc.StandardMaterial();
  mat.name = 'barrelHissingFlameJetMat';
  mat.diffuse = new pc.Color(1.0, 0.72, 0.18);
  mat.emissive = new pc.Color(1.0, 0.58, 0.12);
  mat.emissiveIntensity = 3.2;
  mat.opacity = 0.9;
  mat.blendType = pc.BLEND_ADDITIVEALPHA;
  mat.depthWrite = false;
  mat.cull = pc.CULLFACE_NONE;
  mat.update();
  return mat;
}

export function createBarrelResources(device: pc.GraphicsDevice): BarrelResources {
  const intactMesh = buildLoftedDrumMesh(device, INTACT_DRUM_RINGS, 20, 0);
  intactMesh.incRefCount();
  const crumpledMesh = buildLoftedDrumMesh(device, CRUMPLED_BASE_RINGS, 16, 73);
  crumpledMesh.incRefCount();
  const scorchQuadMesh = buildUnitQuadZMesh(device);
  scorchQuadMesh.incRefCount();

  return {
    intactMesh,
    crumpledMesh,
    scorchQuadMesh,
    intactMat: createHazardBarrelMaterial(device),
    charredMat: createCharredBarrelMaterial(),
    scorchMat: createScorchDecalMaterial(device),
    flameJetMat: createBarrelFlameJetMaterial(),
  };
}

export function destroyBarrelResources(res: BarrelResources | null): void {
  if (!res) return;
  res.intactMesh.destroy();
  res.crumpledMesh.destroy();
  res.scorchQuadMesh.destroy();
}
