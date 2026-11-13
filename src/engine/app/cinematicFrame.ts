import * as pc from 'playcanvas';
import type { AdsFocus } from '../../core/ballistics/aim/aimDownSights.ts';

/**
 * The player camera's HDR frame: the scene is lit into a float target, then composed to the
 * screen with a filmic tone curve, bloom, a vignette and a light sharpen.
 *
 * Everything here is a handful of fullscreen passes at half resolution or lower. Ambient
 * occlusion is left out on purpose: it needs a depth prepass that redraws the whole scene,
 * which costs more of the 16 ms frame than the grounding it adds. Cast shadows do that job.
 */
export interface CinematicFrameLook {
  readonly msaaSamples: number;
  readonly bloomIntensity: number;
  readonly bloomBlurLevel: number;
  readonly vignetteIntensity: number;
  readonly vignetteInner: number;
  readonly vignetteOuter: number;
  readonly sharpness: number;
}

export const DEFAULT_CINEMATIC_LOOK: CinematicFrameLook = {
  msaaSamples: 4,
  bloomIntensity: 0.035,
  bloomBlurLevel: 7,
  vignetteIntensity: 0.5,
  vignetteInner: 0.45,
  vignetteOuter: 1.1,
  sharpness: 0.3,
};

/** Shader output settings a camera needs for its programs to match the ones the HDR scene pass uses. */
export interface SceneShaderOutput {
  readonly toneMapping: number;
  readonly gammaCorrection: number;
}

const DIRECT_TO_SCREEN: SceneShaderOutput = {
  toneMapping: pc.TONEMAP_LINEAR,
  gammaCorrection: pc.GAMMA_SRGB,
};

const INTO_HDR_TARGET: SceneShaderOutput = {
  toneMapping: pc.TONEMAP_NONE,
  gammaCorrection: pc.GAMMA_NONE,
};

function canPostProcess(device: pc.GraphicsDevice): boolean {
  if (device instanceof pc.NullGraphicsDevice) return false;
  const glAware = device as unknown as { gl?: unknown; isWebGPU?: boolean };
  return Boolean(glAware.gl || glAware.isWebGPU);
}

export class CinematicFrame {
  private frame: pc.CameraFrame | null = null;

  public constructor(
    app: pc.AppBase,
    camera: pc.CameraComponent | undefined,
    look: CinematicFrameLook = DEFAULT_CINEMATIC_LOOK
  ) {
    if (!camera || !canPostProcess(app.graphicsDevice)) return;

    const frame = new pc.CameraFrame(app, camera);
    frame.rendering.samples = look.msaaSamples;
    frame.rendering.toneMapping = pc.TONEMAP_ACES2;
    frame.rendering.sharpness = look.sharpness;
    frame.bloom.intensity = look.bloomIntensity;
    frame.bloom.blurLevel = look.bloomBlurLevel;
    frame.vignette.intensity = look.vignetteIntensity;
    frame.vignette.inner = look.vignetteInner;
    frame.vignette.outer = look.vignetteOuter;
    frame.update();
    this.frame = frame;
  }

  /** Depth of field for aiming: sharp at the sight's range, soft elsewhere. Off at the hip. */
  public setAdsFocus(focus: AdsFocus): void {
    const frame = this.frame;
    if (!frame) return;
    const on = focus.strength > 0.02;
    if (on) {
      frame.dof.focusDistance = focus.focusDistanceM;
      frame.dof.focusRange = focus.focusRangeM;
      frame.dof.blurRadius = Math.max(0.5, focus.blurRadius);
      frame.dof.nearBlur = true;
    }
    if (frame.dof.enabled !== on) {
      frame.dof.enabled = on;
      frame.update();
    }
  }

  /** False on headless devices, where the camera keeps drawing straight to the screen. */
  public get isActive(): boolean {
    return this.frame !== null;
  }

  /** What the scene's lit shaders are compiled for; the shader warm-up must draw with the same. */
  public get sceneShaderOutput(): SceneShaderOutput {
    return this.frame ? INTO_HDR_TARGET : DIRECT_TO_SCREEN;
  }

  public destroy(): void {
    this.frame?.destroy();
    this.frame = null;
  }
}
