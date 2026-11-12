import * as pc from 'playcanvas';
import { CombatAudioEngine } from './combatAudioEngine.ts';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import type { DestructibleMaterialKind } from '../../contracts/destruction.ts';
import type {
  EnemyBallisticShotAudioParams,
  GoreImpactAudioKind,
  NearMissGrazeAudioKind,
  RadioBarkCueAudioParams,
  ShellCasingCaliber,
  VocalTraumaCueKind,
} from '../../core/audio/types.ts';

/**
 * CombatAudioScript
 *
 * ES6 PlayCanvas Script component providing 3D spatialized combat audio and DSP sound synthesis.
 * Listens for application-wide `audio:*` events, updates 3D listener coordinates from the attached entity,
 * and exposes Editor configuration attributes.
 */
export class CombatAudioScript extends pc.Script {
  /**
   * @attribute
   * @type {number}
   * @default 0.9
   * @range [0, 2]
   * @title Master Volume
   */
  public masterVolume = 0.9;

  /**
   * @attribute
   * @type {number}
   * @default 0.34
   * @range [0, 1]
   * @title Reverb Wet Mix
   */
  public reverbWetMix = 0.34;

  /**
   * @attribute
   * @type {string}
   * @default 'equalpower'
   * @title Panner Model
   */
  public pannerModel: PanningModelType = 'equalpower';

  public engine!: CombatAudioEngine;
  private appEventHandles: Array<{ name: string; fn: (...args: unknown[]) => void }> = [];

  public initialize(): void {
    this.engine = new CombatAudioEngine({
      masterVolume: this.masterVolume,
      reverbWetMix: this.reverbWetMix,
      pannerModel: this.pannerModel,
    });

    this.bindEvents();
  }

  private bindEvents(): void {
    const bind = (name: string, fn: (...args: unknown[]) => void): void => {
      this.app.on(name, fn, this);
      this.appEventHandles.push({ name, fn });
    };

    bind('audio:fireWeapon', (data: unknown) => {
      const p = data as { weaponId: string; ammoType: string; isAds: boolean };
      this.engine.playWeaponFire(p.weaponId, p.ammoType, p.isAds);
    });

    bind('audio:impact', (data: unknown) => {
      const p = data as {
        material: DestructibleMaterialKind;
        worldPos: Vec3Like;
        energyJ: number;
        listenerPos?: Vec3Like;
      };
      const lPos = p.listenerPos ?? this.entity.getPosition();
      this.engine.playMaterialImpact(p.material, p.worldPos, p.energyJ, lPos);
    });

    bind('audio:gore', (data: unknown) => {
      const p = data as {
        kind: GoreImpactAudioKind;
        worldPos: Vec3Like;
        listenerPos?: Vec3Like;
      };
      const lPos = p.listenerPos ?? this.entity.getPosition();
      this.engine.playGoreImpact(p.kind, p.worldPos, lPos);
    });

    bind('audio:vocal', (data: unknown) => {
      const p = data as {
        cue: VocalTraumaCueKind;
        worldPos?: Vec3Like;
        listenerPos?: Vec3Like;
      };
      this.engine.playVocalTraumaCue(p.cue, p.worldPos, p.listenerPos);
    });

    bind('audio:explosion', (data: unknown) => {
      const p = data as { worldPos: Vec3Like; intensity: number; listenerPos?: Vec3Like };
      const lPos = p.listenerPos ?? this.entity.getPosition();
      this.engine.playExplosion(p.worldPos, lPos, p.intensity);
    });

    bind('audio:casingBounce', (data: unknown) => {
      const p = data as {
        caliber: ShellCasingCaliber;
        worldPos: Vec3Like;
        listenerPos?: Vec3Like;
      };
      const lPos = p.listenerPos ?? this.entity.getPosition();
      this.engine.playShellCasingBounce(p.caliber, p.worldPos, lPos);
    });

    bind('audio:slowMoTransition', (data: unknown) => {
      const p = data as { entering: boolean };
      this.engine.playSlowMoTransition(p.entering);
    });

    bind('audio:timeScale', (data: unknown) => {
      const p = data as { scale: number };
      this.engine.setTimeScale(p.scale);
    });

    bind('audio:listenerTransform', (data: unknown) => {
      const p = data as { position: Vec3Like; yawDeg?: number; pitchDeg?: number };
      this.engine.updateListener(p.position, p.yawDeg ?? 0, p.pitchDeg ?? 0);
    });

    bind('audio:enemyBallisticShot', (data: unknown) => {
      const p = data as EnemyBallisticShotAudioParams;
      this.engine.playEnemyBallisticShot(p);
    });

    bind('audio:nearMissGraze', (data: unknown) => {
      const p = data as {
        kind: NearMissGrazeAudioKind;
        hitOrigin: Vec3Like;
        listenerPos?: Vec3Like;
      };
      this.engine.playNearMissGrazeTinnitus(
        p.kind,
        p.hitOrigin,
        p.listenerPos ?? this.entity.getPosition(),
      );
    });

    bind('audio:radioBark', (data: unknown) => {
      const p = data as RadioBarkCueAudioParams;
      this.engine.playRadioBarkCue(p);
    });

    bind('audio:ricochet', (data: unknown) => {
      const p = data as { worldPos: Vec3Like; listenerPos?: Vec3Like };
      this.engine.playRicochetSnap(p.worldPos, p.listenerPos ?? this.entity.getPosition());
    });
  }

  public update(dt: number): void {
    const pos = this.entity.getPosition();
    const rot = this.entity.getEulerAngles();
    this.engine.updateListener(pos, rot.y, rot.x);
    this.engine.update(dt);
  }

  public swap(old: CombatAudioScript): void {
    this.engine = old.engine;
    this.appEventHandles = old.appEventHandles;
  }

  public destroy(): void {
    for (const h of this.appEventHandles) {
      this.app.off(h.name, h.fn, this);
    }
    this.appEventHandles.length = 0;
    this.engine.destroy();
  }
}
