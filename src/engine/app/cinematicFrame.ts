import * as pc from 'playcanvas';
import type { AdsFocus } from '../../core/ballistics/aim/aimDownSights.ts';

/**
 * The player camera's HDR frame: the scene is lit into a float target, then composed to the
 * screen with a filmic tone curve, bloom, a vignette and a light sharpen.
 *
 * Everything here is a handful of fullscreen passes at half resolution or lower. Ambient
 * occlusion is left out on purpose: it needs a depth prepass that redraws the whole scene,
 * which costs more of the 16 ms frame than the grounding it adds. Cast shadows do that job.
 * Depth of field needs that same prepass, so its depth and blur passes run only while aiming.
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

/** Scene-depth sampling flags a camera's shader keys carry while its frame renders a depth prepass. */
export interface SceneDepthShaderFlags {
  readonly linear: boolean;
  readonly packed: boolean;
  readonly reciprocal: boolean;
}

/** Shader output settings a camera needs for its programs to match the ones the HDR scene pass uses. */
export interface SceneShaderOutput {
  readonly toneMapping: number;
  readonly gammaCorrection: number;
  /** Present when the HDR frame renders a depth prepass; camera shader keys include these flags. */
  readonly sceneDepthMap?: SceneDepthShaderFlags;
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

const ADS_FOCUS_THRESHOLD = 0.02;
// A focus window this wide keeps the circle of confusion at zero for every depth the camera can
// see, so the depth-of-field compose returns the scene colour unchanged.
const NEUTRAL_FOCUS_DISTANCE_M = 0;
const NEUTRAL_FOCUS_RANGE_M = 1e6;

interface DofPassInternals {
  readonly _pass?: { readonly farPass?: pc.FramePass | null; readonly blurPass?: pc.FramePass | null } | null;
}

function setPassEnabled(pass: pc.FramePass | null | undefined, enabled: boolean): void {
  if (pass && pass.enabled !== enabled) pass.enabled = enabled;
}

export class CinematicFrame {
  private frame: pc.CameraFrame | null = null;
  private shaderOutput: SceneShaderOutput = DIRECT_TO_SCREEN;
  private aimFocused = false;

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
    // Depth of field stays enabled for the frame's whole life: toggling it rebuilds every render
    // target and pass and changes the camera's shader keys. At the hip the focus is neutral and
    // its depth and blur passes are switched off instead.
    frame.dof.nearBlur = true;
    frame.dof.enabled = true;
    CinematicFrame.applyNeutralFocus(frame);
    frame.update();
    this.frame = frame;
    const params = camera.shaderParams;
    this.shaderOutput = {
      ...INTO_HDR_TARGET,
      sceneDepthMap: {
        linear: params.sceneDepthMapLinear,
        packed: params.sceneDepthMapPacked,
        reciprocal: params.sceneDepthMapReciprocal,
      },
    };
  }

  /** Depth of field for aiming: sharp at the sight's range, soft elsewhere. Neutral at the hip. */
  public setAdsFocus(focus: AdsFocus): void {
    const frame = this.frame;
    if (!frame) return;
    const aimed = focus.strength > ADS_FOCUS_THRESHOLD;
    if (aimed !== this.aimFocused) {
      this.aimFocused = aimed;
      if (aimed) {
        frame.dof.focusDistance = focus.focusDistanceM;
        frame.dof.focusRange = focus.focusRangeM;
        frame.dof.blurRadius = Math.max(0.5, focus.blurRadius);
      } else {
        CinematicFrame.applyNeutralFocus(frame);
      }
      // Pushes the focus into the depth-of-field passes. The pass chain is unchanged, so nothing is rebuilt.
      frame.update();
    }
    // Applied every frame: a camera layer change rebuilds the passes with everything enabled.
    CinematicFrame.setDofWorkEnabled(frame, aimed);
  }

  private static applyNeutralFocus(frame: pc.CameraFrame): void {
    frame.dof.focusDistance = NEUTRAL_FOCUS_DISTANCE_M;
    frame.dof.focusRange = NEUTRAL_FOCUS_RANGE_M;
  }

  private static setDofWorkEnabled(frame: pc.CameraFrame, enabled: boolean): void {
    setPassEnabled(frame.renderPassCamera?.prePass as pc.FramePass | null | undefined, enabled);
    const dofPass = (frame.dof as unknown as DofPassInternals)._pass;
    setPassEnabled(dofPass?.farPass, enabled);
    setPassEnabled(dofPass?.blurPass, enabled);
  }

  /** False on headless devices, where the camera keeps drawing straight to the screen. */
  public get isActive(): boolean {
    return this.frame !== null;
  }

  /** What the scene's lit shaders are compiled for; the shader warm-up must draw with the same. */
  public get sceneShaderOutput(): SceneShaderOutput {
    return this.shaderOutput;
  }

  public destroy(): void {
    this.frame?.destroy();
    this.frame = null;
  }
}
