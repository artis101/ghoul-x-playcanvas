import * as pc from 'playcanvas';
import type { TargetHealthState, Vec3Like } from '../../contracts/ballistics.ts';
import { applySwayToDirection, swayRotationForBarrel } from '../../core/ai/weaponSway.ts';
import { sampleEnemyWeaponSway } from '../ai/enemyWeaponSway.ts';
import type { CombatantGlbInstance } from '../assets/glbLoader.ts';
import { HAND_ZONE, UPPER_ARM_ZONE } from './armZoneKeys.ts';

/**
 * The one procedural touch on a living aimer: a small, clamped turn of the chest and the gun arm
 * so the barrel points at the target, plus the weapon sway and recoil the bullets use. The clip
 * owns the pose; this only closes the last few degrees a pre-authored take cannot know about
 * (the target's height, a fine yaw error), and it carries the sway so the visible barrel and the
 * bullet leave along the same line.
 */
export interface AimDeltaInput {
  /** Where the gun should point, in world space; null keeps the clip's aim and adds only sway. */
  readonly aimDirWorld: Vec3Like | null;
  /** The gun hand; its upper arm takes the share of the turn the chest does not. */
  readonly hand: 'RIGHT' | 'LEFT';
  /** 1 while the AI aims, 0 otherwise; eased here so the turn never pops. */
  readonly weight: number;
  /** Combatant id, for the sway the AI shares with the shot path. */
  readonly targetId: string;
}

const DEG = Math.PI / 180;
// A real shooter turns the chest a little to correct the aim, and the arms do the rest.
const MAX_YAW = 15 * DEG;
const MAX_PITCH = 25 * DEG;
const THORAX_SHARE = 0.6;
const EASE_RATE = 8;
const BARREL_AXIS = new pc.Vec3(0, 0, -1);

const AIM_CLIPS = new Set(['LongGunAim', 'PistolAim', 'PistolAimOneHand']);

const weights = new WeakMap<CombatantGlbInstance, number>();
const aimTargets = new Map<string, Vec3Like>();

const total = new pc.Quat();
const chestTurn = new pc.Quat();
const armTurn = new pc.Quat();
const scratch = new pc.Quat();
const fingerAxis = new pc.Vec3();
const barrelScratch = new pc.Vec3();

/**
 * Publishes the world point a combatant is aiming at (or null to stop). The AI side calls it
 * while it aims, so the mannequin can turn the gun onto the same point the shot goes to.
 */
export function setCombatantAimTarget(targetId: string, point: Vec3Like | null): void {
  if (point) aimTargets.set(targetId, { x: point.x, y: point.y, z: point.z });
  else aimTargets.delete(targetId);
}

export function combatantAimTarget(targetId: string): Vec3Like | null {
  return aimTargets.get(targetId) ?? null;
}

export function clearCombatantAimTargets(): void {
  aimTargets.clear();
}

/** The aim-delta weight currently eased in on this body, 0..1. */
export function aimDeltaWeight(glb: CombatantGlbInstance): number {
  return weights.get(glb) ?? 0;
}

/** True when any anim layer is playing an aim clip (the upper-body layer aims over a gait). */
export function isPlayingAimClip(glb: CombatantGlbInstance): boolean {
  const anim = glb.animComponent;
  const layers = anim?.layers ?? (anim?.baseLayer ? [anim.baseLayer] : []);
  return layers.some((layer) => {
    const clip = layer?.activeState?.replace('_Southpaw', '');
    return clip !== undefined && AIM_CLIPS.has(clip) && (layer.weight ?? 1) > 0.01;
  });
}

/**
 * The held weapon's barrel axis in world space. Every weapon GLB is modelled with the barrel
 * along its local -Z (the muzzle bone sits on that axis but carries no reliable rotation), so the
 * node's own forward is the barrel.
 */
export function barrelForward(weaponNode: pc.GraphNode): Vec3Like {
  weaponNode.getRotation().transformVector(BARREL_AXIS, barrelScratch).normalize();
  return { x: barrelScratch.x, y: barrelScratch.y, z: barrelScratch.z };
}

function heading(d: Vec3Like): number {
  return Math.atan2(d.x, d.z);
}

function elevation(d: Vec3Like): number {
  const len = Math.hypot(d.x, d.y, d.z) || 1;
  return Math.asin(Math.max(-1, Math.min(1, d.y / len)));
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function clamp(v: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, v));
}

/**
 * Turns the upper chest and the gun-side upper arm so the barrel (or, with none given, the gun
 * hand's finger axis) points along `aimDirWorld` bent by the sway, clamped to ±15° yaw and ±25°
 * pitch. Call it after the clip has posed the body and before the gun is glued to the hand; the
 * hand, and so the gun, then inherits the whole turn.
 *
 * @param barrel The barrel direction the clip pose gives, when the caller has already placed the
 *   gun; without it the hand's finger axis stands in, which an aimed clip points down the sights.
 */
export function applyAimDelta(
  glb: CombatantGlbInstance,
  hs: TargetHealthState,
  input: AimDeltaInput,
  dt: number,
  barrel?: Vec3Like,
): void {
  const goal = hs.alive ? Math.max(0, Math.min(1, input.weight)) : 0;
  const previous = weights.get(glb) ?? 0;
  const easing = Number.isFinite(dt) ? 1 - Math.exp(-EASE_RATE * Math.max(0, dt)) : 1;
  const weight = previous + (goal - previous) * easing;
  weights.set(glb, weight);
  if (weight < 1e-3) return;

  const chest = glb.boneNodes.get('TORSO_UPPER_THORAX');
  const upperArm = glb.boneNodes.get(UPPER_ARM_ZONE[input.hand]);
  const hand = glb.boneNodes.get(HAND_ZONE[input.hand]);
  if (!chest || !upperArm || !hand) return;

  let reference = barrel;
  if (!reference) {
    fingerAxis.copy(hand.up);
    reference = { x: fingerAxis.x, y: fingerAxis.y, z: fingerAxis.z };
  }
  // Point at the target if there is one; either way bend by the sway and recoil the bullet uses.
  const swayed = applySwayToDirection(input.aimDirWorld ?? reference, sampleEnemyWeaponSway(input.targetId));
  const yaw = clamp(wrapAngle(heading(swayed) - heading(reference)), MAX_YAW) * weight;
  const pitch = clamp(elevation(swayed) - elevation(reference), MAX_PITCH) * weight;
  if (Math.abs(yaw) < 1e-6 && Math.abs(pitch) < 1e-6) return;

  const q = swayRotationForBarrel(reference, { yawRad: yaw, pitchRad: pitch });
  total.set(q.x, q.y, q.z, q.w);
  // The chest takes its share about its own joint; the arm then takes the rest, so the hand
  // turns by exactly the whole rotation.
  chestTurn.slerp(pc.Quat.IDENTITY, total, THORAX_SHARE);
  chest.setRotation(scratch.mul2(chestTurn, chest.getRotation()));
  armTurn.copy(chestTurn).invert();
  armTurn.mul2(total, armTurn);
  upperArm.setRotation(scratch.mul2(armTurn, upperArm.getRotation()));
}
