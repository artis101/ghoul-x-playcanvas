import * as pc from 'playcanvas';
import type { EnemyArchetypeId } from '../../contracts/ballistics.ts';
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

export class GlbModelRegistry {
  public readonly app: pc.AppBase;
  public readonly baseUrl: string;

  private readonly containerAssets = new Map<GlbAssetKey, pc.Asset>();
  private readonly loadingPromises = new Map<GlbAssetKey, Promise<pc.ContainerResource>>();
  private readonly detachedHeadgearCache = new Map<string, Array<{ mesh: pc.Mesh; material: pc.Material | null }>>();
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

  public async preloadAll(): Promise<void> {
    await Promise.all([
      ...ALL_GLB_ASSET_KEYS.map((key) => this.loadContainer(key)),
      this.loadConcreteConnectivity(),
    ]);
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
    return extractFracturedConcreteBundle(this.app, container, this.connectivityGraph);
  }

  public getDebrisPackBundle(): DebrisPackBundle {
    const container = this.getContainer('debris_pack');
    if (!container) throw new Error('debris_pack.glb is not loaded yet.');
    return extractDebrisPackBundle(this.app, container);
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
