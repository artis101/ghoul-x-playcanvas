import type {
  GhoulZoneId,
  RagdollBoneState,
  SeverCut,
  Vec3Like,
  WoundChannelEvent,
} from '../../../contracts/ballistics.ts';
import { add, dot, lengthSq, normalize, scale, sub } from '../../ballistics/vec3.ts';

/** Zones whose end is a hand, foot or head: a cut far down them reads as a chunk, not a limb. */
const EXTREMITY_ZONES: ReadonlySet<GhoulZoneId> = new Set<GhoulZoneId>([
  'HAND_RIGHT', 'HAND_LEFT', 'FOOT_RIGHT', 'FOOT_LEFT', 'HEAD_CRANIUM', 'HEAD_FACE_JAW',
]);

/** How far from the bone a wound channel may pass and still be the one that cut it. */
const MAX_MISS_M = 0.09;

type CutBone = Pick<RagdollBoneState, 'position' | 'distalPosition' | 'basisRight' | 'basisUp' | 'basisForward'>;

export interface BoneCrossing {
  /** Fraction along the bone (unclamped) where the wound channel passes closest to it. */
  boneFraction: number;
  /** The point on the wound channel nearest the bone. */
  channelPoint: Vec3Like;
  /** Distance between the channel and the bone axis there. */
  missM: number;
}

/** Closest approach between the bone segment (proximal → distal) and a wound channel segment. */
export function findBoneCrossing(
  proximal: Vec3Like,
  distal: Vec3Like,
  entry: Vec3Like,
  exit: Vec3Like
): BoneCrossing {
  const d1 = sub(distal, proximal);
  const d2 = sub(exit, entry);
  const r = sub(proximal, entry);
  const a = lengthSq(d1);
  const e = lengthSq(d2);
  const f = dot(d2, r);
  let s = 0;
  let t = 0;
  if (a < 1e-10) {
    t = e > 1e-10 ? Math.min(1, Math.max(0, f / e)) : 0;
  } else {
    const c = dot(d1, r);
    if (e < 1e-10) {
      s = -c / a;
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > 1e-12 ? (b * f - c * e) / denom : 0;
      t = Math.min(1, Math.max(0, (b * s + f) / e));
      // Re-solve the bone parameter for the clamped channel point (bone is treated as a line).
      s = (b * t - c) / a;
    }
  }
  const onBone = add(proximal, scale(d1, s));
  const channelPoint = add(entry, scale(d2, t));
  const gap = sub(channelPoint, onBone);
  return { boneFraction: s, channelPoint, missM: Math.sqrt(lengthSq(gap)) };
}

function hashCut(zone: GhoulZoneId, p: Vec3Like): number {
  let h = 2166136261;
  for (let i = 0; i < zone.length; i++) h = Math.imul(h ^ zone.charCodeAt(i), 16777619);
  h = Math.imul(h ^ Math.round(p.x * 1000), 16777619);
  h = Math.imul(h ^ Math.round(p.y * 1000), 16777619);
  h = Math.imul(h ^ Math.round(p.z * 1000), 16777619);
  return h >>> 0;
}

function toBoneLocal(bone: CutBone, v: Vec3Like): Vec3Like {
  return { x: dot(v, bone.basisRight), y: dot(v, bone.basisUp), z: dot(v, bone.basisForward) };
}

/** Clamp range for the cut, as a fraction of the bone, so it never lands on the joint caps' turf. */
export function severCutFractionRange(zone: GhoulZoneId): { min: number; max: number } {
  return EXTREMITY_ZONES.has(zone) ? { min: 0.04, max: 0.45 } : { min: 0.06, max: 0.82 };
}

/**
 * Finds where the bullet that severed `zone` crossed its bone and describes the cut there.
 * Prefers the strongest unarmoured wound channel in the zone itself, then any channel that
 * passes close to the bone. Returns null when no channel came near it (the limb then parts
 * at its joint, as before).
 */
export function computeSeverCut(
  zone: GhoulZoneId,
  bone: CutBone,
  wounds: readonly WoundChannelEvent[]
): SeverCut | null {
  let best: { crossing: BoneCrossing; wound: WoundChannelEvent; score: number } | null = null;
  for (const wound of wounds) {
    if (wound.armorStopped) continue;
    const crossing = findBoneCrossing(bone.position, bone.distalPosition, wound.entryPointWorld, wound.exitPointWorld);
    if (crossing.missM > MAX_MISS_M) continue;
    const inZone = wound.ghoulZone === zone;
    if (!inZone && (crossing.boneFraction < -0.05 || crossing.boneFraction > 1.05)) continue;
    const score = wound.entryEnergyJ * (inZone ? 2 : 1) * (1 - crossing.missM / (MAX_MISS_M * 2));
    if (!best || score > best.score) best = { crossing, wound, score };
  }
  if (!best) return null;

  const range = severCutFractionRange(zone);
  const alongFraction = Math.min(range.max, Math.max(range.min, best.crossing.boneFraction));
  return {
    alongFraction,
    entryLocal: toBoneLocal(bone, sub(best.crossing.channelPoint, bone.position)),
    shotDirLocal: toBoneLocal(bone, normalize(best.wound.impactDirectionWorld)),
    seed: hashCut(zone, best.crossing.channelPoint),
  };
}

/** World-space point on the bone axis where a cut falls: the new stump position. */
export function severCutWorldPoint(bone: CutBone, cut: SeverCut): Vec3Like {
  return add(bone.position, scale(sub(bone.distalPosition, bone.position), cut.alongFraction));
}
