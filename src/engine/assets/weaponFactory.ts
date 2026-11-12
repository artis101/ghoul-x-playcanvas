import * as pc from 'playcanvas';
import { DEFAULT_MUZZLE_OFFSETS, type WeaponAssetId, type WeaponGlbInstance } from './glbTypes.ts';
import { collectBoneNodes, upgradeEntityHierarchyPbr } from './materialUpgrade.ts';

export function instantiateWeaponGlb(
  app: pc.AppBase,
  getContainer: (id: WeaponAssetId) => pc.ContainerResource | null,
  weaponId: WeaponAssetId | 'weapon_beretta_m9',
  options?: { castShadows?: boolean; receiveShadows?: boolean }
): WeaponGlbInstance {
  const isBerettaAlias = weaponId === 'weapon_beretta_m9';
  const resolvedWeaponId: WeaponAssetId = isBerettaAlias ? 'silver_talon_50ae' : weaponId;
  const container = getContainer(resolvedWeaponId);
  if (!container) {
    throw new Error(`${resolvedWeaponId}.glb is not loaded yet; await preloadAll() or loadContainer("${resolvedWeaponId}") first.`);
  }

  const rootEntity = container.instantiateRenderEntity({
    castShadows: options?.castShadows ?? false,
    receiveShadows: options?.receiveShadows ?? true,
  });
  upgradeEntityHierarchyPbr(rootEntity, app.graphicsDevice);
  rootEntity.name = `Weapon_${weaponId}`;

  const clonedSidearmMats: pc.StandardMaterial[] = [];
  if (isBerettaAlias) {
    rootEntity.setLocalScale(0.84, 0.84, 0.84);
    const renderComps = rootEntity.findComponents('render') as pc.RenderComponent[];
    for (const rc of renderComps) {
      for (const mi of rc.meshInstances) {
        if (mi.material instanceof pc.StandardMaterial) {
          const m9Mat = mi.material.clone();
          m9Mat.diffuse.set(0.24, 0.26, 0.29);
          m9Mat.update();
          mi.material = m9Mat;
          clonedSidearmMats.push(m9Mat);
        }
      }
    }
  }

  const boneNodes = new Map<string, pc.GraphNode>();
  collectBoneNodes(rootEntity, boneNodes);
  const rootBone = boneNodes.get('Bone_Root');
  const rootBoneRest = rootBone
    ? { position: rootBone.getLocalPosition().clone(), rotation: rootBone.getLocalRotation().clone() }
    : undefined;

  let muzzleNode = rootEntity.findByName('Bone_Muzzle') ?? rootEntity.findByName('MuzzleSocket');
  if (!muzzleNode) {
    const fallback = new pc.Entity('Bone_Muzzle');
    const offset = DEFAULT_MUZZLE_OFFSETS[resolvedWeaponId];
    fallback.setLocalPosition(offset.x, offset.y, offset.z);
    rootEntity.addChild(fallback);
    muzzleNode = fallback;
  }

  const availableClips = new Set<string>();
  const clipDurations = new Map<string, number>();
  let fireClipName: string | null = null;
  let reloadClipName: string | null = null;
  let animComponent: pc.AnimComponent | null = null;

  if (container.animations && container.animations.length > 0 && app.systems?.anim) {
    animComponent = rootEntity.addComponent('anim', { activate: true }) as pc.AnimComponent;
    for (const animAsset of container.animations) {
      const track = animAsset.resource;
      if (!track) continue;
      const clipName = track.name || animAsset.name;
      const isLooping = clipName === 'Idle';
      animComponent.assignAnimation(clipName, track, undefined, 1.0, isLooping);
      availableClips.add(clipName);
      clipDurations.set(clipName, track.duration);
      if (clipName.startsWith('Fire')) fireClipName = clipName;
      else if (clipName.startsWith('Reload')) reloadClipName = clipName;
    }
    if (availableClips.has('Idle') && animComponent.baseLayer) {
      animComponent.baseLayer.transition('Idle', 0);
    }
  }

  const playClip = (clipName: string, transitionSeconds = 0.04, speed = 1.0): boolean => {
    if (!animComponent || !animComponent.baseLayer || !availableClips.has(clipName)) return false;
    animComponent.speed = speed;
    animComponent.playing = true;
    if (animComponent.baseLayer.activeState === clipName) {
      animComponent.baseLayer.activeStateCurrentTime = 0;
    } else {
      animComponent.baseLayer.transition(clipName, transitionSeconds);
    }
    animComponent.baseLayer.playing = true;
    return true;
  };

  return {
    weaponId: resolvedWeaponId,
    rootEntity,
    animComponent,
    muzzleNode,
    boneNodes,
    rootBoneRest,
    availableClips,
    fireClipName,
    reloadClipName,
    getClipDuration(clipName): number { return clipName === null ? 0 : (clipDurations.get(clipName) ?? 0); },
    playClip,
    playIdle(transitionSeconds = 0.08): boolean { return playClip('Idle', transitionSeconds, 1.0); },
    playFire(speed = 1.0): boolean { return fireClipName ? playClip(fireClipName, 0.01, speed) : false; },
    playReload(speed = 1.0): boolean { return reloadClipName ? playClip(reloadClipName, 0.05, speed) : false; },
    destroy(): void {
      rootEntity.destroy();
      for (const m of clonedSidearmMats) m.destroy();
    },
  };
}
