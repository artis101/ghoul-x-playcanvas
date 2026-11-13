import * as pc from 'playcanvas';
import type { GhoulZoneId } from '../../contracts/ballistics.ts';
import { ALL_GHOUL_ZONES } from '../../core/ghoul/anatomy.ts';
import type { BoneBindPose, CombatantAnimationClipName, CombatantGlbInstance } from './glbTypes.ts';
import { findEntityByName, upgradeEntityHierarchyPbr } from './materialUpgrade.ts';
import { combatantTracks } from './combatantClipMirror.ts';
import { addUpperBodyLayer } from '../mannequin/combatantUpperBodyLayer.ts';

export { instantiateDetachedHeadgearProp } from './headgearFactory.ts';

const LOOPING_COMBATANT_CLIPS = new Set([
  'CombatReadyIdle', 'UnsuspectingIdle', 'Walk', 'Run', 'WalkBackward', 'StrafeLeft', 'StrafeRight', 'Crawl',
  // A one-legged body hops in place until it falls; the stump clutch holds a lost arm to the
  // chest for as long as the combatant has no gun.
  'OneLegHopRight', 'OneLegHopLeft', 'StumpClutchRight', 'StumpClutchLeft',
  // A seated last stand holds its pistol out, or rocks in pain, for as long as it stays down.
  'SeatedPistolAim', 'SeatedAgony',
  // Hurt and empty-handed bodies stand, walk and run in these for as long as they last.
  'HurtIdle', 'HurtWalk', 'UnarmedIdle', 'UnarmedWalk', 'UnarmedRun',
  // A crawler with a useless leg drags it for as long as it crawls.
  'CrawlDragLegRight', 'CrawlDragLegLeft',
  // A pistol carried in one hand, the other forearm tucked to the chest.
  'PistolOneHandHold',
]);

/** Skin page materials in the combatant GLB are named `Mat_Skin_<archetype id>`. */
export const SKIN_MATERIAL_PREFIX = 'Mat_Skin_';

/** True for clips that repeat. The rest play once and hold their last frame. */
export function isLoopingClip(name: string): boolean {
  return LOOPING_COMBATANT_CLIPS.has(name.replace(/_Southpaw$/, ''));
}

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
  const boonieHat = findEntityByName(rootEntity, 'Gear_BoonieHat');
  const punkMohawk = findEntityByName(rootEntity, 'Gear_PunkMohawk');
  const gasMask = findEntityByName(rootEntity, 'Gear_GasMask');
  const evisceratedGut = findEntityByName(rootEntity, 'Gear_EvisceratedGut');

  // Skin_Library is a hidden mesh whose only job is to carry one material per character skin.
  const skinMaterials = new Map<string, pc.Material>();
  const skinLibrary = findEntityByName(rootEntity, 'Skin_Library');
  if (skinLibrary) {
    for (const mi of skinLibrary.render?.meshInstances ?? []) {
      if (mi.material?.name.startsWith(SKIN_MATERIAL_PREFIX)) {
        skinMaterials.set(mi.material.name.slice(SKIN_MATERIAL_PREFIX.length), mi.material);
      }
    }
    skinLibrary.enabled = false;
  }

  if (tacticalVisor) tacticalVisor.enabled = false;
  if (boonieHat) boonieHat.enabled = false;
  if (punkMohawk) punkMohawk.enabled = false;
  // Only the masked archetype shows the respirator; combatantDismemberment turns it back on.
  if (gasMask) gasMask.enabled = false;
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
    boonieHat,
    punkMohawk,
    gasMask,
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
    // The GLB ships one side of each handed or sided clip; the mirrored ones are made at load.
    const tracks = combatantTracks(container);
    for (const [clipName, track] of tracks) {
      animComponent.assignAnimation(clipName, track, undefined, 1.0, isLoopingClip(clipName));
      availableClips.add(clipName);
    }
    const baseClip = options?.initialClip ?? 'CombatReadyIdle';
    const resolved = options?.southpaw && availableClips.has(`${baseClip}_Southpaw`) ? `${baseClip}_Southpaw` : baseClip;
    if (availableClips.has(resolved) && animComponent.baseLayer) animComponent.baseLayer.transition(resolved, 0);
    // The aim and carry clips also go on a second layer masked to the upper body, so a walking
    // body can hold its gun up (combatantUpperBodyLayer.ts).
    addUpperBodyLayer(animComponent, rootEntity, tracks, isLoopingClip);
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
    boonieHat,
    punkMohawk,
    gasMask,
    evisceratedGut,
    skinMaterials,
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
      } else if (!isLoopingClip(resolved)) {
        animComponent.baseLayer.activeStateCurrentTime = 0;
      }
      animComponent.baseLayer.playing = true;
      return true;
    },
    setInternalAnatomyVisible(visible: boolean): void {
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
