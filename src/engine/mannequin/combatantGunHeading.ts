import * as pc from 'playcanvas';
import type { Vec3Like } from '../../contracts/ballistics.ts';
import { add, normalize, scale, vec3 } from '../../core/ballistics/vec3.ts';
import type { CombatantGlbInstance } from '../assets/glbLoader.ts';

/**
 * Where a held long gun points, read from the animated body.
 *
 * Ideally the gun would be glued to the trigger hand's full rotation. The Kimodo takes were made
 * without a prop, though, so the wrist roll in them means nothing: glued rigidly to the hand bone
 * the barrel points 30-100 degrees off the body's facing on most frames (straight up in parts of
 * LongGunAim and every flinch, sideways in UnsuspectingIdle). The gun's position is still rigidly
 * the animated palm; its direction comes from the two animated bones that do carry the take's
 * intent: the chest's heading (so a flinch's twist, a run's swing and a stagger turn the gun with
 * the torso) and the gun forearm (so a lowered or raised arm dips or lifts the muzzle). Nothing
 * here is procedural: the body's root yaw is used only when the chest is folded too far over to
 * have a heading. The aim delta then turns this onto the target.
 */

const CHEST_FORWARD = new pc.Vec3(0, 0, 1);
// The forearm's share of the barrel. It points well off the barrel in a two-handed hold (the
// elbow is out to the side), so it may only lean the gun; the chest gives the heading.
const FOREARM_SHARE = 0.32;
// A forearm pointing down or up dips or lifts the muzzle by about a third as much.
const FOREARM_PITCH_SHARE = 0.35;
/** Below this much horizontal length the chest is folded over and its heading is noise. */
const CHEST_HEADING_FULL = 0.5;

const chestScratch = new pc.Vec3();

/** The chest's horizontal heading, falling back to the body's facing as the chest folds over. */
export function chestHeading(glb: CombatantGlbInstance | null, bodyFacing: Vec3Like): Vec3Like {
  const chest = glb?.boneNodes.get('TORSO_UPPER_THORAX');
  if (!chest) return bodyFacing;
  chest.getRotation().transformVector(CHEST_FORWARD, chestScratch);
  const flat = Math.hypot(chestScratch.x, chestScratch.z);
  if (flat < 1e-4) return bodyFacing;
  const w = Math.min(1, flat / CHEST_HEADING_FULL);
  const heading = vec3(chestScratch.x / flat, 0, chestScratch.z / flat);
  return normalize(add(scale(heading, w), scale(bodyFacing, 1 - w)));
}

/**
 * The barrel direction for a gun in the animated trigger palm: the chest heading leaned by the
 * forearm. `forearm` is the elbow-to-hand direction.
 */
export function animatedBarrelDirection(
  glb: CombatantGlbInstance | null, forearm: Vec3Like, bodyFacing: Vec3Like,
): Vec3Like {
  const handAim = vec3(forearm.x, forearm.y * FOREARM_PITCH_SHARE, forearm.z);
  return normalize(add(scale(handAim, FOREARM_SHARE), scale(chestHeading(glb, bodyFacing), 1 - FOREARM_SHARE)));
}
