export type PreloadPhaseId =
  | 'FONTS_AND_DOM'
  | 'WASM_PHYSICS'
  | 'MODELS_AND_GRAPHS'
  | 'PROCEDURAL_TEXTURES'
  | 'AUDIO_DSP'
  | 'WORLD_COMPOSITION'
  | 'SHADER_COMPILATION'
  | 'READY';

export interface PreloadProgressSnapshot {
  readonly phase: PreloadPhaseId;
  readonly phaseLabel: string;
  readonly itemLabel: string;
  readonly overallProgress: number;
  readonly phaseProgress: number;
  readonly completedSteps: number;
  readonly totalSteps: number;
  readonly elapsedMs: number;
}

export type PreloadProgressCallback = (snapshot: PreloadProgressSnapshot) => void;

export interface AssetLoadProgressEvent {
  readonly assetKey: string;
  readonly url: string;
  readonly loadedCount: number;
  readonly totalCount: number;
}
