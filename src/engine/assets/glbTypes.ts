import * as pc from 'playcanvas';
import type { EnemyArchetypeId, GhoulZoneId, Vec3Like } from '../../contracts/ballistics.ts';
import type { ChunkConnectivityGraphJson, ChunkConnectivityNode } from '../../contracts/destruction.ts';

export type WeaponAssetId =
  | 'm590_shotgun'
  | 'silver_talon_50ae'
  | 'msg90_sniper'
  | 'm4a1_carbine'
  | 'frag_grenade';

export type GlbAssetKey =
  | 'ghoul_combatant'
  | WeaponAssetId
  | 'concrete_wall_fractured'
  | 'debris_pack'
  | 'viewmodel_arms';

/** Clips baked with a `_Southpaw` twin: the same motion for a left-handed character. */
export type CombatantHandedClipName =
  | 'CombatReadyIdle'
  | 'UnsuspectingIdle'
  | 'LongGunAim'
  | 'PistolAim'
  | 'PistolAimOneHand'
  | 'KneelPistolAimOneHand'
  | 'Walk'
  | 'Run'
  | 'WalkBackward'
  | 'StrafeLeft'
  | 'StrafeRight'
  | 'HitStaggerChest'
  | 'HitFlinchHead'
  | 'HitFlinchGut'
  | 'HitFlinchThroat'
  | 'HitFlinchArmRight'
  | 'HitFlinchArmLeft'
  | 'HitFlinchLegRight'
  | 'HitFlinchLegLeft'
  | 'DiaphragmDropKneel'
  | 'LegCollapseCrawl'
  | 'Crawl';

/**
 * Wound clips named for the side of the body they hurt. The gun is dropped, so handedness does
 * not matter and there is no `_Southpaw` twin; the Left clip is the Right take mirrored.
 */
export type CombatantSidedClipName =
  | 'LegShotFallRight'
  | 'LegShotFallLeft'
  | 'LegLossRight'
  | 'LegLossLeft'
  | 'OneLegHopRight'
  | 'OneLegHopLeft'
  | 'LegLossFallRight'
  | 'LegLossFallLeft'
  | 'ArmLossRight'
  | 'ArmLossLeft'
  | 'StumpClutchRight'
  | 'StumpClutchLeft'
  | 'StumpKneelRight'
  | 'StumpKneelLeft'
  | 'DownedCollapse'
  | 'SitToCrawl';

export type CombatantAnimationClipName = CombatantHandedClipName | CombatantSidedClipName;

export const COMBATANT_ANIMATION_CLIPS: readonly CombatantHandedClipName[] = [
  'CombatReadyIdle',
  'UnsuspectingIdle',
  'LongGunAim',
  'PistolAim',
  'PistolAimOneHand',
  'KneelPistolAimOneHand',
  'Walk',
  'Run',
  'WalkBackward',
  'StrafeLeft',
  'StrafeRight',
  'HitStaggerChest',
  'HitFlinchHead',
  'HitFlinchGut',
  'HitFlinchThroat',
  'HitFlinchArmRight',
  'HitFlinchArmLeft',
  'HitFlinchLegRight',
  'HitFlinchLegLeft',
  'DiaphragmDropKneel',
  'LegCollapseCrawl',
  'Crawl',
] as const;

export const COMBATANT_SIDED_CLIPS: readonly CombatantSidedClipName[] = [
  'LegShotFallRight',
  'LegShotFallLeft',
  'LegLossRight',
  'LegLossLeft',
  'OneLegHopRight',
  'OneLegHopLeft',
  'LegLossFallRight',
  'LegLossFallLeft',
  'ArmLossRight',
  'ArmLossLeft',
  'StumpClutchRight',
  'StumpClutchLeft',
  'StumpKneelRight',
  'StumpKneelLeft',
  'DownedCollapse',
  'SitToCrawl',
] as const;

export const WEAPON_ASSET_IDS: readonly WeaponAssetId[] = [
  'm590_shotgun',
  'silver_talon_50ae',
  'msg90_sniper',
  'm4a1_carbine',
  'frag_grenade',
] as const;

export const ALL_GLB_ASSET_KEYS: readonly GlbAssetKey[] = [
  'ghoul_combatant',
  'm590_shotgun',
  'silver_talon_50ae',
  'msg90_sniper',
  'm4a1_carbine',
  'frag_grenade',
  'concrete_wall_fractured',
  'debris_pack',
  'viewmodel_arms',
] as const;

export interface NamedChunkConnectivityNode extends ChunkConnectivityNode {
  name: string;
  halfExtents: Vec3Like;
}

export interface ConcreteWallConnectivityGraphJson extends ChunkConnectivityGraphJson {
  nodes: NamedChunkConnectivityNode[];
}

export interface BoneBindPose {
  modelPos: pc.Vec3;
  modelRot: pc.Quat;
}

export function getArchetypeWeaponAssetId(archetype: EnemyArchetypeId): WeaponAssetId {
  switch (archetype) {
    case 'SKINHEAD_PUNK':
      return 'silver_talon_50ae';
    case 'HEAVY_ENFORCER':
    case 'MASKED_BRUISER':
      return 'm590_shotgun';
    case 'SNIPER_OPERATIVE':
      return 'msg90_sniper';
    case 'MILITIA_GUNNER':
    default:
      return 'm4a1_carbine';
  }
}

export interface CombatantGlbInstance {
  rootEntity: pc.Entity;
  animComponent: pc.AnimComponent | null;
  zoneEntities: Map<GhoulZoneId, pc.Entity>;
  boneNodes: Map<GhoulZoneId, pc.GraphNode>;
  boneBindPoses: ReadonlyMap<GhoulZoneId, BoneBindPose>;
  esapiPlateCarrier: pc.Entity | null;
  pasgtHelmet: pc.Entity | null;
  tacticalVisor: pc.Entity | null;
  boonieHat: pc.Entity | null;
  punkMohawk: pc.Entity | null;
  /** Bear's half-face respirator, skinned to the cranium. */
  gasMask: pc.Entity | null;
  evisceratedGut: pc.Entity | null;
  /** Painted skin page per archetype, keyed by archetype id (from the GLB's Skin_Library mesh). */
  skinMaterials: ReadonlyMap<string, pc.Material>;
  internalAnatomyEntities: {
    organBrain: pc.Entity | null;
    organHeart: pc.Entity | null;
    organLungs: pc.Entity | null;
    organLiver: pc.Entity | null;
    skeletSkull: pc.Entity | null;
    skeletRibcageSpine: pc.Entity | null;
    skeletPelvis: pc.Entity | null;
  };
  availableClips: ReadonlySet<string>;
  playClip(
    clipName: CombatantAnimationClipName,
    transitionSeconds?: number,
    speed?: number,
    southpaw?: boolean
  ): boolean;
  setInternalAnatomyVisible(visible: boolean): void;
  setArmorVisible(chestPlateVisible: boolean, helmetVisible: boolean): void;
  setZoneVisible(zone: GhoulZoneId, visible: boolean): void;
  destroy(): void;
}

export interface WeaponGlbInstance {
  weaponId: WeaponAssetId;
  rootEntity: pc.Entity;
  animComponent: pc.AnimComponent | null;
  muzzleNode: pc.GraphNode;
  boneNodes: Map<string, pc.GraphNode>;
  /** Root bone transform before any clip plays; lets the viewmodel cancel clip motion while aimed. */
  rootBoneRest?: { readonly position: pc.Vec3; readonly rotation: pc.Quat };
  availableClips: ReadonlySet<string>;
  fireClipName: string | null;
  reloadClipName: string | null;
  getClipDuration(clipName: string | null): number;
  playClip(clipName: string, transitionSeconds?: number, speed?: number): boolean;
  playIdle(transitionSeconds?: number): boolean;
  playFire(speed?: number): boolean;
  playReload(speed?: number): boolean;
  destroy(): void;
}

export interface FracturedConcreteWallBundle {
  intactWallMesh: pc.Mesh;
  intactWallMaterial: pc.Material | null;
  chunkMeshes: pc.Mesh[];
  chunkMaterial: pc.Material | null;
  chunkLocalVertices: Float32Array[];
  connectivity: ConcreteWallConnectivityGraphJson;
}

export interface DebrisPackBundle {
  brickMeshes: pc.Mesh[];
  brickMaterial: pc.Material | null;
  brickLocalVertices: Float32Array[];
  splinterMeshes: pc.Mesh[];
  splinterMaterial: pc.Material | null;
  splinterLocalVertices: Float32Array[];
}

export const DEFAULT_MUZZLE_OFFSETS: Record<WeaponAssetId, Vec3Like> = {
  m590_shotgun: { x: 0, y: 0.026, z: -0.645 },
  silver_talon_50ae: { x: 0, y: 0.032, z: -0.292 },
  msg90_sniper: { x: 0, y: 0.034, z: -0.84 },
  m4a1_carbine: { x: 0, y: 0.028, z: -0.565 },
  frag_grenade: { x: 0, y: 0.05, z: 0 },
};
