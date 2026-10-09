// Kachelmodus: alle steuerbaren Sessions als CLI-Fenster über den ganzen Bildschirm verteilt (Taste K).
import { tileLayout } from '../tiles.js';

export class TileGrid {
  // makeBar(el, agentId) → ChatBar (standalone); onFocus(agentId) bei Eingabe in einer Kachel
  constructor(el, { store, makeBar, onFocus = () => {} }) {
    this.el = el;
    this.store = store;
    this.makeBar = makeBar;
    this.onFocus = onFocus;
    this.bars = new Map(); // agentId → { bar, wrap }
    this.on = false;
    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'tiles-empty';
    this.emptyEl.textContent = 'Keine steuerbaren Sessions – mit N eine neue starten';
    el.appendChild(this.emptyEl);
  }

  setOn(on) {
    this.on = !!on;
    this.el.classList.toggle('hidden', !this.on);
    document.body.classList.toggle('tiles', this.on);
    if (this.on) this.render(this.store.agentList(), new Set(['agents', 'chats']));
  }

  toggle() { this.setOn(!this.on); }

  // neueste Session zuerst – sie bekommt bei ungerader Anzahl die große Kachel
  static tilesOf(agents) {
    return agents.filter((a) => a.kind === 'main' && a.controllable).sort((x, y) => (y.startedAt || 0) - (x.startedAt || 0));
  }

  render(agents, changes) {
    if (!this.on) return;
    const list = TileGrid.tilesOf(agents);
    const ids = new Set(list.map((a) => a.id));
    for (const [id, t] of this.bars) if (!ids.has(id)) { t.wrap.remove(); this.bars.delete(id); }
    for (const a of list) {
      if (this.bars.has(a.id)) continue;
      const wrap = document.createElement('div');
      wrap.className = 'tile';
      wrap.addEventListener('focusin', () => this.onFocus(a.id));
      const bar = this.makeBar(wrap, a.id);
      this.el.appendChild(wrap);
      this.bars.set(a.id, { bar, wrap });
    }
    const { cols, rows, cells } = tileLayout(list.length);
    this.el.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    this.el.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
    list.forEach((a, i) => {
      const { bar, wrap } = this.bars.get(a.id);
      const c = cells[i];
      wrap.style.gridColumn = `${c.col} / span ${c.colSpan}`;
      wrap.style.gridRow = `${c.row} / span ${c.rowSpan}`;
      bar.render(a.id, changes);
    });
    this.emptyEl.classList.toggle('hidden', list.length > 0);
  }
}
