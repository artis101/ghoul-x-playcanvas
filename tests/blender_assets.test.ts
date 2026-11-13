import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pc from 'playcanvas';
import { describe, expect, it } from 'vitest';
import type { GhoulZoneId } from '../src/contracts/ballistics.ts';
import { ALL_GHOUL_ZONES, GHOUL_ZONE_HIERARCHY } from '../src/core/ghoul/anatomy.ts';
import {
  ALL_GLB_ASSET_KEYS, COMBATANT_ANIMATION_CLIPS, COMBATANT_SIDED_CLIPS, WEAPON_ASSET_IDS,
} from '../src/engine/assets/glbLoader.ts';
import { BLEND_SOURCES_DIR, readAndParseGlb, readVec4AccessorRow } from './blenderGlbFixtures.ts';
import { mirrorSources } from '../src/engine/assets/combatantClipMirror.ts';
import { DEATH_CLIP_SECONDS } from '../src/core/ballistics/lifecycle/deathAnimation.ts';

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

  it('ghoul_combatant.glb contains 37 low-poly submeshes, parent-only joint blending, and one side of the Kimodo clips', () => {
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
        zone !== 'SHOULDER_RIGHT' &&
        zone !== 'SHOULDER_LEFT';
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

        // Dismemberment invariant: a severable zone's vertices are weighted only to `Bone_${zone}` and its
        // parent bone. The runtime rebinds a severed zone to its own bone, so nothing else may pull on it.
        if (isSeverableOrHeadZone) {
          const ownBone = `Bone_${zone}`;
          const parentBone = `Bone_${GHOUL_ZONE_HIERARCHY[zone].parent}`;
          const scaleFactor =
            weightsAcc.componentType === 5121 ? 1 / 255 : weightsAcc.componentType === 5123 ? 1 / 65535 : 1;
          for (let vIdx = 0; vIdx < weightsAcc.count; vIdx++) {
            const jRow = readVec4AccessorRow(binChunk, bufferViews, jointsAcc, vIdx);
            const wRow = readVec4AccessorRow(binChunk, bufferViews, weightsAcc, vIdx);
            let total = 0;
            for (let slot = 0; slot < 4; slot++) {
              const weight = wRow[slot] * scaleFactor;
              if (weight < 0.001) continue;
              total += weight;
              expect([ownBone, parentBone], `${zoneMeshName} v${vIdx} influence`).toContain(jointNameBySkinIdx[jRow[slot]]);
            }
            expect(total, `${zoneMeshName} v${vIdx} total weight`).toBeGreaterThan(0.999);
          }
        }
      }
      expect(totalVertsInZone, `${zoneMeshName} must be modelled (>24 verts)`).toBeGreaterThan(24);
    }

    // Grounded flat at y ≈ 0.00m and ~1.80m tall
    expect(globalMinY).toBeGreaterThanOrEqual(-0.005);
    expect(globalMinY).toBeLessThanOrEqual(0.02);
    expect(globalMaxY).toBeGreaterThan(1.76);
    expect(globalMaxY).toBeLessThan(1.86);

    // 2. Toggleable Gear (Archetype Headgear + Eviscerated Gut) & Internal X-Ray Anatomy submeshes (14 extra = 36, plus Skin_Library)
    const requiredExtraMeshes = [
      'Gear_ESAPI_PlateCarrier',
      'Gear_PASGT_Helmet',
      'Gear_TacticalVisor',
      'Gear_BoonieHat',
      'Gear_PunkMohawk',
      'Gear_GasMask',
      'Gear_EvisceratedGut',
      'Organ_Brain',
      'Organ_Heart',
      'Organ_Lungs',
      'Organ_Liver',
      'Skelet_Skull',
      'Skelet_RibcageSpine',
      'Skelet_Pelvis',
      'Skin_Library',
    ];
    for (const extraName of requiredExtraMeshes) {
      expect(nodeNames.has(extraName), `Missing node ${extraName}`).toBe(true);
      expect(meshByName.has(extraName), `Missing mesh ${extraName}`).toBe(true);
    }
    expect(meshes.length).toBe(37);

    // One hand-painted, point-sampled skin page per archetype, diffuse only.
    for (const archetype of ['SKINHEAD_PUNK', 'MILITIA_GUNNER', 'MASKED_BRUISER', 'HEAVY_ENFORCER', 'SNIPER_OPERATIVE']) {
      const material = gltf.materials?.find((entry) => entry.name === `Mat_Skin_${archetype}`);
      const texture = material?.pbrMetallicRoughness?.baseColorTexture as { index: number } | undefined;
      expect(texture, `Missing skin page for ${archetype}`).toBeDefined();
      expect(material?.normalTexture).toBeUndefined();
      const sampler = gltf.samplers?.[gltf.textures?.[texture!.index]?.sampler ?? -1];
      expect(sampler?.magFilter).toBe(9728);
    }

    // 3. 22-Bone Armature skinning
    for (const zone of ALL_GHOUL_ZONES) {
      expect(nodeNames.has(`Bone_${zone}`), `Missing joint Bone_${zone}`).toBe(true);
    }

    // 4. One side only: every handed clip right-handed, every sided clip that is not a mirror.
    // The `_Southpaw` twins and the mirrored Left wound clips are made at load (combatantClipMirror.ts).
    const animNames = new Set(animations.map((a) => a.name ?? ''));
    const mirrored = mirrorSources();
    const baked = [...COMBATANT_ANIMATION_CLIPS, ...COMBATANT_SIDED_CLIPS].filter((clip) => !mirrored.has(clip));
    expect([...animNames].sort()).toEqual([...baked].sort());
    for (const clip of baked) {
      expect(animations.find((a) => a.name === clip)!.channels.length, clip).toBeGreaterThan(10);
    }
  });

  it('bakes the death clips once, at the lengths the core times them by, and the one-handed pistol hold', () => {
    const { gltf } = readAndParseGlb('ghoul_combatant.glb');
    const animations = gltf.animations ?? [];
    const lengthOf = (name: string): number => {
      const anim = animations.find((a) => a.name === name);
      expect(anim, `Missing clip ${name}`).toBeDefined();
      let end = 0;
      for (const sampler of anim!.samplers) {
        const max = gltf.accessors?.[sampler.input]?.max?.[0] ?? 0;
        end = Math.max(end, max);
      }
      return end;
    };
    for (const [clip, seconds] of Object.entries(DEATH_CLIP_SECONDS)) {
      // The last key sits one 20 fps frame before the clip's nominal end.
      expect(Math.abs(lengthOf(clip) - seconds), clip).toBeLessThanOrEqual(0.06);
      expect(animations.some((a) => a.name === `${clip}_Southpaw`), `${clip} has no twin`).toBe(false);
    }
    expect(lengthOf('PistolOneHandHold')).toBeCloseTo(0.85, 1);
    expect(COMBATANT_SIDED_CLIPS).toEqual(expect.arrayContaining(Object.keys(DEATH_CLIP_SECONDS)));
    expect(COMBATANT_ANIMATION_CLIPS).toContain('PistolOneHandHold');
    expect(animations.length).toBe(48);
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
