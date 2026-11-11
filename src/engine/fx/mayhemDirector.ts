import * as pc from 'playcanvas';
import type {
  AmmoSpec,
  AmmoType,
  GoreMode,
  ShotSimulationReport,
  Vec3Like,
  WeaponSpec,
} from '../../contracts/ballistics.ts';
import type {
  BallisticPenetrationResult,
  BallisticSegmentImpact,
  BlastEvent,
  ColliderSurfaceTag,
  DestructibleMaterialKind,
  IDestructibleSubsystem,
  QuatLike,
} from '../../contracts/destruction.ts';
import {
  add,
  copyVec3,
  cross,
  distance,
  dot,
  length,
  normalize,
  scale,
  sub,
  vec3,
} from '../../core/ballistics/vec3.ts';
import { HardwareInstancedPool } from '../physics/instancedPool.ts';
import { RapierPhysicsWorld } from '../physics/rapierWorld.ts';

// ============================================================================
// 1. F.E.A.R. Reflex Bullet-Time & Kill-Punch Time Dilation Controller
// ============================================================================

export type KillPunchReason = 'CRANIAL_POP' | 'MULTI_KILL_BLAST' | 'DISMEMBERMENT';

export type BulletTimeVignetteTint = 'NONE' | 'CYAN_REFLEX' | 'AMBER_KILL_PUNCH';

export interface BulletTimeVignetteState {
  readonly active: boolean;
  readonly killPunchActive: boolean;
  readonly timeScale: number;
  readonly reflexEnergyPct: number;
  readonly intensity: number;
  readonly tint: BulletTimeVignetteTint;
  readonly cssBoxShadow: string;
}

export interface BulletTimeOptions {
  /** Target timeScale when [Z] Reflex Slow-Motion is active (default 0.22) */
  reflexTargetScale?: number;
  /** Minimum allowed timeScale during heavy kill-punch dilation (default 0.08) */
  minTimeScale?: number;
  /** Reflex meter drain rate in percentage points per real second (default 20) */
  drainPctPerRealSec?: number;
  /** Reflex meter recharge rate in percentage points per real second (default 15) */
  rechargePctPerRealSec?: number;
  /** Recharge delay after Reflex disengages in real seconds (default 0.4) */
  rechargeCooldownS?: number;
  /** Minimum Reflex meter required to activate slow-motion (default 10%) */
  minActivationPct?: number;
  /** Exponential smoothing speed for timeScale transitions (default 14) */
  lerpRatePerRealSec?: number;
  /** Optional hook receiving CSS/canvas edge vignette updates every frame */
  onVignetteUpdate?: (state: BulletTimeVignetteState) => void;
}

const MIN_TIME_SCALE_LIMIT = 0.08;
const MAX_TIME_SCALE_LIMIT = 1.0;

/**
 * F.E.A.R.-inspired Reflex Slow-Motion (`[Z]` toggle -> `0.22x` time dilation with 100% recharging
 * Reflex energy meter) plus automatic `0.35s` micro-dilation Kill-Punch on `CRANIAL_POP` headshots
 * and multi-kill explosions.
 */
export class BulletTimeController {
  private readonly reflexTargetScale: number;
  private readonly minTimeScale: number;
  private readonly drainPctPerSec: number;
  private readonly rechargePctPerSec: number;
  private readonly rechargeCooldownS: number;
  private readonly minActivationPct: number;
  private readonly lerpRatePerSec: number;

  public onVignetteUpdate?: (state: BulletTimeVignetteState) => void;

  private currentScale = 1.0;
  private reflexActive = false;
  private energyPct = 100.0;
  private rechargeDelayTimerS = 0;

  private killPunchRemainingS = 0;
  private killPunchTargetScale = 0.16;

  private boundKeyTarget: EventTarget | null = null;
  private boundKeyHandler: ((ev: Event) => void) | null = null;
  private vignetteOverlayEl: HTMLDivElement | null = null;
  private meterBarFillEl: HTMLDivElement | null = null;

  public constructor(options: BulletTimeOptions = {}) {
    this.minTimeScale = Math.max(
      MIN_TIME_SCALE_LIMIT,
      Math.min(0.5, options.minTimeScale ?? MIN_TIME_SCALE_LIMIT),
    );
    this.reflexTargetScale = Math.max(
      this.minTimeScale,
      Math.min(0.85, options.reflexTargetScale ?? 0.22),
    );
    this.drainPctPerSec = Math.max(1, options.drainPctPerRealSec ?? 20.0);
    this.rechargePctPerSec = Math.max(1, options.rechargePctPerRealSec ?? 15.0);
    this.rechargeCooldownS = Math.max(0, options.rechargeCooldownS ?? 0.4);
    this.minActivationPct = Math.max(1, Math.min(50, options.minActivationPct ?? 10.0));
    this.lerpRatePerSec = Math.max(2, options.lerpRatePerRealSec ?? 14.0);
    this.onVignetteUpdate = options.onVignetteUpdate;
  }

  public get timeScale(): number {
    return this.currentScale;
  }

  public get isReflexActive(): boolean {
    return this.reflexActive;
  }

  public get isKillPunchActive(): boolean {
    return this.killPunchRemainingS > 0;
  }

  public get reflexEnergyPct(): number {
    return this.energyPct;
  }

  /**
   * Scales a raw wall-clock frame delta `rawDt` by current `timeScale` (`0.08 .. 1.0`).
   */
  public effectiveDt(rawDt: number): number {
    if (!Number.isFinite(rawDt) || rawDt <= 0) {
      return 0;
    }
    return rawDt * this.currentScale;
  }

  /**
   * Toggles F.E.A.R. `[Z]` Reflex Slow-Motion if sufficient Reflex energy is available.
   */
  public toggleReflex(): boolean {
    if (this.reflexActive) {
      this.setReflexActive(false);
      return false;
    }
    return this.setReflexActive(true);
  }

  public setReflexActive(active: boolean): boolean {
    if (active) {
      if (this.energyPct < this.minActivationPct) {
        return false;
      }
      this.reflexActive = true;
      return true;
    }

    if (this.reflexActive) {
      this.reflexActive = false;
      this.rechargeDelayTimerS = this.rechargeCooldownS;
    }
    return false;
  }

  /**
   * Triggers automatic `0.35s` micro-dilation Kill-Punch on multi-kill blasts or `CRANIAL_POP` headshots,
   * without draining the player's Reflex meter (and awarding a small adrenaline boost).
   */
  public triggerKillPunch(
    reason: KillPunchReason = 'CRANIAL_POP',
    durationS = 0.35,
  ): void {
    const clampedDuration = Math.max(0.08, Math.min(1.25, durationS));
    this.killPunchRemainingS = Math.max(this.killPunchRemainingS, clampedDuration);

    const punchScale =
      reason === 'MULTI_KILL_BLAST'
        ? 0.14
        : reason === 'CRANIAL_POP'
          ? 0.16
          : 0.2;
    this.killPunchTargetScale = Math.max(this.minTimeScale, punchScale);

    // Stylish kills feed back Reflex adrenaline energy
    const bonusPct = reason === 'MULTI_KILL_BLAST' ? 18 : reason === 'CRANIAL_POP' ? 12 : 8;
    this.grantReflexEnergy(bonusPct);
  }

  public grantReflexEnergy(amountPct: number): void {
    if (!Number.isFinite(amountPct) || amountPct <= 0) return;
    this.energyPct = Math.min(100.0, this.energyPct + amountPct);
  }

  /**
   * Advances Reflex energy drain/recharge, Kill-Punch timer, and smooth `timeScale` interpolation
   * using real unscaled `rawDt`, returning `effectiveDt(rawDt)`.
   */
  public update(rawDt: number): number {
    if (!Number.isFinite(rawDt) || rawDt <= 0) {
      return 0;
    }
    const clampedRawDt = Math.min(0.25, rawDt);

    // 1. Drain or recharge 100% Reflex meter
    if (this.reflexActive) {
      this.energyPct = Math.max(0, this.energyPct - this.drainPctPerSec * clampedRawDt);
      if (this.energyPct <= 0) {
        this.reflexActive = false;
        this.rechargeDelayTimerS = this.rechargeCooldownS;
      }
    } else if (this.rechargeDelayTimerS > 0) {
      const excessDt = clampedRawDt - this.rechargeDelayTimerS;
      this.rechargeDelayTimerS = Math.max(0, this.rechargeDelayTimerS - clampedRawDt);
      if (excessDt > 1e-6 && this.energyPct < 100.0) {
        this.energyPct = Math.min(
          100.0,
          this.energyPct + this.rechargePctPerSec * excessDt,
        );
      }
    } else if (this.energyPct < 100.0) {
      this.energyPct = Math.min(
        100.0,
        this.energyPct + this.rechargePctPerSec * clampedRawDt,
      );
    }

    // 2. Step automatic Kill-Punch micro-dilation timer
    if (this.killPunchRemainingS > 0) {
      this.killPunchRemainingS = Math.max(0, this.killPunchRemainingS - clampedRawDt);
    }

    // 3. Determine desired timeScale and smoothly interpolate
    let desiredScale = MAX_TIME_SCALE_LIMIT;
    if (this.reflexActive) {
      desiredScale = Math.min(desiredScale, this.reflexTargetScale);
    }
    if (this.killPunchRemainingS > 0) {
      desiredScale = Math.min(desiredScale, this.killPunchTargetScale);
    }
    desiredScale = Math.max(
      this.minTimeScale,
      Math.min(MAX_TIME_SCALE_LIMIT, desiredScale),
    );

    const alpha = 1 - Math.exp(-this.lerpRatePerSec * clampedRawDt);
    this.currentScale += (desiredScale - this.currentScale) * alpha;
    if (Math.abs(desiredScale - this.currentScale) < 1e-3) {
      this.currentScale = desiredScale;
    }
    this.currentScale = Math.max(
      this.minTimeScale,
      Math.min(MAX_TIME_SCALE_LIMIT, this.currentScale),
    );

    // 4. Emit cyan/amber edge vignette state & sync optional HUD overlay
    const vignette = this.getVignetteState();
    this.onVignetteUpdate?.(vignette);
    this.syncMountedOverlay(vignette);

    return this.effectiveDt(rawDt);
  }

  public getVignetteState(): BulletTimeVignetteState {
    const dilationDepth = Math.max(
      0,
      Math.min(1, (1.0 - this.currentScale) / (1.0 - this.reflexTargetScale)),
    );
    const killPunchActive = this.killPunchRemainingS > 0;

    let tint: BulletTimeVignetteTint = 'NONE';
    let cssBoxShadow = 'none';

    if (killPunchActive && !this.reflexActive) {
      tint = 'AMBER_KILL_PUNCH';
      const alpha = (0.38 * dilationDepth).toFixed(3);
      const spreadPx = Math.round(68 * dilationDepth + 14);
      cssBoxShadow = `inset 0 0 ${spreadPx}px rgba(255, 146, 36, ${alpha})`;
    } else if (dilationDepth > 0.02) {
      tint = killPunchActive ? 'AMBER_KILL_PUNCH' : 'CYAN_REFLEX';
      const r = killPunchActive ? 255 : 34;
      const g = killPunchActive ? 168 : 226;
      const b = killPunchActive ? 58 : 255;
      const alpha = (0.34 * dilationDepth).toFixed(3);
      const spreadPx = Math.round(76 * dilationDepth + 16);
      cssBoxShadow = `inset 0 0 ${spreadPx}px rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    return {
      active: this.reflexActive,
      killPunchActive,
      timeScale: this.currentScale,
      reflexEnergyPct: this.energyPct,
      intensity: dilationDepth,
      tint,
      cssBoxShadow,
    };
  }

  /**
   * Binds `[Z]` keyboard shortcut to toggle F.E.A.R. Reflex Slow-Motion.
   */
  public bindKeyboardShortcut(target?: EventTarget): void {
    this.unbindKeyboardShortcut();
    const resolvedTarget =
      target ?? (typeof window !== 'undefined' ? window : null);
    if (!resolvedTarget) return;

    const handler = (ev: Event): void => {
      const ke = ev as KeyboardEvent;
      if (ke.repeat) return;
      if (ke.code === 'KeyZ') {
        this.toggleReflex();
      }
    };

    resolvedTarget.addEventListener('keydown', handler);
    this.boundKeyTarget = resolvedTarget;
    this.boundKeyHandler = handler;
  }

  public unbindKeyboardShortcut(): void {
    if (this.boundKeyTarget && this.boundKeyHandler) {
      this.boundKeyTarget.removeEventListener('keydown', this.boundKeyHandler);
    }
    this.boundKeyTarget = null;
    this.boundKeyHandler = null;
  }

  /**
   * Optional browser DOM edge vignette + compact Reflex meter mount.
   */
  public mountVignetteOverlay(parent?: HTMLElement): void {
    if (typeof document === 'undefined' || this.vignetteOverlayEl) return;
    const host = parent ?? document.body;
    if (!host) return;

    const overlay = document.createElement('div');
    overlay.id = 'mayhem-reflex-vignette';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.pointerEvents = 'none';
    overlay.style.zIndex = '18';
    overlay.style.transition = 'box-shadow 60ms linear';

    const barWrap = document.createElement('div');
    barWrap.style.position = 'fixed';
    barWrap.style.left = '24px';
    barWrap.style.bottom = '66px';
    barWrap.style.width = '136px';
    barWrap.style.height = '5px';
    barWrap.style.background = 'rgba(8, 16, 22, 0.55)';
    barWrap.style.border = '1px solid rgba(72, 220, 255, 0.35)';
    barWrap.style.borderRadius = '2px';

    const barFill = document.createElement('div');
    barFill.style.width = '100%';
    barFill.style.height = '100%';
    barFill.style.background = 'linear-gradient(90deg, #18c8ff, #8cf4ff)';
    barWrap.appendChild(barFill);
    overlay.appendChild(barWrap);

    host.appendChild(overlay);
    this.vignetteOverlayEl = overlay;
    this.meterBarFillEl = barFill;
  }

  public reset(): void {
    this.reflexActive = false;
    this.currentScale = 1.0;
    this.energyPct = 100.0;
    this.rechargeDelayTimerS = 0;
    this.killPunchRemainingS = 0;
  }

  public destroy(): void {
    this.unbindKeyboardShortcut();
    if (this.vignetteOverlayEl) {
      this.vignetteOverlayEl.remove();
      this.vignetteOverlayEl = null;
      this.meterBarFillEl = null;
    }
  }

  private syncMountedOverlay(state: BulletTimeVignetteState): void {
    if (this.vignetteOverlayEl) {
      this.vignetteOverlayEl.style.boxShadow = state.cssBoxShadow;
    }
    if (this.meterBarFillEl) {
      this.meterBarFillEl.style.width = `${state.reflexEnergyPct.toFixed(1)}%`;
      this.meterBarFillEl.style.opacity =
        state.reflexEnergyPct >= 99.5 && !state.active ? '0.45' : '0.95';
    }
  }
}

// ============================================================================
// 2. Procedural Meshes, PBR Materials & Quaternion Surface Alignment Helpers
// ============================================================================

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function hash2d(x: number, y: number, seed: number): number {
  let n = Math.imul(
    x * 374761393 + y * 668265263 + seed * 1442695041,
    1274126177,
  );
  n = (n ^ (n >>> 13)) >>> 0;
  return (n & 0xffff) / 0xffff;
}

function valueNoise2d(u: number, v: number, freq: number, seed: number): number {
  const x = u * freq;
  const y = v * freq;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);

  const n00 = hash2d(x0, y0, seed);
  const n10 = hash2d(x0 + 1, y0, seed);
  const n01 = hash2d(x0, y0 + 1, seed);
  const n11 = hash2d(x0 + 1, y0 + 1, seed);

  const nx0 = n00 + (n10 - n00) * sx;
  const nx1 = n01 + (n11 - n01) * sx;
  return nx0 + (nx1 - nx0) * sy;
}

/**
 * Converts a right-handed 3x3 rotation matrix (columns T, B, N) into a unit quaternion.
 */
export function basisColumnsToQuaternion(
  tx: number,
  ty: number,
  tz: number,
  bx: number,
  by: number,
  bz: number,
  nx: number,
  ny: number,
  nz: number,
): QuatLike {
  // m_row_col where col0 = T, col1 = B, col2 = N
  const m00 = tx;
  const m10 = ty;
  const m20 = tz;
  const m01 = bx;
  const m11 = by;
  const m21 = bz;
  const m02 = nx;
  const m12 = ny;
  const m22 = nz;

  const trace = m00 + m11 + m22;
  let qx: number;
  let qy: number;
  let qz: number;
  let qw: number;

  if (trace > 0) {
    const s = Math.sqrt(trace + 1.0) * 2.0;
    qw = 0.25 * s;
    qx = (m21 - m12) / s;
    qy = (m02 - m20) / s;
    qz = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1.0 + m00 - m11 - m22) * 2.0;
    qw = (m21 - m12) / s;
    qx = 0.25 * s;
    qy = (m01 + m10) / s;
    qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1.0 + m11 - m00 - m22) * 2.0;
    qw = (m02 - m20) / s;
    qx = (m01 + m10) / s;
    qy = 0.25 * s;
    qz = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1.0 + m22 - m00 - m11) * 2.0;
    qw = (m10 - m01) / s;
    qx = (m02 + m20) / s;
    qy = (m12 + m21) / s;
    qz = 0.25 * s;
  }

  const len = Math.hypot(qx, qy, qz, qw);
  if (len < 1e-8) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  const inv = 1 / len;
  return { x: qx * inv, y: qy * inv, z: qz * inv, w: qw * inv };
}

/**
 * Computes a quaternion orienting a local `+Z` streak axis along `directionWorld`.
 */
function directionToStreakQuaternion(directionWorld: Vec3Like): QuatLike {
  const n = normalize(directionWorld);
  if (length(n) < 1e-6) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  const upRef = Math.abs(n.y) < 0.96 ? vec3(0, 1, 0) : vec3(1, 0, 0);
  const t = normalize(cross(upRef, n));
  const b = normalize(cross(n, t));
  return basisColumnsToQuaternion(t.x, t.y, t.z, b.x, b.y, b.z, n.x, n.y, n.z);
}

/**
 * Computes a quaternion orienting a local XY quad (whose front normal is `+Z`) flush
 * along `surfaceNormalWorld` with `rollRad` spin around the normal.
 */
export function computeSurfaceAlignedQuadQuaternion(
  surfaceNormalWorld: Vec3Like,
  sprayDirectionWorld: Vec3Like,
  rollRad = 0,
): QuatLike {
  const n = normalize(surfaceNormalWorld);
  if (length(n) < 1e-6) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }

  let t0: Vec3Like;
  let b0: Vec3Like;

  if (Math.abs(n.y) < 0.95) {
    // Wall or sloped surface: local +Y runs vertically up/down wall, local +X runs horizontally
    t0 = normalize(cross({ x: 0, y: 1, z: 0 }, n));
    b0 = normalize(cross(n, t0));
  } else {
    // Floor or ceiling: align local +Y streak axis along projected ballistic travel direction
    const horizSpray = { x: sprayDirectionWorld.x, y: 0, z: sprayDirectionWorld.z };
    const forwardOnFloor =
      length(horizSpray) > 1e-4 ? normalize(horizSpray) : { x: 0, y: 0, z: -1 };
    t0 = normalize(cross(forwardOnFloor, n));
    b0 = normalize(cross(n, t0));
  }

  const cosR = Math.cos(rollRad);
  const sinR = Math.sin(rollRad);

  const tx = t0.x * cosR + b0.x * sinR;
  const ty = t0.y * cosR + b0.y * sinR;
  const tz = t0.z * cosR + b0.z * sinR;

  const bx = -t0.x * sinR + b0.x * cosR;
  const by = -t0.y * sinR + b0.y * cosR;
  const bz = -t0.z * sinR + b0.z * cosR;

  return basisColumnsToQuaternion(tx, ty, tz, bx, by, bz, n.x, n.y, n.z);
}

function buildLoftedDrumMesh(
  device: pc.GraphicsDevice,
  rings: ReadonlyArray<{ y: number; r: number; v: number }>,
  sides: number,
  crumpleSeed = 0,
): pc.Mesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const pushTri = (
    p0: [number, number, number],
    p1: [number, number, number],
    p2: [number, number, number],
    uv0: [number, number],
    uv1: [number, number],
    uv2: [number, number],
  ): void => {
    const ux = p1[0] - p0[0];
    const uy = p1[1] - p0[1];
    const uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0];
    const vy = p2[1] - p0[1];
    const vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const nLen = Math.hypot(nx, ny, nz);
    if (nLen < 1e-8) return;
    nx /= nLen;
    ny /= nLen;
    nz /= nLen;

    const base = positions.length / 3;
    positions.push(
      p0[0],
      p0[1],
      p0[2],
      p1[0],
      p1[1],
      p1[2],
      p2[0],
      p2[1],
      p2[2],
    );
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    uvs.push(uv0[0], uv0[1], uv1[0], uv1[1], uv2[0], uv2[1]);
    indices.push(base, base + 1, base + 2);
  };

  const ringPts: Array<Array<[number, number, number]>> = [];
  for (let r = 0; r < rings.length; r++) {
    const spec = rings[r];
    const pts: Array<[number, number, number]> = [];
    for (let s = 0; s <= sides; s++) {
      const idx = s % sides;
      const theta = (idx / sides) * Math.PI * 2;
      let rad = spec.r;
      let yVal = spec.y;
      if (crumpleSeed > 0 && r > 0) {
        const jag = hash2d(idx, r, crumpleSeed);
        rad *= 0.68 + jag * 0.58;
        if (r === rings.length - 1) {
          yVal += (jag - 0.5) * 0.14;
        }
      }
      pts.push([Math.sin(theta) * rad, yVal, Math.cos(theta) * rad]);
    }
    ringPts.push(pts);
  }

  for (let r = 0; r < rings.length - 1; r++) {
    const v0 = rings[r].v;
    const v1 = rings[r + 1].v;
    for (let s = 0; s < sides; s++) {
      const u0 = s / sides;
      const u1 = (s + 1) / sides;
      const p00 = ringPts[r][s];
      const p10 = ringPts[r][s + 1];
      const p11 = ringPts[r + 1][s + 1];
      const p01 = ringPts[r + 1][s];
      pushTri(p00, p10, p11, [u0, v0], [u1, v0], [u1, v1]);
      pushTri(p00, p11, p01, [u0, v0], [u1, v1], [u0, v1]);
    }
  }

  // Bottom & top caps
  const botY = rings[0].y;
  const topY = rings[rings.length - 1].y;
  const botCenter: [number, number, number] = [0, botY, 0];
  const topCenter: [number, number, number] = [
    0,
    crumpleSeed > 0 ? topY * 0.45 : topY,
    0,
  ];
  for (let s = 0; s < sides; s++) {
    pushTri(
      botCenter,
      ringPts[0][s + 1],
      ringPts[0][s],
      [0.5, 0.02],
      [0.55, 0.02],
      [0.45, 0.02],
    );
    const last = rings.length - 1;
    pushTri(
      topCenter,
      ringPts[last][s],
      ringPts[last][s + 1],
      [0.5, 0.98],
      [0.45, 0.98],
      [0.55, 0.98],
    );
  }

  const mesh = new pc.Mesh(device);
  mesh.setPositions(positions);
  mesh.setNormals(normals);
  mesh.setUvs(0, uvs);
  mesh.setIndices(indices);
  mesh.update(pc.PRIMITIVE_TRIANGLES);
  return mesh;
}

/**
 * Builds a crossed 2-plane streak mesh aligned along local `+Z` (`z in [-0.5, 0.5]`)
 * so bullet tracers and ricochet sparks are bright from every camera angle with minimal triangles.
 */
function buildCrossedStreakZMesh(device: pc.GraphicsDevice): pc.Mesh {
  const positions = [
    // Horizontal fin (XZ plane, Y = 0)
    -0.5, 0, -0.5,
    0.5, 0, -0.5,
    0.5, 0, 0.5,
    -0.5, 0, 0.5,
    // Vertical fin (YZ plane, X = 0)
    0, -0.5, -0.5,
    0, 0.5, -0.5,
    0, 0.5, 0.5,
    0, -0.5, 0.5,
  ];
  const normals = [
    0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
    1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
  ];
  const uvs = [
    0, 0, 1, 0, 1, 1, 0, 1,
    0, 0, 1, 0, 1, 1, 0, 1,
  ];
  const indices = [
    0, 1, 2, 0, 2, 3,
    4, 5, 6, 4, 6, 7,
  ];

  const mesh = new pc.Mesh(device);
  mesh.setPositions(positions);
  mesh.setNormals(normals);
  mesh.setUvs(0, uvs);
  mesh.setIndices(indices);
  mesh.update(pc.PRIMITIVE_TRIANGLES);
  return mesh;
}

function buildUnitQuadZMesh(device: pc.GraphicsDevice): pc.Mesh {
  const mesh = new pc.Mesh(device);
  mesh.setPositions([
    -0.5, -0.5, 0,
    0.5, -0.5, 0,
    0.5, 0.5, 0,
    -0.5, 0.5, 0,
  ]);
  mesh.setNormals([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ]);
  mesh.setUvs(0, [
    0, 0,
    1, 0,
    1, 1,
    0, 1,
  ]);
  mesh.setIndices([0, 1, 2, 0, 2, 3]);
  mesh.update(pc.PRIMITIVE_TRIANGLES);
  return mesh;
}

function createHazardBarrelMaterial(device: pc.GraphicsDevice): pc.StandardMaterial {
  const width = 128;
  const height = 256;
  const maxAniso = Math.min(device.maxAnisotropy || 4, 8);
  const tex = new pc.Texture(device, {
    name: 'hazardDrumTex',
    width,
    height,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  tex.anisotropy = maxAniso;

  const normalTex = new pc.Texture(device, {
    name: 'hazardDrumNormalTex',
    width,
    height,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  normalTex.anisotropy = maxAniso;

  const pixels = tex.lock() as Uint8Array;
  const nPixels = normalTex.lock() as Uint8Array;
  const hField = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    const v = y / height;
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const grit = (hash2d(x, y, 71) - 0.5) * 16;
      const scratch = valueNoise2d(u, v, 24, 173);

      let r = 192 + grit;
      let g = 22 + grit * 0.3;
      let b = 20 + grit * 0.3;

      const isRimRing =
        v < 0.045 ||
        v > 0.955 ||
        Math.abs(v - 0.33) < 0.024 ||
        Math.abs(v - 0.67) < 0.024;

      let heightVal = scratch * 0.25;
      if (isRimRing) {
        r = 88 + grit + (scratch > 0.72 ? 36 : 0);
        g = 90 + grit + (scratch > 0.72 ? 36 : 0);
        b = 96 + grit + (scratch > 0.72 ? 38 : 0);
        heightVal = 0.85 + scratch * 0.15;
      } else if (v > 0.37 && v < 0.63) {
        const inChevronBand = v < 0.425 || v > 0.575;
        const stripe = ((Math.floor(u * 18 + v * 30) % 2) + 2) % 2 === 0;
        if (inChevronBand && stripe) {
          r = 24 + grit * 0.35;
          g = 23 + grit * 0.35;
          b = 22 + grit * 0.35;
        } else {
          r = 238 + grit * 0.5;
          g = 194 + grit * 0.5;
          b = 22 + grit * 0.3;
        }
        heightVal = 0.35 + scratch * 0.15;
      }

      hField[y * width + x] = heightVal;
      const idx = (y * width + x) * 4;
      pixels[idx] = clampByte(r);
      pixels[idx + 1] = clampByte(g);
      pixels[idx + 2] = clampByte(b);
      pixels[idx + 3] = 255;
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const xm = (x - 1 + width) % width;
      const xp = (x + 1) % width;
      const ym = Math.max(0, y - 1);
      const yp = Math.min(height - 1, y + 1);
      const nx = (hField[y * width + xm] - hField[y * width + xp]) * 2.2;
      const ny = (hField[ym * width + x] - hField[yp * width + x]) * 2.2;
      const nz = 1.0;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const idx = (y * width + x) * 4;
      nPixels[idx] = clampByte((nx * inv * 0.5 + 0.5) * 255);
      nPixels[idx + 1] = clampByte((ny * inv * 0.5 + 0.5) * 255);
      nPixels[idx + 2] = clampByte((nz * inv * 0.5 + 0.5) * 255);
      nPixels[idx + 3] = 255;
    }
  }

  tex.unlock();
  normalTex.unlock();

  const mat = new pc.StandardMaterial();
  mat.name = 'hazardBarrelRedMat';
  mat.diffuseMap = tex;
  mat.normalMap = normalTex;
  mat.bumpiness = 0.72;
  mat.useMetalness = true;
  mat.metalness = 0.42;
  mat.gloss = 0.68;
  mat.clearCoat = 0.25;
  mat.clearCoatGloss = 0.78;
  mat.fresnelModel = pc.FRESNEL_SCHLICK;
  mat.update();
  return mat;
}

function createCharredBarrelMaterial(): pc.StandardMaterial {
  const mat = new pc.StandardMaterial();
  mat.name = 'charredBarrelRemnantMat';
  mat.diffuse = new pc.Color(0.08, 0.075, 0.075);
  mat.emissive = new pc.Color(0.09, 0.022, 0.005);
  mat.useMetalness = true;
  mat.metalness = 0.35;
  mat.gloss = 0.26;
  mat.fresnelModel = pc.FRESNEL_SCHLICK;
  mat.update();
  return mat;
}

function createScorchDecalMaterial(device: pc.GraphicsDevice): pc.StandardMaterial {
  const size = 128;
  const tex = new pc.Texture(device, {
    name: 'barrelScorchTex',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });

  const pixels = tex.lock() as Uint8Array;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const dx = u - 0.5;
      const dy = v - 0.5;
      const angle = Math.atan2(dy, dx);
      const sootRay = Math.sin(angle * 11.0) * 0.04 + Math.cos(angle * 19.0) * 0.03;
      const rayNoise = valueNoise2d(u, v, 9, 409) * 0.12;
      const fineNoise = hash2d(x, y, 419) * 0.05;
      const dist = Math.hypot(dx, dy) - sootRay - rayNoise - fineNoise;

      const alpha = Math.max(0, Math.min(1, (0.42 - dist) / 0.24));
      const ashTint = dist > 0.22 ? 26 : 12;
      const idx = (y * size + x) * 4;
      pixels[idx] = ashTint;
      pixels[idx + 1] = ashTint - 2;
      pixels[idx + 2] = ashTint - 2;
      pixels[idx + 3] = clampByte(alpha * 238);
    }
  }
  tex.unlock();

  const mat = new pc.StandardMaterial();
  mat.name = 'barrelFloorScorchMat';
  mat.diffuse = new pc.Color(0.05, 0.045, 0.045);
  mat.opacityMap = tex;
  mat.opacityMapChannel = 'a';
  mat.blendType = pc.BLEND_NORMAL;
  mat.depthWrite = false;
  mat.update();
  return mat;
}

function createBloodSplatterMaterial(device: pc.GraphicsDevice): pc.StandardMaterial {
  const size = 128;
  const maxAniso = Math.min(device.maxAnisotropy || 4, 8);
  const tex = new pc.Texture(device, {
    name: 'goreWallSplatterTex',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  tex.anisotropy = maxAniso;

  const normalTex = new pc.Texture(device, {
    name: 'goreWallSplatterNormalTex',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  normalTex.anisotropy = maxAniso;

  const pixels = tex.lock() as Uint8Array;
  const nPixels = normalTex.lock() as Uint8Array;
  const heightField = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const dx = u - 0.5;
      const dy = v - 0.54;
      const angle = Math.atan2(dy, dx);

      const radialFinger =
        Math.pow(Math.max(0, Math.sin(angle * 7.0 + 0.4)), 2.0) * 0.085 +
        Math.pow(Math.max(0, Math.cos(angle * 13.0 - 1.1)), 3.0) * 0.065;
      const organicWarp = (valueNoise2d(u, v, 8, 911) - 0.5) * 0.11;
      const drip =
        u > 0.32 && u < 0.68 && v < 0.46
          ? Math.pow(valueNoise2d(u * 2.2, v * 0.45, 7, 977), 2.2) * 0.19
          : 0;
      const speckle = valueNoise2d(u, v, 24, 953);

      const dist = Math.hypot(dx, dy * 0.92) - radialFinger - organicWarp - drip;
      let alpha = 0;
      if (dist < 0.22) {
        alpha = 0.97;
      } else if (dist < 0.31) {
        const t = (0.31 - dist) / 0.09;
        alpha = t * t * (3 - 2 * t) * 0.94;
      } else if (dist < 0.45 && speckle > 0.79) {
        alpha = ((speckle - 0.79) / 0.21) * 0.9;
      }

      heightField[y * size + x] = alpha > 0.05 ? Math.min(1.0, alpha * 0.8 + (dist < 0.24 ? 0.2 : 0)) : 0;

      // Deep oxygenated wet crimson -> dark venous maroon center (never flat neon red!)
      const coreDark = dist < 0.13 ? 0.56 : dist < 0.22 ? 0.78 : 1.0;
      const idx = (y * size + x) * 4;
      pixels[idx] = clampByte(112 * coreDark);
      pixels[idx + 1] = clampByte(6 * coreDark);
      pixels[idx + 2] = clampByte(10 * coreDark);
      pixels[idx + 3] = clampByte(alpha * 255);
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(size - 1, x + 1);
      const ym = Math.max(0, y - 1);
      const yp = Math.min(size - 1, y + 1);
      const nx = (heightField[y * size + xm] - heightField[y * size + xp]) * 2.6;
      const ny = (heightField[ym * size + x] - heightField[yp * size + x]) * 2.6;
      const nz = 1.0;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const idx = (y * size + x) * 4;
      nPixels[idx] = clampByte((nx * inv * 0.5 + 0.5) * 255);
      nPixels[idx + 1] = clampByte((ny * inv * 0.5 + 0.5) * 255);
      nPixels[idx + 2] = clampByte((nz * inv * 0.5 + 0.5) * 255);
      nPixels[idx + 3] = 255;
    }
  }

  tex.unlock();
  normalTex.unlock();

  const mat = new pc.StandardMaterial();
  mat.name = 'wetWallBloodSplatterMat';
  mat.diffuseMap = tex;
  mat.opacityMap = tex;
  mat.opacityMapChannel = 'a';
  mat.normalMap = normalTex;
  mat.bumpiness = 0.78;
  mat.useMetalness = true;
  mat.metalness = 0.1;
  mat.gloss = 0.9;
  mat.clearCoat = 0.88;
  mat.clearCoatGloss = 0.95;
  mat.fresnelModel = pc.FRESNEL_SCHLICK;
  mat.blendType = pc.BLEND_NORMAL;
  mat.depthWrite = false;
  mat.cull = pc.CULLFACE_NONE;
  mat.update();
  return mat;
}

function createGleamingBrassCasingMaterial(device: pc.GraphicsDevice): pc.StandardMaterial {
  const size = 64;
  const maxAniso = Math.min(device.maxAnisotropy || 4, 8);
  const tex = new pc.Texture(device, {
    name: 'brassCasingLatheTex',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  tex.anisotropy = maxAniso;

  const px = tex.lock() as Uint8Array;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    // Annealed neck darkening near case mouth (v > 0.78) + extractor rim groove (v < 0.08)
    const annealTint = v > 0.76 ? (v - 0.76) / 0.24 : 0;
    const grooveShade = v > 0.05 && v < 0.11 ? 0.72 : 1.0;
    const latheRing = 0.96 + Math.sin(v * Math.PI * 28) * 0.04;
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const r = (242 - annealTint * 34) * grooveShade * latheRing;
      const g = (196 - annealTint * 48) * grooveShade * latheRing;
      const b = (86 + annealTint * 22) * grooveShade * latheRing;
      px[idx] = clampByte(r);
      px[idx + 1] = clampByte(g);
      px[idx + 2] = clampByte(b);
      px[idx + 3] = 255;
    }
  }
  tex.unlock();

  const mat = new pc.StandardMaterial();
  mat.name = 'mayhemGlintingBrassMat';
  mat.diffuseMap = tex;
  mat.emissive = new pc.Color(0.11, 0.075, 0.018);
  mat.useMetalness = true;
  mat.metalness = 0.9;
  mat.gloss = 0.88;
  mat.clearCoat = 0.35;
  mat.clearCoatGloss = 0.92;
  mat.fresnelModel = pc.FRESNEL_SCHLICK;
  mat.update();
  return mat;
}

function createShotgunHullMaterial(device: pc.GraphicsDevice): pc.StandardMaterial {
  const width = 64;
  const height = 128;
  const maxAniso = Math.min(device.maxAnisotropy || 4, 8);
  const tex = new pc.Texture(device, {
    name: 'shotgun12gHullTex',
    width,
    height,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  tex.anisotropy = maxAniso;

  const normalTex = new pc.Texture(device, {
    name: 'shotgun12gHullNormalTex',
    width,
    height,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  normalTex.anisotropy = maxAniso;

  const pixels = tex.lock() as Uint8Array;
  const nPixels = normalTex.lock() as Uint8Array;
  const hField = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    const v = y / height;
    for (let x = 0; x < width; x++) {
      const u = x / width;
      // Bottom 30% = high-brass 12G stamped head; upper 70% = extruded ribbed crimson polymer hull
      const isBrassBase = v < 0.3;
      const ribWave = Math.sin(u * Math.PI * 36) * 0.5 + 0.5;
      const crimpLip = v > 0.93 ? 0.78 : 1.0;

      const idx = (y * width + x) * 4;
      if (isBrassBase) {
        const rimRing = v < 0.06 ? 1.06 : 0.98;
        pixels[idx] = clampByte(236 * rimRing);
        pixels[idx + 1] = clampByte(192 * rimRing);
        pixels[idx + 2] = clampByte(82 * rimRing);
        hField[y * width + x] = v < 0.06 ? 0.95 : 0.65;
      } else {
        const ribShade = (0.88 + ribWave * 0.16) * crimpLip;
        pixels[idx] = clampByte(196 * ribShade);
        pixels[idx + 1] = clampByte(18 * ribShade);
        pixels[idx + 2] = clampByte(24 * ribShade);
        hField[y * width + x] = 0.35 + ribWave * 0.35;
      }
      pixels[idx + 3] = 255;
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const xm = (x - 1 + width) % width;
      const xp = (x + 1) % width;
      const ym = Math.max(0, y - 1);
      const yp = Math.min(height - 1, y + 1);
      const nx = (hField[y * width + xm] - hField[y * width + xp]) * 2.0;
      const ny = (hField[ym * width + x] - hField[yp * width + x]) * 2.0;
      const nz = 1.0;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const idx = (y * width + x) * 4;
      nPixels[idx] = clampByte((nx * inv * 0.5 + 0.5) * 255);
      nPixels[idx + 1] = clampByte((ny * inv * 0.5 + 0.5) * 255);
      nPixels[idx + 2] = clampByte((nz * inv * 0.5 + 0.5) * 255);
      nPixels[idx + 3] = 255;
    }
  }

  tex.unlock();
  normalTex.unlock();

  const mat = new pc.StandardMaterial();
  mat.name = 'shotgun12gHullMat';
  mat.diffuseMap = tex;
  mat.normalMap = normalTex;
  mat.bumpiness = 0.62;
  mat.useMetalness = true;
  mat.metalness = 0.28;
  mat.gloss = 0.82;
  mat.clearCoat = 0.42;
  mat.clearCoatGloss = 0.86;
  mat.fresnelModel = pc.FRESNEL_SCHLICK;
  mat.update();
  return mat;
}

function createSoftCloudTexture(device: pc.GraphicsDevice, name: string, seed: number): pc.Texture {
  const size = 64;
  const tex = new pc.Texture(device, {
    name,
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  const px = tex.lock() as Uint8Array;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const d = Math.hypot(u - 0.5, v - 0.5) * 2.0;
      const n = valueNoise2d(u, v, 5, seed) * 0.62 + valueNoise2d(u, v, 11, seed + 97) * 0.38;
      const radial = Math.max(0, 1 - d * d);
      const alpha = radial * radial * (0.42 + n * 0.58);
      const lum = clampByte(205 + n * 50);
      const idx = (y * size + x) * 4;
      px[idx] = lum;
      px[idx + 1] = lum;
      px[idx + 2] = lum;
      px[idx + 3] = clampByte(alpha * 255);
    }
  }
  tex.unlock();
  return tex;
}

function createShockwaveRingTexture(device: pc.GraphicsDevice): pc.Texture {
  const size = 64;
  const tex = new pc.Texture(device, {
    name: 'mayhemBlastShockwaveRingTex',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  const px = tex.lock() as Uint8Array;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const r = Math.hypot(u - 0.5, v - 0.5) * 2.0;
      const ringBand = Math.exp(-Math.pow((r - 0.78) / 0.11, 2));
      const wisp = 0.72 + valueNoise2d(u, v, 9, 2207) * 0.28;
      const alpha = r <= 1.0 ? ringBand * wisp : 0;
      const idx = (y * size + x) * 4;
      px[idx] = 255;
      px[idx + 1] = 216;
      px[idx + 2] = 158;
      px[idx + 3] = clampByte(alpha * 255);
    }
  }
  tex.unlock();
  return tex;
}

function createStreakGlowTexture(device: pc.GraphicsDevice): pc.Texture {
  const w = 16;
  const h = 64;
  const tex = new pc.Texture(device, {
    name: 'mayhemTracerStreakTex',
    width: w,
    height: h,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  const px = tex.lock() as Uint8Array;
  for (let y = 0; y < h; y++) {
    // v = 0 is tail, v = 1 is hot nose
    const v = (y + 0.5) / h;
    const longFade = v < 0.78 ? Math.pow(v / 0.78, 1.5) : Math.sin(((1 - v) / 0.22) * (Math.PI * 0.5));
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const crossFade = Math.max(0, 1 - Math.abs(u - 0.5) * 2.0);
      const alpha = longFade * crossFade * crossFade;
      const idx = (y * w + x) * 4;
      px[idx] = 255;
      px[idx + 1] = clampByte(215 + v * 40);
      px[idx + 2] = clampByte(145 + v * 95);
      px[idx + 3] = clampByte(alpha * 255);
    }
  }
  tex.unlock();
  return tex;
}

// ============================================================================
// 3. Shootable Explosive Red Hazard Barrels (ExplosiveBarrelManager)
// ============================================================================

export type HazardBarrelState = 'INTACT' | 'IGNITED_HISSING' | 'DETONATED';

export interface HazardBarrelInstance {
  readonly index: number;
  readonly objectId: string;
  readonly basePosition: Vec3Like;
  state: HazardBarrelState;
  colliderHandle: number;
  /** Accumulated ignition damage where >= 1.0 ignites the 0.18s hissing fuse (rifle/slug/.50AE = 1.0, buckshot = 0.5) */
  ignitionDamage: number;
  hitCount: number;
  fuseRemainingS: number;
  leakOffsetLocal: Vec3Like;
  leakNormalWorld: Vec3Like;
  rootEntity: pc.Entity | null;
  intactDrumEntity: pc.Entity | null;
  flameJetEntity: pc.Entity | null;
  crumpledBaseEntity: pc.Entity | null;
  scorchDecalEntity: pc.Entity | null;
}

export const BARREL_FUSE_DURATION_S = 0.18;
export const BARREL_BLAST_RADIUS_M = 6.5;
export const BARREL_BLAST_PEAK_IMPULSE_NS = 1850;
export const BARREL_BLAST_PEAK_ENERGY_J = 14000;

export const DEFAULT_HAZARD_BARREL_POSITIONS: readonly Vec3Like[] = [
  { x: -0.95, y: 0, z: -7.0 },  // Next to Wood Shoot-House Wall (z = -7.2)
  { x: -2.35, y: 0, z: -12.2 }, // Next to Instanced Brick Wall (z = -12.5)
  { x: 0.95, y: 0, z: -13.3 },  // Next to Voronoi Concrete Wall (z = -13.5)
  { x: 4.35, y: 0, z: -6.6 },   // Next to Runtime Voronoi Glass Window (z = -6.5)
];

export interface ExplosiveBarrelHitInput {
  ammoType?: AmmoType;
  pelletCount?: number;
  kineticEnergyJ?: number;
  isArmorPiercing?: boolean;
  hitPointWorld?: Vec3Like;
  hitNormalWorld?: Vec3Like;
}

export interface ExplosiveBarrelManagerOptions {
  app?: pc.Application | null;
  rapierWorld: RapierPhysicsWorld;
  shrapnelPool?: HardwareInstancedPool | null;
  barrelPositions?: readonly Vec3Like[];
  /** Delay in seconds when an adjacent barrel's blast sympathetically ignites a neighbor (default 0.08s; 0 = immediate) */
  sympatheticChainFuseS?: number;
  onBarrelIgnited?: (barrel: HazardBarrelInstance) => void;
  onBarrelDetonated?: (barrel: HazardBarrelInstance, blast: BlastEvent) => void;
}

const INTACT_DRUM_RINGS: ReadonlyArray<{ y: number; r: number; v: number }> = [
  { y: 0.0, r: 0.275, v: 0.0 },
  { y: 0.025, r: 0.295, v: 0.03 },
  { y: 0.05, r: 0.282, v: 0.06 },
  { y: 0.28, r: 0.282, v: 0.31 },
  { y: 0.30, r: 0.298, v: 0.33 },
  { y: 0.32, r: 0.282, v: 0.35 },
  { y: 0.58, r: 0.282, v: 0.65 },
  { y: 0.60, r: 0.298, v: 0.67 },
  { y: 0.62, r: 0.282, v: 0.69 },
  { y: 0.85, r: 0.282, v: 0.94 },
  { y: 0.875, r: 0.295, v: 0.97 },
  { y: 0.90, r: 0.275, v: 1.0 },
];

const CRUMPLED_BASE_RINGS: ReadonlyArray<{ y: number; r: number; v: number }> = [
  { y: 0.0, r: 0.29, v: 0.0 },
  { y: 0.04, r: 0.32, v: 0.15 },
  { y: 0.14, r: 0.27, v: 0.55 },
  { y: 0.26, r: 0.33, v: 1.0 },
];

/**
 * Spawns shootable ribbed red/yellow industrial hazard barrels registered in `RapierPhysicsWorld`
 * as `STEEL` colliders (`hazard_barrel_<i>`).
 */
export class ExplosiveBarrelManager implements IDestructibleSubsystem {
  public readonly id = 'explosive_hazard_barrels';
  public readonly barrels: HazardBarrelInstance[] = [];

  private readonly app: pc.Application | null;
  private readonly rapierWorld: RapierPhysicsWorld;
  private readonly shrapnelPool: HardwareInstancedPool | null;
  private readonly sympatheticChainFuseS: number;

  public onBarrelIgnited?: (barrel: HazardBarrelInstance) => void;
  public onBarrelDetonated?: (barrel: HazardBarrelInstance, blast: BlastEvent) => void;

  private readonly rootContainer: pc.Entity | null;
  private readonly intactMesh: pc.Mesh | null = null;
  private readonly crumpledMesh: pc.Mesh | null = null;
  private readonly scorchQuadMesh: pc.Mesh | null = null;
  private readonly intactMat: pc.StandardMaterial | null = null;
  private readonly charredMat: pc.StandardMaterial | null = null;
  private readonly scorchMat: pc.StandardMaterial | null = null;
  private readonly flameJetMat: pc.StandardMaterial | null = null;

  private emberSpawnAccumS = 0;
  private flickerClockS = 0;
  private destroyed = false;

  public constructor(options: ExplosiveBarrelManagerOptions) {
    this.app = options.app ?? null;
    this.rapierWorld = options.rapierWorld;
    this.shrapnelPool = options.shrapnelPool ?? null;
    this.sympatheticChainFuseS = Math.max(0, options.sympatheticChainFuseS ?? 0.08);
    this.onBarrelIgnited = options.onBarrelIgnited;
    this.onBarrelDetonated = options.onBarrelDetonated;

    if (this.app) {
      const dev = this.app.graphicsDevice;
      this.rootContainer = new pc.Entity('HazardBarrelsRoot');
      this.app.root.addChild(this.rootContainer);

      this.intactMesh = buildLoftedDrumMesh(dev, INTACT_DRUM_RINGS, 20, 0);
      this.crumpledMesh = buildLoftedDrumMesh(dev, CRUMPLED_BASE_RINGS, 16, 73);
      this.scorchQuadMesh = buildUnitQuadZMesh(dev);

      this.intactMat = createHazardBarrelMaterial(dev);
      this.charredMat = createCharredBarrelMaterial();
      this.scorchMat = createScorchDecalMaterial(dev);

      this.flameJetMat = new pc.StandardMaterial();
      this.flameJetMat.name = 'barrelHissingFlameJetMat';
      this.flameJetMat.diffuse = new pc.Color(1.0, 0.72, 0.18);
      this.flameJetMat.emissive = new pc.Color(1.0, 0.58, 0.12);
      this.flameJetMat.emissiveIntensity = 3.2;
      this.flameJetMat.opacity = 0.9;
      this.flameJetMat.blendType = pc.BLEND_ADDITIVEALPHA;
      this.flameJetMat.depthWrite = false;
      this.flameJetMat.cull = pc.CULLFACE_NONE;
      this.flameJetMat.update();
    } else {
      this.rootContainer = null;
    }

    const positions = options.barrelPositions ?? DEFAULT_HAZARD_BARREL_POSITIONS;
    for (let i = 0; i < positions.length; i++) {
      this.barrels.push(this.createBarrelSlot(i, positions[i]));
    }
    this.flushRapierBroadPhaseQueries();
  }

  public getBarrelByObjectId(objectId: string): HazardBarrelInstance | undefined {
    return this.barrels.find((b) => b.objectId === objectId);
  }

  public registerBarrelHit(
    barrelOrId: HazardBarrelInstance | string | number,
    hit: ExplosiveBarrelHitInput = {},
  ): boolean {
    if (this.destroyed) return false;

    const barrel =
      typeof barrelOrId === 'number'
        ? this.barrels[barrelOrId]
        : typeof barrelOrId === 'string'
          ? this.getBarrelByObjectId(barrelOrId)
          : barrelOrId;

    if (!barrel || barrel.state !== 'INTACT') {
      return false;
    }

    const isBuckshot =
      hit.ammoType === 'BUCKSHOT_00' ||
      (hit.pelletCount !== undefined && hit.pelletCount > 1) ||
      (hit.ammoType === undefined &&
        !hit.isArmorPiercing &&
        hit.kineticEnergyJ !== undefined &&
        hit.kineticEnergyJ < 650);

    const damageDelta = isBuckshot ? 0.5 : 1.0;
    barrel.hitCount += 1;
    barrel.ignitionDamage += damageDelta;

    if (hit.hitPointWorld) {
      barrel.leakOffsetLocal = {
        x: Math.max(-0.28, Math.min(0.28, hit.hitPointWorld.x - barrel.basePosition.x)),
        y: Math.max(0.18, Math.min(0.82, hit.hitPointWorld.y - barrel.basePosition.y)),
        z: Math.max(-0.28, Math.min(0.28, hit.hitPointWorld.z - barrel.basePosition.z)),
      };
    }
    if (hit.hitNormalWorld && length(hit.hitNormalWorld) > 1e-4) {
      barrel.leakNormalWorld = normalize(hit.hitNormalWorld);
    }

    if (barrel.ignitionDamage >= 1.0 - 1e-6) {
      this.igniteBarrel(barrel, BARREL_FUSE_DURATION_S);
      return true;
    }
    return false;
  }

  public handleRaySegment(
    seg: BallisticSegmentImpact,
  ): BallisticPenetrationResult | null {
    if (this.destroyed || seg.maxDistanceM <= 0 || seg.kineticEnergyJ <= 0) {
      return null;
    }

    const hits = this.rapierWorld.castPenetrationRay(
      seg.originWorld,
      seg.directionWorld,
      seg.maxDistanceM,
    );

    for (const hit of hits) {
      if (!hit.surface.objectId.startsWith('hazard_barrel_')) {
        continue;
      }
      const barrel = this.getBarrelByObjectId(hit.surface.objectId);
      if (!barrel || barrel.state === 'DETONATED') {
        continue;
      }

      this.registerBarrelHit(barrel, {
        kineticEnergyJ: seg.kineticEnergyJ,
        isArmorPiercing: seg.isArmorPiercing,
        hitPointWorld: hit.pointWorld,
        hitNormalWorld: hit.normalWorld,
      });

      const absorbedJ = Math.min(seg.kineticEnergyJ, hit.surface.penetrationResistanceJ);
      const remEnergy = Math.max(0, seg.kineticEnergyJ - absorbedJ);
      const speedRatio =
        seg.kineticEnergyJ > 1e-6 ? Math.sqrt(remEnergy / seg.kineticEnergyJ) : 0;

      return {
        remainingEnergyJ: remEnergy,
        remainingSpeedMs: seg.speedMs * speedRatio,
        stopped: remEnergy < 45,
        impactPointWorld: hit.pointWorld,
        impactNormalWorld: hit.normalWorld,
        hitMaterial: 'STEEL',
      };
    }

    return null;
  }

  public applyBlast(blast: BlastEvent): void {
    if (this.destroyed || blast.radiusM <= 0 || blast.peakEnergyJ <= 0) {
      return;
    }

    for (const barrel of this.barrels) {
      if (barrel.state !== 'INTACT') {
        continue;
      }

      const drumCenter = {
        x: barrel.basePosition.x,
        y: barrel.basePosition.y + 0.45,
        z: barrel.basePosition.z,
      };
      const distM = distance(blast.centerWorld, drumCenter);
      if (distM > blast.radiusM) {
        continue;
      }

      const falloff = Math.max(0, 1 - distM / blast.radiusM);
      const deliveredEnergyJ = blast.peakEnergyJ * falloff;
      if (deliveredEnergyJ < 450) {
        continue;
      }

      barrel.ignitionDamage = Math.max(1.0, barrel.ignitionDamage + 1.0);
      if (this.sympatheticChainFuseS <= 0) {
        this.detonateBarrel(barrel);
      } else {
        this.igniteBarrel(barrel, this.sympatheticChainFuseS);
      }
    }
  }

  public update(dt: number): void {
    if (this.destroyed || !Number.isFinite(dt) || dt <= 0) {
      return;
    }

    this.flickerClockS += dt;
    this.emberSpawnAccumS += dt;
    const emitEmbers = this.emberSpawnAccumS >= 0.03;
    if (emitEmbers) {
      this.emberSpawnAccumS = 0;
    }

    for (const barrel of this.barrels) {
      if (barrel.state !== 'IGNITED_HISSING') {
        continue;
      }

      if (barrel.flameJetEntity) {
        const pulse = 1.0 + Math.sin(this.flickerClockS * 95 + barrel.index) * 0.28;
        barrel.flameJetEntity.setLocalScale(0.12 * pulse, 0.46 * pulse, 0.12 * pulse);
      }

      if (emitEmbers && this.shrapnelPool) {
        const jetWorld = add(barrel.basePosition, barrel.leakOffsetLocal);
        const jetVel = add(
          scale(barrel.leakNormalWorld, 3.8),
          vec3((Math.random() - 0.5) * 1.6, 2.8 + Math.random() * 1.8, (Math.random() - 0.5) * 1.6),
        );
        this.shrapnelPool.spawnKinematicParticle(
          jetWorld,
          jetVel,
          vec3(14, 18, -12),
          vec3(0.022, 0.022, 0.022),
          -6.5,
          0.35,
          0.26,
        );
      }

      barrel.fuseRemainingS -= dt;
      if (barrel.fuseRemainingS <= 0) {
        this.detonateBarrel(barrel);
      }
    }
  }

  public resetBarrels(): void {
    if (this.destroyed) return;

    for (const barrel of this.barrels) {
      if (barrel.colliderHandle >= 0) {
        this.rapierWorld.removeCollider(barrel.colliderHandle);
      }
      barrel.colliderHandle = this.createBarrelStaticCollider(
        barrel.index,
        barrel.basePosition,
      );
      barrel.state = 'INTACT';
      barrel.ignitionDamage = 0;
      barrel.hitCount = 0;
      barrel.fuseRemainingS = 0;
      barrel.leakOffsetLocal = { x: 0, y: 0.62, z: 0.28 };
      barrel.leakNormalWorld = { x: 0, y: 0.35, z: 0.94 };

      if (barrel.intactDrumEntity) barrel.intactDrumEntity.enabled = true;
      if (barrel.flameJetEntity) barrel.flameJetEntity.enabled = false;
      if (barrel.crumpledBaseEntity) barrel.crumpledBaseEntity.enabled = false;
      if (barrel.scorchDecalEntity) barrel.scorchDecalEntity.enabled = false;
    }
    this.flushRapierBroadPhaseQueries();
  }

  private flushRapierBroadPhaseQueries(): void {
    const prevDt = this.rapierWorld.world.timestep;
    this.rapierWorld.world.timestep = 0;
    this.rapierWorld.world.step();
    this.rapierWorld.world.timestep = prevDt;
  }

  public reset(): void {
    this.resetBarrels();
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    for (const barrel of this.barrels) {
      if (barrel.colliderHandle >= 0) {
        this.rapierWorld.removeCollider(barrel.colliderHandle);
        barrel.colliderHandle = -1;
      }
    }
    this.barrels.length = 0;

    if (this.rootContainer) {
      this.rootContainer.destroy();
    }
  }

  private igniteBarrel(barrel: HazardBarrelInstance, fuseDurationS: number): void {
    if (barrel.state !== 'INTACT') return;

    barrel.state = 'IGNITED_HISSING';
    barrel.fuseRemainingS = Math.max(0.01, fuseDurationS);

    if (barrel.flameJetEntity) {
      barrel.flameJetEntity.setLocalPosition(
        barrel.leakOffsetLocal.x,
        barrel.leakOffsetLocal.y,
        barrel.leakOffsetLocal.z,
      );
      barrel.flameJetEntity.enabled = true;
    }

    this.onBarrelIgnited?.(barrel);
  }

  private detonateBarrel(barrel: HazardBarrelInstance): void {
    if (barrel.state === 'DETONATED') {
      return;
    }

    // Transition state & remove static collider FIRST to guarantee zero cyclic recursion
    barrel.state = 'DETONATED';
    barrel.fuseRemainingS = 0;
    if (barrel.colliderHandle >= 0) {
      this.rapierWorld.removeCollider(barrel.colliderHandle);
      barrel.colliderHandle = -1;
    }

    if (barrel.intactDrumEntity) barrel.intactDrumEntity.enabled = false;
    if (barrel.flameJetEntity) barrel.flameJetEntity.enabled = false;
    if (barrel.crumpledBaseEntity) barrel.crumpledBaseEntity.enabled = true;
    if (barrel.scorchDecalEntity) barrel.scorchDecalEntity.enabled = true;

    const blastCenter: Vec3Like = {
      x: barrel.basePosition.x,
      y: barrel.basePosition.y + 0.45,
      z: barrel.basePosition.z,
    };

    const blast: BlastEvent = {
      centerWorld: blastCenter,
      radiusM: BARREL_BLAST_RADIUS_M,
      peakImpulseNs: BARREL_BLAST_PEAK_IMPULSE_NS,
      peakEnergyJ: BARREL_BLAST_PEAK_ENERGY_J,
    };

    // Launch hardware-instanced twisted steel shrapnel shards
    if (this.shrapnelPool) {
      const shardCount = 24;
      for (let i = 0; i < shardCount; i++) {
        const angle = (i / shardCount) * Math.PI * 2 + barrel.index * 0.61;
        const elev = 0.25 + ((i * 7) % 11) * 0.065;
        const speed = 7.5 + ((i * 13) % 9) * 1.35;
        const dir = normalize({
          x: Math.cos(angle),
          y: elev,
          z: Math.sin(angle),
        });
        this.shrapnelPool.spawnKinematicParticle(
          add(blastCenter, scale(dir, 0.24)),
          scale(dir, speed),
          {
            x: ((i % 5) - 2) * 14,
            y: ((i % 7) - 3) * 16,
            z: ((i % 3) - 1) * 19,
          },
          { x: 0.075, y: 0.018, z: 0.048 },
          -9.81,
          0.36,
          3.2,
        );
      }
    }

    this.rapierWorld.applyRadialBlastImpulse(blast);
    this.onBarrelDetonated?.(barrel, blast);
    this.applyBlast(blast);
  }

  private createBarrelStaticCollider(index: number, basePos: Vec3Like): number {
    const objectId = `hazard_barrel_${index}`;
    const tag: ColliderSurfaceTag = {
      material: 'STEEL',
      objectId,
      thicknessM: 0.006,
      penetrationResistanceJ: 950,
    };
    return this.rapierWorld.createStaticBox(
      { x: basePos.x, y: basePos.y + 0.45, z: basePos.z },
      { x: 0.29, y: 0.45, z: 0.29 },
      undefined,
      tag,
    );
  }

  private createBarrelSlot(index: number, pos: Vec3Like): HazardBarrelInstance {
    const basePos = copyVec3(pos);
    const objectId = `hazard_barrel_${index}`;
    const colliderHandle = this.createBarrelStaticCollider(index, basePos);

    let rootEntity: pc.Entity | null = null;
    let intactDrumEntity: pc.Entity | null = null;
    let flameJetEntity: pc.Entity | null = null;
    let crumpledBaseEntity: pc.Entity | null = null;
    let scorchDecalEntity: pc.Entity | null = null;

    if (
      this.app &&
      this.rootContainer &&
      this.intactMesh &&
      this.crumpledMesh &&
      this.scorchQuadMesh &&
      this.intactMat &&
      this.charredMat &&
      this.scorchMat &&
      this.flameJetMat
    ) {
      rootEntity = new pc.Entity(`HazardBarrel_${index}`);
      rootEntity.setPosition(basePos.x, basePos.y, basePos.z);
      this.rootContainer.addChild(rootEntity);

      intactDrumEntity = new pc.Entity(`HazardBarrelIntact_${index}`);
      const intactMi = new pc.MeshInstance(this.intactMesh, this.intactMat);
      intactDrumEntity.addComponent('render', {
        meshInstances: [intactMi],
        castShadows: true,
        receiveShadows: true,
      });
      rootEntity.addChild(intactDrumEntity);

      flameJetEntity = new pc.Entity(`HazardBarrelFlameJet_${index}`);
      flameJetEntity.addComponent('render', {
        type: 'cone',
        material: this.flameJetMat,
        castShadows: false,
      });
      flameJetEntity.setLocalPosition(0, 0.62, 0.28);
      flameJetEntity.setLocalScale(0.11, 0.42, 0.11);
      flameJetEntity.setLocalEulerAngles(55, 0, 0);
      flameJetEntity.enabled = false;
      rootEntity.addChild(flameJetEntity);

      crumpledBaseEntity = new pc.Entity(`HazardBarrelCrumpled_${index}`);
      const crumpledMi = new pc.MeshInstance(this.crumpledMesh, this.charredMat);
      crumpledBaseEntity.addComponent('render', {
        meshInstances: [crumpledMi],
        castShadows: true,
        receiveShadows: true,
      });
      crumpledBaseEntity.enabled = false;
      rootEntity.addChild(crumpledBaseEntity);

      scorchDecalEntity = new pc.Entity(`HazardBarrelScorch_${index}`);
      const scorchMi = new pc.MeshInstance(this.scorchQuadMesh, this.scorchMat);
      scorchDecalEntity.addComponent('render', {
        meshInstances: [scorchMi],
        castShadows: false,
        receiveShadows: true,
      });
      scorchDecalEntity.setLocalPosition(0, 0.006, 0);
      scorchDecalEntity.setLocalEulerAngles(-90, index * 37, 0);
      scorchDecalEntity.setLocalScale(2.9, 2.9, 1);
      scorchDecalEntity.enabled = false;
      rootEntity.addChild(scorchDecalEntity);
    }

    return {
      index,
      objectId,
      basePosition: basePos,
      state: 'INTACT',
      colliderHandle,
      ignitionDamage: 0,
      hitCount: 0,
      fuseRemainingS: 0,
      leakOffsetLocal: { x: 0, y: 0.62, z: 0.28 },
      leakNormalWorld: { x: 0, y: 0.35, z: 0.94 },
      rootEntity,
      intactDrumEntity,
      flameJetEntity,
      crumpledBaseEntity,
      scorchDecalEntity,
    };
  }
}

// ============================================================================
// 4. MayhemDirector — Hot-Core Tracers, Gleaming Brass/12G Casings, Impact Sparks
//    & Dust Plumes, Multi-Stage AAA Detonations, Gore Splatter & Bullet-Time
// ============================================================================

export interface CasingBounceEvent {
  readonly position: Vec3Like;
  readonly impactSpeedMs: number;
  readonly isShotgunHull: boolean;
  readonly bounceIndex: number;
}

export interface BloodSplatterProjectionParams {
  readonly originWorld: Vec3Like;
  readonly impactDirectionWorld: Vec3Like;
  readonly exitEnergyJ: number;
  readonly goreMode?: GoreMode;
  readonly splatterScaleM?: number;
}

export interface MayhemDirectorOptions {
  app: pc.Application;
  rapierWorld: RapierPhysicsWorld;
  barrelPositions?: readonly Vec3Like[];
  sympatheticChainFuseS?: number;
  maxBrassCasings?: number;
  maxShotgunHulls?: number;
  maxBloodSplatters?: number;
  maxShrapnelShards?: number;
  dynamicLightPoolSize?: number;
  bulletTimeOptions?: BulletTimeOptions;
  onCasingBounce?: (event: CasingBounceEvent) => void;
  onExplosionBlast?: (blast: BlastEvent) => void;
  onBarrelIgnited?: (barrel: HazardBarrelInstance) => void;
}

interface PooledDynamicOmniLight {
  entity: pc.Entity;
  active: boolean;
  elapsedS: number;
  durationS: number;
  peakIntensity: number;
  isExplosion: boolean;
}

interface TransientFireballLobe {
  entity: pc.Entity;
  material: pc.StandardMaterial;
  position: pc.Vec3;
  velocity: pc.Vec3;
  angularVelocity: pc.Vec3;
  elapsedS: number;
  durationS: number;
  startScale: number;
  endScale: number;
}

interface TransientBillowPlume {
  entity: pc.Entity;
  material: pc.StandardMaterial;
  position: pc.Vec3;
  velocity: pc.Vec3;
  elapsedS: number;
  durationS: number;
  startScale: number;
  endScale: number;
  baseOpacity: number;
  spinDegPerS: number;
  isGroundRing: boolean;
}

const CASING_BOUNCE_FLOOR_Y = 0.012;
const TRACKED_CASING_CAPACITY = 64;
const BLOOD_RAY_MAX_DIST_M = 4.5;
const BLOOD_WALL_NORMAL_OFFSET_M = 0.004;

export class MayhemDirector {
  public readonly app: pc.Application;
  public readonly rapierWorld: RapierPhysicsWorld;
  public readonly rootEntity: pc.Entity;

  public readonly bulletTime: BulletTimeController;
  public readonly barrels: ExplosiveBarrelManager;

  public readonly brassCasingPool: HardwareInstancedPool;
  public readonly shotgunHullPool: HardwareInstancedPool;
  public readonly shrapnelPool: HardwareInstancedPool;
  public readonly bloodSplatterPool: HardwareInstancedPool;
  public readonly tracerCorePool: HardwareInstancedPool;
  public readonly tracerHaloPool: HardwareInstancedPool;
  public readonly impactSparkPool: HardwareInstancedPool;

  public onCasingBounce?: (event: CasingBounceEvent) => void;
  public onExplosionBlast?: (blast: BlastEvent) => void;

  private readonly lightPool: PooledDynamicOmniLight[] = [];
  private readonly fireballLobes: TransientFireballLobe[] = [];
  private readonly billowPlumes: TransientBillowPlume[] = [];

  private readonly dustPlumeTemplateMat: pc.StandardMaterial;
  private readonly darkSmokeTemplateMat: pc.StandardMaterial;
  private readonly shockwaveRingTemplateMat: pc.StandardMaterial;
  private readonly flashCoreTemplateMat: pc.StandardMaterial;
  private readonly unitQuadMesh: pc.Mesh;

  // Pre-allocated typed-array tracker for casing floor-bounce audio callbacks (zero GC!)
  private readonly trackActive = new Uint8Array(TRACKED_CASING_CAPACITY);
  private readonly trackIsHull = new Uint8Array(TRACKED_CASING_CAPACITY);
  private readonly trackBounces = new Uint8Array(TRACKED_CASING_CAPACITY);
  private readonly trackPosX = new Float32Array(TRACKED_CASING_CAPACITY);
  private readonly trackPosY = new Float32Array(TRACKED_CASING_CAPACITY);
  private readonly trackPosZ = new Float32Array(TRACKED_CASING_CAPACITY);
  private readonly trackVelX = new Float32Array(TRACKED_CASING_CAPACITY);
  private readonly trackVelY = new Float32Array(TRACKED_CASING_CAPACITY);
  private readonly trackVelZ = new Float32Array(TRACKED_CASING_CAPACITY);
  private readonly trackRestitution = new Float32Array(TRACKED_CASING_CAPACITY);
  private trackWriteCursor = 0;

  private splatterRecycleCursor = 0;
  private splatterSeedCounter = 1;
  private casingSeedCounter = 1;
  private fxSeedCounter = 1;
  private destroyed = false;

  public constructor(options: MayhemDirectorOptions) {
    this.app = options.app;
    this.rapierWorld = options.rapierWorld;
    this.onCasingBounce = options.onCasingBounce;
    this.onExplosionBlast = options.onExplosionBlast;

    this.rootEntity = new pc.Entity('MayhemDirectorRoot');
    this.app.root.addChild(this.rootEntity);

    const dev = this.app.graphicsDevice;
    this.unitQuadMesh = buildUnitQuadZMesh(dev);

    // 1. Hardware-instanced Gleaming Bottlenecked Brass Casings & Ribbed 12G Shotgun Hulls
    const casingCylinderMesh = buildLoftedDrumMesh(
      dev,
      [
        { y: -0.5, r: 0.54, v: 0.0 },   // Extractor rim flange
        { y: -0.44, r: 0.46, v: 0.06 }, // Extractor groove
        { y: -0.39, r: 0.51, v: 0.11 }, // Case head web
        { y: 0.18, r: 0.49, v: 0.68 },  // Tapered body
        { y: 0.34, r: 0.38, v: 0.84 },  // Bottleneck shoulder
        { y: 0.5, r: 0.37, v: 1.0 },    // Annealed case mouth
      ],
      14,
      0,
    );
    const hullCylinderMesh = buildLoftedDrumMesh(
      dev,
      [
        { y: -0.5, r: 0.56, v: 0.0 },   // Brass rim flange
        { y: -0.44, r: 0.52, v: 0.06 }, // High-brass head base
        { y: -0.2, r: 0.51, v: 0.3 },   // Brass-to-hull step
        { y: 0.44, r: 0.5, v: 0.94 },   // Ribbed crimson hull
        { y: 0.5, r: 0.46, v: 1.0 },    // Unfurled star-crimp mouth
      ],
      14,
      0,
    );

    const brassMat = createGleamingBrassCasingMaterial(dev);
    const hullMat = createShotgunHullMaterial(dev);

    this.brassCasingPool = new HardwareInstancedPool(
      this.app,
      casingCylinderMesh,
      brassMat,
      options.maxBrassCasings ?? 256,
      'MayhemBrassCasingPool',
      false,
    );
    this.shotgunHullPool = new HardwareInstancedPool(
      this.app,
      hullCylinderMesh,
      hullMat,
      options.maxShotgunHulls ?? 128,
      'MayhemShotgunHullPool',
      false,
    );

    // 2. Hardware-instanced Explosive Steel Shrapnel Pool
    const shrapnelBoxMesh = pc.Mesh.fromGeometry(dev, new pc.BoxGeometry());
    const shrapnelMat = new pc.StandardMaterial();
    shrapnelMat.name = 'mayhemHotShrapnelMat';
    shrapnelMat.diffuse = new pc.Color(0.24, 0.2, 0.18);
    shrapnelMat.emissive = new pc.Color(1.0, 0.38, 0.08);
    shrapnelMat.emissiveIntensity = 2.2;
    shrapnelMat.useMetalness = true;
    shrapnelMat.metalness = 0.82;
    shrapnelMat.gloss = 0.65;
    shrapnelMat.fresnelModel = pc.FRESNEL_SCHLICK;
    shrapnelMat.update();

    this.shrapnelPool = new HardwareInstancedPool(
      this.app,
      shrapnelBoxMesh,
      shrapnelMat,
      options.maxShrapnelShards ?? 256,
      'MayhemShrapnelPool',
      false,
    );

    // 3. Hardware-instanced Persistent Wall & Floor Wet Gore Splatter Decals
    const splatterMat = createBloodSplatterMaterial(dev);
    this.bloodSplatterPool = new HardwareInstancedPool(
      this.app,
      this.unitQuadMesh,
      splatterMat,
      options.maxBloodSplatters ?? 384,
      'MayhemBloodSplatterPool',
      false,
    );

    // 4. Hardware-instanced Incandescent Hot-Core Bullet Tracers & Ricochet Impact Sparks
    const streakMesh = buildCrossedStreakZMesh(dev);
    const streakGlowTex = createStreakGlowTexture(dev);

    const tracerCoreMat = new pc.StandardMaterial();
    tracerCoreMat.name = 'mayhemTracerHotCoreMat';
    tracerCoreMat.diffuse = new pc.Color(1.0, 0.98, 0.88);
    tracerCoreMat.emissive = new pc.Color(1.0, 0.93, 0.72);
    tracerCoreMat.emissiveMap = streakGlowTex;
    tracerCoreMat.emissiveIntensity = 4.2;
    tracerCoreMat.opacityMap = streakGlowTex;
    tracerCoreMat.opacityMapChannel = 'a';
    tracerCoreMat.blendType = pc.BLEND_ADDITIVEALPHA;
    tracerCoreMat.depthWrite = false;
    tracerCoreMat.cull = pc.CULLFACE_NONE;
    tracerCoreMat.update();

    const tracerHaloMat = new pc.StandardMaterial();
    tracerHaloMat.name = 'mayhemTracerPlasmaHaloMat';
    tracerHaloMat.diffuse = new pc.Color(1.0, 0.66, 0.22);
    tracerHaloMat.emissive = new pc.Color(1.0, 0.52, 0.12);
    tracerHaloMat.emissiveMap = streakGlowTex;
    tracerHaloMat.emissiveIntensity = 2.4;
    tracerHaloMat.opacity = 0.72;
    tracerHaloMat.opacityMap = streakGlowTex;
    tracerHaloMat.opacityMapChannel = 'a';
    tracerHaloMat.blendType = pc.BLEND_ADDITIVEALPHA;
    tracerHaloMat.depthWrite = false;
    tracerHaloMat.cull = pc.CULLFACE_NONE;
    tracerHaloMat.update();

    const impactSparkMat = new pc.StandardMaterial();
    impactSparkMat.name = 'mayhemRicochetSparkMat';
    impactSparkMat.diffuse = new pc.Color(1.0, 0.88, 0.48);
    impactSparkMat.emissive = new pc.Color(1.0, 0.72, 0.22);
    impactSparkMat.emissiveMap = streakGlowTex;
    impactSparkMat.emissiveIntensity = 3.8;
    impactSparkMat.opacityMap = streakGlowTex;
    impactSparkMat.opacityMapChannel = 'a';
    impactSparkMat.blendType = pc.BLEND_ADDITIVEALPHA;
    impactSparkMat.depthWrite = false;
    impactSparkMat.cull = pc.CULLFACE_NONE;
    impactSparkMat.update();

    this.tracerCorePool = new HardwareInstancedPool(
      this.app,
      streakMesh,
      tracerCoreMat,
      128,
      'MayhemTracerCorePool',
      false,
    );
    this.tracerHaloPool = new HardwareInstancedPool(
      this.app,
      streakMesh,
      tracerHaloMat,
      128,
      'MayhemTracerHaloPool',
      false,
    );
    this.impactSparkPool = new HardwareInstancedPool(
      this.app,
      streakMesh,
      impactSparkMat,
      320,
      'MayhemImpactSparkPool',
      false,
    );

    // 5. Soft Cloud, Shockwave Ring & Blinding Flash Template Materials
    const dustCloudTex = createSoftCloudTexture(dev, 'mayhemDustPlumeTex', 3109);
    const smokeCloudTex = createSoftCloudTexture(dev, 'mayhemDarkSmokeTex', 4211);
    const shockRingTex = createShockwaveRingTexture(dev);

    this.dustPlumeTemplateMat = new pc.StandardMaterial();
    this.dustPlumeTemplateMat.name = 'mayhemConcreteDustPlumeMat';
    this.dustPlumeTemplateMat.diffuse = new pc.Color(0.66, 0.64, 0.6);
    this.dustPlumeTemplateMat.emissive = new pc.Color(0.08, 0.075, 0.07);
    this.dustPlumeTemplateMat.opacity = 0.52;
    this.dustPlumeTemplateMat.opacityMap = dustCloudTex;
    this.dustPlumeTemplateMat.opacityMapChannel = 'a';
    this.dustPlumeTemplateMat.blendType = pc.BLEND_NORMAL;
    this.dustPlumeTemplateMat.depthWrite = false;
    this.dustPlumeTemplateMat.cull = pc.CULLFACE_NONE;
    this.dustPlumeTemplateMat.update();

    this.darkSmokeTemplateMat = new pc.StandardMaterial();
    this.darkSmokeTemplateMat.name = 'mayhemDetonationSmokeMat';
    this.darkSmokeTemplateMat.diffuse = new pc.Color(0.11, 0.1, 0.1);
    this.darkSmokeTemplateMat.emissive = new pc.Color(0.03, 0.015, 0.008);
    this.darkSmokeTemplateMat.opacity = 0.72;
    this.darkSmokeTemplateMat.opacityMap = smokeCloudTex;
    this.darkSmokeTemplateMat.opacityMapChannel = 'a';
    this.darkSmokeTemplateMat.blendType = pc.BLEND_NORMAL;
    this.darkSmokeTemplateMat.depthWrite = false;
    this.darkSmokeTemplateMat.cull = pc.CULLFACE_NONE;
    this.darkSmokeTemplateMat.update();

    this.shockwaveRingTemplateMat = new pc.StandardMaterial();
    this.shockwaveRingTemplateMat.name = 'mayhemGroundShockwaveRingMat';
    this.shockwaveRingTemplateMat.diffuse = new pc.Color(1.0, 0.85, 0.58);
    this.shockwaveRingTemplateMat.emissive = new pc.Color(1.0, 0.68, 0.28);
    this.shockwaveRingTemplateMat.emissiveIntensity = 2.4;
    this.shockwaveRingTemplateMat.opacity = 0.86;
    this.shockwaveRingTemplateMat.opacityMap = shockRingTex;
    this.shockwaveRingTemplateMat.opacityMapChannel = 'a';
    this.shockwaveRingTemplateMat.blendType = pc.BLEND_ADDITIVEALPHA;
    this.shockwaveRingTemplateMat.depthWrite = false;
    this.shockwaveRingTemplateMat.cull = pc.CULLFACE_NONE;
    this.shockwaveRingTemplateMat.update();

    this.flashCoreTemplateMat = new pc.StandardMaterial();
    this.flashCoreTemplateMat.name = 'mayhemBlindingFlashCoreMat';
    this.flashCoreTemplateMat.diffuse = new pc.Color(1.0, 0.96, 0.82);
    this.flashCoreTemplateMat.emissive = new pc.Color(1.0, 0.9, 0.62);
    this.flashCoreTemplateMat.emissiveIntensity = 5.5;
    this.flashCoreTemplateMat.opacity = 0.96;
    this.flashCoreTemplateMat.blendType = pc.BLEND_ADDITIVEALPHA;
    this.flashCoreTemplateMat.depthWrite = false;
    this.flashCoreTemplateMat.update();

    // 6. Pooled Dynamic Muzzle Flash & Explosion Omni Point Lights (castShadows: false)
    const lightPoolCount = Math.max(4, options.dynamicLightPoolSize ?? 8);
    for (let i = 0; i < lightPoolCount; i++) {
      const lightEnt = new pc.Entity(`MayhemDynamicOmniLight_${i}`);
      lightEnt.addComponent('light', {
        type: 'omni',
        color: new pc.Color(1.0, 0.72, 0.3),
        intensity: 0,
        range: 10,
        castShadows: false,
      });
      lightEnt.enabled = false;
      this.rootEntity.addChild(lightEnt);
      this.lightPool.push({
        entity: lightEnt,
        active: false,
        elapsedS: 0,
        durationS: 0.052,
        peakIntensity: 3.8,
        isExplosion: false,
      });
    }

    // 7. F.E.A.R. Bullet-Time Controller & Shootable Explosive Hazard Barrels
    this.bulletTime = new BulletTimeController(options.bulletTimeOptions);
    this.barrels = new ExplosiveBarrelManager({
      app: this.app,
      rapierWorld: this.rapierWorld,
      shrapnelPool: this.shrapnelPool,
      barrelPositions: options.barrelPositions,
      sympatheticChainFuseS: options.sympatheticChainFuseS,
      onBarrelIgnited: options.onBarrelIgnited,
      onBarrelDetonated: (_barrel, blast) => {
        this.triggerExplosionLight(blast.centerWorld, 20.0);
        this.spawnMultiStageExplosionFx(blast);
        this.onExplosionBlast?.(blast);
      },
    });
  }

  public get activeDynamicLightCount(): number {
    let n = 0;
    for (const l of this.lightPool) {
      if (l.active) n++;
    }
    return n;
  }

  /**
   * Spawns a high-contrast incandescent hot-core + amber plasma-halo bullet tracer streak.
   */
  public spawnBulletTracer(
    originWorld: Vec3Like,
    directionWorld: Vec3Like,
    maxDistanceM = 48.0,
    streakLengthM = 1.65,
  ): void {
    if (this.destroyed) return;
    const dir = normalize(directionWorld);
    if (length(dir) < 1e-6) return;

    const clampedDist = Math.max(1.2, Math.min(85.0, maxDistanceM));
    const ttl = Math.max(0.055, Math.min(0.24, clampedDist / 185.0));
    const speed = clampedDist / ttl;
    const startPos = add(originWorld, scale(dir, Math.min(0.55, clampedDist * 0.25)));
    const vel = scale(dir, speed);
    const quat = directionToStreakQuaternion(dir);

    this.tracerCorePool.spawnKinematicParticle(
      startPos,
      vel,
      { x: 0, y: 0, z: 0 },
      { x: 0.016, y: 0.016, z: streakLengthM },
      0,
      0,
      ttl,
      quat,
    );
    this.tracerHaloPool.spawnKinematicParticle(
      startPos,
      vel,
      { x: 0, y: 0, z: 0 },
      { x: 0.048, y: 0.048, z: streakLengthM * 1.18 },
      0,
      0,
      ttl,
      quat,
    );
  }

  /**
   * Spawns crisp ricochet spark streaks + billowing dust plumes at a concrete, brick, wood, or steel impact!
   */
  public spawnSurfaceImpactFx(
    hitPointWorld: Vec3Like,
    surfaceNormalWorld: Vec3Like,
    surfaceMaterial: DestructibleMaterialKind = 'CONCRETE_INTACT',
    kineticEnergyJ = 650,
  ): void {
    if (this.destroyed) return;

    const n = length(surfaceNormalWorld) > 1e-4 ? normalize(surfaceNormalWorld) : vec3(0, 1, 0);
    const upRef = Math.abs(n.y) < 0.95 ? vec3(0, 1, 0) : vec3(1, 0, 0);
    const tangentA = normalize(cross(upRef, n));
    const tangentB = normalize(cross(n, tangentA));

    const isGlass = surfaceMaterial.startsWith('GLASS');
    const isWood = surfaceMaterial.startsWith('WOOD');
    const isMetallic = surfaceMaterial === 'STEEL' || isGlass;
    const sparkCount = isMetallic
      ? 14
      : isWood
        ? 4
        : 9;

    const energyScale = Math.min(1.65, 0.72 + kineticEnergyJ / 1800);
    const origin = add(hitPointWorld, scale(n, 0.018));

    // 1. High-contrast incandescent ricochet sparks
    for (let i = 0; i < sparkCount; i++) {
      const seed = this.fxSeedCounter++;
      const angle = ((seed * 137.5) % 360) * (Math.PI / 180);
      const spread = 0.25 + ((seed * 31) % 17) / 22;
      const spd = (isMetallic ? 8.5 : 6.2) * energyScale * (0.65 + ((seed * 19) % 13) / 16);

      const sparkDir = normalize({
        x: n.x + (tangentA.x * Math.cos(angle) + tangentB.x * Math.sin(angle)) * spread,
        y: n.y + (tangentA.y * Math.cos(angle) + tangentB.y * Math.sin(angle)) * spread + 0.18,
        z: n.z + (tangentA.z * Math.cos(angle) + tangentB.z * Math.sin(angle)) * spread,
      });

      const quat = directionToStreakQuaternion(sparkDir);
      this.impactSparkPool.spawnKinematicParticle(
        origin,
        scale(sparkDir, spd),
        { x: 0, y: 0, z: 0 },
        { x: 0.012, y: 0.012, z: isMetallic ? 0.24 : 0.16 },
        -11.5,
        0.48,
        0.18 + ((seed % 5) * 0.045),
        quat,
      );
    }

    // 2. Pulverized concrete / masonry / wood dust plumes
    if (this.billowPlumes.length < 48 && !isGlass) {
      const puffCount = isMetallic ? 1 : 2;
      for (let p = 0; p < puffCount; p++) {
        const seed = this.fxSeedCounter++;
        const mat = this.dustPlumeTemplateMat.clone();
        if (surfaceMaterial === 'BRICK_MASONRY') {
          mat.diffuse = new pc.Color(0.64, 0.44, 0.36);
        } else if (isWood) {
          mat.diffuse = new pc.Color(0.68, 0.56, 0.38);
        } else if (isMetallic) {
          mat.diffuse = new pc.Color(0.52, 0.54, 0.58);
        }
        const baseOpacity = isMetallic ? 0.32 : 0.52;
        mat.opacity = baseOpacity;
        mat.update();

        const puffEnt = new pc.Entity('MayhemImpactDustPlume');
        const mi = new pc.MeshInstance(this.unitQuadMesh, mat);
        puffEnt.addComponent('render', {
          meshInstances: [mi],
          castShadows: false,
          receiveShadows: false,
        });

        const startScale = (0.14 + p * 0.06) * energyScale;
        const endScale = (0.62 + p * 0.28) * energyScale;
        puffEnt.setPosition(origin.x, origin.y, origin.z);
        puffEnt.setLocalScale(startScale, startScale, 1);
        this.rootEntity.addChild(puffEnt);

        const jitterA = ((seed * 47) % 19) / 19 - 0.5;
        const jitterB = ((seed * 83) % 23) / 23 - 0.5;
        const driftVel = new pc.Vec3(
          n.x * (1.25 + p * 0.55) + tangentA.x * jitterA * 0.9,
          Math.max(0.25, n.y * 1.1 + 0.55 + p * 0.25),
          n.z * (1.25 + p * 0.55) + tangentB.z * jitterB * 0.9,
        );

        this.billowPlumes.push({
          entity: puffEnt,
          material: mat,
          position: new pc.Vec3(origin.x, origin.y, origin.z),
          velocity: driftVel,
          elapsedS: 0,
          durationS: 0.48 + p * 0.2,
          startScale,
          endScale,
          baseOpacity,
          spinDegPerS: jitterA * 85,
          isGroundRing: false,
        });
      }
    }
  }

  /**
   * Spawns a multi-stage AAA detonation sequence:
   * 1. Blinding white-gold initial flash core sphere
   * 2. Churning multi-lobed emissive-to-soot fireball spheres
   * 3. Rapidly expanding ground shockwave condensation ring
   * 4. Flying incandescent ember streaks
   * 5. Lingering rising dark charcoal smoke plumes
   */
  public spawnMultiStageExplosionFx(blast: BlastEvent): void {
    if (this.destroyed) return;
    const center = blast.centerWorld;
    const radiusScale = Math.max(0.75, Math.min(1.6, blast.radiusM / 6.0));

    // Stage 1: Blinding initial white-gold flash core
    const flashMat = this.flashCoreTemplateMat.clone();
    flashMat.update();
    const flashEnt = new pc.Entity('ExplosionFlashCore');
    flashEnt.addComponent('render', {
      type: 'sphere',
      material: flashMat,
      castShadows: false,
    });
    flashEnt.setPosition(center.x, center.y + 0.15, center.z);
    flashEnt.setLocalScale(0.55 * radiusScale, 0.55 * radiusScale, 0.55 * radiusScale);
    this.rootEntity.addChild(flashEnt);

    this.fireballLobes.push({
      entity: flashEnt,
      material: flashMat,
      position: new pc.Vec3(center.x, center.y + 0.15, center.z),
      velocity: new pc.Vec3(0, 0.4, 0),
      angularVelocity: new pc.Vec3(0, 0, 0),
      elapsedS: 0,
      durationS: 0.085,
      startScale: 0.55 * radiusScale,
      endScale: 3.1 * radiusScale,
    });

    // Stage 2: Churning multi-lobed emissive-to-soot fireball spheres
    const lobeCount = 5;
    for (let i = 0; i < lobeCount; i++) {
      const angle = (i / lobeCount) * Math.PI * 2 + 0.37;
      const radialDist = i === 0 ? 0 : (0.28 + (i % 2) * 0.16) * radiusScale;
      const lobeMat = new pc.StandardMaterial();
      lobeMat.name = `mayhemFireballLobeMat_${i}`;
      lobeMat.diffuse = new pc.Color(1.0, 0.86, 0.45);
      lobeMat.emissive = new pc.Color(1.0, 0.72, 0.24);
      lobeMat.emissiveIntensity = 4.2;
      lobeMat.opacity = 0.94;
      lobeMat.blendType = pc.BLEND_NORMAL;
      lobeMat.depthWrite = false;
      lobeMat.update();

      const lobeEnt = new pc.Entity(`ExplosionFireballLobe_${i}`);
      lobeEnt.addComponent('render', {
        type: 'sphere',
        material: lobeMat,
        castShadows: false,
      });

      const lx = center.x + Math.cos(angle) * radialDist;
      const ly = center.y + (i === 0 ? 0.28 : 0.12 + (i % 3) * 0.14);
      const lz = center.z + Math.sin(angle) * radialDist;
      const startScale = (i === 0 ? 0.85 : 0.62) * radiusScale;
      const endScale = (i === 0 ? 2.55 : 1.95) * radiusScale;

      lobeEnt.setPosition(lx, ly, lz);
      lobeEnt.setLocalScale(startScale, startScale, startScale);
      this.rootEntity.addChild(lobeEnt);

      this.fireballLobes.push({
        entity: lobeEnt,
        material: lobeMat,
        position: new pc.Vec3(lx, ly, lz),
        velocity: new pc.Vec3(
          Math.cos(angle) * (i === 0 ? 0 : 1.65 * radiusScale),
          2.2 + (i % 3) * 0.65,
          Math.sin(angle) * (i === 0 ? 0 : 1.65 * radiusScale),
        ),
        angularVelocity: new pc.Vec3(90 - i * 32, 65 + i * 24, -50 + i * 19),
        elapsedS: 0,
        durationS: 0.56 + (i % 3) * 0.08,
        startScale,
        endScale,
      });
    }

    // Stage 3: Expanding ground shockwave ring
    const ringMat = this.shockwaveRingTemplateMat.clone();
    ringMat.update();
    const ringEnt = new pc.Entity('ExplosionGroundShockwaveRing');
    const ringMi = new pc.MeshInstance(this.unitQuadMesh, ringMat);
    ringEnt.addComponent('render', {
      meshInstances: [ringMi],
      castShadows: false,
      receiveShadows: false,
    });
    const groundY = Math.max(0.03, Math.min(0.25, center.y * 0.12));
    ringEnt.setPosition(center.x, groundY, center.z);
    ringEnt.setLocalEulerAngles(-90, 0, 0);
    ringEnt.setLocalScale(0.6, 0.6, 1);
    this.rootEntity.addChild(ringEnt);

    this.billowPlumes.push({
      entity: ringEnt,
      material: ringMat,
      position: new pc.Vec3(center.x, groundY, center.z),
      velocity: new pc.Vec3(0, 0, 0),
      elapsedS: 0,
      durationS: 0.28,
      startScale: 0.65,
      endScale: blast.radiusM * 2.15,
      baseOpacity: 0.88,
      spinDegPerS: 45,
      isGroundRing: true,
    });

    // Stage 4: Flying incandescent ember streaks
    const emberCount = 28;
    for (let e = 0; e < emberCount; e++) {
      const seed = this.fxSeedCounter++;
      const azim = (e / emberCount) * Math.PI * 2 + ((seed % 11) * 0.09);
      const elev = 0.22 + ((seed * 7) % 13) / 16;
      const spd = (9.5 + ((seed * 17) % 15) * 0.85) * radiusScale;
      const dir = normalize({
        x: Math.cos(azim),
        y: elev,
        z: Math.sin(azim),
      });
      const quat = directionToStreakQuaternion(dir);
      this.impactSparkPool.spawnKinematicParticle(
        add(center, scale(dir, 0.22)),
        scale(dir, spd),
        { x: 0, y: 0, z: 0 },
        { x: 0.022, y: 0.022, z: 0.36 },
        -9.81,
        0.46,
        0.65 + (e % 5) * 0.16,
        quat,
      );
    }

    // Stage 5: Lingering rising dark charcoal smoke plumes
    const smokeCount = 6;
    for (let s = 0; s < smokeCount; s++) {
      if (this.billowPlumes.length >= 60) break;
      const angle = (s / smokeCount) * Math.PI * 2 + 0.52;
      const smokeMat = this.darkSmokeTemplateMat.clone();
      smokeMat.update();

      const smokeEnt = new pc.Entity(`ExplosionDarkSmokePlume_${s}`);
      const smokeMi = new pc.MeshInstance(this.unitQuadMesh, smokeMat);
      smokeEnt.addComponent('render', {
        meshInstances: [smokeMi],
        castShadows: false,
        receiveShadows: false,
      });

      const sx = center.x + Math.cos(angle) * 0.35 * radiusScale;
      const sy = center.y + 0.32 + (s % 3) * 0.22;
      const sz = center.z + Math.sin(angle) * 0.35 * radiusScale;
      const startScale = (0.95 + (s % 2) * 0.25) * radiusScale;
      const endScale = (3.4 + (s % 3) * 0.55) * radiusScale;

      smokeEnt.setPosition(sx, sy, sz);
      smokeEnt.setLocalScale(startScale, startScale, 1);
      this.rootEntity.addChild(smokeEnt);

      this.billowPlumes.push({
        entity: smokeEnt,
        material: smokeMat,
        position: new pc.Vec3(sx, sy, sz),
        velocity: new pc.Vec3(
          Math.cos(angle) * 0.85 * radiusScale,
          1.55 + (s % 3) * 0.42,
          Math.sin(angle) * 0.85 * radiusScale,
        ),
        elapsedS: 0,
        durationS: 1.85 + (s % 3) * 0.35,
        startScale,
        endScale,
        baseOpacity: 0.72,
        spinDegPerS: (s % 2 === 0 ? 1 : -1) * 28,
        isGroundRing: false,
      });
    }
  }

  /**
   * Ejects a glinting brass rifle/pistol casing or red 12G shotgun hull out the right side
   * of the player's viewmodel using `HardwareInstancedPool.spawnKinematicParticle`.
   */
  public ejectWeaponCasing(
    eyeWorldPos: Vec3Like,
    aimDirectionWorld: Vec3Like,
    weapon: Pick<WeaponSpec, 'role'>,
    ammo?: Pick<AmmoSpec, 'type'>,
  ): number {
    if (this.destroyed) return -1;

    const fwd = normalize(aimDirectionWorld);
    const upRef = Math.abs(fwd.y) < 0.98 ? vec3(0, 1, 0) : vec3(0, 0, 1);
    const right = normalize(cross(fwd, upRef));
    const orthoUp = normalize(cross(right, fwd));

    const ejectOrigin: Vec3Like = {
      x: eyeWorldPos.x + fwd.x * 0.34 + right.x * 0.21 - orthoUp.x * 0.11,
      y: eyeWorldPos.y + fwd.y * 0.34 + right.y * 0.21 - orthoUp.y * 0.11,
      z: eyeWorldPos.z + fwd.z * 0.34 + right.z * 0.21 - orthoUp.z * 0.11,
    };

    const s = this.casingSeedCounter++;
    const jitterA = ((s * 73) % 19) / 19 - 0.5;
    const jitterB = ((s * 131) % 23) / 23 - 0.5;

    const isShotgunHull =
      weapon.role === 'SHOTGUN' || ammo?.type === 'BUCKSHOT_00';

    const sideSpeed = (isShotgunHull ? 2.15 : 2.75) + jitterA * 0.55;
    const upSpeed = (isShotgunHull ? 1.45 : 1.75) + jitterB * 0.45;
    const backSpeed = -0.55 + jitterA * 0.3;

    const ejectVel: Vec3Like = {
      x: right.x * sideSpeed + orthoUp.x * upSpeed + fwd.x * backSpeed,
      y: right.y * sideSpeed + orthoUp.y * upSpeed + fwd.y * backSpeed,
      z: right.z * sideSpeed + orthoUp.z * upSpeed + fwd.z * backSpeed,
    };

    const spin: Vec3Like = {
      x: 22 + jitterA * 16,
      y: -26 + jitterB * 18,
      z: 32 + jitterA * 14,
    };

    const casingScale: Vec3Like = isShotgunHull
      ? { x: 0.02, y: 0.062, z: 0.02 }
      : weapon.role === 'SNIPER'
        ? { x: 0.0125, y: 0.055, z: 0.0125 }
        : weapon.role === 'HEAVY_PISTOL'
          ? { x: 0.0145, y: 0.036, z: 0.0145 }
          : { x: 0.0105, y: 0.046, z: 0.0105 };

    const restitution = isShotgunHull ? 0.34 : 0.48;
    const pool = isShotgunHull ? this.shotgunHullPool : this.brassCasingPool;
    const slotId = pool.spawnKinematicParticle(
      ejectOrigin,
      ejectVel,
      spin,
      casingScale,
      -9.81,
      restitution,
      6.5,
    );

    this.registerTrackedCasingBounce(ejectOrigin, ejectVel, restitution, isShotgunHull);
    return slotId;
  }

  /**
   * Warm orange-amber dynamic omni point light (`intensity: 4.2`, `castShadows: false`) decaying over `52ms`.
   */
  public triggerMuzzleFlashLight(muzzleWorldPos: Vec3Like): void {
    this.activateDynamicOmniLight(
      muzzleWorldPos,
      1.0,
      0.72,
      0.28,
      4.2,
      10.5,
      0.052,
      false,
    );
  }

  /**
   * High-intensity multi-temperature detonation omni point light (`intensity: 11.5`, `range: 20m`, `castShadows: false`)
   * flashing white-gold for the initial shock core before decaying through blazing orange over `340ms`.
   */
  public triggerExplosionLight(blastCenterWorld: Vec3Like, rangeM = 18.0): void {
    this.activateDynamicOmniLight(
      {
        x: blastCenterWorld.x,
        y: Math.max(0.35, blastCenterWorld.y + 0.35),
        z: blastCenterWorld.z,
      },
      1.0,
      0.92,
      0.68,
      11.5,
      rangeM,
      0.34,
      true,
    );
  }

  /**
   * Convenience one-call hook for player weapon discharge:
   * - Transient orange-amber muzzle flash dynamic omni light
   * - Spinning brass casing or ribbed red 12G hull ejection
   * - High-contrast incandescent hot-core bullet tracer(s)
   * - Crisp concrete/metal impact spark bursts & dust plumes on cover/floor hits
   */
  public onPlayerWeaponFired(
    eyeWorldPos: Vec3Like,
    aimDirectionWorld: Vec3Like,
    weapon: WeaponSpec,
    ammo: AmmoSpec,
    muzzleWorldPosOverride?: Vec3Like,
  ): void {
    const fwd = normalize(aimDirectionWorld);
    const muzzlePos = muzzleWorldPosOverride ?? add(eyeWorldPos, scale(fwd, 0.65));

    this.triggerMuzzleFlashLight(muzzlePos);
    this.ejectWeaponCasing(eyeWorldPos, fwd, weapon, ammo);

    // Cast ballistic visual ray to clip tracer cleanly & emit surface impact sparks + dust plumes
    const envHit = this.castEnvironmentImpactRay(eyeWorldPos, fwd, 72.0);
    const maxTracerDist = envHit ? Math.max(1.2, envHit.distanceM - 0.35) : 56.0;

    if (ammo.pelletCount > 1) {
      const visualPellets = Math.min(5, ammo.pelletCount);
      const upRef = Math.abs(fwd.y) < 0.96 ? vec3(0, 1, 0) : vec3(1, 0, 0);
      const right = normalize(cross(fwd, upRef));
      const orthoUp = normalize(cross(right, fwd));
      for (let p = 0; p < visualPellets; p++) {
        const ang = (p / visualPellets) * Math.PI * 2 + 0.4;
        const spread = 0.022 + (p % 2) * 0.014;
        const pelletDir = normalize({
          x: fwd.x + (right.x * Math.cos(ang) + orthoUp.x * Math.sin(ang)) * spread,
          y: fwd.y + (right.y * Math.cos(ang) + orthoUp.y * Math.sin(ang)) * spread,
          z: fwd.z + (right.z * Math.cos(ang) + orthoUp.z * Math.sin(ang)) * spread,
        });
        this.spawnBulletTracer(muzzlePos, pelletDir, maxTracerDist, 1.15);
      }
    } else {
      const streakLen =
        weapon.role === 'SNIPER' ? 2.35 : weapon.role === 'HEAVY_PISTOL' ? 1.55 : 1.85;
      this.spawnBulletTracer(muzzlePos, fwd, maxTracerDist, streakLen);
    }

    if (envHit) {
      const muzzleEnergyJ = 0.5 * ammo.massKg * ammo.muzzleVelocityMs * ammo.muzzleVelocityMs;
      this.spawnSurfaceImpactFx(
        envHit.pointWorld,
        envHit.normalWorld,
        envHit.material,
        muzzleEnergyJ,
      );
    }
  }

  /**
   * Directional Wall & Floor Gore Splatter Projector:
   * When a round penetrates a combatant (`exitEnergyJ > 80` or `CRANIAL_POP` / `CLEAN_SEVER`),
   * casts a `4.5m` ray along `impactDirectionWorld` against `RapierPhysicsWorld` walls and the
   * arena floor (`y = 0`), stamping persistent wet crimson quads flush along `normalWorld + 0.004m`.
   */
  public projectBloodSplatter(params: BloodSplatterProjectionParams): number {
    if (this.destroyed) return 0;

    const isHighGoreSever =
      params.goreMode === 'CRANIAL_POP' || params.goreMode === 'CLEAN_SEVER';
    if (params.exitEnergyJ <= 80 && !isHighGoreSever) {
      return 0;
    }

    const baseDir = normalize(params.impactDirectionWorld);
    if (length(baseDir) < 1e-6) {
      return 0;
    }

    const raysToCast: Vec3Like[] = [baseDir];
    if (isHighGoreSever) {
      raysToCast.push(
        normalize({ x: baseDir.x + 0.14, y: baseDir.y - 0.32, z: baseDir.z }),
        normalize({ x: baseDir.x - 0.14, y: baseDir.y - 0.44, z: baseDir.z }),
      );
    }

    let stampedCount = 0;

    for (let r = 0; r < raysToCast.length; r++) {
      const rayDir = raysToCast[r];
      const hit = this.castWallOrFloorBloodRay(
        params.originWorld,
        rayDir,
        BLOOD_RAY_MAX_DIST_M,
      );
      if (!hit) {
        continue;
      }

      let slotId = this.bloodSplatterPool.allocSlot();
      if (slotId < 0) {
        slotId = this.splatterRecycleCursor % this.bloodSplatterPool.maxInstances;
        this.splatterRecycleCursor++;
      }

      const seed = this.splatterSeedCounter++;
      const rollRad = ((seed * 1.93) % (Math.PI * 2));
      const energyFactor = Math.min(2.1, 0.72 + params.exitEnergyJ / 950);
      const baseSize =
        params.splatterScaleM ??
        (params.goreMode === 'CRANIAL_POP'
          ? 0.92
          : params.goreMode === 'CLEAN_SEVER'
            ? 0.78
            : 0.52 * energyFactor);
      const stretchY = Math.abs(hit.normalWorld.y) < 0.5 ? 1.24 : 1.05;

      const depthBias = BLOOD_WALL_NORMAL_OFFSET_M + (slotId % 8) * 0.00012;
      const decalPos: Vec3Like = {
        x: hit.pointWorld.x + hit.normalWorld.x * depthBias,
        y: hit.pointWorld.y + hit.normalWorld.y * depthBias,
        z: hit.pointWorld.z + hit.normalWorld.z * depthBias,
      };

      const quat = computeSurfaceAlignedQuadQuaternion(
        hit.normalWorld,
        rayDir,
        rollRad,
      );

      this.bloodSplatterPool.setSlotTRS(slotId, decalPos, quat, {
        x: baseSize,
        y: baseSize * stretchY,
        z: 1.0,
      });
      stampedCount++;
    }

    if (stampedCount > 0) {
      this.bloodSplatterPool.upload();
    }
    return stampedCount;
  }

  /**
   * Inspects a `ShotSimulationReport` to project exit-wound blood splatters onto walls/floors
   * and trigger automatic F.E.A.R. Kill-Punch dilation on `CRANIAL_POP` headshots!
   */
  public processShotSimulationReport(report: ShotSimulationReport): number {
    if (this.destroyed || !report.hitTarget) return 0;

    let totalDecals = 0;

    for (const wound of report.woundEvents) {
      if (wound.exitEnergyJ > 80) {
        totalDecals += this.projectBloodSplatter({
          originWorld: wound.exitPointWorld,
          impactDirectionWorld: wound.impactDirectionWorld,
          exitEnergyJ: wound.exitEnergyJ,
        });
      }
    }

    let sawCranialPop = false;
    for (const dism of report.dismembermentEvents) {
      if (dism.goreMode === 'CRANIAL_POP') {
        sawCranialPop = true;
      }
      if (dism.goreMode === 'CRANIAL_POP' || dism.goreMode === 'CLEAN_SEVER') {
        totalDecals += this.projectBloodSplatter({
          originWorld: dism.stumpWorldPosition,
          impactDirectionWorld: report.aimDirectionWorld,
          exitEnergyJ: Math.max(250, report.impactEnergyJ * 0.4),
          goreMode: dism.goreMode,
        });
      }
    }

    if (sawCranialPop) {
      this.bulletTime.triggerKillPunch('CRANIAL_POP', 0.35);
    }

    return totalDecals;
  }

  /**
   * Handles external explosions (e.g., M67 frag grenade): triggers multi-stage AAA fireball/shockwave/smoke,
   * high-intensity point light pulse, sympathetic barrel chain reactions, and multi-kill Bullet-Time punch.
   */
  public notifyExternalExplosion(blast: BlastEvent, killedEnemyCount = 0): void {
    if (this.destroyed) return;
    this.triggerExplosionLight(blast.centerWorld, Math.max(18.0, blast.radiusM * 2.5));
    this.spawnMultiStageExplosionFx(blast);
    this.barrels.applyBlast(blast);
    if (killedEnemyCount >= 2) {
      this.bulletTime.triggerKillPunch('MULTI_KILL_BLAST', 0.35);
    }
  }

  /**
   * Updates F.E.A.R. Bullet-Time dilation (`rawDt -> scaledDt`), steps explosive barrels,
   * dynamic point lights, multi-stage explosion fireballs/smoke, instanced tracer/spark/casing pools,
   * and casing bounce audio hooks. Returns `scaledDt`.
   */
  public update(rawDt: number): number {
    if (this.destroyed || !Number.isFinite(rawDt) || rawDt <= 0) {
      return 0;
    }

    const scaledDt = this.bulletTime.update(rawDt);

    this.barrels.update(scaledDt);
    this.stepDynamicLights(scaledDt);
    this.stepTransientExplosionAndImpactFx(scaledDt);
    this.stepTrackedCasingBounces(scaledDt);

    this.brassCasingPool.syncFromPhysics(this.rapierWorld, scaledDt);
    this.shotgunHullPool.syncFromPhysics(this.rapierWorld, scaledDt);
    this.shrapnelPool.syncFromPhysics(this.rapierWorld, scaledDt);
    this.tracerCorePool.syncFromPhysics(null, scaledDt);
    this.tracerHaloPool.syncFromPhysics(null, scaledDt);
    this.impactSparkPool.syncFromPhysics(null, scaledDt);
    this.bloodSplatterPool.upload();

    return scaledDt;
  }

  public resetWave(clearBloodDecals = false): void {
    if (this.destroyed) return;
    this.barrels.resetBarrels();
    this.trackActive.fill(0);
    for (const light of this.lightPool) {
      light.active = false;
      light.entity.enabled = false;
    }
    this.clearTransientExplosionAndImpactFx();
    if (clearBloodDecals) {
      this.clearBloodDecals();
    }
  }

  public clearBloodDecals(): void {
    for (let slot = 0; slot < this.bloodSplatterPool.maxInstances; slot++) {
      if (this.bloodSplatterPool.isSlotActive(slot)) {
        this.bloodSplatterPool.freeSlot(slot);
      }
    }
    this.splatterRecycleCursor = 0;
    this.bloodSplatterPool.upload();
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.clearTransientExplosionAndImpactFx();
    this.bulletTime.destroy();
    this.barrels.destroy();
    this.brassCasingPool.destroy();
    this.shotgunHullPool.destroy();
    this.shrapnelPool.destroy();
    this.tracerCorePool.destroy();
    this.tracerHaloPool.destroy();
    this.impactSparkPool.destroy();
    this.bloodSplatterPool.destroy();
    this.rootEntity.destroy();
  }

  private clearTransientExplosionAndImpactFx(): void {
    for (const lobe of this.fireballLobes) {
      lobe.entity.destroy();
    }
    this.fireballLobes.length = 0;

    for (const plume of this.billowPlumes) {
      plume.entity.destroy();
    }
    this.billowPlumes.length = 0;
  }

  private stepTransientExplosionAndImpactFx(dt: number): void {
    // 1. Step churning emissive-to-soot fireball spheres & blinding flash cores
    for (let i = this.fireballLobes.length - 1; i >= 0; i--) {
      const lobe = this.fireballLobes[i];
      lobe.elapsedS += dt;
      if (lobe.elapsedS >= lobe.durationS) {
        lobe.entity.destroy();
        this.fireballLobes.splice(i, 1);
        continue;
      }

      const t = lobe.elapsedS / lobe.durationS;
      const drag = Math.exp(-3.4 * dt);
      lobe.velocity.scale(drag);
      lobe.position.x += lobe.velocity.x * dt;
      lobe.position.y += lobe.velocity.y * dt;
      lobe.position.z += lobe.velocity.z * dt;

      lobe.entity.setPosition(lobe.position.x, lobe.position.y, lobe.position.z);
      lobe.entity.rotate(
        lobe.angularVelocity.x * dt,
        lobe.angularVelocity.y * dt,
        lobe.angularVelocity.z * dt,
      );

      const easeOut = 1 - Math.pow(1 - t, 2.4);
      const s = lobe.startScale + (lobe.endScale - lobe.startScale) * easeOut;
      lobe.entity.setLocalScale(s, s, s);

      if (lobe.durationS <= 0.12) {
        // Blinding flash core: rapid additive decay
        lobe.material.opacity = Math.max(0, (1 - t) * (1 - t));
      } else {
        // Fireball cooling curve: incandescent white-yellow -> roaring orange-red -> dark soot
        if (t < 0.32) {
          const k = t / 0.32;
          lobe.material.diffuse.set(1.0, 0.9 - k * 0.42, 0.55 - k * 0.45);
          lobe.material.emissive.set(1.0, 0.78 - k * 0.44, 0.3 - k * 0.25);
          lobe.material.emissiveIntensity = 4.2 * (1 - k * 0.35);
          lobe.material.opacity = 0.95;
        } else {
          const k = (t - 0.32) / 0.68;
          const sootLerp = Math.min(1, k * 1.35);
          lobe.material.diffuse.set(
            0.58 * (1 - sootLerp) + 0.09 * sootLerp,
            0.22 * (1 - sootLerp) + 0.08 * sootLerp,
            0.08 * (1 - sootLerp) + 0.08 * sootLerp,
          );
          lobe.material.emissive.set(
            (1 - sootLerp) * 0.85,
            (1 - sootLerp) * 0.24,
            (1 - sootLerp) * 0.04,
          );
          lobe.material.emissiveIntensity = Math.max(0, (1 - sootLerp) * 2.4);
          lobe.material.opacity = 0.92 * (1 - k * k);
        }
      }
      lobe.material.update();
    }

    // 2. Step expanding shockwave rings, concrete impact dust plumes & lingering dark smoke plumes
    const activeCam = this.app.root.findByName('PlayerCamera') as pc.Entity | null;
    const camPos = activeCam ? activeCam.getPosition() : null;

    for (let i = this.billowPlumes.length - 1; i >= 0; i--) {
      const p = this.billowPlumes[i];
      p.elapsedS += dt;
      if (p.elapsedS >= p.durationS) {
        p.entity.destroy();
        this.billowPlumes.splice(i, 1);
        continue;
      }

      const t = p.elapsedS / p.durationS;
      const easeOut = 1 - Math.pow(1 - t, p.isGroundRing ? 2.1 : 1.75);
      const curScale = p.startScale + (p.endScale - p.startScale) * easeOut;

      if (p.isGroundRing) {
        p.entity.setLocalEulerAngles(-90, p.elapsedS * p.spinDegPerS, 0);
        p.entity.setLocalScale(curScale, curScale, 1);
        p.material.opacity = p.baseOpacity * (1 - t) * (1 - t);
      } else {
        const drag = Math.exp(-1.8 * dt);
        p.velocity.x *= drag;
        p.velocity.z *= drag;
        p.velocity.y *= Math.exp(-0.65 * dt);
        p.position.x += p.velocity.x * dt;
        p.position.y = Math.max(0.08, p.position.y + p.velocity.y * dt);
        p.position.z += p.velocity.z * dt;
        p.entity.setPosition(p.position.x, p.position.y, p.position.z);

        if (camPos) {
          p.entity.lookAt(camPos);
          p.entity.rotateLocal(0, 0, p.elapsedS * p.spinDegPerS);
        }
        p.entity.setLocalScale(curScale, curScale, 1);
        const fadeIn = Math.min(1, t * 7.0);
        p.material.opacity = p.baseOpacity * fadeIn * (1 - t) * (1 - t * 0.4);
      }
      p.material.update();
    }
  }

  private castEnvironmentImpactRay(
    origin: Vec3Like,
    dirNormalized: Vec3Like,
    maxDistM: number,
  ): { pointWorld: Vec3Like; normalWorld: Vec3Like; distanceM: number; material: DestructibleMaterialKind } | null {
    const wallHits = this.rapierWorld.castPenetrationRay(origin, dirNormalized, maxDistM);
    let bestHit: {
      pointWorld: Vec3Like;
      normalWorld: Vec3Like;
      distanceM: number;
      material: DestructibleMaterialKind;
    } | null = null;

    for (const h of wallHits) {
      if (h.distanceM > 0.15 && h.distanceM <= maxDistM) {
        let n = h.normalWorld;
        if (dot(n, dirNormalized) > 0) {
          n = scale(n, -1);
        }
        bestHit = {
          pointWorld: h.pointWorld,
          normalWorld: normalize(n),
          distanceM: h.distanceM,
          material: h.surface.material,
        };
        break;
      }
    }

    if (dirNormalized.y < -1e-4 && origin.y > 0.02) {
      const tFloor = -origin.y / dirNormalized.y;
      if (tFloor > 0.15 && tFloor <= maxDistM && (!bestHit || tFloor < bestHit.distanceM)) {
        bestHit = {
          pointWorld: {
            x: origin.x + dirNormalized.x * tFloor,
            y: 0,
            z: origin.z + dirNormalized.z * tFloor,
          },
          normalWorld: { x: 0, y: 1, z: 0 },
          distanceM: tFloor,
          material: 'CONCRETE_INTACT',
        };
      }
    }

    return bestHit;
  }

  private castWallOrFloorBloodRay(
    origin: Vec3Like,
    dirNormalized: Vec3Like,
    maxDistM: number,
  ): { pointWorld: Vec3Like; normalWorld: Vec3Like; distanceM: number } | null {
    const wallHits = this.rapierWorld.castPenetrationRay(
      origin,
      dirNormalized,
      maxDistM,
    );

    let bestWallHit: {
      pointWorld: Vec3Like;
      normalWorld: Vec3Like;
      distanceM: number;
    } | null = null;

    for (const h of wallHits) {
      if (h.surface.objectId.startsWith('hazard_barrel_')) {
        continue;
      }
      if (h.distanceM > 0.02 && h.distanceM <= maxDistM) {
        let n = h.normalWorld;
        if (dot(n, dirNormalized) > 0) {
          n = scale(n, -1);
        }
        bestWallHit = {
          pointWorld: h.pointWorld,
          normalWorld: normalize(n),
          distanceM: h.distanceM,
        };
        break;
      }
    }

    let floorHit: {
      pointWorld: Vec3Like;
      normalWorld: Vec3Like;
      distanceM: number;
    } | null = null;

    if (dirNormalized.y < -1e-4 && origin.y > 0.005) {
      const tFloor = -origin.y / dirNormalized.y;
      if (tFloor > 0.02 && tFloor <= maxDistM) {
        floorHit = {
          pointWorld: {
            x: origin.x + dirNormalized.x * tFloor,
            y: 0,
            z: origin.z + dirNormalized.z * tFloor,
          },
          normalWorld: { x: 0, y: 1, z: 0 },
          distanceM: tFloor,
        };
      }
    }

    if (bestWallHit && floorHit) {
      return bestWallHit.distanceM <= floorHit.distanceM ? bestWallHit : floorHit;
    }
    return bestWallHit ?? floorHit;
  }

  private activateDynamicOmniLight(
    pos: Vec3Like,
    r: number,
    g: number,
    b: number,
    intensity: number,
    rangeM: number,
    durationS: number,
    isExplosion: boolean,
  ): void {
    if (this.destroyed || this.lightPool.length === 0) return;

    let chosen = this.lightPool.find((slot) => !slot.active);
    if (!chosen) {
      chosen = this.lightPool[0];
      let bestProgress = -1;
      for (const slot of this.lightPool) {
        const prog = slot.elapsedS / Math.max(1e-4, slot.durationS);
        if (prog > bestProgress) {
          bestProgress = prog;
          chosen = slot;
        }
      }
    }

    chosen.active = true;
    chosen.elapsedS = 0;
    chosen.durationS = Math.max(0.015, durationS);
    chosen.peakIntensity = intensity;
    chosen.isExplosion = isExplosion;

    chosen.entity.setPosition(pos.x, pos.y, pos.z);
    if (chosen.entity.light) {
      chosen.entity.light.color = new pc.Color(r, g, b);
      chosen.entity.light.intensity = intensity;
      chosen.entity.light.range = rangeM;
    }
    chosen.entity.enabled = true;
  }

  private stepDynamicLights(dt: number): void {
    for (const slot of this.lightPool) {
      if (!slot.active) continue;
      slot.elapsedS += dt;
      if (slot.elapsedS >= slot.durationS) {
        slot.active = false;
        slot.entity.enabled = false;
        if (slot.entity.light) {
          slot.entity.light.intensity = 0;
        }
        continue;
      }

      const t = slot.elapsedS / slot.durationS;
      const rem = 1 - t;
      if (slot.entity.light) {
        slot.entity.light.intensity = slot.peakIntensity * rem * rem;
        if (slot.isExplosion) {
          // Shift color temperature from blinding white-gold flash to deep blazing orange afterglow
          const cool = Math.min(1, t * 3.2);
          slot.entity.light.color = new pc.Color(
            1.0,
            0.92 * (1 - cool) + 0.44 * cool,
            0.68 * (1 - cool) + 0.1 * cool,
          );
        }
      }
    }
  }

  private registerTrackedCasingBounce(
    origin: Vec3Like,
    vel: Vec3Like,
    restitution: number,
    isShotgunHull: boolean,
  ): void {
    const idx = this.trackWriteCursor % TRACKED_CASING_CAPACITY;
    this.trackWriteCursor++;

    this.trackActive[idx] = 1;
    this.trackIsHull[idx] = isShotgunHull ? 1 : 0;
    this.trackBounces[idx] = 0;
    this.trackPosX[idx] = origin.x;
    this.trackPosY[idx] = origin.y;
    this.trackPosZ[idx] = origin.z;
    this.trackVelX[idx] = vel.x;
    this.trackVelY[idx] = vel.y;
    this.trackVelZ[idx] = vel.z;
    this.trackRestitution[idx] = restitution;
  }

  private stepTrackedCasingBounces(dt: number): void {
    const stepDt = Math.min(0.1, dt);
    for (let i = 0; i < TRACKED_CASING_CAPACITY; i++) {
      if (this.trackActive[i] === 0) continue;

      let vx = this.trackVelX[i];
      let vy = this.trackVelY[i] - 9.81 * stepDt;
      let vz = this.trackVelZ[i];

      const px = this.trackPosX[i] + vx * stepDt;
      let py = this.trackPosY[i] + vy * stepDt;
      const pz = this.trackPosZ[i] + vz * stepDt;

      if (py <= CASING_BOUNCE_FLOOR_Y) {
        const impactSpeed = Math.abs(vy);
        py = CASING_BOUNCE_FLOOR_Y;
        const bounceNum = this.trackBounces[i] + 1;
        this.trackBounces[i] = bounceNum;

        if (impactSpeed > 0.35 && bounceNum <= 2) {
          this.onCasingBounce?.({
            position: { x: px, y: CASING_BOUNCE_FLOOR_Y, z: pz },
            impactSpeedMs: impactSpeed,
            isShotgunHull: this.trackIsHull[i] === 1,
            bounceIndex: bounceNum,
          });
        }

        const bouncedVy = impactSpeed * this.trackRestitution[i];
        if (bouncedVy < 0.25 || bounceNum >= 2) {
          this.trackActive[i] = 0;
          continue;
        }
        vy = bouncedVy;
        vx *= 0.72;
        vz *= 0.72;
      }

      this.trackPosX[i] = px;
      this.trackPosY[i] = py;
      this.trackPosZ[i] = pz;
      this.trackVelX[i] = vx;
      this.trackVelY[i] = vy;
      this.trackVelZ[i] = vz;
    }
  }
}
