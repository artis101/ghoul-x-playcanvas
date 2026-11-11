import type { SynthContext } from './synthPrimitives.ts';
import { clampNumber } from '../audioMath.ts';
import {
  synthesizeShotgunFire,
  synthesizePistolFire,
  synthesizeSniperFire,
  synthesizeCarbineFire,
} from './weaponAudioProfiles.ts';

export interface GunshotSynthState {
  m4ShotCounter: number;
  lastWeaponPitchJitter: number;
}

export function playWeaponFire(
  ctx: SynthContext,
  state: GunshotSynthState,
  weaponId: string,
  ammoType: string,
  isAds: boolean,
): void {
  const g = ctx.graph;
  const t0 = g.ctx.currentTime;

  const shotBus = g.createGain();
  shotBus.gain.setValueAtTime(isAds ? 1.05 : 1.0, t0);
  shotBus.connect(g.dryBus);

  const warehouseSend = g.createGain();
  const isAp = ammoType === 'AP';
  const isJhp = ammoType === 'JHP';

  if (weaponId === 'm590_shotgun') {
    state.lastWeaponPitchJitter = 1.0;
    synthesizeShotgunFire(ctx, shotBus, warehouseSend, t0, isAds, isAp);
    return;
  }

  if (weaponId === 'silver_talon_50ae') {
    state.lastWeaponPitchJitter = 1.0;
    synthesizePistolFire(ctx, shotBus, warehouseSend, t0, isAds, isJhp);
    return;
  }

  if (weaponId === 'msg90_sniper') {
    state.lastWeaponPitchJitter = 1.0;
    synthesizeSniperFire(ctx, shotBus, warehouseSend, t0, isAds, isAp);
    return;
  }

  state.m4ShotCounter += 1;
  const cycOffset = (((state.m4ShotCounter * 0.6180339887) % 1) - 0.5) * 0.036;
  const randOffset = (ctx.rng() * 2 - 1) * 0.032;
  const jitter = clampNumber(1.0 + cycOffset + randOffset, 0.92, 1.08);
  state.lastWeaponPitchJitter = jitter;

  synthesizeCarbineFire(ctx, shotBus, warehouseSend, t0, isAds, isJhp, jitter);
}
