import * as pc from 'playcanvas';
import { WEAPONS } from '../../core/ballistics/weapons.ts';
import type { GlbModelRegistry } from '../assets/glbModelRegistry.ts';
import { buildWeaponViewmodel } from '../player/viewmodelBuilder.ts';

/**
 * Builds every player weapon's first-person viewmodel in front of the warm-up camera.
 * A viewmodel is only assembled when its weapon is drawn, with its own tuned material clones,
 * hands and muzzle flash, so without this the first switch to each weapon compiles shaders.
 * Returns a cleanup to call once the staging scene has been rendered.
 */
export function stageViewmodelsForWarmup(
  stagingRoot: pc.Entity,
  warmupCamera: pc.Entity,
  glbRegistry: GlbModelRegistry
): () => void {
  const materials: pc.StandardMaterial[] = [];
  const holders: pc.Entity[] = [];

  for (let i = 0; i < WEAPONS.length; i++) {
    const holder = new pc.Entity(`WarmupViewmodel_${WEAPONS[i].id}`);
    stagingRoot.addChild(holder);
    holder.setPosition((i - 1.5) * 0.3, -250, -2.5);
    holders.push(holder);

    // The builder clears the list it is handed, so each weapon gets its own.
    const weaponMaterials: pc.StandardMaterial[] = [];
    buildWeaponViewmodel(holder, warmupCamera, WEAPONS[i], glbRegistry, weaponMaterials);
    materials.push(...weaponMaterials);

    for (const render of holder.findComponents('render') as pc.RenderComponent[]) {
      render.enabled = true;
      for (const mi of render.meshInstances) mi.cull = false;
    }
  }

  return () => {
    for (const holder of holders) holder.destroy();
    for (const material of materials) material.destroy();
  };
}
