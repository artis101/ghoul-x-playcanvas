import type {
  DismembermentEvent,
  GhoulZoneId,
  ShotSimulationReport,
  TargetHealthState,
  Vec3Like,
  WoundChannelEvent,
} from '../../contracts/ballistics.ts';
import { add, copyVec3, distance, length, normalize, scale, sub, vec3 } from '../../core/ballistics/vec3.ts';
import { GHOUL_ZONE_HIERARCHY, getSubtreeZones } from '../../core/ghoul/anatomy.ts';

export function buildFragBlastReportForTarget(
  hs: TargetHealthState,
  blastCenter: Vec3Like,
  distM: number,
  blastRadiusM: number,
  peakImpulseNs: number,
  peakEnergyJ: number
): ShotSimulationReport {
  const falloff = Math.pow(Math.max(0.05, 1 - distM / blastRadiusM), 1.3);
  const pelvisPos = hs.ragdollBones.PELVIS_GROIN.position;
  const rawDelta = sub(pelvisPos, blastCenter);
  const horizDelta = vec3(rawDelta.x, 0, rawDelta.z);
  const horizDir = length(horizDelta) > 1e-3 ? normalize(horizDelta) : vec3(0, 0, -1);
  const blastDir = normalize(vec3(horizDir.x, 0.18, horizDir.z));

  const energyScale = Math.min(2.2, Math.max(1.0, peakEnergyJ / 4400.0));
  const totalDamageHp = 245.0 * falloff * (0.75 + 0.25 * energyScale);
  const totalEnergyJ = peakEnergyJ * falloff;
  const isCloseLethal = distM < 3.5;
  const isLethalKill = isCloseLethal || totalDamageHp >= hs.currentHp;

  const exposedZones: GhoulZoneId[] = [
    'TORSO_LOWER_ABDOMEN',
    'TORSO_UPPER_THORAX',
    'THIGH_LEFT',
    'THIGH_RIGHT',
    'SHIN_LEFT',
    'SHIN_RIGHT',
    'KNEE_LEFT',
    'KNEE_RIGHT',
  ];
  const woundEvents: WoundChannelEvent[] = [];
  const zoneImpulses: Partial<Record<GhoulZoneId, Vec3Like>> = {};

  const shrapnelZones = exposedZones
    .filter((z) => !hs.severedZones.has(z))
    .sort((a, b) => distance(blastCenter, hs.ragdollBones[a].position) - distance(blastCenter, hs.ragdollBones[b].position))
    .slice(0, distM < 4.2 ? 5 : 3);

  for (const z of shrapnelZones) {
    const bonePos = hs.ragdollBones[z].position;
    const segDir = normalize(sub(bonePos, blastCenter));
    const wEnergy = (totalEnergyJ / Math.max(1, shrapnelZones.length)) * 0.45;
    const wImpulse = (peakImpulseNs * falloff) / Math.max(1, shrapnelZones.length);

    zoneImpulses[z] = scale(segDir, wImpulse * 0.55);

    woundEvents.push({
      colliderId: `frag_shrapnel_${z}`,
      label: GHOUL_ZONE_HIERARCHY[z].label,
      ghoulZone: z,
      layerType: 'SOFT_FLESH',
      entryPointWorld: copyVec3(bonePos),
      exitPointWorld: add(bonePos, scale(segDir, 0.08)),
      entryNormalWorld: scale(segDir, -1),
      localEntryOffset: vec3(0, 0, 0.03),
      localExitOffset: vec3(0, 0, -0.03),
      impactDirectionWorld: segDir,
      pathLengthM: 0.08,
      entryVelocityMs: Math.max(240, 620 * falloff),
      exitVelocityMs: 0,
      entryEnergyJ: wEnergy,
      exitEnergyJ: 0,
      energyDepositedJ: wEnergy,
      impulseTransferredNs: wImpulse,
      permanentCavityRadiusCm: 2.2 * falloff + 0.6,
      temporaryStretchCavityRadiusCm: 5.5 * falloff,
      armorStopped: false,
      bluntTraumaJ: 0,
      boneFractured: distM < 4.8,
      boneShattered: distM < 3.2,
      organRuptured: distM < 3.2 && (z === 'TORSO_LOWER_ABDOMEN' || z === 'TORSO_UPPER_THORAX'),
      limbSensoryShock: true,
      limbSevered: false,
      arterialSevered: distM < 3.8,
      deflectionAngleDeg: 0,
      physiologicalEffect: 'High-explosive fragmentation trauma',
    });
  }

  const dismembermentEvents: DismembermentEvent[] = [];
  const newlySeveredZones: GhoulZoneId[] = [];

  if (distM < 3.4) {
    const candidateLimbs: GhoulZoneId[] = distM < 2.2 ? ['KNEE_LEFT', 'SHIN_RIGHT', 'FOREARM_LEFT'] : ['SHIN_LEFT', 'SHIN_RIGHT'];
    const maxSevers = distM < 2.2 ? 2 : 1;

    for (const limbZone of candidateLimbs) {
      if (dismembermentEvents.length >= maxSevers) break;
      if (hs.severedZones.has(limbZone)) continue;

      const bone = hs.ragdollBones[limbZone];
      const subtree = getSubtreeZones(limbZone);
      for (const sz of subtree) newlySeveredZones.push(sz);

      const limbOut = normalize(add(sub(bone.position, blastCenter), vec3(0, 0.65, 0)));
      dismembermentEvents.push({
        zone: limbZone,
        parentZone: GHOUL_ZONE_HIERARCHY[limbZone].parent,
        goreMode: 'CLEAN_SEVER',
        detachedSubtree: subtree,
        stumpWorldPosition: copyVec3(bone.position),
        arterialSprayDirection: scale(limbOut, -1),
        severedLimbVelocity: scale(limbOut, 5.8 + Math.random() * 2.4),
        severedLimbAngularVelocity: vec3((Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18),
        gibCount: 7,
      });
    }

    if (distM < 2.3 && hs.zoneGoreMode.TORSO_LOWER_ABDOMEN !== 'EVISCERATED') {
      const gutPos = hs.ragdollBones.TORSO_LOWER_ABDOMEN.position;
      dismembermentEvents.push({
        zone: 'TORSO_LOWER_ABDOMEN',
        parentZone: 'PELVIS_GROIN',
        goreMode: 'EVISCERATED',
        detachedSubtree: [],
        stumpWorldPosition: copyVec3(gutPos),
        arterialSprayDirection: copyVec3(blastDir),
        severedLimbVelocity: scale(blastDir, 4.2),
        severedLimbAngularVelocity: vec3(6, 4, -5),
        gibCount: 9,
      });
    }
  }

  const willEnableRagdoll = hs.isRagdollActive || isLethalKill || distM < 5.8;
  const netRootImpulseWorld = scale(blastDir, peakImpulseNs * falloff * 0.68);
  const primaryHitZone: GhoulZoneId = shrapnelZones[0] || 'TORSO_LOWER_ABDOMEN';

  return {
    shotId: `frag_${Date.now()}_${hs.targetId}`,
    weaponId: 'm67_frag_grenade',
    ammoId: 'comp_b_shrapnel',
    originWorld: copyVec3(blastCenter),
    aimDirectionWorld: blastDir,
    targetDistanceM: distM,
    pelletCount: shrapnelZones.length,
    muzzleEnergyJ: peakEnergyJ,
    impactSpeedMs: Math.max(240, 650 * falloff),
    impactEnergyJ: totalEnergyJ,
    flightTimeAtImpactS: 0,
    bulletDropAtImpactCm: 0,
    windDriftAtImpactCm: 0,
    hitTarget: true,
    targetId: hs.targetId,
    pelletResults: [],
    woundEvents,
    totalEnergyDepositedJ: totalEnergyJ,
    totalDamageHp,
    isLethalKill,
    ragdollPlan: {
      willEnableRagdoll,
      activationTimeS: 0,
      primaryHitZone,
      netRootImpulseWorld,
      launchLiftVelocityMs: Math.min(0.45, 0.55 * falloff),
      estimatedLaunchDistanceM: 2.2 * falloff,
      zoneImpulses,
      netTorqueWorld: vec3(blastDir.z * -45 * falloff, 18 * falloff, blastDir.x * 45 * falloff),
      dismembermentEvents,
    },
    triggerXRayKillCam: false,
    xRayFocusZone: primaryHitZone,
    xRayHighlightPointWorld: copyVec3(pelvisPos),
    severedZones: newlySeveredZones,
    dismembermentEvents,
    shatteredBones: distM < 3.8 ? ['Tibia & Fibula (Blast Fracture)'] : [],
    rupturedOrgans: distM < 3.2 ? ['Pulmonary Blast Overpressure'] : [],
    combatantEffects: ['HE FRAGMENTATION BLAST'],
    headgearKnockedOff: distM < 5.6,
    weaponDisarmed: distM < 6.0,
    trajectorySamples: [],
  };
}
