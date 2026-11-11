import * as pc from 'playcanvas';
import type { WeaponSpec } from '../../contracts/ballistics.ts';
import type { GlbModelRegistry, WeaponGlbInstance } from '../assets/glbLoader.ts';
import { toWeaponAssetId, resolveGraphicsDeviceFromEntity } from './arsenalTypes.ts';
import { createMuzzleFlashStarEntity } from './muzzleFlashStar.ts';
import { upgradeViewmodelMaterials } from './viewmodelMaterials.ts';

export interface BuiltViewmodel {
  activeGlb: WeaponGlbInstance | null;
  flashEntity: pc.Entity;
  baseScale: number;
}

export function buildWeaponViewmodel(
  parentEntity: pc.Entity,
  cameraEntity: pc.Entity,
  weapon: WeaponSpec,
  glbRegistry: GlbModelRegistry | null,
  activeMaterials: pc.StandardMaterial[]
): BuiltViewmodel {
  while (parentEntity.children.length > 0) {
    parentEntity.children[0].destroy();
  }
  for (const m of activeMaterials) m.destroy();
  activeMaterials.length = 0;

  const device = resolveGraphicsDeviceFromEntity(cameraEntity);
  const assetId = toWeaponAssetId(weapon.id);

  if (assetId && glbRegistry?.isLoaded(assetId)) {
    try {
      const glbInst = glbRegistry.instantiateWeapon(assetId, {
        castShadows: false,
        receiveShadows: true,
      });
      parentEntity.addChild(glbInst.rootEntity);
      upgradeViewmodelMaterials(glbInst.rootEntity, weapon.id, device, activeMaterials);
      const { flashRoot, baseScale } = createMuzzleFlashStarEntity(device, weapon.role);
      glbInst.muzzleNode.addChild(flashRoot);
      return { activeGlb: glbInst, flashEntity: flashRoot, baseScale };
    } catch {
      // Fall through to fallback
    }
  }

  const fallbackNode = new pc.Entity(`vmFallback_${weapon.id}`);
  parentEntity.addChild(fallbackNode);
  const { flashRoot, baseScale } = createMuzzleFlashStarEntity(device, weapon.role);
  fallbackNode.addChild(flashRoot);
  return { activeGlb: null, flashEntity: flashRoot, baseScale };
}
