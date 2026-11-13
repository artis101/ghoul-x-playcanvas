import { describe, expect, it } from 'vitest';
import { AmmoSpec } from '../src/contracts/ballistics.ts';
import { PHYSIOLOGY_CONSTANTS } from '../src/contracts/physiology.ts';
import { marchInternalBallistics } from '../src/core/ballistics/rayMarchTerminal.ts';
import { normalize, sub, vec3 } from '../src/core/ballistics/vec3.ts';
import {
  AMMO_50AE_JHP,
  AMMO_556_NATO_M855,
  AMMO_762_NATO_AP_TUNGSTEN,
  AMMO_762_NATO_M118LR,
} from '../src/core/ballistics/weapons.ts';
import { getDefaultAnatomicalBvh } from '../src/core/ghoul/bvhVolumes.ts';
import { PhysiologyEcsSystem } from '../src/core/physiology/physiologySystem.ts';
import * as pc from 'playcanvas';
import { getOrCreateMaterials } from '../src/engine/materials.ts';
import {
  createVascularBloodMaterials,
  evaluateSystolicPulseWave,
  VascularBloodFxEmitter,
} from '../src/engine/gore/vascularBloodFx.ts';

const PISTOL_9MM_FMJ: AmmoSpec = {
  id: '9MM_NATO_FMJ',
  name: '9x19mm 124gr FMJ Sub-Threshold Elastic Test Load',
  caliber: '9x19mm',
  type: 'FMJ',
  massKg: 0.00804,
  diameterM: 0.009,
  muzzleVelocityMs: 365,
  dragCoefficient: 0.34,
  tissueExpansionFactor: 1.05,
  armorPenetrationFactor: 0.85,
  pelletCount: 1,
  spreadRadians: 0.002,
  ragdollImpulseMultiplier: 0.8,
  goreFactor: 0.85,
};

describe('4-Stage Anatomical BVH Ray-Marching & Decoupled 8Hz Physiological ECS Suite', () => {
  describe('1. Tier-1 Exact ESAPI Plate Geometry vs Axillary (Armpit) & Supraclavicular (Collarbone) Gaps', () => {
    it('stops center-mass JHP & rifle ball on FRONT_ESAPI_PLATE while armpit (x=0.16) and collarbone (y=1.49) shots bypass armor and lacerate lung/subclavian artery', () => {
      const bvh = getDefaultAnatomicalBvh();

      // A. Center-mass .50 AE JHP into front thoracic ESAPI strike face (x=0, y=1.33)
      const centerJhp = marchInternalBallistics(
        {
          ammo: AMMO_50AE_JHP,
          rayOriginWorld: vec3(0, 1.33, 1.2),
          rayDirectionWorld: vec3(0, 0, -1),
          impactVelocityMs: AMMO_50AE_JHP.muzzleVelocityMs,
          config: { enableArmorPlates: true, enableHelmet: true },
        },
        bvh
      );
      expect(centerJhp.stoppedByArmorPlate).toBe('FRONT_ESAPI_PLATE');
      expect(centerJhp.armorBackfaceBluntTraumaJ).toBeGreaterThan(100);
      expect(centerJhp.organTrauma).toHaveLength(0);
      expect(centerJhp.vascularWounds).toHaveLength(0);
      expect(centerJhp.plateIntegrityAfter.FRONT_ESAPI_PLATE).toBeLessThan(1.0);

      // B. Center-mass 5.56mm M855 ball into intact Level IV ceramic ESAPI strike face
      const centerBall = marchInternalBallistics(
        {
          ammo: AMMO_556_NATO_M855,
          rayOriginWorld: vec3(0.02, 1.32, 1.2),
          rayDirectionWorld: vec3(0, 0, -1),
          impactVelocityMs: 880,
          config: { enableArmorPlates: true, enableHelmet: true },
        },
        bvh
      );
      expect(centerBall.stoppedByArmorPlate).toBe('FRONT_ESAPI_PLATE');
      expect(centerBall.organTrauma).toHaveLength(0);

      // C. Axillary / Armpit gap shot at x = 0.16, y = 1.41 bypassing FRONT_ESAPI_PLATE (|x| <= 0.125)
      const armpitReport = marchInternalBallistics(
        {
          ammo: AMMO_556_NATO_M855,
          rayOriginWorld: vec3(0.16, 1.41, 0.8),
          rayDirectionWorld: vec3(0, 0, -1),
          impactVelocityMs: 890,
          config: { enableArmorPlates: true, enableHelmet: true },
        },
        bvh
      );
      expect(armpitReport.stoppedByArmorPlate).toBeNull();
      expect(armpitReport.armorPlatesIntersected).toHaveLength(0);
      expect(armpitReport.organTrauma.some((o) => o.organId === 'LUNG_LEFT')).toBe(true);
      expect(armpitReport.vascularWounds.some((v) => v.vesselId === 'SUBCLAVIAN_LEFT')).toBe(true);

      // D. Supraclavicular / Collarbone gap shot at y = 1.49 (above ESAPI top edge y = 1.46!)
      const collarReport = marchInternalBallistics(
        {
          ammo: AMMO_556_NATO_M855,
          rayOriginWorld: vec3(0.08, 1.49, 1.0),
          rayDirectionWorld: vec3(0, 0, -1),
          impactVelocityMs: 890,
          config: { enableArmorPlates: true, enableHelmet: true },
        },
        bvh
      );
      expect(collarReport.stoppedByArmorPlate).toBeNull();
      expect(collarReport.organTrauma.some((o) => o.organId === 'LUNG_LEFT')).toBe(true);
      expect(collarReport.vascularWounds.some((v) => v.vesselId === 'SUBCLAVIAN_LEFT')).toBe(true);
    });
  });

  describe('2. Caliber-Specific 5.56mm High-Velocity Spitzer Yaw & Fragmentation vs 7.62mm AP Ice-Picking', () => {
    it('models 5.56mm narrow ~10–14cm entry neck followed by violent 90°+ yaw & jacket fragmentation vs 7.62 AP straight penetration', () => {
      // Unarmored soft-tissue abdominal/thoracic path avoiding spine (x = -0.08, y = 1.08)
      const rayOrigin = vec3(-0.08, 1.08, 0.8);
      const rayDir = vec3(0, 0, -1);

      const m855Report = marchInternalBallistics({
        ammo: AMMO_556_NATO_M855,
        rayOriginWorld: rayOrigin,
        rayDirectionWorld: rayDir,
        impactVelocityMs: 905,
        config: { enableArmorPlates: false, enableHelmet: false },
      });

      expect(m855Report.hitOuterShell).toBe(true);
      expect(m855Report.narrowNeckDepthCm).not.toBeNull();
      expect(m855Report.narrowNeckDepthCm!).toBeGreaterThanOrEqual(9.5);
      expect(m855Report.narrowNeckDepthCm!).toBeLessThanOrEqual(14.5);
      expect(m855Report.peakYawAngleDeg).toBeGreaterThanOrEqual(90);

      // Early steps (< 9 cm) must have narrow permanent crush cavity & modest energy loss compared to yaw peak (13–18 cm)
      const earlySteps = m855Report.steps.filter((s) => s.depthCm <= 8.5);
      const yawPeakSteps = m855Report.steps.filter((s) => s.depthCm >= 13.0 && s.depthCm <= 19.0);
      expect(earlySteps.length).toBeGreaterThan(3);
      expect(yawPeakSteps.length).toBeGreaterThan(2);

      const avgEarlyCrushM =
        earlySteps.reduce((acc, s) => acc + s.crushRadiusM, 0) / earlySteps.length;
      const maxYawCrushM = Math.max(...yawPeakSteps.map((s) => s.crushRadiusM));
      expect(avgEarlyCrushM).toBeLessThan(0.005);
      expect(maxYawCrushM).toBeGreaterThan(avgEarlyCrushM * 2.5);

      const avgEarlyStepEnergyJ =
        earlySteps.reduce((acc, s) => acc + s.energyDepositedStepJ, 0) / earlySteps.length;
      const maxYawStepEnergyJ = Math.max(...yawPeakSteps.map((s) => s.energyDepositedStepJ));
      expect(maxYawStepEnergyJ).toBeGreaterThan(avgEarlyStepEnergyJ * 3.5);

      const jacketFrags = m855Report.secondaryFragments.filter(
        (f) => f.kind === 'JACKET_FRAGMENT'
      );
      expect(jacketFrags.length).toBeGreaterThanOrEqual(2);
      expect(jacketFrags.length).toBeLessThanOrEqual(4);

      // Contrast with 7.62x51mm M993 Tungsten AP sub-caliber penetrator along the exact same path
      const ap762Report = marchInternalBallistics({
        ammo: AMMO_762_NATO_AP_TUNGSTEN,
        rayOriginWorld: rayOrigin,
        rayDirectionWorld: rayDir,
        impactVelocityMs: 830,
        config: { enableArmorPlates: false, enableHelmet: false },
      });

      expect(ap762Report.overPenetrated).toBe(true);
      expect(ap762Report.peakYawAngleDeg).toBeLessThan(15);
      expect(
        ap762Report.secondaryFragments.filter((f) => f.kind === 'JACKET_FRAGMENT')
      ).toHaveLength(0);
      expect(ap762Report.exitVelocityMs).toBeGreaterThan(680);
    });
  });

  describe('3. Cortical Bone Fracture, Secondary Bone Shards & Biomechanical Motor Flags', () => {
    it('fractures cortical femur, spawns secondary bone shards in 12°–22° cone, drops target to PRONE_CRAWL while keeping trigger functional', () => {
      const ecs = new PhysiologyEcsSystem(8);
      ecs.registerEntity({
        entityId: 'rifleman_femur',
        alertnessState: 'COMBAT_ALERT',
        dominantHand: 'LEFT',
        enableArmorPlates: true,
      });

      // Strike left femur shaft directly (local x = 0.119, y = 0.70)
      const femurReport = marchInternalBallistics({
        ammo: AMMO_762_NATO_M118LR,
        rayOriginWorld: vec3(0.119, 0.70, 0.9),
        rayDirectionWorld: vec3(0, 0, -1),
        impactVelocityMs: 790,
      });

      const femurRecord = femurReport.boneTrauma.find((b) => b.boneId === 'FEMUR_LEFT');
      expect(femurRecord).toBeDefined();
      expect(femurRecord!.fractured).toBe(true);
      expect(femurRecord!.deflectionAngleDeg).toBeGreaterThan(0);

      const boneShards = femurReport.secondaryFragments.filter(
        (f) => f.kind === 'CORTICAL_BONE_SHARD' && f.sourceBoneId === 'FEMUR_LEFT'
      );
      expect(boneShards.length).toBeGreaterThanOrEqual(1);
      expect(boneShards.length).toBeLessThanOrEqual(3);
      for (const shard of boneShards) {
        expect(shard.coneAngleDeg).toBeGreaterThanOrEqual(12);
        expect(shard.coneAngleDeg).toBeLessThanOrEqual(22);
      }

      const state = ecs.applyBallisticTrauma('rifleman_femur', femurReport);
      expect(state.canStand).toBe(false);
      expect(state.leftLegFunctional).toBe(false);
      expect(state.locomotionMode).toBe('PRONE_CRAWL');
      expect(state.leftArmFunctional).toBe(true);
      expect(state.rightArmFunctional).toBe(true);
      expect(state.canPullTrigger).toBe(true);
      expect(state.readability.immediatePostureReaction).toBe('LEG_COLLAPSE_PRONE');
    });

    it('triggers immediate weapon drop & 3.5x–6.0x aim sway on brachial plexus or radius-ulna hit', () => {
      const ecs = new PhysiologyEcsSystem(8);
      ecs.registerEntity({
        entityId: 'gunner_brachial',
        alertnessState: 'COMBAT_ALERT',
        dominantHand: 'LEFT',
        enableArmorPlates: false,
      });

      // Left brachial plexus lateral axillary cord (x = 0.185, y = 1.425 — outside left lung)
      const brachialReport = marchInternalBallistics({
        ammo: AMMO_556_NATO_M855,
        rayOriginWorld: vec3(0.185, 1.425, 0.8),
        rayDirectionWorld: vec3(0, 0, -1),
        impactVelocityMs: 850,
        config: { enableArmorPlates: false },
      });
      expect(brachialReport.nervesSevered).toContain('BRACHIAL_PLEXUS_LEFT');

      const brachialState = ecs.applyBallisticTrauma('gunner_brachial', brachialReport);
      expect(brachialState.weaponDropped).toBe(true);
      expect(brachialState.leftArmFunctional).toBe(false);
      expect(brachialState.canPullTrigger).toBe(false);
      expect(brachialState.aimSwayMultiplier).toBeGreaterThanOrEqual(3.5);
      expect(brachialState.aimSwayMultiplier).toBeLessThanOrEqual(6.0);
      expect(brachialState.readability.immediatePostureReaction).toBe('WEAPON_WRENCH_DROP');

      // Right (support-arm) radius-ulna hit spikes aimSwayMultiplier into 3.5x–6.0x while left hand holds weapon
      ecs.registerEntity({
        entityId: 'gunner_forearm_right',
        alertnessState: 'COMBAT_ALERT',
        dominantHand: 'LEFT',
      });
      const forearmReport = marchInternalBallistics({
        ammo: AMMO_50AE_JHP,
        rayOriginWorld: vec3(-0.22, 1.145, 0.6),
        rayDirectionWorld: vec3(0, 0, -1),
        impactVelocityMs: 430,
      });
      expect(
        forearmReport.boneTrauma.some((b) => b.boneId === 'RADIUS_ULNA_RIGHT' && b.fractured)
      ).toBe(true);

      const forearmState = ecs.applyBallisticTrauma('gunner_forearm_right', forearmReport);
      expect(forearmState.rightArmFunctional).toBe(false);
      expect(forearmState.weaponDropped).toBe(false);
      expect(forearmState.aimSwayMultiplier).toBeGreaterThanOrEqual(3.5);
      expect(forearmState.aimSwayMultiplier).toBeLessThanOrEqual(6.0);
    });
  });

  describe('4. Dual Cavitation: >600 m/s Stretch vs <450 m/s Pistol Crush-Only & Inelastic Liver/Brain Rupture', () => {
    it('applies stretch cavitation to off-axis elastic vessels above 600 m/s while <450 m/s pistol produces crush-only channel in elastic muscle', () => {
      // Right femoral artery at y = 0.72 runs near x = -0.109, z = 0.012 (lumen ~6.5mm).
      // Pass 2.1 cm medial to the artery wall (x = -0.080, y = 0.72): outside permanent crush radius, inside rifle stretch cavity!
      const offAxisOrigin = vec3(-0.080, 0.72, 0.6);
      const offAxisDir = vec3(0, 0, -1);

      const pistolElastic = marchInternalBallistics({
        ammo: PISTOL_9MM_FMJ,
        rayOriginWorld: offAxisOrigin,
        rayDirectionWorld: offAxisDir,
        impactVelocityMs: 365, // < 450 m/s
        config: { enableArmorPlates: false },
      });
      expect(pistolElastic.steps.every((s) => s.stretchCavitationActive === false)).toBe(true);
      expect(pistolElastic.vascularWounds.some((v) => v.vesselId === 'FEMORAL_RIGHT')).toBe(false);

      const rifleStretch = marchInternalBallistics({
        ammo: AMMO_762_NATO_M118LR,
        rayOriginWorld: offAxisOrigin,
        rayDirectionWorld: offAxisDir,
        impactVelocityMs: 805, // > 600 m/s
        config: { enableArmorPlates: false },
      });
      expect(rifleStretch.steps.some((s) => s.stretchCavitationActive === true)).toBe(true);
      expect(rifleStretch.vascularWounds.some((v) => v.vesselId === 'FEMORAL_RIGHT')).toBe(true);
    });

    it('ruptures inelastic LIVER and BRAIN parenchyma under temporary stretch energy even below 600 m/s', () => {
      // Sub-450 m/s .50 AE JHP (435 m/s) into right upper quadrant LIVER (localCenter: -0.065, 1.155, 0.015)
      const liverHit = marchInternalBallistics({
        ammo: AMMO_50AE_JHP,
        rayOriginWorld: vec3(-0.085, 1.155, 0.7),
        rayDirectionWorld: vec3(0, 0, -1),
        impactVelocityMs: 435,
        config: { enableArmorPlates: false },
      });
      const liverTrauma = liverHit.organTrauma.find((o) => o.organId === 'LIVER');
      expect(liverTrauma).toBeDefined();
      expect(liverTrauma!.isInelastic).toBe(true);
      expect(liverTrauma!.stretchCavitationRuptured).toBe(true);

      // Sub-450 m/s .50 AE JHP into unhelmeted BRAIN (localCenter: 0, 1.695, -0.005)
      const brainHit = marchInternalBallistics({
        ammo: AMMO_50AE_JHP,
        rayOriginWorld: vec3(0, 1.69, 0.7),
        rayDirectionWorld: vec3(0, 0, -1),
        impactVelocityMs: 440,
        config: { enableHelmet: false },
      });
      const brainTrauma = brainHit.organTrauma.find((o) => o.organId === 'BRAIN');
      expect(brainTrauma).toBeDefined();
      expect(brainTrauma!.isInelastic).toBe(true);
      expect(brainTrauma!.stretchCavitationRuptured).toBe(true);
    });
  });

  describe('5. Decoupled 8 Hz ECS Tick: Pressure-Scaled Arterial Bleed & Tension Pneumothorax + Chest Seal', () => {
    it('accumulates 120 Hz frame dt into 8 Hz biological ticks, scaling bleed by MAP into Class III (>30% loss) and Class IV arrest (>50% loss)', () => {
      const ecs = new PhysiologyEcsSystem(8);
      const state = ecs.registerEntity({
        entityId: 'bleed_subject',
        alertnessState: 'COMBAT_ALERT',
        enableArmorPlates: false,
      });

      // Transect femoral artery without hitting brain/heart
      const femoralShot = marchInternalBallistics({
        ammo: AMMO_556_NATO_M855,
        rayOriginWorld: vec3(0.11, 0.72, 0.6),
        rayDirectionWorld: vec3(0, 0, -1),
        impactVelocityMs: 880,
        config: { enableArmorPlates: false },
      });
      expect(femoralShot.vascularWounds.some((v) => v.vesselId === 'FEMORAL_LEFT')).toBe(true);
      ecs.applyBallisticTrauma('bleed_subject', femoralShot);

      const initialBleedRate = state.effectiveBleedRateMlPerSec;
      expect(initialBleedRate).toBeGreaterThan(45);

      // Step 1 second at 120 Hz -> exactly 8 biological ticks executed!
      let ticksInOneSecond = 0;
      for (let f = 0; f < 120; f++) {
        ticksInOneSecond += ecs.update(1 / 120);
      }
      expect(ticksInOneSecond).toBe(8);
      expect(state.biologicalTicksExecuted).toBe(8);

      // Advance until >30% blood loss (< 3,500 mL) -> Class III Hemorrhagic Shock
      let guard = 0;
      while (state.bloodVolumeMl >= PHYSIOLOGY_CONSTANTS.CLASS_III_BLOOD_VOLUME_ML && guard < 600) {
        ecs.update(0.125);
        guard++;
      }
      expect(state.bloodVolumeMl).toBeLessThan(3500);
      expect(state.bloodVolumeMl).toBeGreaterThan(2500);
      expect(state.shockStage).toBe('CLASS_III');
      expect(state.heartRateBpm).toBeGreaterThan(125);
      // Bleed rate dynamically drops as Mean Arterial Pressure falls!
      expect(state.effectiveBleedRateMlPerSec).toBeLessThan(initialBleedRate * 0.85);
      expect(state.readability.staminaMultiplier).toBeLessThanOrEqual(0.25);

      // Continue ticking until >50% blood loss (<= 2,500 mL) -> Class IV Exsanguination Arrest
      while (state.alive && guard < 1600) {
        ecs.update(0.125);
        guard++;
      }
      expect(state.bloodVolumeMl).toBeLessThanOrEqual(2500);
      expect(state.shockStage).toBe('CLASS_IV');
      expect(state.conscious).toBe(false);
      expect(state.alive).toBe(false);
      expect(state.causeOfDeath).toBe('EXSANGUINATION_CLASS_IV_ARREST');
    });

    it('decays SpO2 into hypoxic coma/arrest under TENSION_PNEUMOTHORAX unless applyChestSealOrDecompression is called', () => {
      const ecs = new PhysiologyEcsSystem(8);
      const untreated = ecs.registerEntity({
        entityId: 'pneumo_untreated',
        alertnessState: 'COMBAT_ALERT',
        enableArmorPlates: false,
      });
      const treated = ecs.registerEntity({
        entityId: 'pneumo_treated',
        alertnessState: 'COMBAT_ALERT',
        enableArmorPlates: false,
      });

      // Clean isolated gunshot perforation of right lung (x = -0.135, y = 1.35) without cardiac/aortic hit
      const lungShot = marchInternalBallistics({
        ammo: PISTOL_9MM_FMJ,
        rayOriginWorld: vec3(-0.135, 1.35, 0.7),
        rayDirectionWorld: vec3(0, 0, -1),
        impactVelocityMs: 365,
        config: { enableArmorPlates: false },
      });
      expect(lungShot.organTrauma.some((o) => o.organId === 'LUNG_RIGHT')).toBe(true);

      ecs.applyBallisticTrauma('pneumo_untreated', lungShot);
      ecs.applyBallisticTrauma('pneumo_treated', lungShot);
      expect(untreated.pneumothoraxState).toBe('TENSION_PNEUMOTHORAX');
      expect(treated.pneumothoraxState).toBe('TENSION_PNEUMOTHORAX');

      // Advance 6 seconds: both decay SpO2
      for (let i = 0; i < 48; i++) {
        ecs.update(0.125);
      }
      const spo2At6s = treated.oxygenSaturationPct;
      expect(spo2At6s).toBeLessThan(95);

      // Apply chest seal / needle decompression to `treated` only
      expect(ecs.applyChestSealOrDecompression('pneumo_treated')).toBe(true);
      expect(treated.pneumothoraxState).toBe('DECOMPRESSED_SEALED');

      // Advance 35 more seconds: untreated collapses into hypoxia coma (<65% SpO2), treated stabilizes >88%!
      for (let i = 0; i < 280; i++) {
        ecs.update(0.125);
      }
      expect(untreated.oxygenSaturationPct).toBeLessThan(65);
      expect(untreated.conscious).toBe(false);

      expect(treated.oxygenSaturationPct).toBeGreaterThan(88);
      expect(treated.conscious).toBe(true);
      expect(treated.alive).toBe(true);
    });
  });

  describe('6. Neurogenic Shock vs Adrenaline Buffer & Stage-4 Gameplay Readability Bridge', () => {
    it('drops unsuspecting target immediately on torso hit while high-adrenaline target stays conscious yet suffers immediate Stage-4 posture/accuracy/bleed readability', () => {
      const ecs = new PhysiologyEcsSystem(8);
      const unsuspecting = ecs.registerEntity({
        entityId: 'sentry_unsuspecting',
        alertnessState: 'UNSUSPECTING',
        enableArmorPlates: false,
      });
      const alertedLiver = ecs.registerEntity({
        entityId: 'enforcer_alert_liver',
        alertnessState: 'COMBAT_ALERT',
        enableArmorPlates: false,
      });
      const alertedChest = ecs.registerEntity({
        entityId: 'enforcer_alert_chest',
        alertnessState: 'COMBAT_ALERT',
        enableArmorPlates: false,
      });

      // Liver / diaphragm torso shot
      const liverReport = marchInternalBallistics({
        ammo: AMMO_50AE_JHP,
        rayOriginWorld: vec3(-0.065, 1.18, 0.8),
        rayDirectionWorld: vec3(0, 0, -1),
        impactVelocityMs: 435,
        config: { enableArmorPlates: false },
      });

      ecs.applyBallisticTrauma('sentry_unsuspecting', liverReport);
      expect(unsuspecting.neurogenicShockCollapsed).toBe(true);
      expect(unsuspecting.conscious).toBe(false);
      expect(unsuspecting.readability.immediatePostureReaction).toBe('NEUROGENIC_DROP');

      ecs.applyBallisticTrauma('enforcer_alert_liver', liverReport);
      // High adrenaline suppresses pure pain unconsciousness...
      expect(alertedLiver.conscious).toBe(true);
      expect(alertedLiver.alive).toBe(true);
      // ...BUT Stage-4 Readability Bridge immediately prevents Terminator laser-aiming!
      expect(alertedLiver.readability.immediatePostureReaction).toBe('DIAPHRAGM_DROP_KNEEL');
      expect(alertedLiver.readability.vocalCue).toBe('SHARP_GASP');
      expect(alertedLiver.readability.aiAccuracyMultiplier).toBeLessThanOrEqual(0.18);
      expect(alertedLiver.readability.bleedVisualProfile.kind).toBe('VENOUS_DARK_OOZE');
      expect(alertedLiver.readability.bleedVisualProfile.rgbColor).toEqual([0.32, 0.01, 0.03]);

      // Subclavian + left lung axillary shot on alerted target -> bright pulsing arterial jet + chest stagger + wet cough
      const subclavianLungReport = marchInternalBallistics({
        ammo: AMMO_556_NATO_M855,
        rayOriginWorld: vec3(0.08, 1.49, 0.8),
        rayDirectionWorld: vec3(0, 0, -1),
        impactVelocityMs: 885,
        config: { enableArmorPlates: true },
      });
      ecs.applyBallisticTrauma('enforcer_alert_chest', subclavianLungReport);

      expect(alertedChest.conscious).toBe(true);
      expect(alertedChest.readability.immediatePostureReaction).toBe('VIOLENT_CHEST_STAGGER');
      expect(alertedChest.readability.vocalCue).toBe('WET_HEMOTHORAX_COUGH');
      expect(alertedChest.readability.aiAccuracyMultiplier).toBeLessThanOrEqual(0.18);
      expect(alertedChest.readability.bleedVisualProfile.kind).toBe('ARTERIAL_PULSING_JET');
      expect(alertedChest.readability.bleedVisualProfile.rgbColor).toEqual([0.96, 0.04, 0.06]);
      expect(alertedChest.readability.bleedVisualProfile.pulsatile).toBe(true);
      expect(alertedChest.readability.bleedVisualProfile.sprayVelocityMs).toBeGreaterThanOrEqual(
        3.5
      );
      expect(alertedChest.readability.bleedVisualProfile.sprayVelocityMs).toBeLessThanOrEqual(6.5);

      // Verify PlayCanvas vascular blood material colors, systolic wave, & emitter particle/pool stepping
      const mats = createVascularBloodMaterials();
      // Arterial spray is rendered darker than the raw crimson so it reads gritty, not candy red.
      expect(mats.arterialJetMat.diffuse.r).toBeCloseTo(0.96 * 0.6, 2);
      expect(mats.venousOozeMat.diffuse.r).toBeCloseTo(0.32, 2);
      expect(evaluateSystolicPulseWave(0.12, 120)).toBeGreaterThan(0.75);
      expect(evaluateSystolicPulseWave(0.45, 120)).toBeLessThan(0.35);

      const mockRoot = new pc.Entity('MockRoot', { systems: {} } as unknown as pc.AppBase);
      const mockApp = { root: mockRoot, systems: {} } as unknown as pc.AppBase;
      const emitter = new VascularBloodFxEmitter(mockApp, getOrCreateMaterials(), 64, 16);
      emitter.bindEntity(alertedChest);
      emitter.bindEntity(alertedLiver);
      alertedChest.elapsedTimeS = 0.12; // Systolic ejection peak
      emitter.update(0.2); // bleeds are deliberately sparse: give both vessels time to emit
      const counts = emitter.getActiveCounts();
      expect(counts.arterialParticles).toBeGreaterThan(0);
      expect(counts.venousParticles).toBeGreaterThan(0);
      // Step gravity until droplets hit y <= 0.012 and form floor pools
      for (let s = 0; s < 16; s++) {
        emitter.update(0.05);
      }
      expect(emitter.getActiveCounts().floorPools).toBeGreaterThan(0);
      emitter.destroy();
    });
  });
});
