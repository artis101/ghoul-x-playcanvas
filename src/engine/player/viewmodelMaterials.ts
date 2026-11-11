import * as pc from 'playcanvas';
import { getOrCreateViewmodelFxAssets } from './viewmodelFxAssets.ts';

function tuneTexture(tex: pc.Texture | null | undefined, maxAniso: number): void {
  if (!tex) return;
  tex.anisotropy = maxAniso;
  if (tex.mipmaps) {
    tex.minFilter = pc.FILTER_LINEAR_MIPMAP_LINEAR;
    tex.magFilter = pc.FILTER_LINEAR;
  }
}

function applyMinSmoothness(targetMat: pc.StandardMaterial, minSmoothness: number): void {
  if (targetMat.glossMap) return;
  if (targetMat.glossInvert) {
    targetMat.gloss = Math.min(targetMat.gloss ?? 1.0, 1.0 - minSmoothness);
  } else {
    targetMat.gloss = Math.max(targetMat.gloss || 0, minSmoothness);
  }
}

function applySmoothnessRange(
  targetMat: pc.StandardMaterial,
  minSmoothness: number,
  maxSmoothness: number,
  defaultSmoothness: number
): void {
  if (targetMat.glossMap) return;
  if (targetMat.glossInvert) {
    const curRoughness = targetMat.gloss ?? 1.0 - defaultSmoothness;
    targetMat.gloss = Math.max(1.0 - maxSmoothness, Math.min(curRoughness, 1.0 - minSmoothness));
  } else {
    targetMat.gloss = Math.max(
      minSmoothness,
      Math.min(targetMat.gloss || defaultSmoothness, maxSmoothness)
    );
  }
}

export function upgradeViewmodelMaterials(
  root: pc.Entity,
  weaponId: string,
  device: pc.GraphicsDevice | null,
  activeMaterials: pc.StandardMaterial[]
): void {
  const maxAniso = device ? Math.min(device.maxAnisotropy || 4, 4) : 1;
  const fxAssets = device ? getOrCreateViewmodelFxAssets(device) : null;
  const clonedBySource = new Map<pc.StandardMaterial, pc.StandardMaterial>();

  const renderComponents = root.findComponents('render') as pc.RenderComponent[];
  for (const rc of renderComponents) {
    for (const mi of renderComponents.length > 0 ? rc.meshInstances : []) {
      const srcMat = mi.material;
      if (!(srcMat instanceof pc.StandardMaterial)) continue;
      if (
        srcMat.blendType === pc.BLEND_ADDITIVE ||
        srcMat.blendType === pc.BLEND_ADDITIVEALPHA
      ) {
        continue;
      }

      let mat = clonedBySource.get(srcMat);
      if (!mat) {
        mat = srcMat.clone();
        const hint = `${srcMat.name || ''} ${mi.node?.name || ''} ${weaponId}`.toLowerCase();

        tuneTexture(mat.diffuseMap, maxAniso);
        tuneTexture(mat.normalMap, maxAniso);
        tuneTexture(mat.metalnessMap, maxAniso);
        tuneTexture(mat.glossMap, maxAniso);
        tuneTexture(mat.aoMap, maxAniso);
        tuneTexture(mat.emissiveMap, maxAniso);
        tuneTexture(mat.specularMap, maxAniso);

        mat.fresnelModel = pc.FRESNEL_SCHLICK;
        mat.useMetalness = true;
        mat.useSkybox = true;

        const isOpticLens =
          hint.includes('lens') ||
          hint.includes('glass') ||
          hint.includes('reflex') ||
          hint.includes('reticle');
        const isChromeOrSilver =
          hint.includes('silver') ||
          hint.includes('chrome') ||
          hint.includes('stainless') ||
          (weaponId === 'silver_talon_50ae' &&
            !hint.includes('grip') &&
            !hint.includes('polymer') &&
            !hint.includes('rubber'));
        const isBrass = hint.includes('brass') || hint.includes('cartridge');
        const isPolymerOrGrip =
          hint.includes('polymer') ||
          hint.includes('grip') ||
          hint.includes('stock') ||
          hint.includes('handguard') ||
          hint.includes('forend') ||
          hint.includes('rubber') ||
          hint.includes('pad');
        const isWood = hint.includes('wood') || hint.includes('walnut');

        if (isOpticLens) {
          if (!mat.metalnessMap) mat.metalness = Math.min(mat.metalness || 0.1, 0.15);
          if (mat.glossMap) mat.gloss = 1.0;
          else mat.gloss = mat.glossInvert ? 0.05 : 0.95;
        } else if (isChromeOrSilver) {
          if (!mat.metalnessMap) mat.metalness = Math.max(mat.metalness || 0, 0.92);
          applyMinSmoothness(mat, 0.84);
        } else if (isBrass) {
          if (!mat.metalnessMap) mat.metalness = Math.max(mat.metalness || 0, 0.9);
          applyMinSmoothness(mat, 0.85);
        } else if (isPolymerOrGrip) {
          if (!mat.metalnessMap) mat.metalness = Math.min(mat.metalness || 0.08, 0.12);
          applySmoothnessRange(mat, 0.38, 0.54, 0.46);
        } else if (isWood) {
          if (!mat.metalnessMap) mat.metalness = 0.04;
          applyMinSmoothness(mat, 0.62);
        } else {
          if (!mat.metalnessMap) mat.metalness = Math.max(mat.metalness || 0, 0.8);
          applyMinSmoothness(mat, 0.7);
        }

        if (!mat.emissiveMap && mat.emissive.r === 0 && mat.emissive.g === 0 && mat.emissive.b === 0) {
          mat.emissive.set(
            Math.max(0.032, mat.diffuse.r * 0.08),
            Math.max(0.034, mat.diffuse.g * 0.08),
            Math.max(0.038, mat.diffuse.b * 0.085)
          );
        }

        if (mat.normalMap) {
          mat.bumpiness = Math.max(mat.bumpiness || 1.0, 1.22);
        } else if (!isOpticLens && fxAssets) {
          mat.normalMap = fxAssets.machinedGrainNormalTex;
          mat.bumpiness = isPolymerOrGrip ? 0.32 : 0.2;
        }

        mat.update();
        clonedBySource.set(srcMat, mat);
        activeMaterials.push(mat);
      }

      mi.material = mat;
    }
  }
}
