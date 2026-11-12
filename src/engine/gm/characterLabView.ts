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
              <label>Animation <select id="gm-character-clip"></select></label>
              <div class="gm-timeline">
                <label for="gm-character-time">Character time</label>
                <output id="gm-character-readout" for="gm-character-time"></output>
                <input id="gm-character-time" type="range" min="0" max="0" step="any">
              </div>
              <label class="gm-check"><input id="gm-headgear" type="checkbox" checked> Show headgear</label>
              <label class="gm-check"><input id="gm-armor" type="checkbox" checked> Show body armor</label>
            </div>
            <div class="gm-control-group">
              <h2>Held item</h2>
              <label>Item <select id="gm-item"></select></label>
              <label>Animation <select id="gm-item-clip"></select></label>
              <div class="gm-timeline">
                <label for="gm-item-time">Item time</label>
                <output id="gm-item-readout" for="gm-item-time"></output>
                <input id="gm-item-time" type="range" min="0" max="0" step="any">
              </div>
            </div>
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
              <label class="gm-check"><input id="gm-loop" type="checkbox" checked> Loop clips</label>
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
    characterClip: element<HTMLSelectElement>('character-clip'),
    characterTime: element<HTMLInputElement>('character-time'),
    characterReadout: element<HTMLOutputElement>('character-readout'),
    headgear: element<HTMLInputElement>('headgear'),
    armor: element<HTMLInputElement>('armor'),
    item: element<HTMLSelectElement>('item'),
    itemClip: element<HTMLSelectElement>('item-clip'),
    itemTime: element<HTMLInputElement>('item-time'),
    itemReadout: element<HTMLOutputElement>('item-readout'),
    play: element<HTMLButtonElement>('play'),
    restart: element<HTMLButtonElement>('restart'),
    speed: element<HTMLSelectElement>('speed'),
    loop: element<HTMLInputElement>('loop'),
  };
}
