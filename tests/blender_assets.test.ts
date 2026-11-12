import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pc from 'playcanvas';
import { describe, expect, it } from 'vitest';
import type { GhoulZoneId } from '../src/contracts/ballistics.ts';
import { ALL_GHOUL_ZONES } from '../src/core/ghoul/anatomy.ts';
import { ALL_GLB_ASSET_KEYS, COMBATANT_ANIMATION_CLIPS, WEAPON_ASSET_IDS } from '../src/engine/assets/glbLoader.ts';
import { BLEND_SOURCES_DIR, readAndParseGlb, readVec4AccessorRow } from './blenderGlbFixtures.ts';

describe('Blender combatant and weapon assets', () => {
  it('exports valid glTF 2.0 binaries within runtime budgets plus native .blend sources', () => {
    for (const key of ALL_GLB_ASSET_KEYS) {
      const parsed = readAndParseGlb(`${key}.glb`);
      expect(parsed.byteLength).toBeGreaterThan(15 * 1024);
      expect(parsed.byteLength).toBeLessThan(2 * 1024 * 1024);
      expect((parsed.gltf.meshes ?? []).length).toBeGreaterThan(0);
      expect((parsed.gltf.materials ?? []).length).toBeGreaterThan(0);
    }

    for (const blendName of [
      'ghoul_combatant.blend',
      'weapons_arsenal.blend',
      'concrete_wall_fractured.blend',
    ]) {
      const blendPath = path.join(BLEND_SOURCES_DIR, blendName);
      expect(fs.existsSync(blendPath), `Missing .blend file: ${blendPath}`).toBe(true);
      const stat = fs.statSync(blendPath);
      expect(stat.size).toBeGreaterThan(50 * 1024);
    }
  });

  it('exports a baked viewmodel arm for each grip used by the runtime', () => {
    const { gltf } = readAndParseGlb('viewmodel_arms.glb');
    const expected = WEAPON_ASSET_IDS.flatMap((weapon) =>
      weapon === 'frag_grenade' ? [`${weapon}_r`] : [`${weapon}_r`, `${weapon}_l`]
    );
    const armNodes = (gltf.nodes ?? []).filter((node) => node.mesh !== undefined);
    expect(armNodes.map((node) => node.name).sort()).toEqual(expected.sort());
    expect(armNodes.every((node) => node.skin === undefined)).toBe(true);
  });

  it('ghoul_combatant.glb contains 35 sculpted submeshes, single-bone severable weights, and Kimodo clips for both hands', () => {
    const { gltf, binChunk } = readAndParseGlb('ghoul_combatant.glb');
    const nodes = gltf.nodes ?? [];
    const meshes = gltf.meshes ?? [];
    const accessors = gltf.accessors ?? [];
    const bufferViews = gltf.bufferViews ?? [];
    const skins = gltf.skins ?? [];
    const animations = gltf.animations ?? [];

    const nodeNames = new Set(nodes.map((n) => n.name ?? ''));
    const meshByName = new Map(meshes.map((m) => [m.name ?? '', m]));

    expect(skins.length).toBeGreaterThanOrEqual(1);
    const ghoulSkin = skins[0];
    expect(ghoulSkin.joints.length).toBe(22);
    const jointNameBySkinIdx = ghoulSkin.joints.map((nodeIdx) => nodes[nodeIdx]?.name ?? '');

    let globalMinY = Number.POSITIVE_INFINITY;
    let globalMaxY = Number.NEGATIVE_INFINITY;

    // 1. All 22 GHOUL Zone submeshes exist, are skinned, UV-mapped, sculpted, and severable zones bind 100% to their own bone
    for (const zone of ALL_GHOUL_ZONES) {
      const zoneMeshName = `Zone_${zone}`;
      expect(nodeNames.has(zoneMeshName), `Missing node ${zoneMeshName}`).toBe(true);
      const mesh = meshByName.get(zoneMeshName);
      expect(mesh, `Missing mesh ${zoneMeshName}`).toBeDefined();
      expect(mesh!.primitives.length).toBeGreaterThanOrEqual(1);

      const isSeverableOrHeadZone =
        zone !== 'PELVIS_GROIN' &&
        zone !== 'TORSO_LOWER_ABDOMEN' &&
        zone !== 'TORSO_UPPER_THORAX' &&
        zone !== 'SHOULDER_LEFT' &&
        zone !== 'SHOULDER_RIGHT';
      let totalVertsInZone = 0;

      for (const prim of mesh!.primitives) {
        expect(prim.attributes.POSITION).toBeDefined();
        expect(prim.attributes.NORMAL).toBeDefined();
        expect(prim.attributes.TEXCOORD_0).toBeDefined();
        expect(prim.attributes.JOINTS_0).toBeDefined();
        expect(prim.attributes.WEIGHTS_0).toBeDefined();

        const posAcc = accessors[prim.attributes.POSITION];
        const jointsAcc = accessors[prim.attributes.JOINTS_0];
        const weightsAcc = accessors[prim.attributes.WEIGHTS_0];

        totalVertsInZone += posAcc.count;
        if (posAcc.min && posAcc.max) {
          globalMinY = Math.min(globalMinY, posAcc.min[1]);
          globalMaxY = Math.max(globalMaxY, posAcc.max[1]);
        }

        // Critical Dismemberment Invariant: every severable Zone_* vertex MUST have 100% weight
        // on `Bone_${zone}` (zero secondary bone weights) so severed GLB limbs never stretch back to BODY!
        if (isSeverableOrHeadZone) {
          for (let vIdx = 0; vIdx < weightsAcc.count; vIdx++) {
            const jRow = readVec4AccessorRow(binChunk, bufferViews, jointsAcc, vIdx);
            const wRow = readVec4AccessorRow(binChunk, bufferViews, weightsAcc, vIdx);
            const scaleFactor =
              weightsAcc.componentType === 5121
                ? 1 / 255
                : weightsAcc.componentType === 5123
                  ? 1 / 65535
                  : 1;
            const w0 = wRow[0] * scaleFactor;
            const wSecondary = (wRow[1] + wRow[2] + wRow[3]) * scaleFactor;
            expect(w0, `${zoneMeshName} v${vIdx} primary weight`).toBeGreaterThan(0.999);
            expect(wSecondary, `${zoneMeshName} v${vIdx} secondary bleed`).toBeLessThan(0.001);
            expect(jointNameBySkinIdx[jRow[0]]).toBe(`Bone_${zone}`);
          }
        }
      }
      expect(totalVertsInZone, `${zoneMeshName} must be sculpted (>40 verts)`).toBeGreaterThan(40);
    }

    // Grounded flat at y ≈ 0.00m and ~1.80m tall
    expect(globalMinY).toBeGreaterThanOrEqual(-0.005);
    expect(globalMinY).toBeLessThanOrEqual(0.02);
    expect(globalMaxY).toBeGreaterThan(1.76);
    expect(globalMaxY).toBeLessThan(1.86);

    // 2. Toggleable Gear (Archetype Headgear + Eviscerated Gut) & Internal X-Ray Anatomy submeshes (13 extra = 35 total)
    const requiredExtraMeshes = [
      'Gear_ESAPI_PlateCarrier',
      'Gear_PASGT_Helmet',
      'Gear_TacticalVisor',
      'Gear_SpetsnazBeret',
      'Gear_PunkMohawk',
      'Gear_EvisceratedGut',
      'Organ_Brain',
      'Organ_Heart',
      'Organ_Lungs',
      'Organ_Liver',
      'Skelet_Skull',
      'Skelet_RibcageSpine',
      'Skelet_Pelvis',
    ];
    for (const extraName of requiredExtraMeshes) {
      expect(nodeNames.has(extraName), `Missing node ${extraName}`).toBe(true);
      expect(meshByName.has(extraName), `Missing mesh ${extraName}`).toBe(true);
    }
    expect(meshes.length).toBe(35);

    for (const name of ['Mat_Skin_Tactical', 'Mat_Head_Sculpted']) {
      const material = gltf.materials?.find((entry) => entry.name === name);
      expect(material?.pbrMetallicRoughness?.baseColorTexture).toBeDefined();
      expect(material?.normalTexture).toBeUndefined();
    }

    // 3. 22-Bone Armature skinning
    for (const zone of ALL_GHOUL_ZONES) {
      expect(nodeNames.has(`Bone_${zone}`), `Missing joint Bone_${zone}`).toBe(true);
    }

    // 4. All combatant clips have both handed variants.
    const animNames = new Set(animations.map((a) => a.name ?? ''));
    expect(animations.length).toBe(COMBATANT_ANIMATION_CLIPS.length * 2);
    for (const expectedClip of COMBATANT_ANIMATION_CLIPS) {
      expect(animNames.has(expectedClip), `Missing right-handed clip ${expectedClip}`).toBe(true);
      const southpawClipName = `${expectedClip}_Southpaw`;
      expect(animNames.has(southpawClipName), `Missing southpaw clip ${southpawClipName}`).toBe(true);

      const rhClip = animations.find((a) => a.name === expectedClip)!;
      const lhClip = animations.find((a) => a.name === southpawClipName)!;
      expect(rhClip.channels.length).toBeGreaterThan(10);
      expect(lhClip.channels.length).toBeGreaterThan(10);
    }
  });

  it('weapon GLBs contain expected armature bones, -Z viewmodel muzzle alignment, and Idle/Fire*/Reload* clips', () => {
    const weaponExpectations: Array<{
      file: string;
      requiredBones: string[];
      fireClip: string;
      reloadClip: string;
      expectMuzzleSocket: boolean;
    }> = [
      {
        file: 'm590_shotgun.glb',
        requiredBones: ['Bone_Root', 'Bone_Pump', 'Bone_Bolt', 'Bone_Shell'],
        fireClip: 'FirePump',
        reloadClip: 'ReloadShell',
        expectMuzzleSocket: true,
      },
      {
        file: 'silver_talon_50ae.glb',
        requiredBones: ['Bone_Root', 'Bone_Slide', 'Bone_Mag', 'Bone_Hammer'],
        fireClip: 'FireBlowback',
        reloadClip: 'ReloadMag',
        expectMuzzleSocket: true,
      },
      {
        file: 'msg90_sniper.glb',
        requiredBones: ['Bone_Root', 'Bone_Mag', 'Bone_ChargingHandle', 'Bone_Bolt'],
        fireClip: 'FireRecoil',
        reloadClip: 'ReloadMag',
        expectMuzzleSocket: true,
      },
      {
        file: 'm4a1_carbine.glb',
        requiredBones: ['Bone_Root', 'Bone_Mag', 'Bone_Bolt', 'Bone_ChargingHandle'],
        fireClip: 'FireCycle',
        reloadClip: 'ReloadMag',
        expectMuzzleSocket: true,
      },
      {
        file: 'frag_grenade.glb',
        requiredBones: ['Bone_Body', 'Bone_Spoon', 'Bone_PinRing'],
        fireClip: 'FirePinPull',
        reloadClip: 'ReloadReady',
        expectMuzzleSocket: false,
      },
    ];

    for (const spec of weaponExpectations) {
      const { gltf } = readAndParseGlb(spec.file);
      const nodes = gltf.nodes ?? [];
      const animations = gltf.animations ?? [];
      const nodeByName = new Map(nodes.map((n) => [n.name ?? '', n]));

      for (const boneName of spec.requiredBones) {
        expect(nodeByName.has(boneName), `${spec.file} missing ${boneName}`).toBe(true);
      }

      const meshes = gltf.meshes ?? [];
      const accessors = gltf.accessors ?? [];
      let minMeshZ = Number.POSITIVE_INFINITY;
      for (const m of meshes) {
        for (const p of m.primitives) {
          const posAcc = accessors[p.attributes.POSITION];
          if (posAcc?.min) {
            minMeshZ = Math.min(minMeshZ, posAcc.min[2]);
          }
        }
      }

      if (spec.expectMuzzleSocket) {
        const muzzle = nodeByName.get('Bone_Muzzle');
        expect(muzzle, `${spec.file} missing Bone_Muzzle`).toBeDefined();
        expect(muzzle!.translation).toBeDefined();
        const [mx, my, mz] = muzzle!.translation!;
        // Bone_Muzzle sits at the barrel tip (>0.25m along Bone_Root's forward axis),
        // and the skinned weapon barrel geometry extends down PlayCanvas -Z (minMeshZ < -0.25m)!
        expect(Math.hypot(mx, my, mz)).toBeGreaterThan(0.25);
        expect(minMeshZ).toBeLessThan(-0.25);
      }

      const animNames = new Set(animations.map((a) => a.name ?? ''));
      expect(animNames.has('Idle'), `${spec.file} missing Idle`).toBe(true);
      expect(animNames.has(spec.fireClip), `${spec.file} missing ${spec.fireClip}`).toBe(true);
      expect(animNames.has(spec.reloadClip), `${spec.file} missing ${spec.reloadClip}`).toBe(true);
    }
  });
});
