import { queryEl } from './hudTypes.ts';

export class HudReticleScope {
  private crosshairEl = queryEl('crosshair-standard');
  private hitmarkerEl = queryEl('hitmarker');
  private sniperScopeMaskEl = queryEl('sniper-scope-mask');
  private scopeZoomLabelEl = queryEl('scope-zoom-label');
  private scopeRangeLabelEl = queryEl('scope-range-label');
  private scopeDropLabelEl = queryEl('scope-drop-label');

  private hitmarkerTimeout: ReturnType<typeof globalThis.setTimeout> | null = null;
  private lastCrosshairHidden: boolean | null = null;
  private lastCrosshairScaleStr = '';
  private lastCrosshairLineOpacityStr = '';

  /** `lineOpacity` fades the crosshair lines as the sights come up; hitmarkers stay visible. */
  public setCrosshairBloom(scaleFactor: number, hidden = false, lineOpacity = 1): void {
    if (!this.crosshairEl) return;
    const lineOpacityStr = lineOpacity.toFixed(2);
    if (lineOpacityStr !== this.lastCrosshairLineOpacityStr) {
      this.lastCrosshairLineOpacityStr = lineOpacityStr;
      this.crosshairEl.style.setProperty('--ch-line-opacity', lineOpacityStr);
    }
    if (hidden !== this.lastCrosshairHidden) {
      this.lastCrosshairHidden = hidden;
      this.crosshairEl.style.opacity = hidden ? '0' : '1';
    }
    // Spread the bars apart (fixed bar size) instead of scaling the whole crosshair.
    const scaleStr = scaleFactor.toFixed(3);
    if (scaleStr !== this.lastCrosshairScaleStr) {
      this.lastCrosshairScaleStr = scaleStr;
      this.crosshairEl.style.setProperty('--ch-off', `${((scaleFactor - 1) * 10.5).toFixed(2)}px`);
      this.crosshairEl.style.setProperty('--ch-ring-scale', scaleStr);
    }
  }

  public triggerHitmarker(mode: 'NORMAL' | 'ARMOR' | 'LETHAL' | boolean): void {
    if (!this.hitmarkerEl) return;
    const resolved = typeof mode === 'boolean' ? (mode ? 'LETHAL' : 'NORMAL') : mode;
    this.hitmarkerEl.classList.toggle('lethal', resolved === 'LETHAL');
    this.hitmarkerEl.classList.toggle('armor', resolved === 'ARMOR');
    this.hitmarkerEl.classList.add('active');

    if (this.hitmarkerTimeout !== null) {
      globalThis.clearTimeout(this.hitmarkerTimeout);
    }
    this.hitmarkerTimeout = globalThis.setTimeout(() => {
      this.hitmarkerEl?.classList.remove('active');
    }, resolved === 'LETHAL' ? 170 : 105);
  }

  public setScopeOverlay(active: boolean, zoom = 4.0, range = 42.0, dropCm = 0.0): void {
    if (!this.sniperScopeMaskEl) return;
    if (active) {
      this.sniperScopeMaskEl.classList.remove('hidden');
      if (this.scopeZoomLabelEl) this.scopeZoomLabelEl.textContent = `${zoom.toFixed(1)}x`;
      if (this.scopeRangeLabelEl) this.scopeRangeLabelEl.textContent = `${range.toFixed(0)}m`;
      if (this.scopeDropLabelEl) this.scopeDropLabelEl.textContent = `DROP ${Math.abs(dropCm).toFixed(1)}cm`;
    } else {
      this.sniperScopeMaskEl.classList.add('hidden');
    }
  }
}
