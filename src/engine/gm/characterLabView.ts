import './characterLab.css';

export function createCharacterLabView(root: HTMLElement) {
  root.innerHTML = `
    <main class="gm-lab">
      <header class="gm-header">
        <div>
          <div class="gm-section-label">Game Master</div>
          <h1>Character Lab</h1>
        </div>
        <a href="/">Back to game <span aria-hidden="true">↗</span></a>
      </header>
      <div class="gm-workspace">
        <section class="gm-stage" aria-label="Preview">
          <canvas id="gm-viewport" tabindex="0" aria-label="Character preview" aria-describedby="gm-camera-help"></canvas>
          <p id="gm-camera-help">Drag to orbit · Scroll to zoom · Arrow keys, + / − and Page Up / Down</p>
          <p id="gm-status" role="status">Loading character and item assets…</p>
        </section>
        <aside class="gm-panel" aria-label="Preview controls">
          <fieldset id="gm-controls" disabled>
            <div class="gm-control-group">
              <h2>Character</h2>
              <label>Model <select id="gm-model"></select></label>
              <label>Weapon <select id="gm-item"></select></label>
              <label class="gm-check"><input id="gm-southpaw" type="checkbox"> Left-handed</label>
              <label class="gm-check" id="gm-support-row"><input id="gm-support-dead" type="checkbox"> Support arm disabled</label>
              <label class="gm-check"><input id="gm-headgear" type="checkbox" checked> Show headgear</label>
              <label class="gm-check"><input id="gm-armor" type="checkbox" checked> Show body armor</label>
            </div>
            <div class="gm-control-group" id="gm-state-group">
              <h2>Body state</h2>
              <div class="gm-state-label">Stance</div>
              <div class="gm-state-buttons" id="gm-stances"></div>
              <div class="gm-state-label">Motion</div>
              <div class="gm-state-buttons" id="gm-motions"></div>
              <div class="gm-state-label">Weapon</div>
              <div class="gm-state-buttons"><button id="gm-aim" type="button" aria-pressed="false">Aim</button></div>
              <output id="gm-clip-readout"></output>
            </div>
            <details class="gm-control-group gm-details">
              <summary>Wounds</summary>
              <div class="gm-details-body" id="gm-wounds">
              <label class="gm-check"><input type="checkbox" data-wound="downed"> Downed</label>
              <label class="gm-check"><input type="checkbox" data-wound="ARM_LEFT"> Lost left arm</label>
              <label class="gm-check"><input type="checkbox" data-wound="ARM_RIGHT"> Lost right arm</label>
              <label class="gm-check"><input type="checkbox" data-wound="LEG_LEFT"> Lost left leg</label>
              <label class="gm-check"><input type="checkbox" data-wound="LEG_RIGHT"> Lost right leg</label>
              <label class="gm-check"><input type="checkbox" data-wound="sidearm" checked> Carries backup sidearm</label>
              <label class="gm-check"><input type="checkbox" data-wound="bleeding"> Bleeds out</label>
              <label>Consciousness
                <input id="gm-consciousness" type="range" min="0.2" max="1" step="0.05" value="0.45">
              </label>
              <output id="gm-wound-readout"></output>
              </div>
            </details>
            <details class="gm-control-group gm-details" id="gm-sequences">
              <summary>Wound sequences</summary>
              <div class="gm-details-body">
              <label class="gm-check"><input id="gm-sequence-sidearm" type="checkbox" checked> Backup sidearm</label>
              <label class="gm-check"><input id="gm-sequence-southpaw" type="checkbox"> Southpaw</label>
              <label>Fortitude
                <select id="gm-sequence-fortitude">
                  <option value="AUTO">Auto (rolled)</option>
                  <option value="HIGH">High: blaze</option>
                  <option value="MIDDLING">Middling: kneel</option>
                  <option value="LOW">Low: sit down</option>
                </select>
              </label>
              <label>You stand
                <select id="gm-sequence-stand-in">
                  <option value="FRONT">In front</option>
                  <option value="LEFT">To its left</option>
                  <option value="BEHIND">Behind</option>
                </select>
              </label>
              <div class="gm-sequence-buttons" id="gm-sequence-buttons"></div>
              <button id="gm-sequence-replay" type="button" disabled>Replay</button>
              <output id="gm-sequence-readout"></output>
              </div>
            </details>
            <div class="gm-control-group">
              <h2>Playback</h2>
              <div class="gm-buttons">
                <button id="gm-play" type="button">Pause</button>
                <button id="gm-restart" type="button">Restart</button>
              </div>
              <label>Speed
                <select id="gm-speed">
                  <option value="0.25">0.25×</option>
                  <option value="0.5">0.5×</option>
                  <option value="1" selected>1×</option>
                  <option value="2">2×</option>
                </select>
              </label>
            </div>
          </fieldset>
        </aside>
      </div>
    </main>`;

  function element<T extends HTMLElement>(id: string): T {
    const found = root.querySelector<T>(`#gm-${id}`);
    if (!found) throw new Error(`Missing Character Lab control: ${id}`);
    return found;
  }

  return {
    canvas: element<HTMLCanvasElement>('viewport'),
    status: element<HTMLParagraphElement>('status'),
    controls: element<HTMLFieldSetElement>('controls'),
    model: element<HTMLSelectElement>('model'),
    wounds: element<HTMLDivElement>('wounds'),
    consciousness: element<HTMLInputElement>('consciousness'),
    woundReadout: element<HTMLOutputElement>('wound-readout'),
    sequenceSidearm: element<HTMLInputElement>('sequence-sidearm'),
    sequenceSouthpaw: element<HTMLInputElement>('sequence-southpaw'),
    sequenceFortitude: element<HTMLSelectElement>('sequence-fortitude'),
    sequenceStandIn: element<HTMLSelectElement>('sequence-stand-in'),
    sequenceButtons: element<HTMLDivElement>('sequence-buttons'),
    sequenceReplay: element<HTMLButtonElement>('sequence-replay'),
    sequenceReadout: element<HTMLOutputElement>('sequence-readout'),
    southpaw: element<HTMLInputElement>('southpaw'),
    supportRow: element<HTMLLabelElement>('support-row'),
    supportDead: element<HTMLInputElement>('support-dead'),
    stances: element<HTMLDivElement>('stances'),
    motions: element<HTMLDivElement>('motions'),
    aim: element<HTMLButtonElement>('aim'),
    clipReadout: element<HTMLOutputElement>('clip-readout'),
    headgear: element<HTMLInputElement>('headgear'),
    armor: element<HTMLInputElement>('armor'),
    item: element<HTMLSelectElement>('item'),
    play: element<HTMLButtonElement>('play'),
    restart: element<HTMLButtonElement>('restart'),
    speed: element<HTMLSelectElement>('speed'),
  };
}
