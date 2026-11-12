import * as pc from 'playcanvas';
import type { GlbModelRegistry } from '../assets/glbModelRegistry.ts';
import { WEAPON_ASSET_IDS } from '../assets/glbTypes.ts';
import { collectSceneMaterials } from './materialCollector.ts';

export interface ShaderWarmupOptions {
  readonly app: pc.Application;
  readonly glbRegistry: GlbModelRegistry;
  readonly extraMaterials?: readonly pc.Material[];
  readonly onProgress?: (label: string, done: number, total: number) => void;
  readonly yieldFrames?: boolean;
}

export interface ShaderWarmupResult {
  readonly compiledMaterials: number;
  readonly warmedVariants: number;
}

function createStagingQuadMesh(device: pc.GraphicsDevice, includeTangents: boolean): pc.Mesh {
  const mesh = new pc.Mesh(device);
  mesh.setPositions(new Float32Array([-0.4, -0.4, 0, 0.4, -0.4, 0, 0.4, 0.4, 0, -0.4, 0.4, 0]));
  mesh.setNormals(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]));
  mesh.setUvs(0, new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]));
  mesh.setColors(new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]));
  if (includeTangents) {
    mesh.setVertexStream(
      pc.SEMANTIC_TANGENT,
      new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
      4
    );
  }
  mesh.setIndices(new Uint16Array([0, 1, 2, 0, 2, 3]));
  mesh.update(pc.PRIMITIVE_TRIANGLES);
  mesh.incRefCount();
  return mesh;
}

function nextAnimationFrame(shouldYield: boolean): Promise<void> {
  if (!shouldYield || typeof requestAnimationFrame !== 'function') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function canRenderShadersOnDevice(app: pc.Application | null | undefined): boolean {
  if (!app || !app.graphicsDevice || !app.root || typeof app.render !== 'function') {
    return false;
  }
  const dev = app.graphicsDevice;
  if (dev instanceof pc.NullGraphicsDevice) {
    return false;
  }
  const glAware = dev as unknown as { gl?: unknown; isWebGPU?: boolean };
  return Boolean(glAware.gl || glAware.isWebGPU);
}

export async function compileAllGameShaders(
  options: ShaderWarmupOptions
): Promise<ShaderWarmupResult> {
  const { app, glbRegistry, extraMaterials, onProgress, yieldFrames = true } = options;

  if (!canRenderShadersOnDevice(app)) {
    onProgress?.('Skipping GPU shader warm-up (headless graphics device)...', 1, 1);
    return { compiledMaterials: 0, warmedVariants: 0 };
  }

  const device = app.graphicsDevice;
  const materialSet = new Set<pc.Material>(collectSceneMaterials(app.root));
  if (extraMaterials) {
    for (const m of extraMaterials) {
      if (m) materialSet.add(m);
    }
  }
  const allMaterials = Array.from(materialSet);

  const batchSize = 10;
  const batches: pc.Material[][] = [];
  for (let i = 0; i < allMaterials.length; i += batchSize) {
    batches.push(allMaterials.slice(i, i + batchSize));
  }

  const totalSteps = Math.max(1, batches.length + 2);
  let compiledMaterials = 0;
  let warmedVariants = 0;

  let stagingRoot: pc.Entity | null = null;
  let meshNoTangents: pc.Mesh | null = null;
  let meshWithTangents: pc.Mesh | null = null;
  let instancingVb: pc.VertexBuffer | null = null;

  try {
    stagingRoot = new pc.Entity('PreloaderShaderWarmupStaging');
    app.root.addChild(stagingRoot);

    const warmupCam = new pc.Entity('WarmupShaderCamera');
    warmupCam.addComponent('camera', {
      clearColorBuffer: false,
      clearDepthBuffer: true,
      nearClip: 0.1,
      farClip: 25,
      fov: 60,
      priority: -100,
      rect: new pc.Vec4(0, 0, 0.04, 0.04),
      toneMapping: pc.TONEMAP_ACES,
      gammaCorrection: pc.GAMMA_SRGB,
    });
    warmupCam.setPosition(0, -250, 0);
    stagingRoot.addChild(warmupCam);

    const warmupDirLight = new pc.Entity('WarmupShadowDirLight');
    warmupDirLight.addComponent('light', {
      type: 'directional',
      color: new pc.Color(1.0, 0.95, 0.86),
      intensity: 1.5,
      castShadows: true,
      shadowType: pc.SHADOW_PCF3_16F,
      shadowResolution: 512,
      shadowDistance: 15,
      numCascades: 2,
      cascadeBlend: 0.15,
    });
    warmupDirLight.setPosition(0, -248, 0);
    warmupDirLight.setEulerAngles(48, 32, 0);
    stagingRoot.addChild(warmupDirLight);

    const warmupPointLight = new pc.Entity('WarmupOmniLight');
    warmupPointLight.addComponent('light', {
      type: 'point',
      color: new pc.Color(1.0, 0.8, 0.45),
      intensity: 2.2,
      range: 12,
      castShadows: false,
    });
    warmupPointLight.setPosition(0, -249.2, -2.2);
    stagingRoot.addChild(warmupPointLight);

    meshNoTangents = createStagingQuadMesh(device, false);
    meshWithTangents = createStagingQuadMesh(device, true);

    const instancingFormat = pc.VertexFormat.getDefaultInstancingFormat(device);
    const instanceMatrices = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, -250, -3, 1,
    ]);
    instancingVb = new pc.VertexBuffer(device, instancingFormat, 1, {
      usage: pc.BUFFER_STATIC,
      data: instanceMatrices,
    });

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      const firstMatName = batch[0]?.name || 'PBR Material';
      onProgress?.(
        `Compiling shader batch ${b + 1}/${batches.length} (${firstMatName})...`,
        b + 1,
        totalSteps
      );

      const batchEntity = new pc.Entity(`WarmupBatch_${b}`);
      batchEntity.setPosition(0, -250, -3);
      stagingRoot.addChild(batchEntity);

      const meshInstances: pc.MeshInstance[] = [];
      const instancedMeshInstances: pc.MeshInstance[] = [];

      for (const mat of batch) {
        const stdMat = mat instanceof pc.StandardMaterial ? mat : null;
        const requiresTangents = Boolean(stdMat?.heightMap);
        const primaryMesh = requiresTangents ? meshWithTangents : meshNoTangents;

        const standardMi = new pc.MeshInstance(primaryMesh, mat);
        standardMi.cull = false;
        standardMi.castShadows = true;
        standardMi.receiveShadows = true;
        meshInstances.push(standardMi);
        warmedVariants += 1;

        const instancedMi = new pc.MeshInstance(primaryMesh, mat);
        instancedMi.setInstancing(instancingVb);
        instancedMi.instancingCount = 1;
        instancedMi.cull = false;
        instancedMi.castShadows = !requiresTangents;
        instancedMi.receiveShadows = true;
        meshInstances.push(instancedMi);
        instancedMeshInstances.push(instancedMi);
        warmedVariants += 1;

        if (!requiresTangents && stdMat?.normalMap) {
          const tangentMi = new pc.MeshInstance(meshWithTangents, mat);
          tangentMi.cull = false;
          tangentMi.castShadows = true;
          tangentMi.receiveShadows = true;
          meshInstances.push(tangentMi);
          warmedVariants += 1;
        }

        compiledMaterials += 1;
      }

      batchEntity.addComponent('render', {
        meshInstances,
        castShadows: true,
        receiveShadows: true,
      });

      stagingRoot.syncHierarchy();
      app.render();

      for (const instMi of instancedMeshInstances) {
        instMi.setInstancing(null);
      }
      batchEntity.destroy();

      await nextAnimationFrame(yieldFrames);
    }

    onProgress?.(
      'Compiling skinned GHOUL anatomy & X-Ray organ shader permutations...',
      batches.length + 1,
      totalSteps
    );
    if (glbRegistry.isLoaded('ghoul_combatant')) {
      let tempCombatant: ReturnType<GlbModelRegistry['instantiateCombatant']> | null = null;
      try {
        tempCombatant = glbRegistry.instantiateCombatant({
          castShadows: true,
          receiveShadows: true,
        });
        stagingRoot.addChild(tempCombatant.rootEntity);
        tempCombatant.rootEntity.setPosition(0, -250.8, -3.2);
        if (tempCombatant.tacticalVisor) tempCombatant.tacticalVisor.enabled = true;
        if (tempCombatant.boonieHat) tempCombatant.boonieHat.enabled = true;
        if (tempCombatant.punkMohawk) tempCombatant.punkMohawk.enabled = true;
        if (tempCombatant.evisceratedGut) tempCombatant.evisceratedGut.enabled = true;

        tempCombatant.setXRayVisible(false);
        stagingRoot.syncHierarchy();
        app.render();
        warmedVariants += 16;

        tempCombatant.setXRayVisible(true);
        stagingRoot.syncHierarchy();
        app.render();
        warmedVariants += 7;
      } catch {
        // Ignore in headless/partial test containers
      } finally {
        tempCombatant?.destroy();
      }
      await nextAnimationFrame(yieldFrames);
    }

    onProgress?.(
      'Compiling 3D arsenal & viewmodel weapon shader permutations...',
      totalSteps,
      totalSteps
    );
    const tempWeapons: Array<{ destroy(): void }> = [];
    try {
      for (let i = 0; i < WEAPON_ASSET_IDS.length; i++) {
        const weaponId = WEAPON_ASSET_IDS[i];
        if (!glbRegistry.isLoaded(weaponId)) continue;
        const w = glbRegistry.instantiateWeapon(weaponId, {
          castShadows: true,
          receiveShadows: true,
        });
        tempWeapons.push(w);
        stagingRoot.addChild(w.rootEntity);
        w.rootEntity.setPosition((i - 2) * 0.25, -250, -2.5);
        warmedVariants += 2;
      }
      if (tempWeapons.length > 0) {
        stagingRoot.syncHierarchy();
        app.render();
      }
    } catch {
      // Ignore in headless/partial test containers
    } finally {
      for (const w of tempWeapons) {
        w.destroy();
      }
    }
  } catch {
    // Gracefully absorb any unexpected graphics pipeline error in mocked/headless environments
  } finally {
    stagingRoot?.destroy();
    instancingVb?.destroy();
    meshNoTangents?.destroy();
    meshWithTangents?.destroy();
  }

  return { compiledMaterials, warmedVariants };
}
