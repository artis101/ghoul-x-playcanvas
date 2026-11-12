import * as pc from 'playcanvas';
import type { GhoulZoneId } from '../../contracts/ballistics.ts';
import { GHOUL_ZONE_HIERARCHY } from '../../core/ghoul/anatomy.ts';
import type { BoneBindPose, CombatantGlbInstance } from '../assets/glbLoader.ts';
import type { EngineMaterialPalette } from '../materials.ts';
import type { StumpCap } from './types.ts';

/** Zones that can come away from the body, with a fallback limb radius where they join it. */
const CUT_RADIUS_M: Partial<Record<GhoulZoneId, number>> = {
  HEAD_CRANIUM: 0.055,
  NECK_CERVICAL: 0.055,
  UPPER_ARM_RIGHT: 0.055,
  UPPER_ARM_LEFT: 0.055,
  FOREARM_RIGHT: 0.045,
  FOREARM_LEFT: 0.045,
  HAND_RIGHT: 0.035,
  HAND_LEFT: 0.035,
  THIGH_RIGHT: 0.085,
  THIGH_LEFT: 0.085,
  KNEE_RIGHT: 0.065,
  KNEE_LEFT: 0.065,
  SHIN_RIGHT: 0.055,
  SHIN_LEFT: 0.055,
  FOOT_RIGHT: 0.05,
  FOOT_LEFT: 0.05,
};
const MIN_RADIUS_M = 0.03;
const MAX_RADIUS_M = 0.13;
// How far past the joint, along the bone, the two zone meshes can overlap.
const MAX_OVERLAP_M = 0.11;

interface CutSurvey {
  /** Limb radius just below the joint. */
  radius: number;
  /** Radius of the body's mesh where it ends at the joint. */
  bodyRadius: number;
  /** Where the body's mesh ends along the bone, measured from the joint. */
  bodyEnd: number;
  /** Where the limb's mesh begins along the bone, measured from the joint. */
  limbStart: number;
}

function forEachVertex(entity: pc.Entity | undefined, visit: (v: pc.Vec3) => void): void {
  const point = new pc.Vec3();
  const positions: number[] = [];
  for (const meshInstance of entity?.render?.meshInstances ?? []) {
    positions.length = 0;
    meshInstance.mesh?.getPositions?.(positions);
    for (let i = 0; i + 2 < positions.length; i += 3) {
      visit(point.set(positions[i], positions[i + 1], positions[i + 2]));
    }
  }
}

/** Measures the cut between a zone and its parent from the two zone meshes in the bind pose. */
function surveyCut(
  glb: CombatantGlbInstance,
  zone: GhoulZoneId,
  parent: GhoulZoneId,
  joint: pc.Vec3,
  axis: pc.Vec3,
  fallbackRadius: number
): CutSurvey {
  const offset = new pc.Vec3();
  const along = (v: pc.Vec3): number => offset.sub2(v, joint).dot(axis);
  const away = (v: pc.Vec3, t: number): number => Math.sqrt(Math.max(0, offset.lengthSq() - t * t));

  let radius = 0;
  forEachVertex(glb.zoneEntities.get(zone), (v) => {
    const t = along(v);
    if (t > -0.01 && t < 0.05) radius = Math.max(radius, away(v, t));
  });
  radius = radius > 0 ? pc.math.clamp(radius, MIN_RADIUS_M, MAX_RADIUS_M) : fallbackRadius;

  let limbStart = 0;
  forEachVertex(glb.zoneEntities.get(zone), (v) => {
    const t = along(v);
    if (away(v, t) < radius * 1.3) limbStart = Math.min(limbStart, t);
  });
  let bodyEnd = 0;
  forEachVertex(glb.zoneEntities.get(parent), (v) => {
    const t = along(v);
    if (t < MAX_OVERLAP_M && away(v, t) < radius * 1.3) bodyEnd = Math.max(bodyEnd, t);
  });
  // The body's mesh may taper toward the joint; the socket wound should not overhang it.
  let bodyRadius = 0;
  forEachVertex(glb.zoneEntities.get(parent), (v) => {
    const t = along(v);
    const r = away(v, t);
    if (t > bodyEnd - 0.03 && t <= bodyEnd && r < radius * 1.3) bodyRadius = Math.max(bodyRadius, r);
  });
  bodyRadius = bodyRadius > 0 ? pc.math.clamp(bodyRadius, MIN_RADIUS_M, radius) : radius;
  return { radius, bodyRadius, bodyEnd, limbStart: Math.max(limbStart, -MAX_OVERLAP_M) };
}

/** Raw flesh over the cut, with the end of the bone standing out of it along local +Y. */
function createCap(name: string, radius: number, materials: EngineMaterialPalette): pc.Entity {
  const root = new pc.Entity(name);
  const flesh = new pc.Entity('Flesh');
  flesh.addComponent('render', { type: 'sphere', material: materials.stumpFleshMat });
  flesh.setLocalScale(radius * 1.8, radius * 0.7, radius * 1.8);
  root.addChild(flesh);

  const bone = new pc.Entity('BoneEnd');
  bone.addComponent('render', { type: 'cylinder', material: materials.exposedBoneMat });
  bone.setLocalScale(radius * 0.42, radius * 0.6, radius * 0.42);
  bone.setLocalPosition(0, radius * 0.4, 0);
  root.addChild(bone);
  root.enabled = false;
  return root;
}

/** Parents `cap` to a bone so it sits at a model-space point, facing along a model-space rotation. */
function seat(cap: pc.Entity, boneNode: pc.GraphNode, bind: BoneBindPose, position: pc.Vec3, rotation: pc.Quat): void {
  const toBone = new pc.Quat().copy(bind.modelRot).invert();
  boneNode.addChild(cap);
  cap.setLocalPosition(toBone.transformVector(new pc.Vec3().sub2(position, bind.modelPos)));
  cap.setLocalRotation(new pc.Quat().mul2(toBone, rotation));
}

/**
 * Builds the wound caps for every zone that can be severed: one on the body where the limb
 * came off and one on the end of the limb. Each is fitted to the zone meshes at the joint and
 * rides on the skeleton, so it stays on the cut in any pose.
 */
export function buildStumpCaps(
  glb: CombatantGlbInstance,
  materials: EngineMaterialPalette
): Map<GhoulZoneId, StumpCap> {
  const caps = new Map<GhoulZoneId, StumpCap>();
  const flip = new pc.Quat().setFromEulerAngles(180, 0, 0);
  for (const zone of Object.keys(CUT_RADIUS_M) as GhoulZoneId[]) {
    const parent = GHOUL_ZONE_HIERARCHY[zone].parent;
    const bind = glb.boneBindPoses?.get(zone);
    const node = glb.boneNodes?.get(zone);
    const parentBind = parent && glb.boneBindPoses?.get(parent);
    const parentNode = parent && glb.boneNodes?.get(parent);
    if (!parent || !bind || !node || !parentBind || !parentNode) continue;

    const axis = bind.modelRot.transformVector(pc.Vec3.UP, new pc.Vec3());
    const cut = surveyCut(glb, zone, parent, bind.modelPos, axis, CUT_RADIUS_M[zone]!);
    const lift = cut.radius * 0.15;

    const socket = createCap(`${zone}_SocketCap`, cut.bodyRadius, materials);
    const socketAt = new pc.Vec3().copy(axis).mulScalar(cut.bodyEnd - lift).add(bind.modelPos);
    seat(socket, parentNode, parentBind, socketAt, bind.modelRot);

    const limb = createCap(`${zone}_LimbCap`, cut.radius, materials);
    const limbAt = new pc.Vec3().copy(axis).mulScalar(cut.limbStart + lift).add(bind.modelPos);
    seat(limb, node, bind, limbAt, new pc.Quat().mul2(bind.modelRot, flip));

    caps.set(zone, { zone, parent, socket, limb });
  }
  return caps;
}
