import {
  WeaponSpec,
  AmmoSpec,
  ShotSimulationReport,
  TargetHealthState,
  GhoulZoneId,
} from '../contracts/ballistics.ts';
import { ALL_GHOUL_ZONES, GHOUL_ZONE_HIERARCHY } from '../core/ghoul/anatomy.ts';
import { WEAPONS } from '../core/ballistics/weapons.ts';

export interface HudControllerCallbacks {
  onWeaponSelected: (weapon: WeaponSpec) => void;
  onAmmoSelected: (ammo: AmmoSpec) => void;
  onAimZoneSelected: (zone: GhoulZoneId) => void;
  onFireRequested: () => void;
  onRespawnRequested: () => void;
  onToggleXRayCam: (enabled: boolean) => void;
  onToggleXRayVision: (enabled: boolean) => void;
  onToggleBulletTrails: (enabled: boolean) => void;
  onWindChanged: (windSpeed: number) => void;
  onTimeScaleChanged: (timeScale: number) => void;
  onPresetShotgunRagdoll: () => void;
  onPresetDecap50ae: () => void;
  onPresetLimbSever: () => void;
  onPresetSniperXray: () => void;
}

/**
 * Class HudController binds the HTML tactical interface to the simulation engine.
 */
export class HudController {
  private callbacks: HudControllerCallbacks;

  // UI Elements Cache
  private weaponListEl: HTMLElement | null = null;
  private ammoListEl: HTMLElement | null = null;
  private ghoulZoneDiagramEl: HTMLElement | null = null;
  private woundLogEl: HTMLElement | null = null;
  private liveLethalityPillEl: HTMLElement | null = null;
  private predRangeEl: HTMLElement | null = null;
  private predLethalEl: HTMLElement | null = null;
  private predRagdollEl: HTMLElement | null = null;
  private predDismemberEl: HTMLElement | null = null;
  private targetHpBadgeEl: HTMLElement | null = null;
  private aimPredictorPipEl: HTMLElement | null = null;
  private shotgunSpreadRingEl: HTMLElement | null = null;
  private sniperScopeMaskEl: HTMLElement | null = null;
  private scopeZoomLabelEl: HTMLElement | null = null;
  private scopeRangeLabelEl: HTMLElement | null = null;
  private scopeDropLabelEl: HTMLElement | null = null;
  private scopeWindLabelEl: HTMLElement | null = null;

  private activeWeaponId = '';
  private activeAmmoId = '';
  private activeAimZone: GhoulZoneId = 'TORSO_UPPER_THORAX';

  constructor(callbacks: HudControllerCallbacks) {
    this.callbacks = callbacks;
    this.initElements();
    this.bindEvents();
    this.buildGhoulZoneDiagram();
  }

  private initElements(): void {
    this.weaponListEl = document.getElementById('weapon-selector-list');
    this.ammoListEl = document.getElementById('ammo-selector-list');
    this.ghoulZoneDiagramEl = document.getElementById('ghoul-zone-diagram');
    this.woundLogEl = document.getElementById('wound-channel-log');
    this.liveLethalityPillEl = document.getElementById('live-lethality-pill');
    this.predRangeEl = document.getElementById('pred-range');
    this.predLethalEl = document.getElementById('pred-lethal');
    this.predRagdollEl = document.getElementById('pred-ragdoll');
    this.predDismemberEl = document.getElementById('pred-dismember');
    this.targetHpBadgeEl = document.getElementById('target-hp-badge');
    this.aimPredictorPipEl = document.getElementById('aim-predictor-pip');
    this.shotgunSpreadRingEl = document.getElementById('shotgun-spread-ring');
    this.sniperScopeMaskEl = document.getElementById('sniper-scope-mask');
    this.scopeZoomLabelEl = document.getElementById('scope-zoom-label');
    this.scopeRangeLabelEl = document.getElementById('scope-range-label');
    this.scopeDropLabelEl = document.getElementById('scope-drop-label');
    this.scopeWindLabelEl = document.getElementById('scope-wind-label');
  }

  private bindEvents(): void {
    // 1. Preset Buttons
    document.getElementById('preset-shotgun-ragdoll')?.addEventListener('click', () => {
      this.callbacks.onPresetShotgunRagdoll();
    });
    document.getElementById('preset-decap-50ae')?.addEventListener('click', () => {
      this.callbacks.onPresetDecap50ae();
    });
    document.getElementById('preset-limb-sever')?.addEventListener('click', () => {
      this.callbacks.onPresetLimbSever();
    });
    document.getElementById('preset-sniper-xray')?.addEventListener('click', () => {
      this.callbacks.onPresetSniperXray();
    });
    document.getElementById('btn-spawn-wave')?.addEventListener('click', () => {
      this.callbacks.onRespawnRequested();
    });

    // 2. Fire Button
    document.getElementById('btn-fire-shot')?.addEventListener('click', () => {
      this.callbacks.onFireRequested();
    });

    // 3. Toggles & Sliders
    const toggleXRayCam = document.getElementById('toggle-xray-cam') as HTMLInputElement | null;
    toggleXRayCam?.addEventListener('change', (e) => {
      this.callbacks.onToggleXRayCam((e.target as HTMLInputElement).checked);
    });

    const toggleXRayVision = document.getElementById('toggle-xray-vision') as HTMLInputElement | null;
    toggleXRayVision?.addEventListener('change', (e) => {
      this.callbacks.onToggleXRayVision((e.target as HTMLInputElement).checked);
    });

    const toggleBulletTrails = document.getElementById('toggle-bullet-trails') as HTMLInputElement | null;
    toggleBulletTrails?.addEventListener('change', (e) => {
      this.callbacks.onToggleBulletTrails((e.target as HTMLInputElement).checked);
    });

    const sliderWind = document.getElementById('slider-wind') as HTMLInputElement | null;
    const valWind = document.getElementById('val-wind');
    sliderWind?.addEventListener('input', (e) => {
      const val = parseFloat((e.target as HTMLInputElement).value);
      if (valWind) valWind.textContent = val.toFixed(1);
      this.callbacks.onWindChanged(val);
    });

    const sliderTimescale = document.getElementById('slider-timescale') as HTMLInputElement | null;
    const valTimescale = document.getElementById('val-timescale');
    sliderTimescale?.addEventListener('input', (e) => {
      const val = parseFloat((e.target as HTMLInputElement).value);
      if (valTimescale) valTimescale.textContent = val.toFixed(2);
      this.callbacks.onTimeScaleChanged(val);
    });

    // 4. Anatomical Aim Zone Buttons
    const zoneBtns = document.querySelectorAll('.zone-aim-btn');
    zoneBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        zoneBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const zone = btn.getAttribute('data-aim-zone') as GhoulZoneId;
        if (zone) {
          this.activeAimZone = zone;
          this.callbacks.onAimZoneSelected(zone);
        }
      });
    });

    // 5. Global Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;

      if (e.code === 'KeyR') {
        e.preventDefault();
        this.callbacks.onRespawnRequested();
      } else if (e.code === 'KeyF') {
        e.preventDefault();
        this.callbacks.onFireRequested();
      } else if (e.code === 'Digit1') {
        this.selectWeaponByIndex(0);
      } else if (e.code === 'Digit2') {
        this.selectWeaponByIndex(1);
      } else if (e.code === 'Digit3') {
        this.selectWeaponByIndex(2);
      } else if (e.code === 'Digit4') {
        this.selectWeaponByIndex(3);
      } else if (e.code === 'KeyX') {
        if (toggleXRayVision) {
          toggleXRayVision.checked = !toggleXRayVision.checked;
          this.callbacks.onToggleXRayVision(toggleXRayVision.checked);
        }
      }
    });
  }

  private selectWeaponByIndex(idx: number): void {
    if (idx >= 0 && idx < WEAPONS.length) {
      const w = WEAPONS[idx];
      this.setActiveWeapon(w);
      this.callbacks.onWeaponSelected(w);
    }
  }

  /**
   * Builds the 22-zone anatomical status chips.
   */
  private buildGhoulZoneDiagram(): void {
    if (!this.ghoulZoneDiagramEl) return;
    this.ghoulZoneDiagramEl.innerHTML = '';

    for (const zone of ALL_GHOUL_ZONES) {
      const hier = GHOUL_ZONE_HIERARCHY[zone];
      const chip = document.createElement('div');
      chip.className = 'zone-chip';
      chip.id = `zone-chip-${zone}`;
      chip.setAttribute('data-zone', zone);

      const label = document.createElement('span');
      label.textContent = hier.label.split(' / ')[0].toUpperCase();

      const val = document.createElement('span');
      val.className = 'zone-val';
      val.textContent = '100%';

      chip.appendChild(label);
      chip.appendChild(val);
      this.ghoulZoneDiagramEl.appendChild(chip);
    }
  }

  /**
   * Sets up the Arsenal weapon selector cards.
   */
  public setupArsenal(
    currentWeapon: WeaponSpec,
    currentAmmo: AmmoSpec
  ): void {
    if (!this.weaponListEl) return;
    this.weaponListEl.innerHTML = '';

    for (let i = 0; i < WEAPONS.length; i++) {
      const w = WEAPONS[i];
      const card = document.createElement('div');
      card.className = `weapon-card ${w.id === currentWeapon.id ? 'active' : ''}`;
      card.id = `weapon-card-${w.id}`;

      const top = document.createElement('div');
      top.className = 'weapon-card-top';
      top.innerHTML = `<span>[${i + 1}] ${w.codeName}</span><span>${w.defaultAmmo.caliber}</span>`;

      const sub = document.createElement('div');
      sub.className = 'weapon-card-sub';
      sub.textContent = w.name;

      card.appendChild(top);
      card.appendChild(sub);

      card.addEventListener('click', () => {
        this.setActiveWeapon(w);
        this.callbacks.onWeaponSelected(w);
      });

      this.weaponListEl.appendChild(card);
    }

    this.setActiveWeapon(currentWeapon, currentAmmo);
  }

  public setActiveWeapon(weapon: WeaponSpec, ammoOverride?: AmmoSpec): void {
    this.activeWeaponId = weapon.id;

    // Update active card class
    const cards = document.querySelectorAll('.weapon-card');
    cards.forEach((c) => {
      c.classList.toggle('active', c.id === `weapon-card-${weapon.id}`);
    });

    // Update ammo pills
    if (this.ammoListEl) {
      this.ammoListEl.innerHTML = '';
      const chosenAmmo = ammoOverride || weapon.defaultAmmo;
      this.activeAmmoId = chosenAmmo.id;

      for (const a of weapon.availableAmmo) {
        const pill = document.createElement('button');
        pill.className = `ammo-pill ${a.id === chosenAmmo.id ? 'active' : ''}`;
        pill.textContent = a.name.split(' (')[0];
        pill.addEventListener('click', () => {
          document.querySelectorAll('.ammo-pill').forEach((p) => p.classList.remove('active'));
          pill.classList.add('active');
          this.activeAmmoId = a.id;
          this.callbacks.onAmmoSelected(a);
        });
        this.ammoListEl.appendChild(pill);
      }
    }

    // Toggle shotgun spread ring visibility
    if (this.shotgunSpreadRingEl) {
      this.shotgunSpreadRingEl.style.display = weapon.role === 'SHOTGUN' ? 'block' : 'none';
    }
  }

  /**
   * Updates real-time pre-impact ballistic predictor UI.
   */
  public updatePreImpactTelemetry(
    report: ShotSimulationReport,
    target: TargetHealthState,
    screenPipOffset: { x: number; y: number }
  ): void {
    if (this.predRangeEl) {
      this.predRangeEl.textContent = `${report.targetDistanceM.toFixed(1)} m`;
    }

    if (this.predLethalEl) {
      if (report.isLethalKill) {
        this.predLethalEl.textContent = 'LETHAL KILL';
        this.predLethalEl.style.color = 'var(--accent-crimson)';
      } else if (report.hitTarget) {
        this.predLethalEl.textContent = `DMG: ${report.totalDamageHp.toFixed(0)} HP`;
        this.predLethalEl.style.color = 'var(--accent-amber)';
      } else {
        this.predLethalEl.textContent = 'MISS';
        this.predLethalEl.style.color = 'var(--text-muted)';
      }
    }

    if (this.predRagdollEl) {
      const launchVel = report.ragdollPlan.launchLiftVelocityMs;
      if (report.ragdollPlan.willEnableRagdoll && launchVel > 0) {
        this.predRagdollEl.textContent = `+${launchVel.toFixed(1)} m/s LAUNCH`;
        this.predRagdollEl.style.color = 'var(--accent-crimson)';
      } else if (report.ragdollPlan.willEnableRagdoll) {
        this.predRagdollEl.textContent = 'RAGDOLL ACTIVE';
        this.predRagdollEl.style.color = 'var(--accent-amber)';
      } else {
        this.predRagdollEl.textContent = 'STABLE';
        this.predRagdollEl.style.color = 'var(--accent-emerald)';
      }
    }

    if (this.predDismemberEl) {
      if (report.severedZones.length > 0) {
        const first = report.severedZones[0].split('_')[0];
        this.predDismemberEl.textContent = `${first} SEVER`;
        this.predDismemberEl.style.color = 'var(--accent-crimson)';
      } else {
        this.predDismemberEl.textContent = 'NONE';
        this.predDismemberEl.style.color = 'var(--text-muted)';
      }
    }

    if (this.liveLethalityPillEl) {
      if (report.isLethalKill) {
        this.liveLethalityPillEl.className = 'status-pill status-lethal';
        this.liveLethalityPillEl.textContent = 'LETHAL';
      } else if (report.hitTarget) {
        this.liveLethalityPillEl.className = 'status-pill status-ready';
        this.liveLethalityPillEl.textContent = 'TARGET LOCKED';
      } else {
        this.liveLethalityPillEl.className = 'status-pill status-ready';
        this.liveLethalityPillEl.textContent = 'CLEAR';
      }
    }

    // Position Aim Predictor Pip (shows drop + wind drift)
    if (this.aimPredictorPipEl) {
      this.aimPredictorPipEl.style.transform = `translate(${screenPipOffset.x}px, ${screenPipOffset.y}px)`;
    }
  }

  /**
   * Updates GHOUL 22-zone integrity chips and target health badge.
   */
  public updateTargetHealthDisplay(target: TargetHealthState): void {
    if (this.targetHpBadgeEl) {
      const hp = Math.max(0, target.currentHp);
      this.targetHpBadgeEl.textContent = `${hp.toFixed(0)} / ${target.maxHp.toFixed(0)} HP`;
      this.targetHpBadgeEl.style.color = hp <= 0 ? 'var(--accent-crimson)' : 'var(--accent-emerald)';
    }

    for (const zone of ALL_GHOUL_ZONES) {
      const chip = document.getElementById(`zone-chip-${zone}`);
      if (!chip) continue;

      const isSevered = target.severedZones.has(zone);
      const integrity = target.zoneIntegrity[zone] ?? 100;

      const valSpan = chip.querySelector('.zone-val');
      if (isSevered) {
        chip.className = 'zone-chip severed';
        if (valSpan) valSpan.textContent = 'SEVERED';
      } else if (integrity < 99) {
        chip.className = 'zone-chip damaged';
        if (valSpan) valSpan.textContent = `${integrity.toFixed(0)}%`;
      } else {
        chip.className = 'zone-chip';
        if (valSpan) valSpan.textContent = '100%';
      }
    }
  }

  /**
   * Appends terminal wound channel log entry.
   */
  public logWoundReport(report: ShotSimulationReport): void {
    if (!this.woundLogEl) return;

    if (this.woundLogEl.querySelector('.log-empty')) {
      this.woundLogEl.innerHTML = '';
    }

    const entry = document.createElement('div');
    entry.className = 'wound-entry';

    const title = document.createElement('span');
    title.className = 'wound-entry-title';

    if (report.ammoId.includes('BUCKSHOT')) {
      title.textContent = `12G BUCKSHOT BLAST (${report.pelletCount} PELLETS)`;
    } else {
      title.textContent = `${report.weaponId.toUpperCase()} // ${report.ammoId}`;
    }

    const meta = document.createElement('span');
    meta.className = 'wound-entry-meta';
    const severTxt = report.severedZones.length > 0 ? ` | SEVERED: [${report.severedZones.join(', ')}]` : '';
    const orgTxt = report.rupturedOrgans.length > 0 ? ` | RUPTURED: [${report.rupturedOrgans.join(', ')}]` : '';

    meta.textContent = `DIST: ${report.targetDistanceM.toFixed(1)}m | E_dep: ${report.totalEnergyDepositedJ.toFixed(0)}J | DMG: ${report.totalDamageHp.toFixed(0)}HP${severTxt}${orgTxt}`;

    entry.appendChild(title);
    entry.appendChild(meta);

    this.woundLogEl.insertBefore(entry, this.woundLogEl.firstChild);

    // Keep log to max 25 items
    while (this.woundLogEl.children.length > 25) {
      this.woundLogEl.removeChild(this.woundLogEl.lastChild!);
    }
  }

  /**
   * Sets precision sniper optic overlay visibility and telemetry.
   */
  public setScopeOverlay(
    active: boolean,
    zoom = 6.0,
    range = 25.0,
    dropCm = 0.0,
    windMs = 0.0
  ): void {
    if (!this.sniperScopeMaskEl) return;

    if (active) {
      this.sniperScopeMaskEl.classList.remove('hidden');
      if (this.scopeZoomLabelEl) this.scopeZoomLabelEl.textContent = `${zoom.toFixed(1)}x OPTIC`;
      if (this.scopeRangeLabelEl) this.scopeRangeLabelEl.textContent = `RNG: ${range.toFixed(1)}m`;
      if (this.scopeDropLabelEl) this.scopeDropLabelEl.textContent = `DROP: ${dropCm.toFixed(1)}cm`;
      if (this.scopeWindLabelEl) this.scopeWindLabelEl.textContent = `WIND: ${windMs > 0 ? '+' : ''}${windMs.toFixed(1)}m/s`;
    } else {
      this.sniperScopeMaskEl.classList.add('hidden');
    }
  }
}
