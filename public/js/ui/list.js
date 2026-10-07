// Agentenliste rechts, gruppiert nach Projekt, Subagenten eingerückt unter ihrem Erzeuger
import { STATIONS, STATUS, agentColor, agentName } from '../config.js';
import { esc, DIAMOND } from './common.js';

export class AgentList {
  constructor(el, { onSelect, onHover }) {
    this.el = el;
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
    const groups = new Map();
    for (const a of this.agents) {
      if (!groups.has(a.project)) groups.set(a.project, []);
      groups.get(a.project).push(a);
    }
    let html = '';
    for (const [project, list] of groups) {
      const closed = this.collapsed.has(project);
      const active = list.some((a) => a.status === 'tool' || a.status === 'thinking');
      html += `<div class="grp">
        <button class="grp-head ${active ? 'active' : ''}" data-toggle="${esc(project)}">
          <svg viewBox="0 0 24 24" class="ic chev ${closed ? '' : 'open'}"><path d="M9 6l6 6-6 6"/></svg>
          <span class="grp-name">${esc(project)}</span><span class="grp-n">${list.length}</span>
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
    this.el.innerHTML = html;
  }

  row(a, depth) {
    const st = STATUS[a.status] || STATUS.idle;
    const color = a.status === 'tool' && a.category ? STATIONS[a.category].color : st.color;
    const sub = a.status === 'tool' && a.tool
      ? `${esc(a.tool.replace(/^mcp__/, ''))}${a.detail ? ' · ' + esc(a.detail) : ''}`
      : st.label;
    return `<div class="row ${a.id === this.selected ? 'sel' : ''} ${a.status}" data-id="${esc(a.id)}" style="--d:${depth}">
      <span class="av" style="--c:${agentColor(a)}">${a.kind === 'main' ? DIAMOND : ''}</span>
      <span class="row-main"><span class="row-name">${esc(agentName(a))}</span><span class="row-sub">${sub}</span></span>
      <span class="pulse" style="--c:${color}"></span>
    </div>`;
  }
}
