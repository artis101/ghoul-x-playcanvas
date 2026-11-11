import * as pc from 'playcanvas';
import type { EnemyArchetypeId } from '../../contracts/ballistics.ts';
import { createProceduralBrickMaterial } from '../destruction/brick/brickMaterial.ts';
import { createProceduralConcreteMaterial } from '../destruction/concrete/concreteMaterial.ts';
import { applyConcreteSurfaceCraterChunks } from '../destruction/decals/concreteCraterChunks.ts';
import { createProceduralCraterTextures } from '../destruction/decals/craterTextures.ts';
import { applyPomCraterShaderChunks } from '../destruction/decals/pomShaderChunks.ts';
import { createWindowGlassPaneTexture } from '../destruction/glass/glassPaneTexture.ts';
import { createMarchingGlassAtlasTexture } from '../destruction/glass/marchingGlassAtlas.ts';
import {
  createProceduralPineStudTexture,
  createProceduralWoodPanelTexture,
} from '../destruction/wood/woodProceduralTextures.ts';
import { createBarrelFlameJetMaterial } from '../fx/barrels/barrelResources.ts';
import { createExplosionTemplateMaterials } from '../fx/explosions/explosionMaterials.ts';
import { createWetGoreMaterialSuite } from '../fx/gore/wetGoreMaterials.ts';
import {
  createGleamingBrassCasingMaterial,
  createShotgunHullMaterial,
} from '../fx/materials/casingMaterials.ts';
import {
  createBloodSplatterMaterial,
  createScorchDecalMaterial,
} from '../fx/materials/decalMaterials.ts';
import {
  createCharredBarrelMaterial,
  createHazardBarrelMaterial,
} from '../fx/materials/hazardBarrelMaterials.ts';
import { createStreakGlowTexture } from '../fx/materials/transientFxMaterials.ts';
import { getOrCreateWetBloodMaps } from '../gore/vascular/vascularBloodMaps.ts';
import { createVascularBloodMaterials } from '../gore/vascular/vascularBloodMaterials.ts';
import {
  type EngineMaterialPalette,
  upgradePaletteWithProceduralPbrMaps,
} from '../materials.ts';
import { getOrCreateViewmodelFxAssets } from '../player/viewmodelFxAssets.ts';
import {
  applyRetroEnvironmentTextures,
  getArchetypeRetroMaterials,
} from '../retroTextures.ts';
import { getOrCreateProceduralIblEnvironment } from '../world/arenaIblLighting.ts';

const ARCHETYPES: readonly EnemyArchetypeId[] = [
  'SKINHEAD_PUNK',
  'HEAVY_ENFORCER',
  'SNIPER_OPERATIVE',
  'MILITIA_GUNNER',
];

const prewarmedDeviceMaterials = new WeakMap<pc.GraphicsDevice, pc.Material[]>();

function addUniqueMaterials(target: Set<pc.Material>, mats: Iterable<pc.Material | null | undefined>): void {
  for (const m of mats) {
    if (m) target.add(m);
  }
}

function createGlassWarmupMaterials(glassTex: pc.Texture): pc.StandardMaterial[] {
  const marchingMat = new pc.StandardMaterial();
  marchingMat.name = 'ArmoredVoronoiGlassMaterial';
  marchingMat.diffuse.set(0.84, 0.96, 0.96);
  marchingMat.diffuseMap = glassTex;
  marchingMat.opacityMap = glassTex;
  marchingMat.opacityMapChannel = 'a';
  marchingMat.emissive.set(0.18, 0.3, 0.32);
  marchingMat.emissiveMap = glassTex;
  marchingMat.useMetalness = true;
  marchingMat.metalness = 0.16;
  marchingMat.gloss = 0.95;
  marchingMat.blendType = pc.BLEND_NORMAL;
  marchingMat.depthWrite = false;
  marchingMat.cull = pc.CULLFACE_NONE;
  marchingMat.diffuseVertexColor = true;
  marchingMat.opacityVertexColor = true;
  marchingMat.update();

  const shardMat = new pc.StandardMaterial();
  shardMat.name = 'VoronoiExtrudedShardMaterial';
  shardMat.diffuse.set(0.84, 0.95, 1.0);
  shardMat.diffuseMap = glassTex;
  shardMat.emissive.set(0.18, 0.28, 0.34);
  shardMat.emissiveMap = glassTex;
  shardMat.useMetalness = true;
  shardMat.metalness = 0.2;
  shardMat.gloss = 0.96;
  shardMat.blendType = pc.BLEND_NORMAL;
  shardMat.depthWrite = false;
  shardMat.cull = pc.CULLFACE_NONE;
  shardMat.diffuseVertexColor = true;
  shardMat.opacityVertexColor = true;
  shardMat.update();

  const triMat = new pc.StandardMaterial();
  triMat.name = 'InstancedGlassTriangleMaterial';
  triMat.diffuse.set(0.84, 0.97, 1.0);
  triMat.emissive.set(0.28, 0.42, 0.48);
  triMat.useMetalness = true;
  triMat.metalness = 0.22;
  triMat.gloss = 0.96;
  triMat.opacity = 0.74;
  triMat.blendType = pc.BLEND_NORMAL;
  triMat.depthWrite = false;
  triMat.cull = pc.CULLFACE_NONE;
  triMat.update();

  return [marchingMat, shardMat, triMat];
}

export async function prewarmProceduralTexturesAndMaterials(
  app: pc.AppBase,
  basePalette: EngineMaterialPalette,
  onStep?: (label: string, done: number, total: number) => Promise<void> | void
): Promise<pc.Material[]> {
  const totalSteps = 10;
  const collected = new Set<pc.Material>();
  addUniqueMaterials(collected, Object.values(basePalette) as pc.Material[]);

  const device = app?.graphicsDevice;
  if (!device || device instanceof pc.NullGraphicsDevice) {
    for (let i = 1; i <= totalSteps; i++) {
      await onStep?.('Warming headless material definitions...', i, totalSteps);
    }
    return Array.from(collected);
  }

  const cached = prewarmedDeviceMaterials.get(device);
  if (cached) {
    for (let i = 1; i <= totalSteps; i++) {
      await onStep?.('Reusing cached procedural PBR textures & materials...', i, totalSteps);
    }
    addUniqueMaterials(collected, cached);
    return Array.from(collected);
  }

  await onStep?.('Synthesizing tactical PBR palette & range surface maps...', 1, totalSteps);
  applyRetroEnvironmentTextures(device, basePalette.floorGridMat, basePalette.barrierConcreteMat);
  upgradePaletteWithProceduralPbrMaps(device, basePalette);

  await onStep?.('Synthesizing HDR skybox & prefiltered IBL lighting atlas...', 2, totalSteps);
  const tempSun = new pc.Entity('PrewarmSunDir');
  tempSun.setEulerAngles(48, 32, 0);
  tempSun.syncHierarchy();
  getOrCreateProceduralIblEnvironment(device, tempSun.up);
  tempSun.destroy();

  await onStep?.('Generating procedural wood, terracotta brick & concrete textures...', 3, totalSteps);
  const brick = createProceduralBrickMaterial(device);
  const concrete = createProceduralConcreteMaterial(device);
  applyConcreteSurfaceCraterChunks(concrete.material);
  const woodPanelTex = createProceduralWoodPanelTexture(device);
  const woodStudTex = createProceduralPineStudTexture(device);
  const woodPanelMat = new pc.StandardMaterial();
  woodPanelMat.name = 'WoodWallPanelMat';
  woodPanelMat.diffuseMap = woodPanelTex;
  woodPanelMat.gloss = 0.22;
  woodPanelMat.cull = pc.CULLFACE_NONE;
  woodPanelMat.update();
  const woodStudMat = new pc.StandardMaterial();
  woodStudMat.name = 'WoodWallStudMat';
  woodStudMat.diffuseMap = woodStudTex;
  woodStudMat.gloss = 0.16;
  woodStudMat.cull = pc.CULLFACE_NONE;
  woodStudMat.update();
  addUniqueMaterials(collected, [brick.material, concrete.material, woodPanelMat, woodStudMat]);

  await onStep?.('Generating Parallax Occlusion Mapping (POM) crater & spall shaders...', 4, totalSteps);
  const craterTextures = createProceduralCraterTextures(device, 128);
  const pomDecalMat = new pc.StandardMaterial();
  pomDecalMat.name = 'ConcretePomCraterDecalMat';
  applyPomCraterShaderChunks(pomDecalMat, craterTextures);
  const spallChipMat = new pc.StandardMaterial();
  spallChipMat.name = 'ConcreteSpallChipMat';
  spallChipMat.diffuse = new pc.Color(0.68, 0.66, 0.63);
  spallChipMat.useMetalness = true;
  spallChipMat.metalness = 0.04;
  spallChipMat.gloss = 0.24;
  spallChipMat.fresnelModel = pc.FRESNEL_SCHLICK;
  spallChipMat.update();
  addUniqueMaterials(collected, [pomDecalMat, spallChipMat]);

  await onStep?.('Generating tempered glass pane & 256-tile marching fracture atlas...', 5, totalSteps);
  const glassPaneTex = createWindowGlassPaneTexture(device, 128);
  createMarchingGlassAtlasTexture(device, 256);
  addUniqueMaterials(collected, createGlassWarmupMaterials(glassPaneTex));

  await onStep?.('Generating vascular arterial & venous blood normal/meniscus maps...', 6, totalSteps);
  getOrCreateWetBloodMaps(device);
  const vascularMats = createVascularBloodMaterials(basePalette, device);
  addUniqueMaterials(collected, Object.values(vascularMats) as pc.Material[]);

  await onStep?.('Generating wet gore, muscle fiber & aerosol mist textures...', 7, totalSteps);
  const wetGoreSuite = createWetGoreMaterialSuite(device);
  addUniqueMaterials(collected, [
    wetGoreSuite.wetBloodDropMat,
    wetGoreSuite.wetBloodPoolMat,
    wetGoreSuite.wetBloodMistBaseMat,
    wetGoreSuite.wetFleshGibMat,
    wetGoreSuite.wetCorticalBoneMat,
    wetGoreSuite.wetMarrowCapMat,
    wetGoreSuite.incandescentSparkMat,
    wetGoreSuite.tracerTailMat,
  ]);

  await onStep?.('Generating multi-stage explosion plumes & shockwave ring textures...', 8, totalSteps);
  const explosionMats = createExplosionTemplateMaterials(device);
  addUniqueMaterials(collected, Object.values(explosionMats) as pc.Material[]);

  await onStep?.('Generating brass casings, 12ga hulls, hazard drums & tracer FX...', 9, totalSteps);
  const streakTex = createStreakGlowTexture(device);
  const tracerMat = new pc.StandardMaterial();
  tracerMat.name = 'mayhemTracerHotCoreMat';
  tracerMat.emissive = new pc.Color(1.0, 0.93, 0.72);
  tracerMat.emissiveMap = streakTex;
  tracerMat.opacityMap = streakTex;
  tracerMat.opacityMapChannel = 'a';
  tracerMat.blendType = pc.BLEND_ADDITIVEALPHA;
  tracerMat.depthWrite = false;
  tracerMat.cull = pc.CULLFACE_NONE;
  tracerMat.update();
  addUniqueMaterials(collected, [
    createGleamingBrassCasingMaterial(device),
    createShotgunHullMaterial(device),
    createScorchDecalMaterial(device),
    createBloodSplatterMaterial(device),
    createHazardBarrelMaterial(device),
    createCharredBarrelMaterial(),
    createBarrelFlameJetMaterial(),
    tracerMat,
  ]);

  await onStep?.('Generating viewmodel muzzle flash FX & archetype garment materials...', 10, totalSteps);
  const vmFx = getOrCreateViewmodelFxAssets(device);
  addUniqueMaterials(collected, [
    vmFx.starPetalMat,
    vmFx.coreSpearMat,
    vmFx.coronaHaloMat,
    vmFx.barrelSmokeTemplateMat,
  ]);
  for (const archetype of ARCHETYPES) {
    const retroSet = getArchetypeRetroMaterials(device, archetype);
    addUniqueMaterials(collected, Object.values(retroSet) as pc.Material[]);
  }

  const finalMaterials = Array.from(collected);
  prewarmedDeviceMaterials.set(device, finalMaterials);
  return finalMaterials;
}

export function collectSceneMaterials(root: pc.GraphNode | null | undefined): pc.Material[] {
  if (!root) return [];
  const materials = new Set<pc.Material>();
  const stack: pc.GraphNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;
    const entity = node as pc.Entity;
    const meshInstances = entity.render?.meshInstances;
    if (Array.isArray(meshInstances)) {
      for (let i = 0; i < meshInstances.length; i++) {
        const mat = meshInstances[i]?.material;
        if (mat) materials.add(mat);
      }
    }
    const children = node.children;
    if (Array.isArray(children)) {
      for (let i = children.length - 1; i >= 0; i--) {
        if (children[i]) stack.push(children[i]);
      }
    }
  }

  return Array.from(materials);
}
