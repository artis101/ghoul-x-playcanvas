import {
  AmmoSpec,
  DismembermentEvent,
  GhoulZoneId,
  GoreMode,
  TargetHealthState,
  Vec3Like,
  WeaponSpec,
  WoundChannelEvent,
} from '../../../contracts/ballistics.ts';
import { GHOUL_ZONE_HIERARCHY, getSubtreeZones } from '../../ghoul/anatomy.ts';
import {
  add,
  copyVec3,
  distance,
  dot,
  length,
  lengthSq,
  normalize,
  scale,
  sub,
  vec3,
} from '../vec3.ts';
import { ALL_ANATOMICAL_COLLIDERS } from '../math/restBoneBases.ts';

const JOINT_SEVER_SPECS: Array<{
  severZone: GhoulZoneId;
  jointPivotZone: GhoulZoneId;
  radiusM: number;
  label: string;
  relatedZones: GhoulZoneId[];
}> = [
  { severZone: 'HAND_LEFT', jointPivotZone: 'HAND_LEFT', radiusM: 0.085, label: 'Left Wrist Joint', relatedZones: ['HAND_LEFT', 'FOREARM_LEFT'] },
  { severZone: 'HAND_RIGHT', jointPivotZone: 'HAND_RIGHT', radiusM: 0.085, label: 'Right Wrist Joint', relatedZones: ['HAND_RIGHT', 'FOREARM_RIGHT'] },
  { severZone: 'FOREARM_LEFT', jointPivotZone: 'FOREARM_LEFT', radiusM: 0.085, label: 'Left Elbow Joint', relatedZones: ['FOREARM_LEFT', 'UPPER_ARM_LEFT'] },
  { severZone: 'FOREARM_RIGHT', jointPivotZone: 'FOREARM_RIGHT', radiusM: 0.085, label: 'Right Elbow Joint', relatedZones: ['FOREARM_RIGHT', 'UPPER_ARM_RIGHT'] },
  { severZone: 'UPPER_ARM_LEFT', jointPivotZone: 'UPPER_ARM_LEFT', radiusM: 0.088, label: 'Left Shoulder Joint', relatedZones: ['UPPER_ARM_LEFT', 'SHOULDER_LEFT'] },
  { severZone: 'UPPER_ARM_RIGHT', jointPivotZone: 'UPPER_ARM_RIGHT', radiusM: 0.088, label: 'Right Shoulder Joint', relatedZones: ['UPPER_ARM_RIGHT', 'SHOULDER_RIGHT'] },
  { severZone: 'FOOT_LEFT', jointPivotZone: 'FOOT_LEFT', radiusM: 0.085, label: 'Left Ankle Joint', relatedZones: ['FOOT_LEFT', 'SHIN_LEFT'] },
  { severZone: 'FOOT_RIGHT', jointPivotZone: 'FOOT_RIGHT', radiusM: 0.085, label: 'Right Ankle Joint', relatedZones: ['FOOT_RIGHT', 'SHIN_RIGHT'] },
  { severZone: 'KNEE_LEFT', jointPivotZone: 'KNEE_LEFT', radiusM: 0.092, label: 'Left Knee Joint', relatedZones: ['KNEE_LEFT', 'THIGH_LEFT', 'SHIN_LEFT'] },
  { severZone: 'KNEE_RIGHT', jointPivotZone: 'KNEE_RIGHT', radiusM: 0.092, label: 'Right Knee Joint', relatedZones: ['KNEE_RIGHT', 'THIGH_RIGHT', 'SHIN_RIGHT'] },
  { severZone: 'THIGH_LEFT', jointPivotZone: 'THIGH_LEFT', radiusM: 0.090, label: 'Left Hip Joint', relatedZones: ['THIGH_LEFT', 'PELVIS_GROIN'] },
  { severZone: 'THIGH_RIGHT', jointPivotZone: 'THIGH_RIGHT', radiusM: 0.090, label: 'Right Hip Joint', relatedZones: ['THIGH_RIGHT', 'PELVIS_GROIN'] },
  { severZone: 'NECK_CERVICAL', jointPivotZone: 'NECK_CERVICAL', radiusM: 0.078, label: 'Cervical Neck Joint', relatedZones: ['NECK_CERVICAL'] },
];

function pointToSegmentDist(pt: Vec3Like, a: Vec3Like, b: Vec3Like): number {
  const ab = sub(b, a);
  const lenSq = lengthSq(ab);
  if (lenSq < 1e-8) return distance(pt, a);
  const t = Math.max(0, Math.min(1, dot(sub(pt, a), ab) / lenSq));
  return distance(pt, add(a, scale(ab, t)));
}

export function evaluateJointDismemberment(
  weapon: WeaponSpec,
  ammo: AmmoSpec,
  target: TargetHealthState,
  targetDistanceM: number,
  normAimDir: Vec3Like,
  allWoundEvents: WoundChannelEvent[],
  zoneEnergyDeposited: Partial<Record<GhoulZoneId, number>>,
  zoneImpulses: Partial<Record<GhoulZoneId, Vec3Like>>,
  severedZonesSet: Set<GhoulZoneId>,
  newlySeveredZones: GhoulZoneId[],
  dismembermentEvents: DismembermentEvent[],
  combatantEffectsSet: Set<string>
): { weaponDisarmed: boolean } {
  let weaponDisarmed = false;

  const isHeavyOrSurgicalCapable =
    ammo.diameterM >= 0.007 &&
    ((ammo.type === 'BUCKSHOT_00' && targetDistanceM <= 6.5) ||
      (ammo.id === '12G_FLECHETTE_SLUG' && targetDistanceM <= 18.0) ||
      (weapon.role === 'HEAVY_PISTOL' && ammo.diameterM >= 0.012 && targetDistanceM <= 9.0) ||
      (weapon.role === 'SNIPER' && targetDistanceM <= 55.0));

  if (!isHeavyOrSurgicalCapable) {
    return { weaponDisarmed };
  }

  const isPointBlank12G = weapon.role === 'SHOTGUN' && targetDistanceM <= 3.6;
  const isCloseHighImpactLimbBlast =
    (weapon.role === 'SHOTGUN' && targetDistanceM <= 4.6) ||
    (ammo.id === '12G_FLECHETTE_SLUG' && targetDistanceM <= 5.5) ||
    (weapon.role === 'HEAVY_PISTOL' && ammo.diameterM >= 0.012 && targetDistanceM <= 2.8);

  const jointHitBonusByZone: Partial<Record<GhoulZoneId, { maxEntryJ: number; label: string }>> = {};
  if (allWoundEvents.length > 0) {
    for (const jSpec of JOINT_SEVER_SPECS) {
      const pivotPos = target.ragdollBones[jSpec.jointPivotZone].position;
      let maxEntryJ = 0;
      let matched = false;
      for (const we of allWoundEvents) {
        if (we.armorStopped || !jSpec.relatedZones.includes(we.ghoulZone)) continue;
        const d = pointToSegmentDist(pivotPos, we.entryPointWorld, we.exitPointWorld);
        if (d <= jSpec.radiusM) {
          matched = true;
          if (we.entryEnergyJ > maxEntryJ) maxEntryJ = we.entryEnergyJ;
        }
      }
      if (matched) {
        const isThickSocket =
          jSpec.severZone === 'THIGH_LEFT' ||
          jSpec.severZone === 'THIGH_RIGHT' ||
          jSpec.severZone === 'UPPER_ARM_LEFT' ||
          jSpec.severZone === 'UPPER_ARM_RIGHT' ||
          jSpec.severZone === 'NECK_CERVICAL';
        if (weapon.role === 'HEAVY_PISTOL' && isThickSocket && targetDistanceM > 6.0) {
          continue;
        }
        jointHitBonusByZone[jSpec.severZone] = { maxEntryJ, label: jSpec.label };
        if (zoneEnergyDeposited[jSpec.severZone] === undefined) {
          zoneEnergyDeposited[jSpec.severZone] = 0;
        }
      }
    }
  }

  const rawCandidates = Object.keys(zoneEnergyDeposited) as GhoulZoneId[];
  // Evaluate cranium/jaw before cervical neck so point-blank skull blasts pop the cranium cleanly
  const candidateZones = rawCandidates.sort((a, b) => {
    const aHead = a === 'HEAD_CRANIUM' || a === 'HEAD_FACE_JAW' ? 0 : 1;
    const bHead = b === 'HEAD_CRANIUM' || b === 'HEAD_FACE_JAW' ? 0 : 1;
    return aHead - bHead;
  });

  for (const zone of candidateZones) {
    if (severedZonesSet.has(zone)) continue;
    if (zone === 'NECK_CERVICAL' && (severedZonesSet.has('HEAD_CRANIUM') || severedZonesSet.has('HEAD_FACE_JAW'))) {
      continue;
    }

    const shotGoreEnergy = zoneEnergyDeposited[zone] || 0;
    const jointHit = jointHitBonusByZone[zone];

    if (zone === 'HEAD_CRANIUM' || zone === 'HEAD_FACE_JAW') {
      const canPopSkull =
        (weapon.role === 'SHOTGUN' && targetDistanceM <= 5.5) ||
        (weapon.role === 'HEAVY_PISTOL' && ammo.diameterM >= 0.012 && targetDistanceM <= 5.6) ||
        (weapon.role === 'SNIPER' && ammo.tissueExpansionFactor >= 1.4 && targetDistanceM <= 11.5);
      if (!canPopSkull) continue;
    } else if (zone === 'TORSO_LOWER_ABDOMEN') {
      if (!isPointBlank12G) continue;
    } else {
      // Earned reward rule: limb & neck amputations require EITHER a surgical joint/neck hit
      // OR a close-distance high-impact blast (no accidental mid-range cumulative chip amputations)
      if (!jointHit && !isCloseHighImpactLimbBlast) continue;
    }

    const refCol = ALL_ANATOMICAL_COLLIDERS.find(
      (c) => c.ghoulZone === zone && c.layerType !== 'ARMOR_KEVLAR'
    );
    const severThreshold = refCol ? refCol.severThresholdJ : 9999;

    let effectiveShotGoreJ = shotGoreEnergy;
    if (jointHit) {
      let jointRelatedGoreJ = shotGoreEnergy;
      for (const we of allWoundEvents) {
        if (!we.armorStopped && distance(we.entryPointWorld, target.ragdollBones[zone].position) <= 0.12) {
          jointRelatedGoreJ += we.energyDepositedJ * ammo.goreFactor * 0.65;
        }
      }
      effectiveShotGoreJ = jointRelatedGoreJ * 1.85 + jointHit.maxEntryJ * 0.34;
    } else if (isCloseHighImpactLimbBlast && zone !== 'HEAD_CRANIUM' && zone !== 'HEAD_FACE_JAW') {
      effectiveShotGoreJ = shotGoreEnergy * 1.12;
    }

    if (effectiveShotGoreJ >= severThreshold && !severedZonesSet.has(zone)) {
      const blastDir = normalize(normAimDir);
      const boneState = target.ragdollBones[zone];
      const stumpWorld = copyVec3(boneState.position);

      if (zone === 'TORSO_LOWER_ABDOMEN') {
        if (target.zoneGoreMode.TORSO_LOWER_ABDOMEN !== 'EVISCERATED') {
          combatantEffectsSet.add('GHOUL Gut Evisceration — Massive Abdominal Trauma');
          dismembermentEvents.push({
            zone,
            parentZone: 'PELVIS_GROIN',
            goreMode: 'EVISCERATED',
            detachedSubtree: [],
            stumpWorldPosition: stumpWorld,
            arterialSprayDirection: scale(blastDir, -0.6),
            severedLimbVelocity: scale(blastDir, 6.0),
            severedLimbAngularVelocity: vec3(4, 3, -4),
            gibCount: 7,
          });
        }
        continue;
      }

      let goreMode: GoreMode = 'CLEAN_SEVER';
      let gibCount = 4;
      if (zone === 'HEAD_CRANIUM' || zone === 'HEAD_FACE_JAW') {
        goreMode = 'CRANIAL_POP';
        gibCount = 14;
        combatantEffectsSet.add('GHOUL Cranial Pop — Catastrophic Head Obliteration');
      } else if (zone === 'NECK_CERVICAL') {
        gibCount = 8;
        combatantEffectsSet.add('CERVICAL DECAPITATION — Head Severed Clean Off');
        if (jointHit) {
          combatantEffectsSet.add(`JOINT SHATTERED — ${jointHit.label} Severed`);
        }
      } else if (jointHit) {
        combatantEffectsSet.add(`JOINT SHATTERED — ${jointHit.label} Severed`);
      } else {
        combatantEffectsSet.add(`GHOUL Clean Sever — ${GHOUL_ZONE_HIERARCHY[zone].label} Amputated`);
      }

      const isArm =
        zone === 'HAND_LEFT' || zone === 'HAND_RIGHT' ||
        zone === 'UPPER_ARM_LEFT' || zone === 'FOREARM_LEFT' ||
        zone === 'UPPER_ARM_RIGHT' || zone === 'FOREARM_RIGHT';
      if (isArm) weaponDisarmed = true;

      const detachedSubtree = getSubtreeZones(zone);
      for (const det of detachedSubtree) {
        severedZonesSet.add(det);
        if (!newlySeveredZones.includes(det)) newlySeveredZones.push(det);
      }

      const hierNode = GHOUL_ZONE_HIERARCHY[zone];
      const zoneImpulse = zoneImpulses[zone] || scale(blastDir, 22);
      const limbSpeed = Math.min(11.0, Math.max(3.8, length(zoneImpulse) / (hierNode.defaultMassKg + 1.1)));
      const upwardLift = zone === 'NECK_CERVICAL' ? 2.75 + Math.random() * 1.1 : 1.6 + Math.random() * 1.4;
      const limbVelocity = add(
        scale(blastDir, zone === 'NECK_CERVICAL' ? Math.min(8.5, limbSpeed) : limbSpeed),
        vec3((Math.random() - 0.5) * 1.4, upwardLift, (Math.random() - 0.5) * 1.4)
      );
      const limbSpin =
        zone === 'NECK_CERVICAL'
          ? vec3(8.5, (Math.random() - 0.5) * 10, -6.5)
          : vec3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);

      const parentZone = hierNode.parent;
      const sprayDir = parentZone
        ? normalize(add(sub(boneState.position, target.ragdollBones[parentZone].position), vec3(0, 0.35, 0)))
        : vec3(0, 1, 0);

      dismembermentEvents.push({
        zone,
        parentZone,
        goreMode,
        detachedSubtree,
        stumpWorldPosition: stumpWorld,
        arterialSprayDirection: sprayDir,
        severedLimbVelocity: limbVelocity,
        severedLimbAngularVelocity: limbSpin,
        gibCount,
      });

      for (const we of allWoundEvents) {
        if (we.ghoulZone === zone) we.limbSevered = true;
      }
    }
  }

  return { weaponDisarmed };
}
