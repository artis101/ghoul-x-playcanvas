import * as pc from 'playcanvas';
import type { GlbModelRegistry } from '../assets/glbModelRegistry.ts';
import { WEAPON_ASSET_IDS } from '../assets/glbTypes.ts';
import { getBloodSoakedTwin } from '../mannequin/combatantGlbMaterials.ts';
import { collectSceneMaterials } from './materialCollector.ts';
import { stageViewmodelsForWarmup } from './warmupViewmodels.ts';
import {
  collectSceneMeshInstances,
  createShapeMatchedDraw,
  PrimitiveShapeWarmup,
  stageWarmupDraws,
  type WarmupDraw,
} from './warmupVariants.ts';

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

  let compiledMaterials = 0;
  let warmedVariants = 0;

  let stagingRoot: pc.Entity | null = null;
  let primitiveShapes: PrimitiveShapeWarmup | null = null;
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
      toneMapping: pc.TONEMAP_LINEAR,
      gammaCorrection: pc.GAMMA_SRGB,
    });
    warmupCam.setPosition(0, -250, 0);
    stagingRoot.addChild(warmupCam);

    // No warm-up lights: directional lights are compiled into every lit shader, so an extra one
    // here would warm programs the game never asks for. The arena's own sun is already in the scene.

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

    // 1. Every material on the exact mesh shapes the scene already holds (pools included), plus
    //    the blood-soaked twin each skinned body part swaps to when it is first wounded.
    const fallbackVb = instancingVb;
    const draws: WarmupDraw[] = [];
    for (const live of collectSceneMeshInstances(app)) {
      const liveMat = live.material;
      if (!liveMat) continue;
      draws.push(createShapeMatchedDraw(live, liveMat, fallbackVb));
      const bloodyTwin = getBloodSoakedTwin(liveMat);
      if (bloodyTwin) draws.push(createShapeMatchedDraw(live, bloodyTwin, fallbackVb));
    }
    // 2. Every material on the primitive shapes used by effects that are spawned on demand.
    primitiveShapes = new PrimitiveShapeWarmup(device);
    for (const mat of allMaterials) {
      draws.push(...primitiveShapes.createDraws(mat));
      compiledMaterials += 1;
    }

    const batchSize = 64;
    const batchCount = Math.ceil(draws.length / batchSize);
    const totalSteps = Math.max(1, batchCount + 2);
    for (let b = 0; b < batchCount; b++) {
      const batch = draws.slice(b * batchSize, (b + 1) * batchSize);
      const firstMatName = batch[0]?.meshInstance.material?.name || 'PBR Material';
      onProgress?.(
        `Compiling shader batch ${b + 1}/${batchCount} (${firstMatName})...`,
        b + 1,
        totalSteps
      );

      const batchEntity = new pc.Entity(`WarmupBatch_${b}`);
      batchEntity.setPosition(0, -250, -3);
      stagingRoot.addChild(batchEntity);
      stageWarmupDraws(batchEntity, batch);

      stagingRoot.syncHierarchy();
      app.render();
      warmedVariants += batch.length;

      for (const draw of batch) draw.release();
      batchEntity.destroy();

      await nextAnimationFrame(yieldFrames);
    }

    onProgress?.(
      'Compiling skinned GHOUL anatomy shader permutations...',
      batchCount + 1,
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
        if (tempCombatant.gasMask) tempCombatant.gasMask.enabled = true;
        if (tempCombatant.evisceratedGut) tempCombatant.evisceratedGut.enabled = true;

        tempCombatant.setInternalAnatomyVisible(false);
        stagingRoot.syncHierarchy();
        app.render();
        warmedVariants += 16;

        tempCombatant.setInternalAnatomyVisible(true);
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
      tempWeapons.push({ destroy: stageViewmodelsForWarmup(stagingRoot, warmupCam, glbRegistry) });
      stagingRoot.syncHierarchy();
      app.render();
    } catch (err: unknown) {
      console.warn('GHOUL-X weapon shader warm-up stopped early:', err);
    } finally {
      for (const w of tempWeapons) {
        w.destroy();
      }
    }
  } catch (err: unknown) {
    // A failed warm-up must not block boot, but say so: every shader it skipped compiles mid-game.
    console.warn('GHOUL-X shader warm-up stopped early:', err);
  } finally {
    stagingRoot?.destroy();
    instancingVb?.destroy();
    primitiveShapes?.destroy();
  }

  return { compiledMaterials, warmedVariants };
}
