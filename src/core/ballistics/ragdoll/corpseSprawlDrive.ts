import type { TargetHealthState } from '../../../contracts/ballistics.ts';
import { Vec3Like, add, dot, normalize, scale, sub, vec3 } from '../vec3.ts';
import { DEG, type LimitParticle, clampConeDirection } from './ragdollJointLimitMath.ts';

// The torso is lying down once one end of the spine is no higher than this above the other.
const MAX_LYING_SPINE_RISE_M = 0.15;
// A torso still propped up is toppled once its lower end is this close to the floor.
const PROPPED_END_HEIGHT_M = 0.4;
const MIN_LEAN_M = 0.03;
const TOPPLE_ACCEL_MS2 = 12;

// Where slack limbs come to rest, and how far from that they may stay. The slack keeps one
// corpse from looking like the next.
const LEG_SPREAD = 11 * DEG;
const THIGH_SLACK = 16 * DEG;
const SHIN_SLACK = 22 * DEG;
const ARM_SPREAD = 55 * DEG;
const UPPER_ARM_SLACK = 28 * DEG;
const FOREARM_SLACK = 40 * DEG;
// A shoulder or hip line tilted further than this means the body is balanced on its side.
const MAX_SHOULDER_TILT_M = 0.1;
const MAX_HIP_TILT_M = 0.06;

const UNFOLD_RATE_PER_S = 9;
const MAX_UNFOLD_SPEED_MS = 1.6;
// Slower than this and the floor's grip holds a resting limb where it is.
const MIN_UNFOLD_SPEED_MS = 0.35;
const SETTLED_ERROR_M = 0.02;
// Enough to drag a limb across the floor against its grip, with nothing left over to throw it.
const UNFOLD_ACCEL_MS2 = 55;

// A limb the drive is pushing but that is not getting anywhere is wedged, not unfolding.
const PROGRESS_SPEED_MS = 0.08;

/** How far along a corpse is in spreading out: nothing left to do, wedged, or still going. */
export type SprawlProgress = 'SETTLED' | 'STALLED' | 'MOVING';

const SIDES = ['RIGHT', 'LEFT'] as const;

function flat(v: Vec3Like): Vec3Like {
  return vec3(v.x, 0, v.z);
}

/** A pending push that slides `limb` and `pivot` apart along the floor, in the direction `dir`. */
interface Slide {
  pivot: LimitParticle;
  /** The particle being placed, followed by everything hanging off it. */
  limb: LimitParticle[];
  dirX: number;
  dirZ: number;
  sizeM: number;
}

function planSlide(pivot: LimitParticle, limb: LimitParticle[], error: Vec3Like): Slide | null {
  const sizeM = Math.hypot(error.x, error.z);
  if (sizeM < SETTLED_ERROR_M) return null;
  return { pivot, limb, dirX: error.x / sizeM, dirZ: error.z / sizeM, sizeM };
}

function closingSpeed({ pivot, limb, dirX, dirZ }: Slide): number {
  const lead = limb[0];
  return (lead.velocity.x - pivot.velocity.x) * dirX + (lead.velocity.z - pivot.velocity.z) * dirZ;
}

/**
 * Carries out a slide. Everything hanging off the limb is carried along: a foot gripping the
 * floor would otherwise pin the knee above it. The push is level, so it can straighten a limb
 * but never lift one, and it is shared by inverse mass, so it adds no momentum to the body.
 */
function applySlide(slide: Slide, maxKickMs: number): void {
  const { pivot, limb, dirX, dirZ } = slide;
  const wanted = Math.min(Math.max(slide.sizeM * UNFOLD_RATE_PER_S, MIN_UNFOLD_SPEED_MS), MAX_UNFOLD_SPEED_MS);
  const kick = Math.min(Math.max(0, wanted - closingSpeed(slide)), maxKickMs);
  if (kick <= 0) return;
  const wLimb = 1 / limb.reduce((sum, p) => sum + p.massKg, 0);
  const wPivot = 1 / pivot.massKg;
  const toLimb = (kick * wLimb) / (wLimb + wPivot);
  const toPivot = (kick * wPivot) / (wLimb + wPivot);
  for (const p of limb) {
    p.velocity.x += dirX * toLimb;
    p.velocity.z += dirZ * toLimb;
  }
  pivot.velocity.x -= dirX * toPivot;
  pivot.velocity.z -= dirZ * toPivot;
}

/** Plans easing the segment from `pivot` to the head of `limb` to within `slack` of `rest`. */
function relaxSegment(pivot: LimitParticle, limb: LimitParticle[], rest: Vec3Like, slack: number): Slide | null {
  const segment = sub(limb[0].position, pivot.position);
  const span = Math.hypot(segment.x, segment.y, segment.z);
  if (span < 1e-4) return null;
  const eased = clampConeDirection(scale(segment, 1 / span), rest, slack);
  return eased ? planSlide(pivot, limb, flat(sub(scale(eased, span), segment))) : null;
}

/** Plans tipping a body balanced on its side, by sliding the raised end of a line off the lower. */
function tipOver(a: LimitParticle, b: LimitParticle, across: Vec3Like, maxTiltM: number): Slide | null {
  const tilt = b.position.y - a.position.y;
  if (Math.abs(tilt) <= maxTiltM) return null;
  const [lower, upper] = tilt > 0 ? [a, b] : [b, a];
  const lean = dot(sub(upper.position, lower.position), across);
  return planSlide(lower, [upper], scale(across, (lean >= 0 ? 1 : -1) * Math.abs(tilt)));
}

/**
 * Topples a torso left propped on one end: sitting over its hips, or stood on its shoulders
 * with the hips in the air. The raised end is pushed the way it already leans, or failing
 * that away from the legs, and gravity brings it down.
 */
function toppleTorso(target: TargetHealthState, floorY: number, h: number): void {
  const b = target.ragdollBones;
  const sitting = b.TORSO_UPPER_THORAX.position.y >= b.PELVIS_GROIN.position.y;
  const lower = sitting ? b.PELVIS_GROIN : b.TORSO_UPPER_THORAX;
  const upper = sitting ? b.TORSO_UPPER_THORAX : b.PELVIS_GROIN;
  if (lower.position.y > floorY + PROPPED_END_HEIGHT_M) return;

  let lean = flat(sub(upper.position, lower.position));
  if (Math.hypot(lean.x, lean.z) < MIN_LEAN_M) {
    const knees = scale(add(b.KNEE_RIGHT.position, b.KNEE_LEFT.position), 0.5);
    lean = scale(flat(sub(knees, b.PELVIS_GROIN.position)), sitting ? -1 : 1);
    if (Math.hypot(lean.x, lean.z) < MIN_LEAN_M) lean = vec3(0, 0, 1);
  }
  const rise = upper.position.y - lower.position.y;
  const slide = planSlide(lower, [upper], scale(normalize(lean), rise));
  if (slide) applySlide(slide, TOPPLE_ACCEL_MS2 * h);
}

/**
 * Lets a corpse that has reached the floor go slack and spread out. The particle skeleton has no
 * weight resting on its joints, so a body that crumples at the hips and knees on the way down
 * would otherwise stay curled up. Once the torso is down, the legs are eased out in line with
 * the spine, the arms out to the sides, and a body left balanced on its side is tipped flat.
 *
 * Returns how far along it is, so a corpse is not put to sleep half unfolded.
 */
export function applyCorpseSprawl(target: TargetHealthState, floorY: number, h: number): SprawlProgress {
  const b = target.ragdollBones;
  const pelvis = b.PELVIS_GROIN;
  const thorax = b.TORSO_UPPER_THORAX;
  if (pelvis.componentId !== 'BODY' || thorax.componentId !== 'BODY') return 'SETTLED';
  if (Math.abs(thorax.position.y - pelvis.position.y) > MAX_LYING_SPINE_RISE_M) {
    toppleTorso(target, floorY, h);
    return 'MOVING';
  }
  if (Math.min(thorax.position.y, pelvis.position.y) > floorY + PROPPED_END_HEIGHT_M) return 'MOVING';

  const toFeet = normalize(flat(sub(pelvis.position, thorax.position)));
  const across = vec3(toFeet.z, 0, -toFeet.x);
  const sideOf = (joint: LimitParticle, centre: LimitParticle): number =>
    dot(sub(joint.position, centre.position), across) >= 0 ? 1 : -1;
  const restDirection = (outward: number, spread: number): Vec3Like =>
    add(scale(toFeet, Math.cos(spread)), scale(across, outward * Math.sin(spread)));
  const aux = target.auxParticles;
  const attached = (...particles: (LimitParticle & { componentId: string })[]): LimitParticle[] =>
    particles.filter((p) => p.componentId === 'BODY');

  const planned: (Slide | null)[] = [];
  if (b.SHOULDER_RIGHT.componentId === 'BODY' && b.SHOULDER_LEFT.componentId === 'BODY') {
    planned.push(tipOver(b.SHOULDER_RIGHT, b.SHOULDER_LEFT, across, MAX_SHOULDER_TILT_M));
  }
  if (b.THIGH_RIGHT.componentId === 'BODY' && b.THIGH_LEFT.componentId === 'BODY') {
    planned.push(tipOver(b.THIGH_RIGHT, b.THIGH_LEFT, across, MAX_HIP_TILT_M));
  }
  for (const side of SIDES) {
    const thigh = b[`THIGH_${side}`];
    const knee = b[`KNEE_${side}`];
    if (thigh.componentId === 'BODY' && knee.componentId === 'BODY') {
      const rest = restDirection(sideOf(thigh, pelvis), LEG_SPREAD);
      const foot = b[`FOOT_${side}`];
      const lowerLeg = attached(foot, b[`SHIN_${side}`], aux[`FOOT_TOE_${side}`]);
      planned.push(relaxSegment(thigh, [knee, ...lowerLeg], rest, THIGH_SLACK));
      if (foot.componentId === 'BODY') planned.push(relaxSegment(knee, lowerLeg, rest, SHIN_SLACK));
    }

    const upperArm = b[`UPPER_ARM_${side}`];
    const forearm = b[`FOREARM_${side}`];
    if (upperArm.componentId === 'BODY' && forearm.componentId === 'BODY') {
      // An arm lying across the body cannot swing out through the chest, so it is first
      // brought down along its own side.
      const outward = sideOf(upperArm, thorax);
      const crossed = sideOf(forearm, thorax) !== outward;
      const rest = restDirection(outward, crossed ? LEG_SPREAD : ARM_SPREAD);
      const hand = b[`HAND_${side}`];
      const lowerArm = attached(hand, aux[`HAND_TIP_${side}`]);
      planned.push(relaxSegment(upperArm, [forearm, ...lowerArm], rest, UPPER_ARM_SLACK));
      if (hand.componentId === 'BODY') planned.push(relaxSegment(forearm, lowerArm, rest, FOREARM_SLACK));
    }
  }

  // Progress is read before any push lands, from how the limbs moved over the last step.
  const slides = planned.filter((slide): slide is Slide => slide !== null);
  if (slides.length === 0) return 'SETTLED';
  const progressing = slides.some((slide) => closingSpeed(slide) >= PROGRESS_SPEED_MS);
  for (const slide of slides) applySlide(slide, UNFOLD_ACCEL_MS2 * h);
  return progressing ? 'MOVING' : 'STALLED';
}
