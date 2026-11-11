import * as pc from 'playcanvas';
import { GoreAndBallisticsFxManager } from '../../goreFx.ts';
import type { DismembermentEvent, EnemyArchetypeId, TargetHealthState, TrajectorySample, Vec3Like } from '../../../contracts/ballistics.ts';
import type { EngineMaterialPalette } from '../../materials.ts';
import type { GlbModelRegistry } from '../../assets/glbLoader.ts';

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
  private appEventHandles: Array<{ name: string; fn: (...args: unknown[]) => void }> = [];

  public initialize(): void {
    const materials = (this.app as unknown as { materials?: EngineMaterialPalette }).materials;
    const glbRegistry = (this.app as unknown as { glbRegistry?: GlbModelRegistry }).glbRegistry;
    this.manager = new GoreAndBallisticsFxManager(this.app as any, materials ?? ({} as EngineMaterialPalette), glbRegistry);

    this.bindEvents();
  }

  private bindEvents(): void {
    const bind = (name: string, fn: (...args: unknown[]) => void): void => {
      this.app.on(name, fn, this);
      this.appEventHandles.push({ name, fn });
    };

    bind('gore:projectileSpawn', (d: unknown) => {
      const p = d as { trajectorySamples: TrajectorySample[]; isShotgunPellet?: boolean };
      this.manager.spawnFlyingProjectile(p.trajectorySamples, p.isShotgunPellet);
    });

    bind('gore:bloodBurst', (d: unknown) => {
      const p = d as { worldPos: Vec3Like; normalDir: Vec3Like; energyJ: number; count?: number };
      this.manager.spawnBloodBurst(p.worldPos, p.normalDir, p.energyJ, p.count);
    });

    bind('gore:dismember', (d: unknown) => {
      this.manager.spawnDismembermentGibs(d as DismembermentEvent);
    });

    bind('gore:arterialFountain', (d: unknown) => {
      const p = d as { target: TargetHealthState; event: DismembermentEvent };
      this.manager.attachArterialFountain(p.target, p.event);
    });

    bind('gore:boneShatter', (d: unknown) => {
      const p = d as { worldPos: Vec3Like; dir: Vec3Like };
      this.manager.spawnBoneShatterSparks(p.worldPos, p.dir);
    });

    bind('gore:armorSpark', (d: unknown) => {
      const p = d as { worldPos: Vec3Like; normalDir: Vec3Like };
      this.manager.spawnArmorImpactSparks(p.worldPos, p.normalDir);
    });

    bind('gore:detachedHeadgear', (d: unknown) => {
      const p = d as { archetype: EnemyArchetypeId; worldPos: Vec3Like; shotDir: Vec3Like };
      this.manager.spawnDetachedHeadgearProp(p.archetype, p.worldPos, p.shotDir);
    });

    bind('gore:droppedWeapon', (d: unknown) => {
      const p = d as { archetype: EnemyArchetypeId; worldPos: Vec3Like; inheritedVel: Vec3Like };
      this.manager.spawnDroppedWeaponProp(p.archetype, p.worldPos, p.inheritedVel);
    });

    bind('gore:clearAll', () => {
      this.manager.clearAll();
    });

    bind('camera:transform', (d: unknown) => {
      const p = d as { position: pc.Vec3 };
      this.manager.setCachedCameraPos(p.position);
    });
  }

  public update(dt: number): void {
    this.manager.update(dt, this.showTrails);
  }

  public swap(old: GoreFxScript): void {
    this.manager = old.manager;
    this.appEventHandles = old.appEventHandles;
  }

  public destroy(): void {
    for (const h of this.appEventHandles) {
      this.app.off(h.name, h.fn, this);
    }
    this.appEventHandles.length = 0;
    this.manager.clearAll();
  }
}
