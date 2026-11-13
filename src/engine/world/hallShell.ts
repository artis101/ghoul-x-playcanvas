import * as pc from 'playcanvas';
import type { ColliderSurfaceTag } from '../../contracts/destruction.ts';
import type { EngineMaterialPalette } from '../materials.ts';
import type { RapierPhysicsWorld } from '../physics/rapierWorld.ts';
import { applyFlatPaintedSurface } from '../textures/environmentTextures.ts';
import { getOrCreateTileHallTextures, WALL_TILE_ROWS } from '../textures/tileHallTextures.ts';
import { HALL_CENTER_Z, HALL_LENGTH_M, HALL_SHELL } from './arenaLayout.ts';

const CEILING_PANEL_REPEAT_M = 2.4;
const PILASTER_TILES_WIDE = 6;
const BEAM_DEPTH_M = 0.45;

interface ShellSlab {
  readonly id: string;
  readonly material: pc.StandardMaterial;
  readonly center: [number, number, number];
  readonly size: [number, number, number];
}

function createDetailMaterial(name: string, detailMaterials: pc.StandardMaterial[]): pc.StandardMaterial {
  const mat = new pc.StandardMaterial();
  mat.name = name;
  detailMaterials.push(mat);
  return mat;
}

/**
 * Encloses the range in a tiled underground hall: four ceramic-tile walls, a stained panel
 * ceiling on concrete beams, tiled pilasters, and boxy fluorescent fixtures that light it.
 */
export function buildHallShell(
  arenaRootEntity: pc.Entity,
  device: pc.GraphicsDevice,
  materials: EngineMaterialPalette,
  rapierWorld: RapierPhysicsWorld | null,
  colliderHandles: number[],
  detailMaterials: pc.StandardMaterial[]
): void {
  const { halfWidthM, frontZ, backZ, heightM, wallThicknessM } = HALL_SHELL;
  const textures = getOrCreateTileHallTextures(device);
  const widthM = halfWidthM * 2;
  const tileM = heightM / WALL_TILE_ROWS;

  const tiledMat = (name: string, faceWidthM: number): pc.StandardMaterial => {
    const mat = createDetailMaterial(name, detailMaterials);
    applyFlatPaintedSurface(mat, textures.wallTile, new pc.Vec2(faceWidthM / heightM, 1), 0.06);
    return mat;
  };
  const sideWallMat = tiledMat('hallSideWallTileMat', HALL_LENGTH_M);
  const endWallMat = tiledMat('hallEndWallTileMat', widthM);
  const pilasterSizeM = tileM * PILASTER_TILES_WIDE;
  const pilasterMat = tiledMat('hallPilasterTileMat', pilasterSizeM);

  const ceilingMat = createDetailMaterial('hallCeilingPanelMat', detailMaterials);
  applyFlatPaintedSurface(
    ceilingMat,
    textures.ceilingPanel,
    new pc.Vec2(widthM / CEILING_PANEL_REPEAT_M, HALL_LENGTH_M / CEILING_PANEL_REPEAT_M)
  );

  const housingMat = createDetailMaterial('hallFixtureHousingMat', detailMaterials);
  housingMat.diffuse = new pc.Color(0.05, 0.05, 0.045);
  housingMat.update();

  const diffuserMat = createDetailMaterial('hallFixtureDiffuserMat', detailMaterials);
  diffuserMat.diffuse = new pc.Color(0.9, 0.86, 0.7);
  diffuserMat.emissive = new pc.Color(1.0, 0.95, 0.78);
  // Bright enough to clear the bloom knee, so each tube carries a soft halo.
  diffuserMat.emissiveIntensity = 7;
  diffuserMat.update();

  const shell = new pc.Entity('TiledHallShell');
  arenaRootEntity.addChild(shell);

  const addBox = (name: string, mat: pc.StandardMaterial, slab: Pick<ShellSlab, 'center' | 'size'>): void => {
    const ent = new pc.Entity(name);
    ent.addComponent('render', { type: 'box', material: mat, castShadows: false, receiveShadows: true });
    ent.setLocalScale(slab.size[0], slab.size[1], slab.size[2]);
    ent.setPosition(slab.center[0], slab.center[1], slab.center[2]);
    shell.addChild(ent);
  };

  const wallX = halfWidthM + wallThicknessM / 2;
  const outerLengthM = HALL_LENGTH_M + wallThicknessM * 2;
  const outerWidthM = widthM + wallThicknessM * 2;
  const slabs: ShellSlab[] = [
    { id: 'HallWall_Left', material: sideWallMat, center: [-wallX, heightM / 2, HALL_CENTER_Z], size: [wallThicknessM, heightM, HALL_LENGTH_M] },
    { id: 'HallWall_Right', material: sideWallMat, center: [wallX, heightM / 2, HALL_CENTER_Z], size: [wallThicknessM, heightM, HALL_LENGTH_M] },
    { id: 'HallWall_Back', material: endWallMat, center: [0, heightM / 2, backZ - wallThicknessM / 2], size: [widthM, heightM, wallThicknessM] },
    { id: 'HallWall_Front', material: endWallMat, center: [0, heightM / 2, frontZ + wallThicknessM / 2], size: [widthM, heightM, wallThicknessM] },
    { id: 'HallCeiling', material: ceilingMat, center: [0, heightM + wallThicknessM / 2, HALL_CENTER_Z], size: [outerWidthM, wallThicknessM, outerLengthM] },
  ];

  for (const slab of slabs) {
    addBox(slab.id, slab.material, slab);
    if (!rapierWorld) continue;
    const tag: ColliderSurfaceTag = {
      material: 'CONCRETE_INTACT',
      objectId: slab.id,
      thicknessM: wallThicknessM,
      penetrationResistanceJ: 60000,
    };
    colliderHandles.push(
      rapierWorld.createStaticBox(
        { x: slab.center[0], y: slab.center[1], z: slab.center[2] },
        { x: slab.size[0] / 2, y: slab.size[1] / 2, z: slab.size[2] / 2 },
        undefined,
        tag
      )
    );
  }

  const pilasterX = halfWidthM - pilasterSizeM / 2 + 0.01;
  for (const z of HALL_SHELL.beamZOffsetsM) {
    addBox(`HallCeilingBeam_${z}`, materials.barrierConcreteMat, {
      center: [0, heightM - BEAM_DEPTH_M / 2, z],
      size: [widthM, BEAM_DEPTH_M, pilasterSizeM * 0.8],
    });
    for (const side of [-pilasterX, pilasterX]) {
      addBox(`HallPilaster_${side < 0 ? 'L' : 'R'}_${z}`, pilasterMat, {
        center: [side, heightM / 2, z],
        size: [pilasterSizeM, heightM, pilasterSizeM],
      });
    }
  }

  for (const z of HALL_SHELL.fixtureBayZOffsetsM) {
    for (const x of HALL_SHELL.fixtureXOffsetsM) {
      const id = `${x < 0 ? 'L' : 'R'}_${z}`;
      addBox(`HallFixtureHousing_${id}`, housingMat, { center: [x, heightM - 0.08, z], size: [1.5, 0.16, 0.62] });
      addBox(`HallFixtureDiffuser_${id}`, diffuserMat, { center: [x, heightM - 0.17, z], size: [1.36, 0.03, 0.48] });

      const lamp = new pc.Entity(`HallFixtureLamp_${id}`);
      lamp.addComponent('light', {
        type: 'omni',
        color: new pc.Color(1.0, 0.95, 0.8),
        // Local pools under each fixture; the key light does the broad lighting and the shadows.
        intensity: 1.3,
        range: 10,
        castShadows: false,
      });
      lamp.setPosition(x, heightM - 0.7, z);
      shell.addChild(lamp);
    }
  }
}
