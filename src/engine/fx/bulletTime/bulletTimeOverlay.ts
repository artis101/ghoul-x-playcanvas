import type { BulletTimeVignetteState, BulletTimeVignetteTint } from './bulletTimeTypes.ts';

export function computeBulletTimeVignette(
  active: boolean,
  killPunchActive: boolean,
  timeScale: number,
  energyPct: number,
  reflexTargetScale = 0.22,
): BulletTimeVignetteState {
  const dilationDepth = Math.max(
    0,
    Math.min(1, (1.0 - timeScale) / Math.max(0.001, 1.0 - reflexTargetScale)),
  );
  let tint: BulletTimeVignetteTint = 'NONE';
  let cssBoxShadow = 'none';

  if (killPunchActive && !active) {
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
    active,
    killPunchActive,
    timeScale,
    reflexEnergyPct: energyPct,
    intensity: dilationDepth,
    tint,
    cssBoxShadow,
  };
}

export class BulletTimeOverlayManager {
  private vignetteOverlayEl: HTMLDivElement | null = null;
  private meterBarFillEl: HTMLDivElement | null = null;

  public mount(parent?: HTMLElement): void {
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

  public sync(state: BulletTimeVignetteState): void {
    if (this.vignetteOverlayEl) {
      this.vignetteOverlayEl.style.boxShadow = state.cssBoxShadow;
    }
    if (this.meterBarFillEl) {
      this.meterBarFillEl.style.width = `${state.reflexEnergyPct.toFixed(1)}%`;
      this.meterBarFillEl.style.opacity =
        state.reflexEnergyPct >= 99.5 && !state.active ? '0.45' : '0.95';
    }
  }

  public destroy(): void {
    if (this.vignetteOverlayEl) {
      this.vignetteOverlayEl.remove();
      this.vignetteOverlayEl = null;
      this.meterBarFillEl = null;
    }
  }
}
