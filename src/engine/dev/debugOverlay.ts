import type { IGhoulXApp } from '../app/appContext.ts';
import type { DevRuntime } from './devRuntime.ts';
import { PROFILE_SECTION_LABELS } from './frameProfiler.ts';

export const DEBUG_OVERLAY_REFRESH_MS = 250;

const OVERLAY_CSS =
  'position:fixed;top:8px;left:8px;z-index:9999;pointer-events:none;margin:0;padding:6px 8px;' +
  'font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;color:#d8ffd8;background:rgba(0,0,0,0.72);' +
  'white-space:pre;display:none';

const BOOT_LINE_WIDTH = 60;

const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

/** Text panel for frame, physics and boot diagnostics; writes to the DOM at most 4 times a second. */
export class DebugOverlay {
  public visible: boolean;
  private readonly el: HTMLPreElement;
  private lastRefreshMs: number;
  private windowSeconds = 0;
  private lastText = '';

  constructor(
    private readonly runtime: DevRuntime,
    private readonly app: IGhoulXApp,
    initiallyVisible: boolean,
  ) {
    this.visible = initiallyVisible;
    const el = document.createElement('pre');
    el.style.cssText = OVERLAY_CSS;
    document.body.appendChild(el);
    this.el = el;
    this.lastRefreshMs = nowMs();
    this.refresh();
  }

  public toggle(): void {
    this.visible = !this.visible;
    this.refresh();
  }

  public tick(nowMsValue: number): void {
    if (nowMsValue - this.lastRefreshMs < DEBUG_OVERLAY_REFRESH_MS) return;
    this.windowSeconds = (nowMsValue - this.lastRefreshMs) / 1000;
    this.lastRefreshMs = nowMsValue;
    this.refresh();
    this.runtime.resetWindowStats();
  }

  public refresh(): void {
    const showBadge = !this.runtime.clock.isNormalSpeed;
    if (!this.visible && !showBadge) {
      if (this.el.style.display !== 'none') this.el.style.display = 'none';
      return;
    }
    const text = this.visible ? this.buildFullText() : this.statusLine();
    if (text !== this.lastText) {
      this.el.textContent = text;
      this.lastText = text;
    }
    if (this.el.style.display !== 'block') this.el.style.display = 'block';
  }

  public destroy(): void {
    this.el.remove();
  }

  private statusLine(): string {
    const clock = this.runtime.clock;
    let line = '';
    if (clock.paused) line += 'PAUSED (F7 step)';
    if (clock.timeScale !== 1) line += ` SPEED x${clock.timeScale}`;
    return line.trim();
  }

  private buildFullText(): string {
    const rt = this.runtime;
    const lines: string[] = ['GHOUL-X DEV  F3 overlay  F6 pause  F7 step  F8 speed'];
    const status = this.statusLine();
    if (status) lines.push(status);

    const frames = rt.framesInWindow;
    const fps = this.windowSeconds > 0 ? frames / this.windowSeconds : 0;
    const avgMs = frames > 0 ? (rt.rawDtSumS / frames) * 1000 : 0;
    lines.push(
      `fps ${fps.toFixed(1)}  frame ${avgMs.toFixed(2)} avg / ${(rt.rawDtMaxS * 1000).toFixed(2)} max`,
    );

    for (let i = 0; i < PROFILE_SECTION_LABELS.length; i++) {
      lines.push(
        `${PROFILE_SECTION_LABELS[i].padEnd(12)}${rt.profiler.average(i).toFixed(2)} avg  ${rt.profiler.max(i).toFixed(2)} max ms`,
      );
    }

    const stats = (this.app.app as unknown as { stats?: { drawCalls?: { total?: number } } }).stats;
    lines.push(`draw calls ${stats?.drawCalls?.total ?? 0}`);

    try {
      const rw = this.app.rapierWorld;
      lines.push(
        `rapier bodies ${rw.world.bodies.len()}  colliders ${rw.world.colliders.len()}  dynamic ${rw.activeDynamicBodyCount}`,
      );
    } catch {
      lines.push('rapier n/a');
    }

    const p = rt.physics;
    lines.push(
      p.available
        ? `physics steps ${p.steps} (max ${p.maxSteps})  flushes ${p.queryFlushes} (max ${p.maxQueryFlushes})  rays ${p.raycasts} (max ${p.maxRaycasts})`
        : 'physics counters n/a',
    );

    const mem =
      typeof performance !== 'undefined'
        ? (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
        : undefined;
    if (mem) lines.push(`heap ${(mem.usedJSHeapSize / (1024 * 1024)).toFixed(1)} MB`);

    if (rt.bootTimings) {
      const boot = rt.bootTimings;
      let line = `boot ${Math.round(boot.totalMs)} ms`;
      for (const phase of boot.phases) {
        const part = `  ${phase.phase} ${Math.round(phase.ms)}`;
        if (line.length + part.length > BOOT_LINE_WIDTH) {
          lines.push(line);
          line = ' ' + part;
        } else {
          line += part;
        }
      }
      lines.push(line);
    }

    return lines.join('\n');
  }
}
