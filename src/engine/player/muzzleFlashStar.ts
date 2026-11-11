import * as pc from 'playcanvas';
import type { WeaponRole } from '../../contracts/ballistics.ts';
import { getOrCreateViewmodelFxAssets } from './viewmodelFxAssets.ts';

export function calculateMuzzleFlashBaseScale(role: WeaponRole): number {
  switch (role) {
    case 'SHOTGUN':
      return 1.32;
    case 'HEAVY_PISTOL':
      return 1.24;
    case 'SNIPER':
      return 1.18;
    default:
      return 1.0;
  }
}

export function createMuzzleFlashStarEntity(
  device: pc.GraphicsDevice | null,
  role: WeaponRole
): { flashRoot: pc.Entity; baseScale: number } {
  const flashRoot = new pc.Entity('MuzzleFlashStar');
  const fxAssets = device ? getOrCreateViewmodelFxAssets(device) : null;
  const baseScale = calculateMuzzleFlashBaseScale(role);

  if (fxAssets) {
    const rollAngles = [0, 45, 90, 135];
    for (let i = 0; i < rollAngles.length; i++) {
      const fin = new pc.Entity(`FlashStarPetal_${i}`);
      const mi = new pc.MeshInstance(fxAssets.quadMesh, fxAssets.starPetalMat);
      fin.addComponent('render', {
        meshInstances: [mi],
        castShadows: false,
        receiveShadows: false,
      });
      fin.setLocalPosition(0, 0, -0.085);
      fin.setLocalEulerAngles(0, 90, rollAngles[i]);
      const s = i % 2 === 0 ? 0.25 : 0.2;
      fin.setLocalScale(0.24, s, 1);
      flashRoot.addChild(fin);
    }

    const corona = new pc.Entity('FlashFrontCorona');
    const coronaMi = new pc.MeshInstance(fxAssets.quadMesh, fxAssets.coronaHaloMat);
    corona.addComponent('render', {
      meshInstances: [coronaMi],
      castShadows: false,
      receiveShadows: false,
    });
    corona.setLocalPosition(0, 0, -0.025);
    corona.setLocalScale(0.26, 0.26, 1);
    flashRoot.addChild(corona);

    const coreSpear = new pc.Entity('FlashPlasmaSpear');
    coreSpear.addComponent('render', {
      type: 'cone',
      material: fxAssets.coreSpearMat,
      castShadows: false,
    });
    coreSpear.setLocalPosition(0, 0, -0.11);
    coreSpear.setLocalEulerAngles(-90, 0, 0);
    coreSpear.setLocalScale(0.048, 0.22, 0.048);
    flashRoot.addChild(coreSpear);
  } else {
    const fallbackMat = new pc.StandardMaterial();
    fallbackMat.name = 'glbMuzzleFlashStarMat';
    fallbackMat.diffuse = new pc.Color(1.0, 0.82, 0.32);
    fallbackMat.emissive = new pc.Color(1.0, 0.76, 0.22);
    fallbackMat.blendType = pc.BLEND_ADDITIVEALPHA;
    fallbackMat.opacity = 0.92;
    fallbackMat.depthWrite = false;
    fallbackMat.cull = pc.CULLFACE_NONE;
    fallbackMat.update();

    const fin = new pc.Entity('FlashFin_Fallback');
    fin.addComponent('render', {
      type: 'box',
      material: fallbackMat,
      castShadows: false,
    });
    fin.setLocalScale(0.16, 0.16, 0.18);
    flashRoot.addChild(fin);
  }

  flashRoot.setLocalPosition(0, 0, -0.04);
  flashRoot.setLocalScale(0.00001, 0.00001, 0.00001);
  flashRoot.enabled = true;
  return { flashRoot, baseScale };
}
