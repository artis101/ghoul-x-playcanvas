import { computeCombatantTriageStatus } from '../../core/ballistics/solver.ts';
import {
  formatTriageLabel,
  type ProjectedTargetTriageEntry,
  triageColorClass,
  type WorldTriagePlateDom,
} from './hudTypes.ts';

export function createWorldTriagePlateDom(parent: HTMLElement): WorldTriagePlateDom {
  const root = document.createElement('div');
  root.className = 'world-triage-plate';
  const top = document.createElement('div');
  top.className = 'wtp-top';
  const triageLabel = document.createElement('span');
  triageLabel.className = 'wtp-triage triage-healthy';
  const hpNum = document.createElement('span');
  hpNum.className = 'wtp-hp-num';
  top.appendChild(triageLabel);
  top.appendChild(hpNum);

  const hpTrack = document.createElement('div');
  hpTrack.className = 'wtp-hp-track';
  const hpFill = document.createElement('div');
  hpFill.className = 'wtp-hp-fill triage-healthy';
  hpTrack.appendChild(hpFill);

  const armorTrack = document.createElement('div');
  armorTrack.className = 'wtp-armor-track hidden';
  const armorFill = document.createElement('div');
  armorFill.className = 'wtp-armor-fill';
  armorTrack.appendChild(armorFill);

  const barkPill = document.createElement('div');
  barkPill.className = 'wtp-bark-pill hidden';

  root.appendChild(top);
  root.appendChild(hpTrack);
  root.appendChild(armorTrack);
  root.appendChild(barkPill);
  parent.appendChild(root);
  return {
    root,
    triageLabel,
    hpNum,
    hpFill,
    armorTrack,
    armorFill,
    barkPill,
    lastVisible: -1,
    lastXTenths: Number.NaN,
    lastYTenths: Number.NaN,
    lastDead: -1,
    lastStatus: '',
    lastStatusTag: '\u0000',
    lastHpClamped: -1,
    lastHpTenths: -1,
    lastArmorTenths: -2,
    lastBark: null,
  };
}

function buildPlateLabel(baseLabel: string, statusTag: string): string {
  return statusTag === 'SIDEARM_DRAWN' ? `${baseLabel} • SIDEARM DRAWN`
    : statusTag === 'SIDEARM_DRAWING' ? `${baseLabel} • DRAWING .50 AE`
    : statusTag === 'DISARMED' ? 'DISARMED'
    : statusTag === 'LAST_STAND' ? `${baseLabel} • LAST STAND`
    : statusTag === 'PANIC_SHAKEN' ? `${baseLabel} • SHAKEN`
    : statusTag === 'JUGGERNAUT' ? `${baseLabel} • ARMORED PUSH`
    : statusTag === 'RUSHING' ? `${baseLabel} • RUSHING`
    : baseLabel;
}

export function updateWorldPlateEntry(
  dom: WorldTriagePlateDom,
  entry: ProjectedTargetTriageEntry,
  activeBarkText?: string
): void {
  if (!entry.visible) {
    if (dom.lastVisible !== 0) {
      dom.root.style.display = 'none';
      dom.lastVisible = 0;
    }
    return;
  }

  if (dom.lastVisible !== 1) {
    dom.root.style.display = 'block';
    dom.lastVisible = 1;
  }
  const xT = Math.round(entry.screenX * 10);
  const yT = Math.round(entry.screenY * 10);
  if (xT !== dom.lastXTenths || yT !== dom.lastYTenths) {
    dom.lastXTenths = xT;
    dom.lastYTenths = yT;
    dom.root.style.transform = `translate3d(${(xT / 10).toFixed(1)}px, ${(yT / 10).toFixed(1)}px, 0) translate(-50%, -100%)`;
  }

  const status = computeCombatantTriageStatus(entry.state);
  const statusTag = (entry.state.alive ? entry.state.combatantStatusTag : null) ?? '';

  const dead = status === 'DEAD' ? 1 : 0;
  if (dead !== dom.lastDead) {
    dom.root.classList.toggle('is-dead', dead === 1);
    dom.lastDead = dead;
  }

  if (status !== dom.lastStatus || statusTag !== dom.lastStatusTag) {
    dom.triageLabel.textContent = buildPlateLabel(formatTriageLabel(status), statusTag);
    if (status !== dom.lastStatus) {
      const colorCls = triageColorClass(status);
      dom.triageLabel.className = `wtp-triage ${colorCls}`;
      dom.hpFill.className = `wtp-hp-fill ${colorCls}`;
    }
    dom.lastStatus = status;
    dom.lastStatusTag = statusTag;
  }

  const hpClamped = entry.state.alive ? Math.max(1, Math.round(entry.state.currentHp)) : 0;
  if (hpClamped !== dom.lastHpClamped) {
    dom.hpNum.textContent = String(hpClamped);
    dom.lastHpClamped = hpClamped;
  }

  const hpPct = entry.state.alive
    ? Math.max(0, Math.min(100, (entry.state.currentHp / Math.max(1, entry.state.maxHp)) * 100))
    : 0;
  const hpT = Math.round(hpPct * 10);
  if (hpT !== dom.lastHpTenths) {
    dom.hpFill.style.width = `${(hpT / 10).toFixed(1)}%`;
    dom.lastHpTenths = hpT;
  }

  const armorIntegrity = (entry.state.hasChestArmor ? entry.state.chestArmorIntegrity : 0) || 0;
  const armorT = armorIntegrity > 0 ? Math.round(armorIntegrity * 1000) : -1;
  if (armorT !== dom.lastArmorTenths) {
    if (armorT < 0) {
      dom.armorTrack.classList.add('hidden');
    } else {
      if (dom.lastArmorTenths < 0) dom.armorTrack.classList.remove('hidden');
      dom.armorFill.style.width = `${(armorT / 10).toFixed(1)}%`;
    }
    dom.lastArmorTenths = armorT;
  }

  if (dom.barkPill) {
    const bark = activeBarkText && entry.state.alive ? activeBarkText : '';
    if (bark !== dom.lastBark) {
      if (bark) {
        dom.barkPill.classList.remove('hidden');
        dom.barkPill.textContent = bark;
      } else {
        dom.barkPill.classList.add('hidden');
        dom.barkPill.textContent = '';
      }
      dom.lastBark = bark;
    }
  }
}
