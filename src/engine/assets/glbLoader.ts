import * as pc from 'playcanvas';
import type { EnemyArchetypeId, GhoulZoneId, Vec3Like } from '../../contracts/ballistics.ts';
import type {
  ChunkConnectivityEdge,
  ChunkConnectivityGraphJson,
  ChunkConnectivityNode,
} from '../../contracts/destruction.ts';
import { ALL_GHOUL_ZONES } from '../../core/ghoul/anatomy.ts';

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
  | 'debris_pack';

export type CombatantAnimationClipName =
  | 'CombatReadyIdle'
  | 'UnsuspectingIdle'
  | 'HitStaggerChest'
  | 'DiaphragmDropKneel'
  | 'LegCollapseCrawl';

export const COMBATANT_ANIMATION_CLIPS: readonly CombatantAnimationClipName[] = [
  'CombatReadyIdle',
  'UnsuspectingIdle',
  'HitStaggerChest',
  'DiaphragmDropKneel',
  'LegCollapseCrawl',
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
  spetsnazBeret: pc.Entity | null;
  punkMohawk: pc.Entity | null;
  evisceratedGut: pc.Entity | null;
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
  setXRayVisible(visible: boolean): void;
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
  availableClips: ReadonlySet<string>;
  fireClipName: string | null;
  reloadClipName: string | null;
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

const DEFAULT_MUZZLE_OFFSETS: Record<WeaponAssetId, Vec3Like> = {
  m590_shotgun: { x: 0, y: 0.026, z: -0.645 },
  silver_talon_50ae: { x: 0, y: 0.032, z: -0.292 },
  msg90_sniper: { x: 0, y: 0.012, z: -0.82 },
  m4a1_carbine: { x: 0, y: 0.016, z: -0.61 },
  frag_grenade: { x: 0, y: 0.04, z: 0.0 },
};

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null;
}

function parseVec3Like(raw: unknown, label: string): Vec3Like {
  if (!isRecord(raw)) {
    throw new Error(`Invalid Vec3Like at ${label}`);
  }
  const x = Number(raw.x);
  const y = Number(raw.y);
  const z = Number(raw.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    throw new Error(`Non-finite Vec3Like coordinates at ${label}`);
  }
  return { x, y, z };
}

/**
 * Validates raw parsed JSON against `ConcreteWallConnectivityGraphJson` (`version: 1`).
 */
export function parseConnectivityGraphJson(raw: unknown): ConcreteWallConnectivityGraphJson {
  if (!isRecord(raw)) {
    throw new Error('Connectivity graph JSON root must be an object');
  }
  if (raw.version !== 1) {
    throw new Error(`Unsupported connectivity graph version: ${String(raw.version)}`);
  }
  if (typeof raw.wallId !== 'string' || raw.wallId.length === 0) {
    throw new Error('Connectivity graph wallId must be a non-empty string');
  }
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    throw new Error('Connectivity graph nodes must be a non-empty array');
  }

  const nodes: NamedChunkConnectivityNode[] = raw.nodes.map((item: unknown, idx: number) => {
    if (!isRecord(item)) {
      throw new Error(`Node at index ${idx} is not an object`);
    }
    const index = Number(item.index);
    if (!Number.isInteger(index) || index !== idx) {
      throw new Error(`Node index mismatch at ${idx}: got ${String(item.index)}`);
    }
    const name = typeof item.name === 'string' && item.name.length > 0
      ? item.name
      : `Chunk_${String(index).padStart(2, '0')}`;
    const isAnchored = Boolean(item.isAnchored);
    const localCenter = parseVec3Like(item.localCenter, `nodes[${idx}].localCenter`);
    const halfExtents = item.halfExtents !== undefined
      ? parseVec3Like(item.halfExtents, `nodes[${idx}].halfExtents`)
      : { x: 0.25, y: 0.2, z: 0.14 };
    const massKg = Number(item.massKg);
    if (!Number.isFinite(massKg) || massKg <= 0) {
      throw new Error(`Invalid massKg at nodes[${idx}]`);
    }
    if (!Array.isArray(item.edges)) {
      throw new Error(`Missing edges array at nodes[${idx}]`);
    }

    const edges: ChunkConnectivityEdge[] = item.edges.map((edgeRaw: unknown, eIdx: number) => {
      if (!isRecord(edgeRaw)) {
        throw new Error(`Invalid edge at nodes[${idx}].edges[${eIdx}]`);
      }
      const neighborIndex = Number(edgeRaw.neighborIndex);
      const breakThresholdJ = Number(edgeRaw.breakThresholdJ);
      if (!Number.isInteger(neighborIndex) || neighborIndex < 0) {
        throw new Error(`Invalid neighborIndex at nodes[${idx}].edges[${eIdx}]`);
      }
      if (!Number.isFinite(breakThresholdJ) || breakThresholdJ <= 0) {
        throw new Error(`Invalid breakThresholdJ at nodes[${idx}].edges[${eIdx}]`);
      }
      return {
        neighborIndex,
        breakThresholdJ,
        severed: Boolean(edgeRaw.severed),
      };
    });

    const nodeOut: NamedChunkConnectivityNode = {
      index,
      name,
      isAnchored,
      localCenter,
      halfExtents,
      massKg,
      edges,
    };
    if (typeof item.meshVariant === 'number' && Number.isInteger(item.meshVariant)) {
      nodeOut.meshVariant = item.meshVariant;
    }
    return nodeOut;
  });

  return {
    version: 1,
    wallId: raw.wallId,
    nodes,
  };
}

/**
 * Streams and validates `concrete_wall_connectivity.json` over HTTP/Vite dev/prod asset serving.
 */
export async function loadConnectivityGraphJson(
  url = '/models/concrete_wall_connectivity.json'
): Promise<ConcreteWallConnectivityGraphJson> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch connectivity graph (${response.status}) from ${url}`);
  }
  const raw: unknown = await response.json();
  return parseConnectivityGraphJson(raw);
}

/**
 * Extracts tightly packed local `Float32Array` `[x0, y0, z0, x1, y1, z1, ...]` positions from a `pc.Mesh`
 * for Rapier3D `ColliderDesc.convexHull(localVertices)`.
 */
export function extractMeshLocalVertices(mesh: pc.Mesh): Float32Array {
  const positions: number[] = [];
  mesh.getPositions(positions);
  return new Float32Array(positions);
}

function findEntityByName(root: pc.Entity, name: string): pc.Entity | null {
  const node = root.findByName(name);
  return node instanceof pc.Entity ? node : null;
}

function collectBoneNodes(root: pc.GraphNode, out: Map<string, pc.GraphNode>): void {
  if (root.name.startsWith('Bone_')) {
    out.set(root.name, root);
  }
  for (const child of root.children) {
    collectBoneNodes(child, out);
  }
}

const upgradedGlbMaterials = new WeakSet<pc.StandardMaterial>();
const upgradedGlbTextures = new WeakSet<pc.Texture>();

function upgradeGlbTexture(tex: pc.Texture | null | undefined, maxAniso: number): void {
  if (!tex || upgradedGlbTextures.has(tex)) return;
  upgradedGlbTextures.add(tex);
  tex.anisotropy = maxAniso;
  if (tex.mipmaps) {
    tex.minFilter = pc.FILTER_LINEAR_MIPMAP_LINEAR;
    tex.magFilter = pc.FILTER_LINEAR;
  }
}

function upgradeGlbStandardMaterial(mat: pc.Material | null | undefined, device: pc.GraphicsDevice): void {
  if (!(mat instanceof pc.StandardMaterial) || upgradedGlbMaterials.has(mat)) return;
  upgradedGlbMaterials.add(mat);

  const maxAniso =
    device instanceof pc.NullGraphicsDevice
      ? 1
      : Math.max(1, Math.min(4, device.maxAnisotropy || 1));

  upgradeGlbTexture(mat.diffuseMap, maxAniso);
  upgradeGlbTexture(mat.normalMap, maxAniso);
  upgradeGlbTexture(mat.glossMap, maxAniso);
  upgradeGlbTexture(mat.metalnessMap, maxAniso);
  upgradeGlbTexture(mat.aoMap, maxAniso);
  upgradeGlbTexture(mat.emissiveMap, maxAniso);
  upgradeGlbTexture(mat.specularMap, maxAniso);

  mat.fresnelModel = pc.FRESNEL_SCHLICK;
  mat.useSkybox = true;
  if (mat.aoMap) {
    mat.occludeSpecular = pc.SPECOCC_GLOSSDEPENDENT;
  }
  if (mat.normalMap) {
    mat.bumpiness = Math.max(mat.bumpiness || 1.0, 1.22);
  }
  mat.update();
}

function upgradeContainerPbrQuality(container: pc.ContainerResource, device: pc.GraphicsDevice): void {
  const maxAniso =
    device instanceof pc.NullGraphicsDevice
      ? 1
      : Math.max(1, Math.min(4, device.maxAnisotropy || 1));

  if (Array.isArray(container.textures)) {
    for (const texAsset of container.textures) {
      if (texAsset?.resource instanceof pc.Texture) {
        upgradeGlbTexture(texAsset.resource, maxAniso);
      }
    }
  }
  if (Array.isArray(container.materials)) {
    for (const matAsset of container.materials) {
      if (matAsset?.resource instanceof pc.StandardMaterial) {
        upgradeGlbStandardMaterial(matAsset.resource, device);
      }
    }
  }
}

function upgradeEntityHierarchyPbr(root: pc.Entity, device: pc.GraphicsDevice): void {
  const renderComps = root.findComponents('render') as pc.RenderComponent[];
  for (const rc of renderComps) {
    for (const mi of rc.meshInstances) {
      upgradeGlbStandardMaterial(mi.material, device);
    }
  }
}

/**
 * PlayCanvas 2.4 GLB Container Asset Registry & Factory.
 *
 * Coordinate Conventions:
 * - `ghoul_combatant.glb`: +Y Up, +Z Character Forward, grounded at y = 0.00m, crown at y = 1.80m.
 * - Weapon viewmodels (`m590_shotgun.glb`, `silver_talon_50ae.glb`, `msg90_sniper.glb`, `m4a1_carbine.glb`):
 *   +X Right, +Y Top Rail, -Z Barrel Forward (matches PlayCanvas `cameraEntity` forward axis `-Z`).
 * - `concrete_wall_fractured.glb`: `IntactConcreteWall` + 36 Voronoi `Chunk_00..Chunk_35` meshes with
 *   local vertices centered around `(0, 0, 0)` and node translations at `node.localCenter`.
 * - `debris_pack.glb`: `Brick_0..2` and `Splinter_0..2` single-primitive instancing meshes centered at `(0, 0, 0)`.
 */
export class GlbModelRegistry {
  public readonly app: pc.AppBase;
  public readonly baseUrl: string;

  private readonly containerAssets = new Map<GlbAssetKey, pc.Asset>();
  private readonly loadingPromises = new Map<GlbAssetKey, Promise<pc.ContainerResource>>();
  private readonly detachedHeadgearCache = new Map<
    string,
    Array<{ mesh: pc.Mesh; material: pc.Material | null }>
  >();
  private connectivityGraph: ConcreteWallConnectivityGraphJson | null = null;
  private connectivityPromise: Promise<ConcreteWallConnectivityGraphJson> | null = null;

  public constructor(app: pc.AppBase, baseUrl = '/models') {
    this.app = app;
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  }

  public getAssetUrl(key: GlbAssetKey): string {
    return `${this.baseUrl}/${key}.glb`;
  }

  public getConnectivityUrl(): string {
    return `${this.baseUrl}/concrete_wall_connectivity.json`;
  }

  public isLoaded(key: GlbAssetKey | 'weapon_beretta_m9'): boolean {
    const resolvedKey: GlbAssetKey = key === 'weapon_beretta_m9' ? 'silver_talon_50ae' : key;
    const asset = this.containerAssets.get(resolvedKey);
    return Boolean(asset && asset.resource);
  }

  public getContainer(key: GlbAssetKey | 'weapon_beretta_m9'): pc.ContainerResource | null {
    const resolvedKey: GlbAssetKey = key === 'weapon_beretta_m9' ? 'silver_talon_50ae' : key;
    const asset = this.containerAssets.get(resolvedKey);
    if (!asset || !asset.resource) {
      return null;
    }
    return asset.resource as pc.ContainerResource;
  }

  /**
   * Registers an already-parsed `pc.ContainerResource` under `key` (for synchronous preload / headless tests).
   */
  public registerContainerResource(key: GlbAssetKey, container: pc.ContainerResource): void {
    upgradeContainerPbrQuality(container, this.app.graphicsDevice);
    const asset = new pc.Asset(`glb_${key}`, 'container');
    asset.resource = container;
    this.containerAssets.set(key, asset);
  }

  /**
   * Loads a single `.glb` container via `pc.Asset(..., 'container', { url })` + `app.assets.load(asset)`.
   */
  public loadContainer(key: GlbAssetKey): Promise<pc.ContainerResource> {
    const existing = this.getContainer(key);
    if (existing) {
      return Promise.resolve(existing);
    }

    const inFlight = this.loadingPromises.get(key);
    if (inFlight) {
      return inFlight;
    }

    const url = this.getAssetUrl(key);
    const asset = new pc.Asset(`glb_${key}`, 'container', { url });
    this.containerAssets.set(key, asset);

    const promise = new Promise<pc.ContainerResource>((resolve, reject) => {
      const onLoad = (loadedAsset: pc.Asset): void => {
        asset.off('error', onError);
        this.loadingPromises.delete(key);
        const resource = loadedAsset.resource as pc.ContainerResource | null;
        if (!resource) {
          reject(new Error(`Container resource missing after loading ${url}`));
          return;
        }
        upgradeContainerPbrQuality(resource, this.app.graphicsDevice);
        resolve(resource);
      };

      const onError = (err: string): void => {
        asset.off('load', onLoad);
        this.loadingPromises.delete(key);
        reject(new Error(`Failed to load GLB container ${url}: ${err}`));
      };

      asset.once('load', onLoad);
      asset.once('error', onError);
      this.app.assets.add(asset);
      this.app.assets.load(asset);
    });

    this.loadingPromises.set(key, promise);
    return promise;
  }

  public loadConcreteConnectivity(): Promise<ConcreteWallConnectivityGraphJson> {
    if (this.connectivityGraph) {
      return Promise.resolve(this.connectivityGraph);
    }
    if (!this.connectivityPromise) {
      this.connectivityPromise = loadConnectivityGraphJson(this.getConnectivityUrl()).then((graph) => {
        this.connectivityGraph = graph;
        return graph;
      });
    }
    return this.connectivityPromise;
  }

  /**
   * Preloads all 8 `.glb` containers and `concrete_wall_connectivity.json` concurrently.
   */
  public async preloadAll(): Promise<void> {
    await Promise.all([
      ...ALL_GLB_ASSET_KEYS.map((key) => this.loadContainer(key)),
      this.loadConcreteConnectivity(),
    ]);
  }

  /**
   * Instantiates a rigged, skinned, and animated 22-zone GHOUL tactical combatant hierarchy.
   */
  public instantiateCombatant(options?: {
    castShadows?: boolean;
    receiveShadows?: boolean;
    initialClip?: CombatantAnimationClipName;
    southpaw?: boolean;
  }): CombatantGlbInstance {
    const container = this.getContainer('ghoul_combatant');
    if (!container) {
      throw new Error('ghoul_combatant.glb is not loaded yet; await preloadAll() or loadContainer("ghoul_combatant") first.');
    }

    const rootEntity = container.instantiateRenderEntity({
      castShadows: options?.castShadows ?? true,
      receiveShadows: options?.receiveShadows ?? true,
    });
    upgradeEntityHierarchyPbr(rootEntity, this.app.graphicsDevice);
    rootEntity.name = 'GhoulCombatantRoot';
    rootEntity.setPosition(0, 0, 0);
    rootEntity.setEulerAngles(0, 0, 0);
    rootEntity.syncHierarchy();

    const zoneEntities = new Map<GhoulZoneId, pc.Entity>();
    const boneNodes = new Map<GhoulZoneId, pc.GraphNode>();
    const boneBindPoses = new Map<GhoulZoneId, BoneBindPose>();

    for (const zone of ALL_GHOUL_ZONES) {
      const zoneEnt = findEntityByName(rootEntity, `Zone_${zone}`);
      if (zoneEnt) {
        zoneEntities.set(zone, zoneEnt);
      }
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

    // Optional archetype headgear & gore cavity start hidden until configured by GhoulMannequinEntity
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

    // Hide internal X-Ray organs & skeleton until X-Ray inspector is toggled on
    for (const ent of Object.values(internalAnatomyEntities)) {
      if (ent) {
        ent.enabled = false;
        if (ent.render) {
          ent.render.castShadows = false;
          ent.render.receiveShadows = false;
        }
      }
    }

    // Disable bind-pose frustum culling on all skinned submeshes so ragdolled corpses
    // and flying dismembered limbs never clip out when bones move away from origin!
    const allSkinnedEntities: Array<pc.Entity | null> = [
      ...zoneEntities.values(),
      esapiPlateCarrier,
      pasgtHelmet,
      tacticalVisor,
      spetsnazBeret,
      punkMohawk,
      evisceratedGut,
      ...Object.values(internalAnatomyEntities),
    ];
    for (const ent of allSkinnedEntities) {
      if (ent?.render) {
        for (const mi of ent.render.meshInstances) {
          mi.cull = false;
        }
      }
    }

    const availableClips = new Set<string>();
    let animComponent: pc.AnimComponent | null = null;

    if (container.animations && container.animations.length > 0 && this.app.systems?.anim) {
      animComponent = rootEntity.addComponent('anim', {
        activate: true,
      }) as pc.AnimComponent;

      for (const animAsset of container.animations) {
        const track = animAsset.resource;
        if (!track) continue;
        const clipName = track.name || animAsset.name;
        const isLooping =
          clipName.startsWith('CombatReadyIdle') || clipName.startsWith('UnsuspectingIdle');
        animComponent.assignAnimation(clipName, track, undefined, 1.0, isLooping);
        availableClips.add(clipName);
      }

      const baseClip = options?.initialClip ?? 'CombatReadyIdle';
      const resolvedInitial =
        options?.southpaw && availableClips.has(`${baseClip}_Southpaw`)
          ? `${baseClip}_Southpaw`
          : baseClip;
      if (availableClips.has(resolvedInitial) && animComponent.baseLayer) {
        animComponent.baseLayer.transition(resolvedInitial, 0);
      }
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
      playClip(
        clipName: CombatantAnimationClipName,
        transitionSeconds = 0.12,
        speed = 1.0,
        southpaw = false
      ): boolean {
        if (!animComponent || !animComponent.baseLayer) {
          return false;
        }
        const resolved =
          southpaw && availableClips.has(`${clipName}_Southpaw`)
            ? `${clipName}_Southpaw`
            : clipName;
        if (!availableClips.has(resolved)) {
          return false;
        }
        animComponent.speed = speed;
        animComponent.playing = true;
        if (animComponent.baseLayer.activeState !== resolved) {
          animComponent.baseLayer.transition(resolved, transitionSeconds);
        } else if (
          !resolved.startsWith('CombatReadyIdle') &&
          !resolved.startsWith('UnsuspectingIdle')
        ) {
          animComponent.baseLayer.activeStateCurrentTime = 0;
        }
        animComponent.baseLayer.playing = true;
        return true;
      },
      setXRayVisible(visible: boolean): void {
        for (const ent of Object.values(internalAnatomyEntities)) {
          if (ent) {
            ent.enabled = visible;
          }
        }
      },
      setArmorVisible(chestPlateVisible: boolean, helmetVisible: boolean): void {
        if (esapiPlateCarrier) esapiPlateCarrier.enabled = chestPlateVisible;
        if (pasgtHelmet) pasgtHelmet.enabled = helmetVisible;
      },
      setZoneVisible(zone: GhoulZoneId, visible: boolean): void {
        const zEnt = zoneEntities.get(zone);
        if (zEnt) zEnt.enabled = visible;
      },
      destroy(): void {
        rootEntity.destroy();
      },
    };
  }

  /**
   * Instantiates an unskinned standalone physics prop from the sculpted Blender headgear
   * (`Gear_PASGT_Helmet`, `Gear_SpetsnazBeret`, `Gear_TacticalVisor`) centered around `(0,0,0)`
   * so shot-off helmets, berets, and shades fly through the air using the new Blender models!
   */
  public instantiateDetachedHeadgearProp(archetype: EnemyArchetypeId): pc.Entity | null {
    const container = this.getContainer('ghoul_combatant');
    if (!container) return null;

    const gearNames: string[] =
      archetype === 'HEAVY_ENFORCER'
        ? ['Gear_PASGT_Helmet', 'Gear_TacticalVisor']
        : archetype === 'MILITIA_GUNNER'
          ? ['Gear_PASGT_Helmet']
          : archetype === 'SNIPER_OPERATIVE'
            ? ['Gear_SpetsnazBeret']
            : ['Gear_TacticalVisor'];

    const cacheKey = gearNames.join('+');
    let primitives = this.detachedHeadgearCache.get(cacheKey);

    if (!primitives) {
      const tempRoot = container.instantiateRenderEntity();
      try {
        const extracted: Array<{
          positions: number[];
          normals: number[];
          uvs: number[];
          indices: number[];
          material: pc.Material | null;
        }> = [];

        let sumX = 0;
        let sumY = 0;
        let sumZ = 0;
        let vertTotal = 0;

        for (const gName of gearNames) {
          const ent = findEntityByName(tempRoot, gName);
          if (!ent?.render) continue;
          for (const mi of ent.render.meshInstances) {
            const srcMesh = mi.mesh;
            if (!srcMesh) continue;
            const positions: number[] = [];
            const normals: number[] = [];
            const uvs: number[] = [];
            const indices: number[] = [];
            srcMesh.getPositions(positions);
            srcMesh.getNormals(normals);
            srcMesh.getUvs(0, uvs);
            srcMesh.getIndices(indices);
            if (positions.length === 0) continue;

            for (let i = 0; i < positions.length; i += 3) {
              sumX += positions[i];
              sumY += positions[i + 1];
              sumZ += positions[i + 2];
              vertTotal++;
            }
            extracted.push({
              positions,
              normals,
              uvs,
              indices,
              material: mi.material ?? null,
            });
          }
        }

        if (vertTotal === 0) return null;
        const cx = sumX / vertTotal;
        const cy = sumY / vertTotal;
        const cz = sumZ / vertTotal;

        primitives = extracted.map((item) => {
          const centered = new Array<number>(item.positions.length);
          for (let i = 0; i < item.positions.length; i += 3) {
            centered[i] = item.positions[i] - cx;
            centered[i + 1] = item.positions[i + 1] - cy;
            centered[i + 2] = item.positions[i + 2] - cz;
          }
          const mesh = new pc.Mesh(this.app.graphicsDevice);
          mesh.setPositions(centered);
          if (item.normals.length === centered.length) {
            mesh.setNormals(item.normals);
          }
          if (item.uvs.length === (centered.length / 3) * 2) {
            mesh.setUvs(0, item.uvs);
          }
          if (item.indices.length > 0) {
            mesh.setIndices(item.indices);
          }
          mesh.update();
          mesh.incRefCount();
          return { mesh, material: item.material };
        });

        this.detachedHeadgearCache.set(cacheKey, primitives);
      } finally {
        tempRoot.destroy();
      }
    }

    const propRoot = new pc.Entity(`DetachedHeadgear_${archetype}`);
    const meshInstances = primitives.map((p) => {
      const mat = p.material ?? new pc.StandardMaterial();
      upgradeGlbStandardMaterial(mat, this.app.graphicsDevice);
      return new pc.MeshInstance(p.mesh, mat);
    });
    propRoot.addComponent('render', {
      meshInstances,
      castShadows: true,
      receiveShadows: true,
    });
    return propRoot;
  }

  /**
   * Instantiates an animated 3D weapon viewmodel or world prop (`m590_shotgun`, `silver_talon_50ae`,
   * `msg90_sniper`, `m4a1_carbine`, or `frag_grenade`, plus compact `weapon_beretta_m9` sidearm alias).
   */
  public instantiateWeapon(
    weaponId: WeaponAssetId | 'weapon_beretta_m9',
    options?: { castShadows?: boolean; receiveShadows?: boolean }
  ): WeaponGlbInstance {
    const isBerettaAlias = weaponId === 'weapon_beretta_m9';
    const resolvedWeaponId: WeaponAssetId = isBerettaAlias ? 'silver_talon_50ae' : weaponId;
    const container = this.getContainer(resolvedWeaponId);
    if (!container) {
      throw new Error(`${resolvedWeaponId}.glb is not loaded yet; await preloadAll() or loadContainer("${resolvedWeaponId}") first.`);
    }

    const rootEntity = container.instantiateRenderEntity({
      castShadows: options?.castShadows ?? false,
      receiveShadows: options?.receiveShadows ?? true,
    });
    upgradeEntityHierarchyPbr(rootEntity, this.app.graphicsDevice);
    rootEntity.name = `Weapon_${weaponId}`;

    const clonedSidearmMats: pc.StandardMaterial[] = [];
    if (isBerettaAlias) {
      // Compact dark-parkerized 9mm service sidearm profile derived from pistol container
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

    let muzzleNode = rootEntity.findByName('Bone_Muzzle') ?? rootEntity.findByName('MuzzleSocket');
    if (!muzzleNode) {
      const fallback = new pc.Entity('Bone_Muzzle');
      const offset = DEFAULT_MUZZLE_OFFSETS[resolvedWeaponId];
      fallback.setLocalPosition(offset.x, offset.y, offset.z);
      rootEntity.addChild(fallback);
      muzzleNode = fallback;
    }

    const availableClips = new Set<string>();
    let fireClipName: string | null = null;
    let reloadClipName: string | null = null;
    let animComponent: pc.AnimComponent | null = null;

    if (container.animations && container.animations.length > 0 && this.app.systems?.anim) {
      animComponent = rootEntity.addComponent('anim', {
        activate: true,
      }) as pc.AnimComponent;

      for (const animAsset of container.animations) {
        const track = animAsset.resource;
        if (!track) continue;
        const clipName = track.name || animAsset.name;
        const isLooping = clipName === 'Idle';
        animComponent.assignAnimation(clipName, track, undefined, 1.0, isLooping);
        availableClips.add(clipName);

        if (clipName.startsWith('Fire')) {
          fireClipName = clipName;
        } else if (clipName.startsWith('Reload')) {
          reloadClipName = clipName;
        }
      }

      if (availableClips.has('Idle') && animComponent.baseLayer) {
        animComponent.baseLayer.transition('Idle', 0);
      }
    }

    const playClip = (clipName: string, transitionSeconds = 0.04, speed = 1.0): boolean => {
      if (!animComponent || !animComponent.baseLayer || !availableClips.has(clipName)) {
        return false;
      }
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
      availableClips,
      fireClipName,
      reloadClipName,
      playClip,
      playIdle(transitionSeconds = 0.08): boolean {
        return playClip('Idle', transitionSeconds, 1.0);
      },
      playFire(speed = 1.0): boolean {
        if (!fireClipName) return false;
        return playClip(fireClipName, 0.01, speed);
      },
      playReload(speed = 1.0): boolean {
        if (!reloadClipName) return false;
        return playClip(reloadClipName, 0.05, speed);
      },
      destroy(): void {
        rootEntity.destroy();
        for (const m of clonedSidearmMats) {
          m.destroy();
        }
      },
    };
  }

  /**
   * Extracts `IntactConcreteWall`, ordered `Chunk_00..Chunk_NN` `pc.Mesh` instances, local convex-hull
   * `Float32Array` vertex buffers, and the `ConcreteWallConnectivityGraphJson` adjacency graph.
   */
  public getFracturedConcreteWallBundle(): FracturedConcreteWallBundle {
    const container = this.getContainer('concrete_wall_fractured');
    if (!container) {
      throw new Error('concrete_wall_fractured.glb is not loaded yet.');
    }
    if (!this.connectivityGraph) {
      throw new Error('concrete_wall_connectivity.json is not loaded yet.');
    }

    const tempRoot = container.instantiateRenderEntity();
    upgradeEntityHierarchyPbr(tempRoot, this.app.graphicsDevice);
    try {
      const intactEnt = findEntityByName(tempRoot, 'IntactConcreteWall');
      const intactMi = intactEnt?.render?.meshInstances?.[0];
      if (!intactMi || !intactMi.mesh) {
        throw new Error('IntactConcreteWall meshInstance missing in concrete_wall_fractured.glb');
      }

      const intactWallMesh = intactMi.mesh;
      const intactWallMaterial = intactMi.material ?? null;

      const chunkMeshes: pc.Mesh[] = [];
      const chunkLocalVertices: Float32Array[] = [];
      let chunkMaterial: pc.Material | null = null;

      for (const node of this.connectivityGraph.nodes) {
        const chunkEnt = findEntityByName(tempRoot, node.name);
        const mi = chunkEnt?.render?.meshInstances?.[0];
        if (!mi || !mi.mesh) {
          throw new Error(`Missing meshInstance for ${node.name} in concrete_wall_fractured.glb`);
        }
        chunkMeshes.push(mi.mesh);
        chunkLocalVertices.push(extractMeshLocalVertices(mi.mesh));
        if (!chunkMaterial && mi.material) {
          chunkMaterial = mi.material;
        }
      }

      // Increment mesh ref counts before destroying temporary container hierarchy
      intactWallMesh.incRefCount();
      for (const m of chunkMeshes) {
        m.incRefCount();
      }

      return {
        intactWallMesh,
        intactWallMaterial,
        chunkMeshes,
        chunkMaterial,
        chunkLocalVertices,
        connectivity: this.connectivityGraph,
      };
    } finally {
      tempRoot.destroy();
    }
  }

  /**
   * Extracts the 3 beveled masonry brick variants (`Brick_0..2`) and 3 jagged wood-splinter
   * meshes (`Splinter_0..2`) from `debris_pack.glb` for `HardwareInstancedPool`.
   */
  public getDebrisPackBundle(): DebrisPackBundle {
    const container = this.getContainer('debris_pack');
    if (!container) {
      throw new Error('debris_pack.glb is not loaded yet.');
    }

    const tempRoot = container.instantiateRenderEntity();
    upgradeEntityHierarchyPbr(tempRoot, this.app.graphicsDevice);
    try {
      const brickMeshes: pc.Mesh[] = [];
      const brickLocalVertices: Float32Array[] = [];
      let brickMaterial: pc.Material | null = null;

      for (let i = 0; i < 3; i++) {
        const name = `Brick_${i}`;
        const ent = findEntityByName(tempRoot, name);
        const mi = ent?.render?.meshInstances?.[0];
        if (!mi || !mi.mesh) {
          throw new Error(`Missing ${name} meshInstance in debris_pack.glb`);
        }
        mi.mesh.incRefCount();
        brickMeshes.push(mi.mesh);
        brickLocalVertices.push(extractMeshLocalVertices(mi.mesh));
        if (!brickMaterial && mi.material) {
          brickMaterial = mi.material;
        }
      }

      const splinterMeshes: pc.Mesh[] = [];
      const splinterLocalVertices: Float32Array[] = [];
      let splinterMaterial: pc.Material | null = null;

      for (let i = 0; i < 3; i++) {
        const name = `Splinter_${i}`;
        const ent = findEntityByName(tempRoot, name);
        const mi = ent?.render?.meshInstances?.[0];
        if (!mi || !mi.mesh) {
          throw new Error(`Missing ${name} meshInstance in debris_pack.glb`);
        }
        mi.mesh.incRefCount();
        splinterMeshes.push(mi.mesh);
        splinterLocalVertices.push(extractMeshLocalVertices(mi.mesh));
        if (!splinterMaterial && mi.material) {
          splinterMaterial = mi.material;
        }
      }

      return {
        brickMeshes,
        brickMaterial,
        brickLocalVertices,
        splinterMeshes,
        splinterMaterial,
        splinterLocalVertices,
      };
    } finally {
      tempRoot.destroy();
    }
  }

  public destroy(): void {
    for (const asset of this.containerAssets.values()) {
      this.app.assets.remove(asset);
      asset.unload();
    }
    this.containerAssets.clear();
    this.loadingPromises.clear();
    this.detachedHeadgearCache.clear();
    this.connectivityGraph = null;
    this.connectivityPromise = null;
  }
}
