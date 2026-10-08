// Agentenliste rechts, gruppiert nach Haus (Auftrag), Subagenten eingerückt unter ihrem Erzeuger
import { STATIONS, STATUS, agentColor, agentName } from '../config.js';
import { esc, DIAMOND, ICON } from './common.js';
import { svgIcon } from '../config.js';
import { groupByHouse, houseName } from '../houses.js';

export class AgentList {
  constructor(el, { onSelect, onHover, onAdopt = () => {} }) {
    this.el = el;
    this.onAdopt = onAdopt;
    this.adopting = new Set();
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.agents = [];
    this.selected = null;
    this.collapsed = new Set();

    el.addEventListener('click', (e) => {
      const tog = e.target.closest('[data-toggle]');
      if (tog) {
        const k = tog.dataset.toggle;
        this.collapsed.has(k) ? this.collapsed.delete(k) : this.collapsed.add(k);
        this.draw();
        return;
      }
      const adopt = e.target.closest('[data-adopt]');
      if (adopt) {
        const id = adopt.dataset.adopt;
        if (this.adopting.has(id)) return;
        this.adopting.add(id);
        this.draw();
        Promise.resolve(this.onAdopt(id)).finally(() => { this.adopting.delete(id); this.draw(); });
        return;
      }
      const row = e.target.closest('[data-id]');
      if (row) this.onSelect(row.dataset.id === this.selected ? null : row.dataset.id);
    });
    el.addEventListener('pointerover', (e) => {
      const row = e.target.closest('[data-id]');
      this.onHover(row?.dataset.id || null);
    });
    el.addEventListener('pointerleave', () => this.onHover(null));
  }

  render(agents, selected) {
    this.agents = agents;
    this.selected = selected;
    this.draw();
  }

  scrollTo(id) {
    if (id) this.el.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  draw() {
    const groups = groupByHouse(this.agents);
    let html = '';
    for (const [house, list] of groups) {
      const closed = this.collapsed.has(house);
      const active = list.some((a) => a.status === 'tool' || a.status === 'thinking');
      // Kopf: Hausname (Auftrag), Ordner als Untertitel, wenn er nicht ohnehin der Name ist
      const name = houseName(list);
      const project = list.find((a) => a.kind === 'main')?.project ?? list[0]?.project ?? '';
      html += `<div class="grp">
        <button class="grp-head ${active ? 'active' : ''}" data-toggle="${esc(house)}" title="${esc(project)}">
          <svg viewBox="0 0 24 24" class="ic chev ${closed ? '' : 'open'}"><path d="M9 6l6 6-6 6"/></svg>
          <span class="grp-name">${esc(name)}</span><span class="grp-proj">${esc(project !== name ? project : '')}</span><span class="grp-n">${list.length}</span>
        </button>`;
      if (!closed) {
        const mains = list.filter((a) => a.kind === 'main');
        const subsOf = (id) => list.filter((a) => a.kind === 'sub' && a.parentId === id);
        const orphan = list.filter((a) => a.kind === 'sub' && !list.some((m) => m.id === a.parentId));
        const rowsFor = (a, depth) => {
          let h = this.row(a, depth);
          for (const s of subsOf(a.id)) h += rowsFor(s, depth + 1);
          return h;
        };
        for (const m of mains) html += rowsFor(m, 0);
        for (const o of orphan) html += rowsFor(o, 1);
      }
      html += '</div>';
    }
    // nur bei Änderung neu bauen (sonst gehen Klicks auf Knöpfe zwischen mousedown und mouseup verloren)
    if (html === this.html) return;
    this.html = html;
    this.el.innerHTML = html;
  }

  row(a, depth) {
    const st = STATUS[a.status] || STATUS.idle;
    const color = a.status === 'tool' && a.category ? (STATIONS[a.category]?.color ?? st.color) : st.color;
    const sub = a.status === 'tool' && a.tool
      ? `${esc(a.tool.replace(/^mcp__/, ''))}${a.detail ? ' · ' + esc(a.detail) : ''}`
      : st.label;
    return `<div class="row ${a.id === this.selected ? 'sel' : ''} ${a.status}" data-id="${esc(a.id)}" style="--d:${depth}">
      <span class="av" style="--c:${agentColor(a)}">${a.kind === 'main' ? DIAMOND : ''}</span>
      <span class="row-main"><span class="row-name">${esc(agentName(a))}</span><span class="row-sub">${sub}</span></span>
      ${a.adoptable && a.source === 'watch' ? `<button class="adopt-btn" data-adopt="${esc(a.id)}" title="Übernehmen – in Agent City fortsetzen" ${this.adopting.has(a.id) ? 'disabled' : ''}>${svgIcon(ICON.adopt)}</button>` : ''}
      <span class="pulse" style="--c:${color}"></span>
    </div>`;
  }
}
