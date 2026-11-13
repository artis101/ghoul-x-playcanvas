import * as pc from 'playcanvas';
import { describe, expect, it, vi } from 'vitest';
import { createTargetHealthState } from '../src/core/ghoul/anatomy.ts';
import { vec3 } from '../src/core/ballistics/vec3.ts';
import { COMBATANT_ANIMATION_CLIPS, COMBATANT_SIDED_CLIPS } from '../src/engine/assets/glbLoader.ts';
import { CombatantAnimController } from '../src/engine/mannequin/combatantAnimController.ts';
import {
  addUpperBodyLayer, CombatantUpperBodyLayer, UPPER_BODY_LAYER, upperBodyMask,
} from '../src/engine/mannequin/combatantUpperBodyLayer.ts';
import { markWeaponPickupProgress } from '../src/engine/ai/weaponRecovery.ts';

const ALL_CLIPS: ReadonlySet<string> = new Set([...COMBATANT_ANIMATION_CLIPS, ...COMBATANT_SIDED_CLIPS]);
const ARMATURE = ['GhoulArmature', 'Bone_PELVIS_GROIN', 'Bone_TORSO_LOWER_ABDOMEN', 'Bone_TORSO_UPPER_THORAX'];
const THIGH = ['GhoulArmature', 'Bone_PELVIS_GROIN', 'Bone_THIGH_RIGHT'];

/** A clip that holds the thorax and the right thigh at fixed yaw angles (degrees). */
function holdTrack(name: string, thoraxDeg: number, thighDeg: number): pc.AnimTrack {
  const q = (deg: number): number[] => {
    const r = new pc.Quat().setFromEulerAngles(0, deg, 0);
    return [r.x, r.y, r.z, r.w, r.x, r.y, r.z, r.w];
  };
  const input = new pc.AnimData(1, [0, 1]);
  const outputs = [new pc.AnimData(4, q(thoraxDeg)), new pc.AnimData(4, q(thighDeg))];
  const curves = [
    new pc.AnimCurve([{ entityPath: ARMATURE, component: 'graph', propertyPath: ['localRotation'] }], 0, 0, pc.INTERPOLATION_LINEAR),
    new pc.AnimCurve([{ entityPath: THIGH, component: 'graph', propertyPath: ['localRotation'] }], 0, 1, pc.INTERPOLATION_LINEAR),
  ];
  return new pc.AnimTrack(name, 1, [input], outputs, curves);
}

/**
 * The instanced combatant. In the shipped GLB the armature node is the instanced root itself
 * (renamed), while the curves still name it; `armatureIsRoot` false nests it under the root.
 */
function buildRig(app: pc.AppBase, armatureIsRoot = false) {
  const root = new pc.Entity('GhoulCombatantRoot', app);
  let parent: pc.Entity = root;
  for (const name of armatureIsRoot ? ARMATURE.slice(1) : ARMATURE) {
    const node = new pc.Entity(name, app);
    parent.addChild(node);
    parent = node;
  }
  const thigh = new pc.Entity('Bone_THIGH_RIGHT', app);
  root.findByName('Bone_PELVIS_GROIN')!.addChild(thigh);
  app.root.addChild(root);
  return { root, thorax: root.findByName('Bone_TORSO_UPPER_THORAX')!, thigh };
}

const yawOf = (node: pc.GraphNode): number => node.getLocalRotation().getEulerAngles().y;

describe('upper-body anim layer', () => {
  it('masks the thorax and everything above it, by the path the GLB curves use', () => {
    const app = new pc.Application({ width: 1, height: 1 } as HTMLCanvasElement, {
      graphicsDevice: new pc.NullGraphicsDevice({ width: 1, height: 1 } as HTMLCanvasElement),
    });
    try {
      const { root } = buildRig(app);
      const path = 'GhoulArmature/Bone_PELVIS_GROIN/Bone_TORSO_LOWER_ABDOMEN/Bone_TORSO_UPPER_THORAX';
      expect(upperBodyMask(root)).toEqual({ [path]: { children: true }, [`GhoulCombatantRoot/${path}`]: { children: true } });
      expect(upperBodyMask(new pc.Entity('empty'))).toBeNull();
    } finally {
      app.destroy();
    }
  });

  it.each([false, true])('plays the aim on the chest while the legs keep the gait (armature is root: %s)', (armatureIsRoot) => {
    const canvas = { width: 1, height: 1 } as HTMLCanvasElement;
    const app = new pc.Application(canvas, { graphicsDevice: new pc.NullGraphicsDevice(canvas) });
    try {
      const { root, thorax, thigh } = buildRig(app, armatureIsRoot);
      const anim = root.addComponent('anim', { activate: true }) as pc.AnimComponent;
      const tracks = new Map([['Walk', holdTrack('Walk', 10, 30)], ['LongGunAim', holdTrack('LongGunAim', -40, -50)]]);
      for (const [name, track] of tracks) anim.assignAnimation(name, track, undefined, 1, true);
      anim.baseLayer!.transition('Walk', 0);
      expect(addUpperBodyLayer(anim, root, tracks, () => true)).not.toBeNull();

      const upper = new CombatantUpperBodyLayer();
      const host = { animComponent: anim };
      const tick = (n: number): void => { for (let i = 0; i < n; i++) app.systems.fire('animationUpdate', 1 / 30); };
      upper.sync(host, null);
      tick(10);
      expect(yawOf(thorax)).toBeCloseTo(10, 1);
      expect(yawOf(thigh)).toBeCloseTo(30, 1);

      upper.sync(host, { clip: 'LongGunAim', southpaw: false });
      expect(upper.clip).toBe('LongGunAim');
      tick(20);
      expect(anim.findLayer(UPPER_BODY_LAYER)!.weight).toBeCloseTo(1, 5);
      expect(yawOf(thorax)).toBeCloseTo(-40, 1);
      expect(yawOf(thigh)).toBeCloseTo(30, 1);

      upper.sync(host, null);
      tick(20);
      expect(yawOf(thorax)).toBeCloseTo(10, 1);
    } finally {
      app.destroy();
    }
  });
});

function makeGlb() {
  const baseLayer = { activeStateProgress: 0 };
  const animComponent = { playing: true, speed: 1, baseLayer } as unknown as pc.AnimComponent;
  // Typed like the real playClip so the tests can read the clip name off each call.
  const playClip = vi.fn((_clip: string, _blend?: number, _speed?: number, _loop?: boolean) => true);
  return { glb: { animComponent, playClip, availableClips: ALL_CLIPS }, baseLayer, playClip };
}

/** A controller whose upper-layer requests are recorded instead of played. */
function spyController() {
  const controller = new CombatantAnimController();
  const requests: Array<string | null> = [];
  vi.spyOn(controller.upperBody, 'sync').mockImplementation((_glb, request) => {
    requests.push(request ? `${request.clip}${request.southpaw ? '_L' : ''}` : null);
  });
  return { controller, requests };
}

describe('standing clip choice with the upper layer', () => {
  it('keeps the gait on the base layer and the aim on the upper layer while moving', () => {
    const state = createTargetHealthState('npc', 'NPC', vec3());
    const { controller, requests } = spyController();
    const { glb, playClip } = makeGlb();
    controller.syncAnimation(glb, state, false, { clip: 'WalkBackward', playbackSpeed: 0.9 }, { clip: 'LongGunAim' });
    expect(playClip).toHaveBeenLastCalledWith('WalkBackward', 0.12, 0.9, false);
    expect(requests.at(-1)).toBe('LongGunAim');
    controller.syncAnimation(glb, state, false, undefined, { clip: 'LongGunAim' });
    expect(playClip).toHaveBeenLastCalledWith('LongGunAim', 0.12, 1, false);
    expect(requests.at(-1)).toBeNull();
    controller.syncAnimation(glb, state, false, { clip: 'Walk', playbackSpeed: 1 }, { clip: 'PistolAim', hand: 'LEFT' });
    expect(requests.at(-1)).toBe('PistolAim_L');
    // Moving without aiming: the armed gait carries the gun itself.
    controller.syncAnimation(glb, state, false, { clip: 'Run', playbackSpeed: 1 });
    expect(requests.at(-1)).toBeNull();
  });

  it('stands hurt after the flinch and walks hunched', () => {
    const state = createTargetHealthState('npc', 'NPC', vec3());
    state.posture = 'GUT_HURT';
    const { controller, requests } = spyController();
    const { glb, playClip } = makeGlb();
    controller.syncAnimation(glb, state);
    expect(playClip).toHaveBeenLastCalledWith('HurtIdle', 0.12, 1, false);
    controller.syncAnimation(glb, state, false, { clip: 'Walk', playbackSpeed: 0.8 });
    expect(playClip).toHaveBeenLastCalledWith('HurtWalk', 0.12, 0.8, false);
    expect(requests.at(-1)).toBeNull();
    // A strafe has no hurt take: the armed strafe plays under the hurt carry.
    controller.syncAnimation(glb, state, false, { clip: 'StrafeLeft', playbackSpeed: 1 });
    expect(playClip).toHaveBeenLastCalledWith('StrafeLeft', 0.12, 1, false);
    expect(requests.at(-1)).toBe('HurtIdle');
  });

  it('goes empty-handed with no gun and no pistol, and back on a sidearm', () => {
    const state = createTargetHealthState('npc', 'NPC', vec3());
    state.weaponDropped = true;
    state.combatantStatusTag = 'DISARMED';
    const { controller, requests } = spyController();
    const { glb, playClip } = makeGlb();
    controller.syncAnimation(glb, state);
    expect(playClip).toHaveBeenLastCalledWith('UnarmedIdle', 0.12, 1, false);
    controller.syncAnimation(glb, state, false, { clip: 'Walk', playbackSpeed: 1 });
    expect(playClip).toHaveBeenLastCalledWith('UnarmedWalk', 0.12, 1, false);
    controller.syncAnimation(glb, state, false, { clip: 'Run', playbackSpeed: 1.2 });
    expect(playClip).toHaveBeenLastCalledWith('UnarmedRun', 0.12, 1.2, false);
    controller.syncAnimation(glb, state, false, { clip: 'StrafeRight', playbackSpeed: 1 });
    expect(requests.at(-1)).toBe('UnarmedIdle');
    state.combatantStatusTag = 'SIDEARM_DRAWN';
    controller.syncAnimation(glb, state, false, undefined, { clip: 'PistolAim', hand: 'RIGHT' });
    expect(playClip).toHaveBeenLastCalledWith('PistolAim', 0.12, 1, false);
  });

  it('plays the pickup while the AI reaches for the gun and until the body has stood up', () => {
    const state = createTargetHealthState('npc', 'NPC', vec3());
    state.weaponDropped = true;
    const { controller } = spyController();
    const { glb, playClip, baseLayer } = makeGlb();
    markWeaponPickupProgress(state, 0.05);
    controller.syncAnimation(glb, state, false, undefined, undefined, 0, 1 / 60);
    expect(playClip).toHaveBeenLastCalledWith('PickupWeapon', 0.12, 1, false);
    expect(controller.isFlinchHolding).toBe(false);
    // Gun back in hand halfway: the clip keeps going and holds the AI still until it ends.
    markWeaponPickupProgress(state, null);
    state.weaponDropped = false;
    baseLayer.activeStateProgress = 0.6;
    controller.syncAnimation(glb, state, false, { clip: 'Walk', playbackSpeed: 1 }, { clip: 'LongGunAim' }, 0, 1 / 60);
    expect(playClip).toHaveBeenCalledTimes(1);
    expect(controller.isFlinchHolding).toBe(true);
    baseLayer.activeStateProgress = 0.99;
    controller.syncAnimation(glb, state, false, undefined, { clip: 'LongGunAim' }, 0, 1 / 60);
    expect(playClip).toHaveBeenLastCalledWith('LongGunAim', 0.12, 1, false);
    expect(controller.isFlinchHolding).toBe(false);
  });

  it('drops the pickup when the AI gives up reaching', () => {
    const state = createTargetHealthState('npc', 'NPC', vec3());
    state.weaponDropped = true;
    const { controller } = spyController();
    const { glb, playClip } = makeGlb();
    markWeaponPickupProgress(state, 0.1);
    for (let i = 0; i < 30; i++) controller.syncAnimation(glb, state, false, undefined, undefined, 0, 1 / 60);
    expect(playClip).toHaveBeenLastCalledWith('UnarmedIdle', 0.12, 1, false);
    markWeaponPickupProgress(state, null);
  });

  it('crawls dragging a useless leg with its own take, and the plain crawl with both', () => {
    const state = createTargetHealthState('npc', 'NPC', vec3());
    state.woundedPhase = 'DOWNED_CRAWL';
    state.rightLegFunctional = false;
    const { controller, requests } = spyController();
    const { glb, playClip } = makeGlb();
    controller.syncAnimation(glb, state, false, undefined, undefined, 0.4, 1 / 60);
    expect(playClip).toHaveBeenLastCalledWith('SitToCrawl', 0.2, 1, false);
    for (let i = 0; i < 200; i++) controller.syncAnimation(glb, state, false, undefined, undefined, 0.47, 1 / 60);
    expect(playClip.mock.lastCall?.[0]).toBe('CrawlDragLegRight');
    expect(controller.isCrawling).toBe(true);
    expect(requests.at(-1)).toBeNull();
    state.leftLegFunctional = false;
    controller.syncAnimation(glb, state, false, undefined, undefined, 0.47, 1 / 60);
    expect(playClip.mock.lastCall?.[0]).toBe('Crawl');
  });

  it('a body down on its seat with no plan plays the fall out, rolls over and crawls', () => {
    const state = createTargetHealthState('npc', 'NPC', vec3());
    state.posture = 'LEG_BUCKLED';
    const { controller } = spyController();
    const { glb, playClip, baseLayer } = makeGlb();
    controller.syncAnimation(glb, state);
    expect(playClip).toHaveBeenLastCalledWith('DownedCollapse', 0.12, 1, false);
    baseLayer.activeStateProgress = 0.99;
    controller.syncAnimation(glb, state);
    expect(playClip).toHaveBeenLastCalledWith('SitToCrawl', 0.12, 1, false);
    controller.syncAnimation(glb, state, false, undefined, undefined, 0.47);
    expect(playClip).toHaveBeenLastCalledWith('Crawl', 0.4, 1, false);
  });
});
