import * as pc from 'playcanvas';
import type { CombatantAnimationClipName } from '../assets/glbTypes.ts';

/**
 * The upper-body anim layer (docs/procedural-animation-audit.md, "B-layer"). The base layer plays
 * the gait; this layer, masked to the chest, both arms, the neck and the head, plays the aim or
 * carry clip over it. A body can then walk, strafe or back off with its gun up on the target
 * instead of carrying it at the hip, and a one-handed pistol aim keeps its stump tucked in.
 *
 * Its weight is 0 whenever the base clip owns the whole body: standing still, wounds, falls,
 * draws, the seated last stand and the crawl.
 */

export const UPPER_BODY_LAYER = 'UpperBody';
/** Blend time for the layer's weight and for a change of upper clip. */
export const UPPER_BODY_BLEND_S = 0.15;

/** The clips the upper layer can play: aims, and the carries of a body whose gait clip lacks them. */
export const UPPER_BODY_CLIPS = [
  'LongGunAim', 'PistolAim', 'PistolAimOneHand', 'PistolOneHandHold', 'CombatReadyIdle', 'HurtIdle',
  'UnarmedIdle', 'StumpClutchRight', 'StumpClutchLeft',
] as const satisfies readonly CombatantAnimationClipName[];

export type UpperBodyClip = (typeof UPPER_BODY_CLIPS)[number];

/** The upper clip asked for this frame; `southpaw` picks the `_Southpaw` twin when there is one. */
export interface UpperBodyRequest {
  readonly clip: UpperBodyClip;
  readonly southpaw: boolean;
}

/**
 * The lowest masked bone. The lower abdomen stays with the gait so the hips and the small of the
 * back keep swinging with the legs; everything above it (thorax, neck, head, both arms, and any
 * gear or props parented to them) follows the upper clip.
 */
const MASK_ROOT_BONE = 'Bone_TORSO_UPPER_THORAX';

const UPPER_CLIP_SET: ReadonlySet<string> = new Set(UPPER_BODY_CLIPS);

export function isUpperBodyClipName(name: string): boolean {
  return UPPER_CLIP_SET.has(name.replace(/_Southpaw$/, ''));
}

/**
 * The layer mask, or null when the rig has no thorax bone. PlayCanvas matches a mask key against
 * the path the GLB's curves use, starting either at the curve's own top node or at the name of
 * the entity the anim component sits on. The GLB's top node may be the instanced root itself
 * (renamed) or a child of it, so the key is given both ways.
 */
export function upperBodyMask(root: pc.GraphNode): Record<string, { children: true }> | null {
  const bone = root.findByName(MASK_ROOT_BONE);
  if (!bone) return null;
  const names: string[] = [];
  for (let node: pc.GraphNode | null = bone; node && node !== root; node = node.parent) names.unshift(node.name);
  const below = names.join('/');
  return { [below]: { children: true }, [`${root.name}/${below}`]: { children: true } };
}

/**
 * Adds the masked upper layer to the combatant's anim component, with its clips. Called once, from
 * the GLB instancing, after the base layer has its clips. Returns null when the rig cannot be
 * masked, in which case the body simply plays one clip at a time as before.
 */
export function addUpperBodyLayer(
  animComponent: pc.AnimComponent,
  root: pc.GraphNode,
  tracks: ReadonlyMap<string, pc.AnimTrack>,
  isLooping: (clipName: string) => boolean,
): pc.AnimComponentLayer | null {
  const mask = upperBodyMask(root);
  if (!mask) return null;
  const layer = animComponent.addLayer(UPPER_BODY_LAYER, 0, mask);
  if (!layer) return null;
  layer.mask = mask;
  for (const [name, track] of tracks) {
    if (isUpperBodyClipName(name)) animComponent.assignAnimation(name, track, UPPER_BODY_LAYER, 1, isLooping(name));
  }
  // The base layer's curve targets were bound for one layer; bind them again for two.
  animComponent.rebind();
  return layer;
}

type LayerHost = { readonly animComponent: pc.AnimComponent | null };

function findLayer(glb: LayerHost): pc.AnimComponentLayer | null {
  // Test doubles of the anim component have no layers; they simply play one clip at a time.
  const anim = glb.animComponent;
  return typeof anim?.findLayer === 'function' ? anim.findLayer(UPPER_BODY_LAYER) ?? null : null;
}

/** Drives the upper layer of one combatant: which clip it plays and how much it shows. */
export class CombatantUpperBodyLayer {
  /** The layer state playing now (a twin carries its `_Southpaw` suffix), or null when faded out. */
  public activeState: string | null = null;
  private targetWeight = 0;

  public reset(): void {
    this.activeState = null;
    this.targetWeight = 0;
  }

  /** The upper clip asked for this frame, by its base name, or null while the layer is off. */
  public get clip(): UpperBodyClip | null {
    return this.activeState ? (this.activeState.replace(/_Southpaw$/, '') as UpperBodyClip) : null;
  }

  /**
   * Plays `request` on the upper layer and fades the layer in, or fades it out for null. A clip
   * is started once; asking for it again leaves it running (or holding its last frame).
   */
  public sync(glb: LayerHost, request: UpperBodyRequest | null): void {
    const layer = findLayer(glb);
    if (!layer) {
      this.activeState = null;
      return;
    }
    if (!request) {
      this.fadeTo(layer, 0);
      this.activeState = null;
      return;
    }
    const states = layer.states;
    const twin = `${request.clip}_Southpaw`;
    const state = request.southpaw && states.includes(twin) ? twin : request.clip;
    if (!states.includes(state)) {
      this.fadeTo(layer, 0);
      this.activeState = null;
      return;
    }
    if (layer.activeState !== state) layer.transition(state, this.targetWeight > 0 ? UPPER_BODY_BLEND_S : 0);
    layer.playing = true;
    this.activeState = state;
    this.fadeTo(layer, 1);
  }

  private fadeTo(layer: pc.AnimComponentLayer, weight: number): void {
    if (this.targetWeight === weight) return;
    this.targetWeight = weight;
    layer.blendToWeight(weight, UPPER_BODY_BLEND_S);
  }
}
