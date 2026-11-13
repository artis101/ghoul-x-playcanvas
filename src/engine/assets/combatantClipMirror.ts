import * as pc from 'playcanvas';
import { COMBATANT_ANIMATION_CLIPS, COMBATANT_SIDED_CLIPS } from './glbTypes.ts';

/**
 * Left-right mirrored clips, made from the right-handed takes when the GLB loads, so the bake only
 * has to ship one side.
 *
 * The combatant's rest pose is symmetric about the model's X = 0 plane: every `_LEFT` bone sits
 * where its `_RIGHT` twin does with x negated, and its local rotation is the twin's
 * (x, -y, -z, w). So a pose mirrors bone by bone, in local space: swap each LEFT/RIGHT pair, negate
 * x in every position and y and z in every rotation. Centre bones map onto themselves.
 */

const SOUTHPAW = '_Southpaw';

/** Swaps `_LEFT` and `_RIGHT` in a bone name. */
export function mirrorBoneName(name: string): string {
  if (name.includes('_LEFT')) return name.replace('_LEFT', '_RIGHT');
  if (name.includes('_RIGHT')) return name.replace('_RIGHT', '_LEFT');
  return name;
}

/** Swaps the `Left`/`Right` side word in a clip name (StrafeLeft, HitFlinchArmRight, ...). */
export function swapClipSide(clip: string): string {
  if (/Left(?=$|_)/.test(clip)) return clip.replace(/Left(?=$|_)/, 'Right');
  if (/Right(?=$|_)/.test(clip)) return clip.replace(/Right(?=$|_)/, 'Left');
  return clip;
}

/** Mirrors keyframe values of one transform property in place. */
export function mirrorValues(property: string, components: number, data: Float32Array | number[]): void {
  if (property === 'localPosition' && components === 3) {
    for (let i = 0; i < data.length; i += 3) data[i] = -data[i];
  } else if (property === 'localRotation' && components === 4) {
    for (let i = 0; i < data.length; i += 4) {
      data[i + 1] = -data[i + 1];
      data[i + 2] = -data[i + 2];
    }
  }
}

/** The mirror image of `track`, named `name`. Inputs (key times) are shared with the source. */
export function mirrorTrack(track: pc.AnimTrack, name: string): pc.AnimTrack {
  const outputs = new Map<number, pc.AnimData>();
  const curves = track.curves.map((curve) => {
    const property = curve.paths[0]?.propertyPath[0] ?? '';
    if (!outputs.has(curve.output)) {
      const source = track.outputs[curve.output];
      const data = Float32Array.from(source.data);
      mirrorValues(property, source.components, data);
      outputs.set(curve.output, new pc.AnimData(source.components, data));
    }
    const paths = curve.paths.map((p) => ({ ...p, entityPath: p.entityPath.map(mirrorBoneName) }));
    return new pc.AnimCurve(paths, curve.input, curve.output, curve.interpolation);
  });
  const mirroredOutputs = track.outputs.map((out, i) => outputs.get(i) ?? out);
  return new pc.AnimTrack(name, track.duration, track.inputs, mirroredOutputs, curves);
}

/**
 * Which clip each generated one mirrors. A left-handed body doing X is a right-handed body doing
 * the other-side X, mirrored: `StrafeLeft_Southpaw` mirrors `StrafeRight`, `HitFlinchArmRight_Southpaw`
 * mirrors `HitFlinchArmLeft`. A sided wound `...Left` clip is its `...Right` clip mirrored.
 */
export function mirrorSources(): ReadonlyMap<string, string> {
  const sources = new Map<string, string>();
  for (const clip of COMBATANT_ANIMATION_CLIPS) sources.set(clip + SOUTHPAW, swapClipSide(clip));
  for (const clip of COMBATANT_SIDED_CLIPS) {
    if (/Left$/.test(clip) && COMBATANT_SIDED_CLIPS.includes(swapClipSide(clip) as never)) {
      sources.set(clip, swapClipSide(clip));
    }
  }
  return sources;
}

const MIRROR_SOURCES = mirrorSources();

/**
 * Adds every mirrored clip the GLB does not ship to `tracks`. A clip the GLB already has is kept
 * as baked, so an older GLB with its twins still plays them.
 */
export function addMirroredClips(tracks: Map<string, pc.AnimTrack>): string[] {
  const added: string[] = [];
  for (const [clip, source] of MIRROR_SOURCES) {
    if (tracks.has(clip)) continue;
    const track = tracks.get(source);
    if (!track) continue;
    tracks.set(clip, mirrorTrack(track, clip));
    added.push(clip);
  }
  return added;
}

const containerTracks = new WeakMap<object, Map<string, pc.AnimTrack>>();

/** The container's clips by name, mirrored ones included. Built once per container. */
export function combatantTracks(container: pc.ContainerResource): Map<string, pc.AnimTrack> {
  const cached = containerTracks.get(container);
  if (cached) return cached;
  const tracks = new Map<string, pc.AnimTrack>();
  for (const asset of container.animations ?? []) {
    const track = asset.resource as pc.AnimTrack | undefined;
    if (track) tracks.set(track.name || asset.name, track);
  }
  addMirroredClips(tracks);
  containerTracks.set(container, tracks);
  return tracks;
}
