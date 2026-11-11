import * as pc from 'playcanvas';
import type { GhoulZoneId } from '../../contracts/ballistics.ts';
import { ALL_GHOUL_ZONES } from '../../core/ghoul/anatomy.ts';
import type { BoneBindPose, CombatantAnimationClipName, CombatantGlbInstance } from './glbTypes.ts';
import { findEntityByName, upgradeEntityHierarchyPbr } from './materialUpgrade.ts';

export { instantiateDetachedHeadgearProp } from './headgearFactory.ts';

export function instantiateCombatantGlb(
  app: pc.AppBase,
  container: pc.ContainerResource,
  options?: {
    castShadows?: boolean;
    receiveShadows?: boolean;
    initialClip?: CombatantAnimationClipName;
    southpaw?: boolean;
  }
): CombatantGlbInstance {
  const rootEntity = container.instantiateRenderEntity({
    castShadows: options?.castShadows ?? true,
    receiveShadows: options?.receiveShadows ?? true,
  });
  upgradeEntityHierarchyPbr(rootEntity, app.graphicsDevice);
  rootEntity.name = 'GhoulCombatantRoot';
  rootEntity.setPosition(0, 0, 0);
  rootEntity.setEulerAngles(0, 0, 0);
  rootEntity.syncHierarchy();

  const zoneEntities = new Map<GhoulZoneId, pc.Entity>();
  const boneNodes = new Map<GhoulZoneId, pc.GraphNode>();
  const boneBindPoses = new Map<GhoulZoneId, BoneBindPose>();

  for (const zone of ALL_GHOUL_ZONES) {
    const zoneEnt = findEntityByName(rootEntity, `Zone_${zone}`);
    if (zoneEnt) zoneEntities.set(zone, zoneEnt);
    const boneNode = rootEntity.findByName(`Bone_${zone}`);
    if (boneNode) {
      boneNodes.set(zone, boneNode);
      boneBindPoses.set(zone, {
        modelPos: boneNode.getPosition().clone(),
        modelRot: boneNode.getRotation().clone(),
      });
    }
  }

  const esapiPlateCarrier = findEntityByName(rootEntity, 'Gear_ESAPI_PlateCarrier');
  const pasgtHelmet = findEntityByName(rootEntity, 'Gear_PASGT_Helmet');
  const tacticalVisor = findEntityByName(rootEntity, 'Gear_TacticalVisor');
  const spetsnazBeret = findEntityByName(rootEntity, 'Gear_SpetsnazBeret');
  const punkMohawk = findEntityByName(rootEntity, 'Gear_PunkMohawk');
  const evisceratedGut = findEntityByName(rootEntity, 'Gear_EvisceratedGut');

  if (tacticalVisor) tacticalVisor.enabled = false;
  if (spetsnazBeret) spetsnazBeret.enabled = false;
  if (punkMohawk) punkMohawk.enabled = false;
  if (evisceratedGut) evisceratedGut.enabled = false;

  const internalAnatomyEntities = {
    organBrain: findEntityByName(rootEntity, 'Organ_Brain'),
    organHeart: findEntityByName(rootEntity, 'Organ_Heart'),
    organLungs: findEntityByName(rootEntity, 'Organ_Lungs'),
    organLiver: findEntityByName(rootEntity, 'Organ_Liver'),
    skeletSkull: findEntityByName(rootEntity, 'Skelet_Skull'),
    skeletRibcageSpine: findEntityByName(rootEntity, 'Skelet_RibcageSpine'),
    skeletPelvis: findEntityByName(rootEntity, 'Skelet_Pelvis'),
  };

  for (const ent of Object.values(internalAnatomyEntities)) {
    if (ent) {
      ent.enabled = false;
      if (ent.render) {
        ent.render.castShadows = false;
        ent.render.receiveShadows = false;
      }
    }
  }

  const allSkinned: Array<pc.Entity | null> = [
    ...zoneEntities.values(),
    esapiPlateCarrier,
    pasgtHelmet,
    tacticalVisor,
    spetsnazBeret,
    punkMohawk,
    evisceratedGut,
    ...Object.values(internalAnatomyEntities),
  ];
  for (const ent of allSkinned) {
    if (ent?.render) {
      for (const mi of ent.render.meshInstances) mi.cull = false;
    }
  }

  const availableClips = new Set<string>();
  let animComponent: pc.AnimComponent | null = null;

  if (container.animations && container.animations.length > 0 && app.systems?.anim) {
    animComponent = rootEntity.addComponent('anim', { activate: true }) as pc.AnimComponent;
    for (const animAsset of container.animations) {
      const track = animAsset.resource;
      if (!track) continue;
      const clipName = track.name || animAsset.name;
      const isLooping = clipName.startsWith('CombatReadyIdle') || clipName.startsWith('UnsuspectingIdle');
      animComponent.assignAnimation(clipName, track, undefined, 1.0, isLooping);
      availableClips.add(clipName);
    }
    const baseClip = options?.initialClip ?? 'CombatReadyIdle';
    const resolved = options?.southpaw && availableClips.has(`${baseClip}_Southpaw`) ? `${baseClip}_Southpaw` : baseClip;
    if (availableClips.has(resolved) && animComponent.baseLayer) animComponent.baseLayer.transition(resolved, 0);
  }

  return {
    rootEntity,
    animComponent,
    zoneEntities,
    boneNodes,
    boneBindPoses,
    esapiPlateCarrier,
    pasgtHelmet,
    tacticalVisor,
    spetsnazBeret,
    punkMohawk,
    evisceratedGut,
    internalAnatomyEntities,
    availableClips,
    playClip(clipName: CombatantAnimationClipName, transitionSeconds = 0.12, speed = 1.0, southpaw = false): boolean {
      if (!animComponent || !animComponent.baseLayer) return false;
      const resolved = southpaw && availableClips.has(`${clipName}_Southpaw`) ? `${clipName}_Southpaw` : clipName;
      if (!availableClips.has(resolved)) return false;
      animComponent.speed = speed;
      animComponent.playing = true;
      if (animComponent.baseLayer.activeState !== resolved) {
        animComponent.baseLayer.transition(resolved, transitionSeconds);
      } else if (!resolved.startsWith('CombatReadyIdle') && !resolved.startsWith('UnsuspectingIdle')) {
        animComponent.baseLayer.activeStateCurrentTime = 0;
      }
      animComponent.baseLayer.playing = true;
      return true;
    },
    setXRayVisible(visible: boolean): void {
      for (const ent of Object.values(internalAnatomyEntities)) if (ent) ent.enabled = visible;
    },
    setArmorVisible(chestPlateVisible: boolean, helmetVisible: boolean): void {
      if (esapiPlateCarrier) esapiPlateCarrier.enabled = chestPlateVisible;
      if (pasgtHelmet) pasgtHelmet.enabled = helmetVisible;
    },
    setZoneVisible(zone: GhoulZoneId, visible: boolean): void {
      const zEnt = zoneEntities.get(zone);
      if (zEnt) zEnt.enabled = visible;
    },
    destroy(): void { rootEntity.destroy(); },
  };
}
