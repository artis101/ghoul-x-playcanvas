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

const WARMUP_ARCHETYPES: readonly EnemyArchetypeId[] = [
  'SKINHEAD_PUNK',
  'HEAVY_ENFORCER',
  'SNIPER_OPERATIVE',
  'MILITIA_GUNNER',
];

export class GlbModelRegistry {
  public readonly app: pc.AppBase;
  public readonly baseUrl: string;

  private readonly containerAssets = new Map<GlbAssetKey, pc.Asset>();
  private readonly loadingPromises = new Map<GlbAssetKey, Promise<pc.ContainerResource>>();
  private readonly detachedHeadgearCache = new Map<string, Array<{ mesh: pc.Mesh; material: pc.Material | null }>>();
  private cachedFracturedConcreteBundle: FracturedConcreteWallBundle | null = null;
  private cachedDebrisPackBundle: DebrisPackBundle | null = null;
  private connectivityGraph: ConcreteWallConnectivityGraphJson | null = null;
  private connectivityPromise: Promise<ConcreteWallConnectivityGraphJson> | null = null;

  public constructor(app: pc.AppBase, baseUrl = '/models') {
    this.app = app;
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  }

  public getAssetUrl(key: GlbAssetKey): string { return `${this.baseUrl}/${key}.glb`; }
  public getConnectivityUrl(): string { return `${this.baseUrl}/concrete_wall_connectivity.json`; }

  public isLoaded(key: GlbAssetKey | 'weapon_beretta_m9'): boolean {
    const resolvedKey: GlbAssetKey = key === 'weapon_beretta_m9' ? 'silver_talon_50ae' : key;
    const asset = this.containerAssets.get(resolvedKey);
    return Boolean(asset && asset.resource);
  }

  public getContainer(key: GlbAssetKey | 'weapon_beretta_m9'): pc.ContainerResource | null {
    const resolvedKey: GlbAssetKey = key === 'weapon_beretta_m9' ? 'silver_talon_50ae' : key;
    const asset = this.containerAssets.get(resolvedKey);
    return asset && asset.resource ? (asset.resource as pc.ContainerResource) : null;
  }

  public registerContainerResource(key: GlbAssetKey, container: pc.ContainerResource): void {
    upgradeContainerPbrQuality(container, this.app.graphicsDevice);
    const asset = new pc.Asset(`glb_${key}`, 'container');
    asset.resource = container;
    this.containerAssets.set(key, asset);
    if (key === 'concrete_wall_fractured') this.cachedFracturedConcreteBundle = null;
    if (key === 'debris_pack') this.cachedDebrisPackBundle = null;
    if (key === 'ghoul_combatant') this.detachedHeadgearCache.clear();
  }

  public loadContainer(key: GlbAssetKey): Promise<pc.ContainerResource> {
    const existing = this.getContainer(key);
    if (existing) return Promise.resolve(existing);

    const inFlight = this.loadingPromises.get(key);
    if (inFlight) return inFlight;

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
    if (this.connectivityGraph) return Promise.resolve(this.connectivityGraph);
    if (!this.connectivityPromise) {
      this.connectivityPromise = loadConnectivityGraphJson(this.getConnectivityUrl()).then((graph) => {
        this.connectivityGraph = graph;
        return graph;
      });
    }
    return this.connectivityPromise;
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
    if (this.isLoaded('concrete_wall_fractured') && this.connectivityGraph) {
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
    weaponId: WeaponAssetId | 'weapon_beretta_m9',
    options?: { castShadows?: boolean; receiveShadows?: boolean }
  ): WeaponGlbInstance {
    return instantiateWeaponGlb(this.app, (id) => this.getContainer(id), weaponId, options);
  }

  public getFracturedConcreteWallBundle(): FracturedConcreteWallBundle {
    const container = this.getContainer('concrete_wall_fractured');
    if (!container) throw new Error('concrete_wall_fractured.glb is not loaded yet.');
    if (!this.connectivityGraph) throw new Error('concrete_wall_connectivity.json is not loaded yet.');
    if (!this.cachedFracturedConcreteBundle) {
      this.cachedFracturedConcreteBundle = extractFracturedConcreteBundle(this.app, container, this.connectivityGraph);
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
    for (const asset of this.containerAssets.values()) {
      this.app.assets.remove(asset);
      asset.unload();
    }
    this.containerAssets.clear();
    this.loadingPromises.clear();
    this.detachedHeadgearCache.clear();
    this.cachedFracturedConcreteBundle = null;
    this.cachedDebrisPackBundle = null;
    this.connectivityGraph = null;
    this.connectivityPromise = null;
  }
}
