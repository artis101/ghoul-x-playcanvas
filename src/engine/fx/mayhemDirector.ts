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
// 2. Procedural Meshes, Materials & Quaternion Surface Alignment Helpers
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
  const width = 64;
  const height = 128;
  const tex = new pc.Texture(device, {
    name: 'hazardDrumTex',
    width,
    height,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: pc.FILTER_NEAREST,
    magFilter: pc.FILTER_NEAREST,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });

  const pixels = tex.lock() as Uint8Array;
  for (let y = 0; y < height; y++) {
    const v = y / height;
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const grit = (hash2d(x, y, 71) - 0.5) * 20;

      // Industrial red drum body with bright yellow/black hazard center band & metallic chimes
      let r = 188 + grit;
      let g = 24 + grit * 0.3;
      let b = 22 + grit * 0.3;

      const isRimRing =
        v < 0.045 ||
        v > 0.955 ||
        Math.abs(v - 0.33) < 0.026 ||
        Math.abs(v - 0.67) < 0.026;

      if (isRimRing) {
        r = 74 + grit;
        g = 76 + grit;
        b = 80 + grit;
      } else if (v > 0.37 && v < 0.63) {
        // Yellow hazard band with diagonal black/amber warning stripes near borders
        const inChevronBand = v < 0.42 || v > 0.58;
        const stripe = ((Math.floor(u * 16 + v * 28) % 2) + 2) % 2 === 0;
        if (inChevronBand && stripe) {
          r = 28 + grit * 0.4;
          g = 26 + grit * 0.4;
          b = 24 + grit * 0.4;
        } else {
          r = 236 + grit * 0.6;
          g = 192 + grit * 0.6;
          b = 24 + grit * 0.3;
        }
      }

      const idx = (y * width + x) * 4;
      pixels[idx] = clampByte(r);
      pixels[idx + 1] = clampByte(g);
      pixels[idx + 2] = clampByte(b);
      pixels[idx + 3] = 255;
    }
  }
  tex.unlock();

  const mat = new pc.StandardMaterial();
  mat.name = 'hazardBarrelRedMat';
  mat.diffuseMap = tex;
  mat.specular = new pc.Color(0.38, 0.34, 0.3);
  mat.shininess = 52;
  mat.update();
  return mat;
}

function createCharredBarrelMaterial(): pc.StandardMaterial {
  const mat = new pc.StandardMaterial();
  mat.name = 'charredBarrelRemnantMat';
  mat.diffuse = new pc.Color(0.09, 0.08, 0.08);
  mat.emissive = new pc.Color(0.08, 0.02, 0.005);
  mat.specular = new pc.Color(0.14, 0.12, 0.11);
  mat.shininess = 22;
  mat.update();
  return mat;
}

function createScorchDecalMaterial(device: pc.GraphicsDevice): pc.StandardMaterial {
  const size = 64;
  const tex = new pc.Texture(device, {
    name: 'barrelScorchTex',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: pc.FILTER_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });

  const pixels = tex.lock() as Uint8Array;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const angleSector = Math.floor((Math.atan2(dy, dx) + Math.PI) * 5.1);
      const rayNoise = hash2d(angleSector, 3, 409) * 0.14;
      const fineNoise = hash2d(x, y, 419) * 0.08;
      const dist = Math.hypot(dx, dy) - rayNoise - fineNoise;

      const alpha = Math.max(0, Math.min(1, (0.44 - dist) / 0.24));
      const idx = (y * size + x) * 4;
      pixels[idx] = 16;
      pixels[idx + 1] = 13;
      pixels[idx + 2] = 12;
      pixels[idx + 3] = clampByte(alpha * 232);
    }
  }
  tex.unlock();

  const mat = new pc.StandardMaterial();
  mat.name = 'barrelFloorScorchMat';
  mat.diffuse = new pc.Color(0.06, 0.05, 0.05);
  mat.opacityMap = tex;
  mat.opacityMapChannel = 'a';
  mat.blendType = pc.BLEND_NORMAL;
  mat.depthWrite = false;
  mat.update();
  return mat;
}

function createBloodSplatterMaterial(device: pc.GraphicsDevice): pc.StandardMaterial {
  const size = 64;
  const tex = new pc.Texture(device, {
    name: 'goreWallSplatterTex',
    width: size,
    height: size,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: pc.FILTER_LINEAR,
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
      const dy = v - 0.54;

      const radialSector = Math.floor((Math.atan2(dy, dx) + Math.PI) * 7.5);
      const streak = hash2d(radialSector, 11, 911) * 0.17;
      const drip = u > 0.34 && u < 0.66 && v < 0.45 ? hash2d(x >> 1, 7, 977) * 0.16 : 0;
      const speckle = hash2d(x, y, 953);

      const dist = Math.hypot(dx, dy * 0.92) - streak - drip;
      let alpha = 0;
      if (dist < 0.24) {
        alpha = 0.95;
      } else if (dist < 0.34) {
        alpha = ((0.34 - dist) / 0.1) * 0.88;
      } else if (dist < 0.45 && speckle > 0.84) {
        alpha = 0.85;
      }

      const coreDark = dist < 0.13 ? 0.68 : 1.0;
      const idx = (y * size + x) * 4;
      pixels[idx] = clampByte(148 * coreDark);
      pixels[idx + 1] = clampByte(8 * coreDark);
      pixels[idx + 2] = clampByte(12 * coreDark);
      pixels[idx + 3] = clampByte(alpha * 255);
    }
  }
  tex.unlock();

  const mat = new pc.StandardMaterial();
  mat.name = 'wetWallBloodSplatterMat';
  mat.diffuseMap = tex;
  mat.opacityMap = tex;
  mat.opacityMapChannel = 'a';
  mat.specular = new pc.Color(0.62, 0.12, 0.12);
  mat.shininess = 88;
  mat.blendType = pc.BLEND_NORMAL;
  mat.depthWrite = false;
  mat.cull = pc.CULLFACE_NONE;
  mat.update();
  return mat;
}

function createShotgunHullMaterial(device: pc.GraphicsDevice): pc.StandardMaterial {
  const width = 16;
  const height = 64;
  const tex = new pc.Texture(device, {
    name: 'shotgun12gHullTex',
    width,
    height,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: pc.FILTER_NEAREST,
    magFilter: pc.FILTER_NEAREST,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });

  const pixels = tex.lock() as Uint8Array;
  for (let y = 0; y < height; y++) {
    const v = y / height;
    for (let x = 0; x < width; x++) {
      // Bottom 28% = high-brass 12G head; upper 72% = ribbed crimson polymer hull
      const isBrassBase = v < 0.28;
      const rib = x % 2 === 0 ? 1.0 : 0.9;
      const idx = (y * width + x) * 4;
      if (isBrassBase) {
        pixels[idx] = 224;
        pixels[idx + 1] = 178;
        pixels[idx + 2] = 72;
      } else {
        pixels[idx] = clampByte(205 * rib);
        pixels[idx + 1] = clampByte(24 * rib);
        pixels[idx + 2] = clampByte(28 * rib);
      }
      pixels[idx + 3] = 255;
    }
  }
  tex.unlock();

  const mat = new pc.StandardMaterial();
  mat.name = 'shotgun12gHullMat';
  mat.diffuseMap = tex;
  mat.specular = new pc.Color(0.55, 0.45, 0.28);
  mat.shininess = 68;
  mat.update();
  return mat;
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
 *
 * - `1` rifle / 12G slug / `.50 AE` hit OR `2` buckshot hits ignites a `0.18s` hissing flame jet
 *   followed by catastrophic detonation (`radiusM: 6.5`, `peakImpulseNs: 1850`, `peakEnergyJ: 14000`).
 * - Supports chain-reaction detonations across neighboring barrels while strictly preventing infinite recursion.
 * - Leaves a charred crumpled barrel base + scorch decal on the floor and respawns cleanly via `resetBarrels()`.
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

      this.intactMesh = buildLoftedDrumMesh(dev, INTACT_DRUM_RINGS, 16, 0);
      this.crumpledMesh = buildLoftedDrumMesh(dev, CRUMPLED_BASE_RINGS, 14, 73);
      this.scorchQuadMesh = buildUnitQuadZMesh(dev);

      this.intactMat = createHazardBarrelMaterial(dev);
      this.charredMat = createCharredBarrelMaterial();
      this.scorchMat = createScorchDecalMaterial(dev);

      this.flameJetMat = new pc.StandardMaterial();
      this.flameJetMat.name = 'barrelHissingFlameJetMat';
      this.flameJetMat.diffuse = new pc.Color(1.0, 0.65, 0.14);
      this.flameJetMat.emissive = new pc.Color(1.0, 0.52, 0.08);
      this.flameJetMat.opacity = 0.88;
      this.flameJetMat.blendType = pc.BLEND_NORMAL;
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

  /**
   * Applies a weapon/projectile hit to a specific barrel.
   * - `1` rifle / slug / `.50 AE` hit (`damage >= 1.0`) ignites immediately.
   * - `1` buckshot hit adds `0.5` ignition damage; `2` buckshot hits reach `1.0` and ignite!
   */
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

  /**
   * Triggers sympathetic chain-reaction ignition/detonation on any intact barrel inside `blast.radiusM`.
   * Infinite recursion is impossible because each detonating barrel transitions out of `'INTACT'`
   * BEFORE emitting its own `BlastEvent`.
   */
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

      // Animate flickering blowtorch flame jet & hot sparks during 0.18s fuse
      if (barrel.flameJetEntity) {
        const pulse = 1.0 + Math.sin(this.flickerClockS * 95 + barrel.index) * 0.28;
        barrel.flameJetEntity.setLocalScale(0.11 * pulse, 0.42 * pulse, 0.11 * pulse);
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

  /**
   * Respawns all hazard barrels cleanly on a fresh wave, restoring `STEEL` colliders and hiding scorch remnants.
   */
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

    // Wake and hurl any nearby Rapier dynamic debris bodies
    this.rapierWorld.applyRadialBlastImpulse(blast);

    // Broadcast BlastEvent first so chronological event order is source -> sympathetic neighbors
    this.onBarrelDetonated?.(barrel, blast);

    // Sympathetically ignite/detonate any neighboring intact hazard barrels in blast radius
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
      scorchDecalEntity.setLocalScale(2.75, 2.75, 1);
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
// 4. MayhemDirector — Brass/12G Casings, Dynamic Point Lights, Gore Splatter,
//    Explosive Barrels & Bullet-Time Facade
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

  public onCasingBounce?: (event: CasingBounceEvent) => void;
  public onExplosionBlast?: (blast: BlastEvent) => void;

  private readonly lightPool: PooledDynamicOmniLight[] = [];

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
  private destroyed = false;

  public constructor(options: MayhemDirectorOptions) {
    this.app = options.app;
    this.rapierWorld = options.rapierWorld;
    this.onCasingBounce = options.onCasingBounce;
    this.onExplosionBlast = options.onExplosionBlast;

    this.rootEntity = new pc.Entity('MayhemDirectorRoot');
    this.app.root.addChild(this.rootEntity);

    const dev = this.app.graphicsDevice;

    // 1. Hardware-instanced Brass Casings & Red 12G Shotgun Hulls
    const casingCylinderMesh = buildLoftedDrumMesh(
      dev,
      [
        { y: -0.5, r: 0.52, v: 0.0 },
        { y: 0.22, r: 0.5, v: 0.72 },
        { y: 0.5, r: 0.41, v: 1.0 },
      ],
      8,
      0,
    );
    const hullCylinderMesh = buildLoftedDrumMesh(
      dev,
      [
        { y: -0.5, r: 0.53, v: 0.0 },
        { y: -0.22, r: 0.51, v: 0.28 },
        { y: 0.5, r: 0.5, v: 1.0 },
      ],
      10,
      0,
    );

    const brassMat = new pc.StandardMaterial();
    brassMat.name = 'mayhemGlintingBrassMat';
    brassMat.diffuse = new pc.Color(0.92, 0.72, 0.26);
    brassMat.emissive = new pc.Color(0.14, 0.09, 0.02);
    brassMat.specular = new pc.Color(0.98, 0.86, 0.48);
    brassMat.shininess = 90;
    brassMat.update();

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
    shrapnelMat.diffuse = new pc.Color(0.26, 0.22, 0.2);
    shrapnelMat.emissive = new pc.Color(0.85, 0.28, 0.05);
    shrapnelMat.specular = new pc.Color(0.55, 0.45, 0.35);
    shrapnelMat.shininess = 64;
    shrapnelMat.update();

    this.shrapnelPool = new HardwareInstancedPool(
      this.app,
      shrapnelBoxMesh,
      shrapnelMat,
      options.maxShrapnelShards ?? 256,
      'MayhemShrapnelPool',
      false,
    );

    // 3. Hardware-instanced Persistent Wall & Floor Gore Splatter Decals
    const splatterQuadMesh = buildUnitQuadZMesh(dev);
    const splatterMat = createBloodSplatterMaterial(dev);
    this.bloodSplatterPool = new HardwareInstancedPool(
      this.app,
      splatterQuadMesh,
      splatterMat,
      options.maxBloodSplatters ?? 384,
      'MayhemBloodSplatterPool',
      false,
    );

    // 4. Pooled Dynamic Muzzle Flash & Explosion Omni Point Lights (castShadows: false)
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
        durationS: 0.045,
        peakIntensity: 3.5,
      });
    }

    // 5. F.E.A.R. Bullet-Time Controller & Shootable Explosive Hazard Barrels
    this.bulletTime = new BulletTimeController(options.bulletTimeOptions);
    this.barrels = new ExplosiveBarrelManager({
      app: this.app,
      rapierWorld: this.rapierWorld,
      shrapnelPool: this.shrapnelPool,
      barrelPositions: options.barrelPositions,
      sympatheticChainFuseS: options.sympatheticChainFuseS,
      onBarrelIgnited: options.onBarrelIgnited,
      onBarrelDetonated: (_barrel, blast) => {
        this.triggerExplosionLight(blast.centerWorld, 18.0);
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
      x: 18 + jitterA * 14,
      y: -22 + jitterB * 16,
      z: 26 + jitterA * 12,
    };

    const casingScale: Vec3Like = isShotgunHull
      ? { x: 0.02, y: 0.062, z: 0.02 }
      : weapon.role === 'SNIPER'
        ? { x: 0.012, y: 0.054, z: 0.012 }
        : weapon.role === 'HEAVY_PISTOL'
          ? { x: 0.014, y: 0.036, z: 0.014 }
          : { x: 0.01, y: 0.045, z: 0.01 };

    const restitution = isShotgunHull ? 0.34 : 0.46;
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
   * Warm amber dynamic omni point light (`intensity: 3.5`, `castShadows: false`) decaying over `45ms`.
   */
  public triggerMuzzleFlashLight(muzzleWorldPos: Vec3Like): void {
    this.activateDynamicOmniLight(
      muzzleWorldPos,
      1.0,
      0.74,
      0.32,
      3.5,
      9.5,
      0.045,
    );
  }

  /**
   * Blazing orange dynamic omni point light (`intensity: 8.5`, `range: 18m`, `castShadows: false`)
   * decaying over `320ms`.
   */
  public triggerExplosionLight(blastCenterWorld: Vec3Like, rangeM = 18.0): void {
    this.activateDynamicOmniLight(
      {
        x: blastCenterWorld.x,
        y: Math.max(0.35, blastCenterWorld.y + 0.35),
        z: blastCenterWorld.z,
      },
      1.0,
      0.48,
      0.12,
      8.5,
      rangeM,
      0.32,
    );
  }

  /**
   * Convenience one-call hook for player weapon discharge (muzzle flash omni light + brass/12G hull ejection).
   */
  public onPlayerWeaponFired(
    eyeWorldPos: Vec3Like,
    aimDirectionWorld: Vec3Like,
    weapon: WeaponSpec,
    ammo: AmmoSpec,
  ): void {
    const fwd = normalize(aimDirectionWorld);
    const muzzlePos = add(eyeWorldPos, scale(fwd, 0.65));
    this.triggerMuzzleFlashLight(muzzlePos);
    this.ejectWeaponCasing(eyeWorldPos, fwd, weapon, ammo);
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
      // Additional downward-angled arterial spray rays so CRANIAL_POP / CLEAN_SEVER paints wall & floor
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

      // Offset by +0.004m (+ tiny per-slot sub-mm bias) along surface normal to eliminate Z-fighting
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
   * Handles external explosions (e.g., M67 frag grenade): triggers blazing 320ms point light,
   * sympathetic barrel chain reactions, and multi-kill Bullet-Time micro-dilation punch.
   */
  public notifyExternalExplosion(blast: BlastEvent, killedEnemyCount = 0): void {
    if (this.destroyed) return;
    this.triggerExplosionLight(blast.centerWorld, Math.max(18.0, blast.radiusM * 2.4));
    this.barrels.applyBlast(blast);
    if (killedEnemyCount >= 2) {
      this.bulletTime.triggerKillPunch('MULTI_KILL_BLAST', 0.35);
    }
  }

  /**
   * Updates F.E.A.R. Bullet-Time dilation (`rawDt -> scaledDt`), steps explosive barrels,
   * dynamic point lights, instanced brass/hull/shrapnel pools, and casing bounce audio hooks.
   * Returns `scaledDt`.
   */
  public update(rawDt: number): number {
    if (this.destroyed || !Number.isFinite(rawDt) || rawDt <= 0) {
      return 0;
    }

    const scaledDt = this.bulletTime.update(rawDt);

    this.barrels.update(scaledDt);
    this.stepDynamicLights(scaledDt);
    this.stepTrackedCasingBounces(scaledDt);

    this.brassCasingPool.syncFromPhysics(this.rapierWorld, scaledDt);
    this.shotgunHullPool.syncFromPhysics(this.rapierWorld, scaledDt);
    this.shrapnelPool.syncFromPhysics(this.rapierWorld, scaledDt);
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

    this.bulletTime.destroy();
    this.barrels.destroy();
    this.brassCasingPool.destroy();
    this.shotgunHullPool.destroy();
    this.shrapnelPool.destroy();
    this.bloodSplatterPool.destroy();
    this.rootEntity.destroy();
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

    // Check analytical arena floor plane y = 0 (since ground collider has no ColliderSurfaceTag)
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
  ): void {
    if (this.destroyed || this.lightPool.length === 0) return;

    let chosen = this.lightPool.find((slot) => !slot.active);
    if (!chosen) {
      // Recycle slot closest to completion
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

      const rem = 1 - slot.elapsedS / slot.durationS;
      if (slot.entity.light) {
        slot.entity.light.intensity = slot.peakIntensity * rem * rem;
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
