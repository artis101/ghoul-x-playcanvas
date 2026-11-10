import * as pc from 'playcanvas';
import type { GhoulZoneId, Vec3Like } from '../../contracts/ballistics.ts';
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

export interface CombatantGlbInstance {
  rootEntity: pc.Entity;
  animComponent: pc.AnimComponent | null;
  zoneEntities: Map<GhoulZoneId, pc.Entity>;
  boneNodes: Map<GhoulZoneId, pc.GraphNode>;
  esapiPlateCarrier: pc.Entity | null;
  pasgtHelmet: pc.Entity | null;
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
  playClip(clipName: CombatantAnimationClipName, transitionSeconds?: number, speed?: number): boolean;
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

  public isLoaded(key: GlbAssetKey): boolean {
    const asset = this.containerAssets.get(key);
    return Boolean(asset && asset.resource);
  }

  public getContainer(key: GlbAssetKey): pc.ContainerResource | null {
    const asset = this.containerAssets.get(key);
    if (!asset || !asset.resource) {
      return null;
    }
    return asset.resource as pc.ContainerResource;
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
  }): CombatantGlbInstance {
    const container = this.getContainer('ghoul_combatant');
    if (!container) {
      throw new Error('ghoul_combatant.glb is not loaded yet; await preloadAll() or loadContainer("ghoul_combatant") first.');
    }

    const rootEntity = container.instantiateRenderEntity({
      castShadows: options?.castShadows ?? true,
      receiveShadows: options?.receiveShadows ?? true,
    });
    rootEntity.name = 'GhoulCombatantRoot';

    const zoneEntities = new Map<GhoulZoneId, pc.Entity>();
    const boneNodes = new Map<GhoulZoneId, pc.GraphNode>();

    for (const zone of ALL_GHOUL_ZONES) {
      const zoneEnt = findEntityByName(rootEntity, `Zone_${zone}`);
      if (zoneEnt) {
        zoneEntities.set(zone, zoneEnt);
      }
      const boneNode = rootEntity.findByName(`Bone_${zone}`);
      if (boneNode) {
        boneNodes.set(zone, boneNode);
      }
    }

    const esapiPlateCarrier = findEntityByName(rootEntity, 'Gear_ESAPI_PlateCarrier');
    const pasgtHelmet = findEntityByName(rootEntity, 'Gear_PASGT_Helmet');

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
        const isLooping = clipName === 'CombatReadyIdle' || clipName === 'UnsuspectingIdle';
        animComponent.assignAnimation(clipName, track, undefined, 1.0, isLooping);
        availableClips.add(clipName);
      }

      const initialClip = options?.initialClip ?? 'CombatReadyIdle';
      if (availableClips.has(initialClip) && animComponent.baseLayer) {
        animComponent.baseLayer.transition(initialClip, 0);
      }
    }

    return {
      rootEntity,
      animComponent,
      zoneEntities,
      boneNodes,
      esapiPlateCarrier,
      pasgtHelmet,
      internalAnatomyEntities,
      availableClips,
      playClip(clipName: CombatantAnimationClipName, transitionSeconds = 0.12, speed = 1.0): boolean {
        if (!animComponent || !animComponent.baseLayer || !availableClips.has(clipName)) {
          return false;
        }
        animComponent.speed = speed;
        animComponent.baseLayer.transition(clipName, transitionSeconds);
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
   * Instantiates an animated 3D weapon viewmodel or world prop (`m590_shotgun`, `silver_talon_50ae`,
   * `msg90_sniper`, `m4a1_carbine`, or `frag_grenade`).
   */
  public instantiateWeapon(
    weaponId: WeaponAssetId,
    options?: { castShadows?: boolean; receiveShadows?: boolean }
  ): WeaponGlbInstance {
    const container = this.getContainer(weaponId);
    if (!container) {
      throw new Error(`${weaponId}.glb is not loaded yet; await preloadAll() or loadContainer("${weaponId}") first.`);
    }

    const rootEntity = container.instantiateRenderEntity({
      castShadows: options?.castShadows ?? false,
      receiveShadows: options?.receiveShadows ?? true,
    });
    rootEntity.name = `Weapon_${weaponId}`;

    const boneNodes = new Map<string, pc.GraphNode>();
    collectBoneNodes(rootEntity, boneNodes);

    let muzzleNode = rootEntity.findByName('Bone_Muzzle') ?? rootEntity.findByName('MuzzleSocket');
    if (!muzzleNode) {
      const fallback = new pc.Entity('Bone_Muzzle');
      const offset = DEFAULT_MUZZLE_OFFSETS[weaponId];
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
      animComponent.baseLayer.transition(clipName, transitionSeconds);
      return true;
    };

    return {
      weaponId,
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
        if (animComponent?.baseLayer) {
          animComponent.baseLayer.reset();
        }
        return playClip(fireClipName, 0.01, speed);
      },
      playReload(speed = 1.0): boolean {
        if (!reloadClipName) return false;
        if (animComponent?.baseLayer) {
          animComponent.baseLayer.reset();
        }
        return playClip(reloadClipName, 0.05, speed);
      },
      destroy(): void {
        rootEntity.destroy();
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
    this.connectivityGraph = null;
    this.connectivityPromise = null;
  }
}
