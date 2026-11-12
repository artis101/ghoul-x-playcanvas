import { describe, expect, it } from 'vitest';
import * as pc from 'playcanvas';
import { Paths64 } from 'clipper2-js';
import {
  ALL_AUX_PARTICLES,
  ALL_GHOUL_ZONES,
  createTargetHealthState,
} from '../src/core/ghoul/anatomy.ts';
import {
  createProceduralTraumaTracker,
  isArmDeadButAttached,
  stepPinnedDeadArmVerlet,
  stepProceduralTraumaIk,
} from '../src/core/ghoul/anatomy/proceduralTraumaIk.ts';
import { stepRagdollPhysics } from '../src/core/ballistics/ragdoll/ragdollVerletStep.ts';
import { stabilizeRagdollPoseForTransition } from '../src/core/ballistics/ragdoll/ragdollPoseStabilizer.ts';
import { applyShotReportToTarget, simulateShot } from '../src/core/ballistics/solver.ts';
import {
  AMMO_762_NATO_M118LR,
  DEFAULT_ENVIRONMENT,
  WEAPON_MSG90,
} from '../src/core/ballistics/weapons.ts';
import { length, normalize, sub, vec3 } from '../src/core/ballistics/vec3.ts';
import {
  createJaggedHoleStamp,
  createWoodPanelState,
  extrudeDroppedWoodSlabs,
  points2DToPath64,
  recheckUnanchoredWoodShells,
  stampHoleInWoodPanel,
  type WoodMeshScratchBuffers,
} from '../src/core/destruction/woodPolygonClipper.ts';
import {
  collapseFloatingStudSections,
  collectIntactStudSpans,
  createInitialStudColumns,
} from '../src/engine/destruction/wood/woodStudFrameBuilder.ts';
import { buildStudAnchorsFromColumns } from '../src/engine/destruction/wood/woodStudColliderSync.ts';
import {
  createRuntimeConnectivityGraph,
  findDetachedSubgraphs,
  generateRunningBondBrickGraph,
  severEdgesFromBlast,
} from '../src/core/destruction/connectivityGraph.ts';
import { GunsmokeGrid } from '../src/core/fx/gunsmokeGrid.ts';
import { PomCraterDecalSystem } from '../src/engine/destruction/decals/pomCraterDecalSystem.ts';
import type { RapierPhysicsWorld } from '../src/engine/physics/rapierWorld.ts';

function createTestWoodScratchBuffers(): WoodMeshScratchBuffers {
  return {
    positions: new Float32Array(8192 * 3),
    normals: new Float32Array(8192 * 3),
    uvs: new Float32Array(8192 * 2),
    indices: new Uint16Array(24576),
  };
}

describe('Wave 1, Wave 2 & Wave 3 — Ragdoll Stability, Trauma IK, Destruction & Gunsmoke', () => {
  it('settles a dead ragdoll on floorY = 0 into permanent zero-velocity sleep', () => {
    const target = createTargetHealthState('corpse_sleep_1', 'Militia', vec3(1.5, 0, -4.0), 0.3);
    target.alive = false;
    target.isRagdollActive = true;
    target.posture = 'AIRBORNE_RAGDOLL';
    stabilizeRagdollPoseForTransition(target, 0.0);
    target.ragdollBones.TORSO_UPPER_THORAX.velocity = vec3(0.4, -0.5, 0.3);

    for (let i = 0; i < 180; i++) {
      stepRagdollPhysics(target, 1 / 60, 0.0);
    }

    expect(target.posture).toBe('RAGDOLL_GROUNDED');
    for (const z of ALL_GHOUL_ZONES) {
      const b = target.ragdollBones[z];
      expect(length(b.velocity)).toBe(0);
    }
    for (const aId of ALL_AUX_PARTICLES) {
      const a = target.auxParticles[aId];
      expect(length(a.velocity)).toBe(0);
    }

    const settledPelvis = { ...target.ragdollBones.PELVIS_GROIN.position };
    const settledHead = { ...target.ragdollBones.HEAD_CRANIUM.position };
    for (let i = 0; i < 30; i++) {
      stepRagdollPhysics(target, 1 / 60, 0.0);
    }
    expect(target.ragdollBones.PELVIS_GROIN.position).toEqual(settledPelvis);
    expect(target.ragdollBones.HEAD_CRANIUM.position).toEqual(settledHead);
  });

  it('never launches a corpse positioned outside the old +-9.7m clamp (e.g. x=14.5m, z=-12m)', () => {
    const target = createTargetHealthState('corpse_wide_bounds', 'Sniper', vec3(14.5, 0, -12.0), -0.4);
    target.alive = false;
    target.isRagdollActive = true;
    target.posture = 'AIRBORNE_RAGDOLL';
    stabilizeRagdollPoseForTransition(target, 0.0);

    let maxObservedSpeed = 0;
    for (let i = 0; i < 90; i++) {
      stepRagdollPhysics(target, 1 / 60, 0.0);
      for (const z of ALL_GHOUL_ZONES) {
        const sp = length(target.ragdollBones[z].velocity);
        if (sp > maxObservedSpeed) maxObservedSpeed = sp;
      }
    }

    expect(maxObservedSpeed).toBeLessThanOrEqual(11.0);
    expect(Math.abs(target.ragdollBones.PELVIS_GROIN.position.x - 14.5)).toBeLessThan(1.75);
    expect(Math.abs(target.ragdollBones.PELVIS_GROIN.position.z - -12.0)).toBeLessThan(1.75);
  });

  it('never teleports or launches the 42m overwatch sniper (z=-42m) or boundary-contacting ragdolls upward when killed', () => {
    const sniper = createTargetHealthState(
      'target_6',
      'SPETSNAZ SNIPER (42m OVERWATCH)',
      vec3(0.4, 0, -42.0),
      0,
      'SNIPER_OPERATIVE',
      true
    );
    const shooterOrigin = vec3(0.4, 1.62, 0);
    const headPos = sniper.ragdollBones.HEAD_CRANIUM.position;
    const report = simulateShot(
      WEAPON_MSG90,
      AMMO_762_NATO_M118LR,
      shooterOrigin,
      normalize(sub(headPos, shooterOrigin)),
      sniper,
      DEFAULT_ENVIRONMENT
    );
    expect(report.hitTarget).toBe(true);
    applyShotReportToTarget(sniper, report);
    expect(sniper.alive).toBe(false);
    expect(sniper.isRagdollActive).toBe(true);

    // Must remain at the 42m overwatch station rather than teleporting to -28m
    expect(Math.abs(sniper.ragdollBones.PELVIS_GROIN.position.z - -42.0)).toBeLessThan(0.5);

    let maxPelvisY = sniper.ragdollBones.PELVIS_GROIN.position.y;
    let maxHeadY = sniper.ragdollBones.HEAD_CRANIUM.position.y;
    for (let i = 0; i < 120; i++) {
      stepRagdollPhysics(sniper, 1 / 60, 0.0);
      maxPelvisY = Math.max(maxPelvisY, sniper.ragdollBones.PELVIS_GROIN.position.y);
      maxHeadY = Math.max(maxHeadY, sniper.ragdollBones.HEAD_CRANIUM.position.y);
    }

    expect(maxPelvisY).toBeLessThan(1.1);
    expect(maxHeadY).toBeLessThan(1.8);
    expect(Math.abs(sniper.ragdollBones.PELVIS_GROIN.position.z - -42.0)).toBeLessThan(2.5);

    // Also verify XZ world safety boundary contact stops normal velocity without wall suction or vertical launch
    const edgeCorpse = createTargetHealthState('edge_corpse', 'Edge', vec3(0, 0, -319.7), 0);
    edgeCorpse.alive = false;
    edgeCorpse.isRagdollActive = true;
    stabilizeRagdollPoseForTransition(edgeCorpse, 0.0);
    for (const z of ALL_GHOUL_ZONES) {
      edgeCorpse.ragdollBones[z].velocity = vec3(0, 0, -3.2);
    }
    let maxEdgePelvisY = edgeCorpse.ragdollBones.PELVIS_GROIN.position.y;
    for (let i = 0; i < 90; i++) {
      stepRagdollPhysics(edgeCorpse, 1 / 60, 0.0);
      maxEdgePelvisY = Math.max(maxEdgePelvisY, edgeCorpse.ragdollBones.PELVIS_GROIN.position.y);
    }
    expect(maxEdgePelvisY).toBeLessThan(1.1);
    expect(edgeCorpse.ragdollBones.PELVIS_GROIN.position.z).toBeGreaterThanOrEqual(-320.0);
  });

  it('solves procedural trauma IK: wound clutching, hit-jolt, downed prop-up, and dead-limb pendulum', () => {
    const target = createTargetHealthState('trauma_ik_1', 'Enforcer', vec3(0, 0, -5), 0);
    const tracker = createProceduralTraumaTracker();

    target.zoneGoreMode.TORSO_LOWER_ABDOMEN = 'LACERATED';
    target.posture = 'GUT_HURT';
    target.painShock = 0.35;
    target.zoneCumulativeDamageJ.TORSO_LOWER_ABDOMEN = 540;
    target.surfaceWounds.push({
      id: 'w_gut_1',
      zone: 'TORSO_LOWER_ABDOMEN',
      localOffset: vec3(0.04, 0.02, 0.11),
      localNormal: vec3(0, 0, 1),
      radiusM: 0.035,
      isExit: false,
      armorDent: false,
    });

    const shoulders = { RIGHT: vec3(-0.28, -3.62, -5.0), LEFT: vec3(0.28, -3.62, -5.0) };
    const elbows = { RIGHT: vec3(-0.31, -3.87, -4.95), LEFT: vec3(0.31, -3.87, -4.95) };
    const wrists = { RIGHT: vec3(-0.14, -3.85, -4.76), LEFT: vec3(0.14, -3.85, -4.76) };

    let lastOut = stepProceduralTraumaIk(target, tracker, 1 / 60, shoulders, elbows, wrists);
    for (let i = 0; i < 15; i++) {
      lastOut = stepProceduralTraumaIk(target, tracker, 1 / 60, shoulders, elbows, wrists);
    }
    expect(lastOut.clutchBlend).toBeGreaterThan(0.2);
    expect(lastOut.clutchSide).toBe('LEFT');
    expect(lastOut.hasJoltOrPropUp).toBe(true);

    // Disable right arm while attached -> dead-limb Verlet pendulum swings under gravity
    target.rightArmFunctional = false;
    target.fracturedBones.add('humerus_right');
    expect(isArmDeadButAttached(target, 'RIGHT')).toBe(true);
    for (let i = 0; i < 20; i++) {
      const stepped = stepPinnedDeadArmVerlet(target, tracker, 'RIGHT', vec3(-0.28, 1.38, -5.0), 1 / 60);
      expect(stepped).toBe(true);
    }
    expect(target.ragdollBones.HAND_RIGHT.position.y).toBeLessThan(1.0);

    // Disable right leg while weapon is still held -> downed torso prop-up activates
    target.rightLegFunctional = false;
    target.posture = 'LEG_BUCKLED';
    for (let i = 0; i < 20; i++) {
      lastOut = stepProceduralTraumaIk(target, tracker, 1 / 60, shoulders, elbows, wrists);
    }
    expect(tracker.propUpBlend).toBeGreaterThan(0.4);
    expect(lastOut.torsoPitchAddRad).toBeLessThan(-0.15);
  });

  it('extrudes large (> 0.6 m^2) unanchored wood cutouts and stud-severed shells into droppedSlabs instead of floating', () => {
    // 1. Direct extrusion of a large 0.8m x 0.9m (0.72 m^2) detached island
    const islandPath = points2DToPath64([
      { u: 0.4, v: 0.5 },
      { u: 1.2, v: 0.5 },
      { u: 1.2, v: 1.4 },
      { u: 0.4, v: 1.4 },
    ]);
    const islands = new Paths64();
    islands.push(islandPath);
    const slabs = extrudeDroppedWoodSlabs(islands, 2.4, 2.4, 0.08);
    expect(slabs.length).toBe(1);
    expect(slabs[0].areaM2).toBeCloseTo(0.72, 2);
    expect(slabs[0].indices.length).toBeGreaterThan(12);
    expect(slabs[0].hullVertices.length).toBe(24);
    expect(slabs[0].massKg).toBeGreaterThan(20);

    // 2. Carve a large (> 0.65 m^2) island supported only by an interior stud at u = 1.2m;
    //    when the stud is severed top & bottom, collapseFloatingStudSections + recheckUnanchoredWoodShells
    //    must drop the large wood slab intact rather than leaving it floating in state.shells!
    const state = createWoodPanelState(2.4, 2.4, 0.08);
    const buffers = createTestWoodScratchBuffers();
    const studCols = createInitialStudColumns(2.4, 0.08, [0.04, 1.2, 2.36]);
    state.studAnchors = buildStudAnchorsFromColumns(studCols);

    // Stamp a continuous ring of holes isolating a ~0.9m x 0.9m (0.81 m^2) central island around u=1.2, v=1.2
    const ringPts: Array<[number, number]> = [];
    for (let u = 0.65; u <= 1.75; u += 0.16) ringPts.push([u, 0.65], [u, 1.75]);
    for (let v = 0.65; v <= 1.75; v += 0.16) ringPts.push([0.65, v], [1.75, v]);

    for (let i = 0; i < ringPts.length; i++) {
      const [ru, rv] = ringPts[i];
      const stamp = createJaggedHoleStamp({
        u: ru,
        v: rv,
        caliberRadiusM: 0.02,
        kineticEnergyJ: 1800,
        profile: 'BUCKSHOT_CLUSTER',
        seed: i + 1,
        overrideRadiusM: 0.14,
      });
      stampHoleInWoodPanel(state, stamp, buffers, 4);
    }

    // While the central stud at u=1.2 is intact, the island is held by the stud
    expect(state.shells.length).toBeGreaterThanOrEqual(2);

    // Now break the bottom section (0) and top section (n-1) of the interior stud at u=1.2:
    // middle sections are now floating and must collapse, leaving 0 stud anchors on the island!
    const midCol = studCols[1];
    midCol.sections[0].broken = true;
    midCol.sections[0].hp = 0;
    midCol.sections[midCol.sections.length - 1].broken = true;
    midCol.sections[midCol.sections.length - 1].hp = 0;

    const collapsed = collapseFloatingStudSections(midCol);
    expect(collapsed.length).toBe(midCol.sections.length - 2);
    expect(collectIntactStudSpans(midCol).length).toBe(0);

    state.studAnchors = buildStudAnchorsFromColumns(studCols);
    const recheck = recheckUnanchoredWoodShells(state, buffers, 6);
    expect(recheck.cutAnyWood).toBe(true);
    expect(recheck.droppedIslandAreaM2).toBeGreaterThan(0.45);
    expect(recheck.droppedSlabs?.length).toBeGreaterThanOrEqual(1);
    expect(state.shells.length).toBe(1);
  });

  it('groups detached multi-brick masonry islands into connected subgraphs', () => {
    const graphData = generateRunningBondBrickGraph('brick_test_wall', 4, 4);
    const graph = createRuntimeConnectivityGraph(graphData);

    // Sever all edges on row 1 (brick indices 4, 5, 6, 7) to detach rows 2 & 3 (8 bricks) from bottom row 0
    for (let i = 0; i < graph.nodes.length; i++) {
      const node = graph.nodes[i];
      const aRow = Math.floor(i / 4);
      for (let e = 0; e < node.edges.length; e++) {
        const edge = node.edges[e];
        const bRow = Math.floor(edge.neighborIndex / 4);
        if (aRow === 1 || bRow === 1) {
          edge.severed = true;
        }
      }
    }

    // Also test severEdgesFromBlast API compatibility
    severEdgesFromBlast(
      graph,
      { position: vec3(0, 0, 0) },
      { centerWorld: vec3(0, 0.18, 0), radiusM: 0.01, peakEnergyJ: 10, peakImpulseNs: 1 },
    );

    const subgraphs = findDetachedSubgraphs(graph, undefined, 10);
    const multiBrickIslands = subgraphs.filter((sg) => sg.length >= 2);
    expect(multiBrickIslands.length).toBe(1);
    expect(multiBrickIslands[0].length).toBe(8);
  });

  it('advects lingering hallway gunsmoke and swirls puffs outward on explosion blast', () => {
    const grid = new GunsmokeGrid({ maxPuffs: 64 });
    const slot = grid.injectGunsmoke(vec3(0, 1.5, -2.0), vec3(0, 0, -1), 1.2);
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(grid.activeCount).toBe(1);

    const puffBefore = { ...grid.getPuffs()[slot] };
    grid.step(0.5);
    const puffAfterStep = grid.getPuffs()[slot];
    expect(puffAfterStep.posY).toBeGreaterThan(puffBefore.posY);

    const swirled = grid.applyBlastSwirl(vec3(0.2, 1.2, -2.8), 6.0, 220);
    expect(swirled).toBe(1);
    expect(Math.hypot(puffAfterStep.velX, puffAfterStep.velZ)).toBeGreaterThan(0.5);
  });

  it('prunes POM bullet craters when their backing static concrete chunk detaches or is breached', () => {
    const canvasStub = { width: 320, height: 240 };
    const device = new pc.NullGraphicsDevice(canvasStub);
    const app = new pc.Application(canvasStub as unknown as HTMLCanvasElement, {
      graphicsDevice: device,
    });
    const pomSystem = new PomCraterDecalSystem(app, 8, 64, 32);

    try {
      // Spawn two bullet craters on an intact concrete wall face at z = -12 (normal +Z)
      pomSystem.spawnCraterImpact(vec3(-0.4, 1.2, -12.0), vec3(0, 0, 1), vec3(0, 0, -1), 2200, 0.004);
      pomSystem.spawnCraterImpact(vec3(0.6, 1.2, -12.0), vec3(0, 0, 1), vec3(0, 0, -1), 2200, 0.004);
      expect(pomSystem.activeDecalCount).toBe(2);

      // Simulate the left Voronoi chunk (x < 0) detaching into dynamic CONCRETE_CHUNKS while right chunk (x >= 0) stays intact static
      let rightChunkIntact = true;
      const mockRapierWorld = {
        world: {
          getCollider: (handle: number) =>
            handle === 101
              ? { parent: () => ({ isFixed: () => true }) }
              : { parent: () => ({ isFixed: () => false }) },
        },
        castPenetrationRay: (origin: { x: number; y: number; z: number }) => {
          if (origin.x < 0) {
            return [
              {
                colliderHandle: 202,
                surface: { material: 'CONCRETE_CHUNKS' as const, thicknessM: 0.25 },
              },
            ];
          }
          if (!rightChunkIntact) return [];
          return [
            {
              colliderHandle: 101,
              surface: { material: 'CONCRETE_INTACT' as const, thicknessM: 0.25 },
            },
          ];
        },
      } as unknown as RapierPhysicsWorld;

      const prunedFirst = pomSystem.pruneUnsupportedCraters(mockRapierWorld);
      expect(prunedFirst).toBe(1);
      expect(pomSystem.activeDecalCount).toBe(1);

      // Now breach the right chunk too -> remaining crater is evicted cleanly
      rightChunkIntact = false;
      const prunedSecond = pomSystem.pruneUnsupportedCraters(mockRapierWorld);
      expect(prunedSecond).toBe(1);
      expect(pomSystem.activeDecalCount).toBe(0);
    } finally {
      pomSystem.destroy();
      app.destroy();
    }
  });
});
