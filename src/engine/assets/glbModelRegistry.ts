import * as pc from 'playcanvas';
import type { EnemyArchetypeId } from '../../contracts/ballistics.ts';
import type { AssetLoadProgressEvent } from '../../contracts/preloader.ts';
import { instantiateCombatantGlb, instantiateDetachedHeadgearProp } from './combatantFactory.ts';
import { loadConnectivityGraphJson } from './connectivityLoader.ts';
import { extractDebrisPackBundle, extractFracturedConcreteBundle } from './destructionFactory.ts';
import {
  ALL_GLB_ASSET_KEYS,
  type CombatantAnimationClipName,
  type CombatantGlbInstance,
  type ConcreteWallConnectivityGraphJson,
  type DebrisPackBundle,
  type FracturedConcreteWallBundle,
  type GlbAssetKey,
  type WeaponAssetId,
  type WeaponGlbInstance,
} from './glbTypes.ts';
import { upgradeContainerPbrQuality } from './materialUpgrade.ts';
import { instantiateWeaponGlb } from './weaponFactory.ts';

export type AssetLoadEntry<T> =
  | {
      readonly kind: 'LOADING';
      readonly epoch: number;
      readonly promise: Promise<T>;
      readonly asset?: pc.Asset;
    }
  | {
      readonly kind: 'READY';
      readonly value: T;
      readonly asset?: pc.Asset;
    };

export type GlbRegistryLifecycleState =
  | { readonly kind: 'ACTIVE'; readonly epoch: number }
  | { readonly kind: 'DESTROYED'; readonly epoch: number };

const WARMUP_ARCHETYPES: readonly EnemyArchetypeId[] = [
  'SKINHEAD_PUNK',
  'HEAVY_ENFORCER',
  'SNIPER_OPERATIVE',
  'MILITIA_GUNNER',
  'MASKED_BRUISER',
];

export class GlbModelRegistry {
  public readonly app: pc.AppBase;
  public readonly baseUrl: string;
  public registryState: GlbRegistryLifecycleState = { kind: 'ACTIVE', epoch: 1 };

  private readonly containerEntries = new Map<GlbAssetKey, AssetLoadEntry<pc.ContainerResource>>();
  private readonly detachedHeadgearCache = new Map<string, Array<{ mesh: pc.Mesh; material: pc.Material | null }>>();
  private cachedFracturedConcreteBundle: FracturedConcreteWallBundle | null = null;
  private cachedDebrisPackBundle: DebrisPackBundle | null = null;
  private connectivityEntry: AssetLoadEntry<ConcreteWallConnectivityGraphJson> | null = null;
  private connectivityGraph: ConcreteWallConnectivityGraphJson | null = null;

  public constructor(app: pc.AppBase, baseUrl = '/models') {
    this.app = app;
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  }

  public getAssetUrl(key: GlbAssetKey): string { return `${this.baseUrl}/${key}.glb`; }
  public getConnectivityUrl(): string { return `${this.baseUrl}/concrete_wall_connectivity.json`; }

  public isLoaded(key: GlbAssetKey): boolean {
    const entry = this.containerEntries.get(key);
    return entry?.kind === 'READY';
  }

  public getContainer(key: GlbAssetKey): pc.ContainerResource | null {
    const entry = this.containerEntries.get(key);
    return entry?.kind === 'READY' ? entry.value : null;
  }

  public registerContainerResource(key: GlbAssetKey, container: pc.ContainerResource): void {
    if (this.registryState.kind === 'DESTROYED') {
      this.registryState = { kind: 'ACTIVE', epoch: this.registryState.epoch + 1 };
    }
    const prev = this.containerEntries.get(key);
    if (prev?.asset) {
      this.app.assets.remove(prev.asset);
      prev.asset.unload();
    }
    upgradeContainerPbrQuality(container, this.app.graphicsDevice);
    const asset = new pc.Asset(`glb_${key}`, 'container');
    asset.resource = container;
    this.containerEntries.set(key, { kind: 'READY', value: container, asset });
    if (key === 'concrete_wall_fractured') this.cachedFracturedConcreteBundle = null;
    if (key === 'debris_pack') this.cachedDebrisPackBundle = null;
    if (key === 'ghoul_combatant') this.detachedHeadgearCache.clear();
  }

  public loadContainer(key: GlbAssetKey): Promise<pc.ContainerResource> {
    if (this.registryState.kind === 'DESTROYED') {
      return Promise.reject(new Error(`Cannot load GLB container ${key}: GlbModelRegistry is destroyed`));
    }
    const existing = this.containerEntries.get(key);
    if (existing?.kind === 'READY') return Promise.resolve(existing.value);
    if (existing?.kind === 'LOADING' && existing.epoch === this.registryState.epoch) {
      return existing.promise;
    }

    const loadEpoch = this.registryState.epoch;
    const url = this.getAssetUrl(key);
    const asset = new pc.Asset(`glb_${key}`, 'container', { url });

    const promise = new Promise<pc.ContainerResource>((resolve, reject) => {
      const cleanupFailedAsset = (): void => {
        const cur = this.containerEntries.get(key);
        if (cur?.kind === 'LOADING' && cur.asset === asset) {
          this.containerEntries.delete(key);
        }
        this.app.assets.remove(asset);
        asset.unload();
      };

      const onLoad = (loadedAsset: pc.Asset): void => {
        asset.off('error', onError);
        if (this.registryState.kind !== 'ACTIVE' || this.registryState.epoch !== loadEpoch) {
          cleanupFailedAsset();
          reject(new Error(`GlbModelRegistry destroyed while loading ${url}`));
          return;
        }
        const resource = loadedAsset.resource as pc.ContainerResource | null;
        if (!resource) {
          cleanupFailedAsset();
          reject(new Error(`Container resource missing after loading ${url}`));
          return;
        }
        upgradeContainerPbrQuality(resource, this.app.graphicsDevice);
        this.containerEntries.set(key, { kind: 'READY', value: resource, asset });
        resolve(resource);
      };

      const onError = (err: string): void => {
        asset.off('load', onLoad);
        cleanupFailedAsset();
        reject(new Error(`Failed to load GLB container ${url}: ${err}`));
      };

      asset.once('load', onLoad);
      asset.once('error', onError);
      this.app.assets.add(asset);
      this.app.assets.load(asset);
    });

    this.containerEntries.set(key, { kind: 'LOADING', epoch: loadEpoch, promise, asset });
    return promise;
  }

  public loadConcreteConnectivity(): Promise<ConcreteWallConnectivityGraphJson> {
    if (this.registryState.kind === 'DESTROYED') {
      return Promise.reject(new Error('Cannot load concrete connectivity: GlbModelRegistry is destroyed'));
    }
    if (this.connectivityGraph) return Promise.resolve(this.connectivityGraph);
    if (this.connectivityEntry?.kind === 'READY') {
      this.connectivityGraph = this.connectivityEntry.value;
      return Promise.resolve(this.connectivityEntry.value);
    }
    if (this.connectivityEntry?.kind === 'LOADING' && this.connectivityEntry.epoch === this.registryState.epoch) {
      return this.connectivityEntry.promise;
    }

    const loadEpoch = this.registryState.epoch;
    const promise = loadConnectivityGraphJson(this.getConnectivityUrl())
      .then((graph) => {
        if (this.registryState.kind !== 'ACTIVE' || this.registryState.epoch !== loadEpoch) {
          throw new Error('GlbModelRegistry destroyed while loading concrete connectivity');
        }
        this.connectivityGraph = graph;
        this.connectivityEntry = { kind: 'READY', value: graph };
        return graph;
      })
      .catch((err: unknown) => {
        if (this.connectivityEntry?.kind === 'LOADING' && this.connectivityEntry.epoch === loadEpoch) {
          this.connectivityEntry = null;
        }
        throw err;
      });

    this.connectivityEntry = { kind: 'LOADING', epoch: loadEpoch, promise };
    return promise;
  }

  public async preloadAll(onAssetLoaded?: (ev: AssetLoadProgressEvent) => void): Promise<void> {
    const totalCount = ALL_GLB_ASSET_KEYS.length + 1;
    let loadedCount = 0;

    const notify = (assetKey: string, url: string): void => {
      loadedCount += 1;
      onAssetLoaded?.({ assetKey, url, loadedCount, totalCount });
    };

    await Promise.all([
      ...ALL_GLB_ASSET_KEYS.map((key) =>
        this.loadContainer(key).then(() => {
          notify(key, this.getAssetUrl(key));
        })
      ),
      this.loadConcreteConnectivity().then(() => {
        notify('concrete_wall_connectivity', this.getConnectivityUrl());
      }),
    ]);
  }

  public warmExtractedBundles(onStep?: (label: string) => void): void {
    const graph = this.connectivityEntry?.kind === 'READY' ? this.connectivityEntry.value : this.connectivityGraph;
    if (this.isLoaded('concrete_wall_fractured') && graph) {
      onStep?.('Extracting Voronoi concrete fracture bundle...');
      try {
        this.getFracturedConcreteWallBundle();
      } catch {
        // Ignore in headless/partial test containers
      }
    }

    if (this.isLoaded('debris_pack')) {
      onStep?.('Extracting ballistic debris & splinter bundle...');
      try {
        this.getDebrisPackBundle();
      } catch {
        // Ignore in headless/partial test containers
      }
    }

    if (this.isLoaded('ghoul_combatant')) {
      onStep?.('Warming detached tactical headgear meshes...');
      for (const archetype of WARMUP_ARCHETYPES) {
        try {
          const prop = this.instantiateDetachedHeadgearProp(archetype);
          prop?.destroy();
        } catch {
          // Ignore in headless/partial test containers
        }
      }
    }
  }

  public instantiateCombatant(options?: {
    castShadows?: boolean;
    receiveShadows?: boolean;
    initialClip?: CombatantAnimationClipName;
    southpaw?: boolean;
  }): CombatantGlbInstance {
    const container = this.getContainer('ghoul_combatant');
    if (!container) throw new Error('ghoul_combatant.glb is not loaded yet; await preloadAll() or loadContainer("ghoul_combatant") first.');
    return instantiateCombatantGlb(this.app, container, options);
  }

  public instantiateDetachedHeadgearProp(archetype: EnemyArchetypeId): pc.Entity | null {
    return instantiateDetachedHeadgearProp(this.app, this.getContainer('ghoul_combatant'), archetype, this.detachedHeadgearCache);
  }

  public instantiateWeapon(
    weaponId: WeaponAssetId,
    options?: { castShadows?: boolean; receiveShadows?: boolean }
  ): WeaponGlbInstance {
    return instantiateWeaponGlb(this.app, (id) => this.getContainer(id), weaponId, options);
  }

  public getFracturedConcreteWallBundle(): FracturedConcreteWallBundle {
    const container = this.getContainer('concrete_wall_fractured');
    if (!container) throw new Error('concrete_wall_fractured.glb is not loaded yet.');
    const graph = this.connectivityEntry?.kind === 'READY' ? this.connectivityEntry.value : this.connectivityGraph;
    if (!graph) throw new Error('concrete_wall_connectivity.json is not loaded yet.');
    if (!this.cachedFracturedConcreteBundle) {
      this.cachedFracturedConcreteBundle = extractFracturedConcreteBundle(this.app, container, graph);
    }
    return {
      ...this.cachedFracturedConcreteBundle,
      chunkMeshes: [...this.cachedFracturedConcreteBundle.chunkMeshes],
      chunkLocalVertices: [...this.cachedFracturedConcreteBundle.chunkLocalVertices],
    };
  }

  public getDebrisPackBundle(): DebrisPackBundle {
    const container = this.getContainer('debris_pack');
    if (!container) throw new Error('debris_pack.glb is not loaded yet.');
    if (!this.cachedDebrisPackBundle) {
      this.cachedDebrisPackBundle = extractDebrisPackBundle(this.app, container);
    }
    return {
      ...this.cachedDebrisPackBundle,
      brickMeshes: [...this.cachedDebrisPackBundle.brickMeshes],
      brickLocalVertices: [...this.cachedDebrisPackBundle.brickLocalVertices],
      splinterMeshes: [...this.cachedDebrisPackBundle.splinterMeshes],
      splinterLocalVertices: [...this.cachedDebrisPackBundle.splinterLocalVertices],
    };
  }

  public destroy(): void {
    this.registryState = { kind: 'DESTROYED', epoch: this.registryState.epoch + 1 };
    for (const entry of this.containerEntries.values()) {
      if (entry.asset) {
        this.app.assets.remove(entry.asset);
        entry.asset.unload();
      }
    }
    this.containerEntries.clear();
    this.detachedHeadgearCache.clear();
    this.cachedFracturedConcreteBundle = null;
    this.cachedDebrisPackBundle = null;
    this.connectivityEntry = null;
    this.connectivityGraph = null;
  }
}
