import type * as pc from 'playcanvas';
import type { EnemyArchetypeId, TargetHealthState } from '../../contracts/ballistics.ts';
import { createTargetHealthState } from '../../core/ghoul/anatomy.ts';
import { getPreferredPrimaryHand } from '../ai/combatantArmEvaluation.ts';
import { setEnemySwayClock } from '../ai/enemyWeaponSway.ts';
import type { CombatantGlbInstance, GlbModelRegistry, WeaponAssetId } from '../assets/glbLoader.ts';
import { getOrCreateMaterials } from '../materials.ts';
import { CombatantAimFacing } from '../mannequin/combatantAimFacing.ts';
import { setCombatantAimTarget } from '../mannequin/combatantAimDelta.ts';
import { CombatantAnimController, type CombatantAimPose } from '../mannequin/combatantAnimController.ts';
import { CombatantDismemberment } from '../mannequin/combatantDismemberment.ts';
import { setupCombatantGlbInstance } from '../mannequin/combatantGlbSetup.ts';
import { CombatantWeaponMount } from '../mannequin/combatantWeaponMount.ts';
import { gunKindOf, supportArmWorks, weaponPoseFor } from '../mannequin/combatantWeaponPoseMap.ts';
import { UPPER_BODY_LAYER } from '../mannequin/combatantUpperBodyLayer.ts';
import { canRaiseGun, isPistol, movementFor, type BodyState } from './labBodyStates.ts';

/** Where a raised gun points: well ahead of the body at chest height. */
const AIM_POINT = { x: 0, y: 1.5, z: 8 };

/**
 * One standing combatant driven by the game's own clip selection. The lab only sets the health
 * flags the game would (posture, dropped gun, handedness, a dead support arm) and the inputs the
 * AI would pass (gait and aim pose); CombatantAnimController then picks the clips and the weapon
 * mount seats the gun, exactly as for a combatant in the arena.
 */
export class LabStandingBody {
  public readonly health: TargetHealthState;
  public glb: CombatantGlbInstance;
  public southpaw = false;
  public supportArmDead = false;
  private readonly controller = new CombatantAnimController();
  private readonly mount = new CombatantWeaponMount();
  private readonly facing = new CombatantAimFacing();
  private readonly dismemberment = new CombatantDismemberment();
  private weapon: WeaponAssetId | null = null;
  private state: BodyState = { stance: 'READY', motion: 'STAND', aim: false };
  private showHeadgear = true;
  private showArmor = true;
  /** Seconds since the body was made, as the sway clock and the aim clip's recoil see it. */
  private clockS = 0;

  public constructor(
    private readonly app: pc.AppBase,
    private readonly registry: GlbModelRegistry,
    public readonly archetype: EnemyArchetypeId,
  ) {
    this.health = createTargetHealthState('gm-standing', 'Lab', { x: 0, y: 0, z: 0 }, 0, archetype);
    const glb = setupCombatantGlbInstance(registry, this.health, getOrCreateMaterials(), new Map());
    if (!glb) throw new Error('Unable to instantiate the combatant');
    this.glb = glb;
    app.root.addChild(glb.rootEntity);
  }

  public get availableClips(): ReadonlySet<string> {
    return this.glb.availableClips;
  }

  /** The clip the base layer plays, with the upper-body clip over it while the body moves aiming. */
  public get activeClip(): string {
    const anim = this.glb.animComponent;
    const base = anim?.baseLayer?.activeState ?? '—';
    const upper = anim?.findLayer(UPPER_BODY_LAYER);
    return upper && upper.weight > 0.01 ? `${base} + upper ${upper.activeState}` : base;
  }

  public set enabled(value: boolean) {
    this.glb.rootEntity.enabled = value;
    if (this.mount.heldWeaponNode) this.mount.heldWeaponNode.enabled = value && this.mount.wasWeaponHeld;
  }

  public setWeapon(weapon: WeaponAssetId | null): void {
    this.mount.destroy();
    this.weapon = weapon;
    if (weapon) this.mount.attachGlbWeaponIfReady(this.registry, this.health, this.app.root, weapon);
  }

  public setState(state: BodyState): void {
    this.state = state;
  }

  public setGear(headgear: boolean, armor: boolean): void {
    this.showHeadgear = headgear;
    this.showArmor = armor;
  }

  /** Runs one frame of the game's mannequin pass for the chosen weapon and state. */
  public update(dt: number, frozen: boolean): void {
    if (frozen) {
      if (this.glb.animComponent) this.glb.animComponent.playing = false;
      return;
    }
    this.clockS += dt;
    this.applyHealthFlags();
    const aim = this.aimPose();
    const movement = movementFor(this.state.motion);
    const guarding = this.state.stance === 'GUARD';
    setEnemySwayClock(this.clockS);
    setCombatantAimTarget(this.health.targetId, aim ? AIM_POINT : null);
    this.controller.syncAnimation(this.glb, this.health, guarding, movement, aim, 0, dt);
    this.glb.rootEntity.setPosition(0, 0, 0);
    const yaw = this.facing.update(this.glb, this.health.alive, dt);
    this.glb.rootEntity.setEulerAngles(0, (yaw * 180) / Math.PI, 0);
    this.dismemberment.syncGearVisibility(this.glb, this.health, this.showHeadgear);
    if (this.glb.esapiPlateCarrier && !this.showArmor) this.glb.esapiPlateCarrier.enabled = false;
    this.mount.syncWeaponPosition(
      this.health, this.glb, undefined, guarding, dt, aim && aim.clip !== 'LongGunAim' ? aim.hand ?? null : null,
    );
  }

  private applyHealthFlags(): void {
    const { stance } = this.state;
    const hs = this.health;
    hs.isLeftHanded = this.southpaw;
    hs.posture = stance === 'HURT' ? 'STAGGERED' : 'COMBAT_READY';
    hs.weaponDropped = stance === 'UNARMED' || this.weapon === null;
    const supportHand = getPreferredPrimaryHand(hs) === 'RIGHT' ? 'left' : 'right';
    hs.leftArmFunctional = !(this.supportArmDead && supportHand === 'left');
    hs.rightArmFunctional = !(this.supportArmDead && supportHand === 'right');
  }

  /** The aim the game would pass: the carry or aim clip for this gun, with the hand for a pistol. */
  private aimPose(): CombatantAimPose | undefined {
    const { weapon, state } = this;
    if (!weapon || !state.aim || !canRaiseGun(weapon, state.stance)) return undefined;
    const hand = getPreferredPrimaryHand(this.health);
    const pose = weaponPoseFor(gunKindOf(weapon), supportArmWorks(this.health, hand));
    if (!isPistol(weapon)) return { clip: 'LongGunAim' };
    return { clip: pose.aim === 'PistolAimOneHand' ? 'PistolAimOneHand' : 'PistolAim', hand };
  }

  public destroy(): void {
    setCombatantAimTarget(this.health.targetId, null);
    this.mount.destroy();
    this.glb.destroy();
  }
}
