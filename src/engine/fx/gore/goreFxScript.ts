import * as pc from 'playcanvas';
import { GoreAndBallisticsFxManager } from '../../goreFx.ts';
import type { DismembermentEvent, EnemyArchetypeId, TargetHealthState, TrajectorySample, Vec3Like } from '../../../contracts/ballistics.ts';
import type { EngineMaterialPalette } from '../../materials.ts';
import type { GlbModelRegistry } from '../../assets/glbLoader.ts';

export type GoreFxScriptLifecycleState =
  | 'UNINITIALIZED'
  | 'ACTIVE'
  | 'SWAPPED_OUT'
  | 'DESTROYED';

export class GoreFxScript extends pc.Script {
  /**
   * @attribute
   * @type {number}
   * @default 512
   * @range [64, 2048]
   * @title Max Blood Droplets
   */
  public maxBloodDrops = 512;

  /**
   * @attribute
   * @type {number}
   * @default 65
   * @range [10, 256]
   * @title Max Blood Pools
   */
  public maxBloodPools = 65;

  /**
   * @attribute
   * @type {boolean}
   * @default true
   * @title Show Ballistic Trails
   */
  public showTrails = true;

  public manager!: GoreAndBallisticsFxManager;
  private _lifecycleState: GoreFxScriptLifecycleState = 'UNINITIALIZED';
  private readonly _eventCleanups: Array<() => void> = [];

  public get lifecycleState(): GoreFxScriptLifecycleState {
    return this._lifecycleState;
  }

  public initialize(): void {
    if (this._lifecycleState === 'ACTIVE') return;
    if (!this.manager) {
      const materials = (this.app as unknown as { materials?: EngineMaterialPalette }).materials;
      const glbRegistry = (this.app as unknown as { glbRegistry?: GlbModelRegistry }).glbRegistry;
      this.manager = new GoreAndBallisticsFxManager(
        this.app as pc.AppBase,
        materials ?? ({} as EngineMaterialPalette),
        glbRegistry,
      );
    }

    this.bindEvents();
    this._lifecycleState = 'ACTIVE';
  }

  private bindEvents(): void {
    this.unbindEvents();
    const bind = (name: string, fn: (...args: unknown[]) => void): void => {
      this.app.on(name, fn, this);
      this._eventCleanups.push(() => this.app.off(name, fn, this));
    };

    bind('gore:projectileSpawn', (d: unknown) => {
      const p = d as { trajectorySamples: TrajectorySample[]; isShotgunPellet?: boolean };
      this.manager?.spawnFlyingProjectile(p.trajectorySamples, p.isShotgunPellet);
    });

    bind('gore:bloodBurst', (d: unknown) => {
      const p = d as { worldPos: Vec3Like; normalDir: Vec3Like; energyJ: number; count?: number };
      this.manager?.spawnBloodBurst(p.worldPos, p.normalDir, p.energyJ, p.count);
    });

    bind('gore:dismember', (d: unknown) => {
      this.manager?.spawnDismembermentGibs(d as DismembermentEvent);
    });

    bind('gore:arterialFountain', (d: unknown) => {
      const p = d as { target: TargetHealthState; event: DismembermentEvent };
      this.manager?.attachArterialFountain(p.target, p.event);
    });

    bind('gore:boneShatter', (d: unknown) => {
      const p = d as { worldPos: Vec3Like; dir: Vec3Like };
      this.manager?.spawnBoneShatterSparks(p.worldPos, p.dir);
    });

    bind('gore:armorSpark', (d: unknown) => {
      const p = d as { worldPos: Vec3Like; normalDir: Vec3Like };
      this.manager?.spawnArmorImpactSparks(p.worldPos, p.normalDir);
    });

    bind('gore:detachedHeadgear', (d: unknown) => {
      const p = d as { archetype: EnemyArchetypeId; worldPos: Vec3Like; shotDir: Vec3Like };
      this.manager?.spawnDetachedHeadgearProp(p.archetype, p.worldPos, p.shotDir);
    });

    bind('gore:droppedWeapon', (d: unknown) => {
      const p = d as { archetype: EnemyArchetypeId; worldPos: Vec3Like; inheritedVel: Vec3Like };
      this.manager?.spawnDroppedWeaponProp(p.archetype, p.worldPos, p.inheritedVel);
    });

    bind('gore:clearAll', () => {
      this.manager?.clearAll();
    });

    bind('camera:transform', (d: unknown) => {
      const p = d as { position: pc.Vec3; entity?: pc.Entity };
      if (p.entity) this.manager?.setCameraEntity(p.entity);
      this.manager?.setCachedCameraPos(p.position);
    });
  }

  private unbindEvents(): void {
    while (this._eventCleanups.length > 0) {
      const cleanup = this._eventCleanups.pop();
      cleanup?.();
    }
  }

  public update(dt: number): void {
    if (this._lifecycleState !== 'ACTIVE' || !this.manager) return;
    this.manager.update(dt, this.showTrails);
  }

  public swap(old: GoreFxScript): void {
    old.unbindEvents();
    old._lifecycleState = 'SWAPPED_OUT';

    if (this.manager && this.manager !== old.manager) {
      this.manager.clearAll();
      this.manager.fxRoot?.destroy();
    }
    this.manager = old.manager;
    old.manager = undefined as unknown as GoreAndBallisticsFxManager;

    this.bindEvents();
    this._lifecycleState = 'ACTIVE';
  }

  public destroy(): void {
    if (this._lifecycleState === 'DESTROYED') return;
    this.unbindEvents();
    if (this._lifecycleState !== 'SWAPPED_OUT' && this.manager) {
      this.manager.clearAll();
      this.manager.fxRoot?.destroy();
    }
    this.manager = undefined as unknown as GoreAndBallisticsFxManager;
    this._lifecycleState = 'DESTROYED';
  }
}

try {
  (pc.registerScript as (script: typeof pc.Script, name?: string) => void)(
    GoreFxScript,
    'goreFxScript',
  );
} catch {}
