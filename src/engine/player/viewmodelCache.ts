import * as pc from 'playcanvas';
import type { WeaponSpec } from '../../contracts/ballistics.ts';
import type { GlbModelRegistry, WeaponGlbInstance } from '../assets/glbLoader.ts';
import { buildWeaponViewmodel } from './viewmodelBuilder.ts';

export interface CachedViewmodel {
  readonly holder: pc.Entity;
  readonly glb: WeaponGlbInstance | null;
  readonly flashEntity: pc.Entity;
  readonly baseScale: number;
  readonly materials: pc.StandardMaterial[];
}

/** Puts a weapon GLB back in the state a fresh instance starts in: Idle clip at time 0, normal speed. */
export function resetWeaponGlbToIdle(glb: WeaponGlbInstance): void {
  const anim = glb.animComponent;
  const layer = anim?.baseLayer;
  if (!anim || !layer || !glb.availableClips.has('Idle')) return;
  anim.speed = 1;
  anim.playing = true;
  layer.transition('Idle', 0);
  layer.activeStateCurrentTime = 0;
  layer.playing = true;
}

/** Hides the flash and returns the GLB to its initial pose. The caller enables the holder first. */
export function resetViewmodelForDraw(vm: CachedViewmodel): void {
  vm.flashEntity.setLocalScale(0.00001, 0.00001, 0.00001);
  vm.flashEntity.setLocalEulerAngles(0, 0, 0);
  vm.flashEntity.enabled = false;
  if (vm.glb) {
    vm.glb.rootEntity.enabled = true;
    resetWeaponGlbToIdle(vm.glb);
  }
}

/** One viewmodel per weapon, built on first draw and kept parented and disabled while holstered. */
export class ViewmodelCache {
  private readonly byWeaponId = new Map<string, CachedViewmodel>();

  constructor(
    private readonly parent: pc.Entity,
    private readonly cameraEntity: pc.Entity,
    private readonly glbRegistry: GlbModelRegistry | null
  ) {}

  public get(weapon: WeaponSpec): CachedViewmodel {
    const cached = this.byWeaponId.get(weapon.id);
    if (cached) return cached;

    const holder = new pc.Entity(`Viewmodel_${weapon.id}`);
    this.parent.addChild(holder);
    const materials: pc.StandardMaterial[] = [];
    const built = buildWeaponViewmodel(holder, this.cameraEntity, weapon, this.glbRegistry, materials);
    built.flashEntity.enabled = false;
    holder.enabled = false;

    const entry: CachedViewmodel = {
      holder,
      glb: built.activeGlb,
      flashEntity: built.flashEntity,
      baseScale: built.baseScale,
      materials,
    };
    this.byWeaponId.set(weapon.id, entry);
    return entry;
  }

  public destroy(): void {
    for (const entry of this.byWeaponId.values()) {
      entry.holder.destroy();
      for (const material of entry.materials) material.destroy();
    }
    this.byWeaponId.clear();
  }
}
