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
  return { root, triageLabel, hpNum, hpFill, armorTrack, armorFill, barkPill };
}

export function updateWorldPlateEntry(
  dom: WorldTriagePlateDom,
  entry: ProjectedTargetTriageEntry,
  activeBarkText?: string
): void {
  if (!entry.visible) {
    dom.root.style.display = 'none';
    return;
  }

  dom.root.style.display = 'block';
  dom.root.style.transform = `translate3d(${entry.screenX.toFixed(1)}px, ${entry.screenY.toFixed(1)}px, 0) translate(-50%, -100%)`;

  const status = computeCombatantTriageStatus(entry.state);
  const statusTag = entry.state.alive ? entry.state.combatantStatusTag : null;
  const baseLabel = formatTriageLabel(status);
  const label =
    statusTag === 'SIDEARM_DRAWN' ? `${baseLabel} • SIDEARM DRAWN`
    : statusTag === 'SIDEARM_DRAWING' ? `${baseLabel} • DRAWING M9`
    : statusTag === 'DISARMED' ? 'DISARMED'
    : statusTag === 'LAST_STAND' ? `${baseLabel} • LAST STAND`
    : statusTag === 'PANIC_SHAKEN' ? `${baseLabel} • SHAKEN`
    : statusTag === 'JUGGERNAUT' ? `${baseLabel} • ARMORED PUSH`
    : statusTag === 'RUSHING' ? `${baseLabel} • RUSHING`
    : baseLabel;

  const colorCls = triageColorClass(status);
  const hpClamped = entry.state.alive ? Math.max(1, Math.round(entry.state.currentHp)) : 0;
  const hpPct = entry.state.alive
    ? Math.max(0, Math.min(100, (entry.state.currentHp / Math.max(1, entry.state.maxHp)) * 100))
    : 0;

  dom.root.classList.toggle('is-dead', status === 'DEAD');
  dom.triageLabel.textContent = label;
  dom.triageLabel.className = `wtp-triage ${colorCls}`;
  dom.hpNum.textContent = `${hpClamped}`;
  dom.hpFill.className = `wtp-hp-fill ${colorCls}`;
  dom.hpFill.style.width = `${hpPct.toFixed(1)}%`;

  const armorIntegrity = (entry.state.hasChestArmor ? entry.state.chestArmorIntegrity : 0) || 0;
  if (armorIntegrity > 0) {
    dom.armorTrack.classList.remove('hidden');
    dom.armorFill.style.width = `${(armorIntegrity * 100).toFixed(1)}%`;
  } else {
    dom.armorTrack.classList.add('hidden');
  }

  if (dom.barkPill) {
    if (activeBarkText && entry.state.alive) {
      dom.barkPill.classList.remove('hidden');
      dom.barkPill.textContent = activeBarkText;
    } else {
      dom.barkPill.classList.add('hidden');
      dom.barkPill.textContent = '';
    }
  }
}
