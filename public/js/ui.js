// HUD: Kennzahlen, Agentenliste, Detailkarte, Legende
import { STATIONS, STATUS, agentColor, agentName, shortModel, fmtTokens, fmtAgo, svgIcon } from './config.js';

const ICON = {
  rooms: 'M3 9l9-6 9 6v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM9 21V12h6v9',
  agent: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  sub: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M22 11h-6',
  bolt: 'M13 2 3 14h9l-1 8 10-12h-9z',
  close: 'M6 6l12 12M18 6 6 18',
  prompt: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  text: 'M4 6h16M4 12h16M4 18h10',
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class UI {
  constructor({ onSelect, onHover }) {
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.statsEl = document.getElementById('stats');
    this.listEl = document.getElementById('list');
    this.detailEl = document.getElementById('detail');
    this.emptyEl = document.getElementById('empty');
    this.liveEl = document.getElementById('live');
    this.panelEl = document.getElementById('panel');
    this.selected = null;
    this.agents = [];
    this.collapsed = new Set();
    this.renderLegend();

    this.listEl.addEventListener('click', (e) => {
      const tog = e.target.closest('[data-toggle]');
      if (tog) {
        const k = tog.dataset.toggle;
        this.collapsed.has(k) ? this.collapsed.delete(k) : this.collapsed.add(k);
        this.renderList();
        return;
      }
      const row = e.target.closest('[data-key]');
      if (row) this.onSelect(row.dataset.key === this.selected ? null : row.dataset.key);
    });
    this.listEl.addEventListener('pointerover', (e) => {
      const row = e.target.closest('[data-key]');
      this.onHover(row?.dataset.key || null);
    });
    this.listEl.addEventListener('pointerleave', () => this.onHover(null));
    this.detailEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) this.onSelect(null);
      const jump = e.target.closest('[data-jump]');
      if (jump) this.onSelect(jump.dataset.jump);
    });
    setInterval(() => this.selected && this.renderDetail(), 1000);
  }

  setConnection(state) {
    this.liveEl.dataset.state = state;
    this.liveEl.title = { live: 'Live verbunden', demo: 'Demo-Modus', off: 'Keine Verbindung' }[state];
  }

  render(snap) {
    this.now = snap.now;
    this.receivedAt = Date.now();
    this.agents = snap.agents;
    this.renderStats();
    this.renderList();
    this.renderDetail();
    this.emptyEl.classList.toggle('hidden', snap.agents.length > 0);
  }

  renderStats() {
    const a = this.agents;
    const rooms = new Set(a.map((x) => x.project)).size;
    const mains = a.filter((x) => x.kind === 'main').length;
    const subs = a.filter((x) => x.kind === 'sub' && x.status !== 'done').length;
    const busy = a.filter((x) => x.status === 'tool' || x.status === 'thinking').length;
    this.statsEl.innerHTML = [
      [ICON.rooms, rooms, 'Projekte'],
      [ICON.agent, mains, 'Sessions'],
      [ICON.sub, subs, 'aktive Subagenten'],
      [ICON.bolt, busy, 'arbeiten gerade'],
    ].map(([ic, n, t]) => `<span class="stat" title="${t}">${svgIcon(ic)}<b>${n}</b></span>`).join('');
  }

  renderList() {
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
        const subsOf = (key) => list.filter((a) => a.kind === 'sub' && a.parentKey === key);
        const orphan = list.filter((a) => a.kind === 'sub' && !list.some((m) => m.key === a.parentKey));
        const rowsFor = (a, depth) => {
          let h = this.row(a, depth);
          for (const s of subsOf(a.key)) h += rowsFor(s, depth + 1);
          return h;
        };
        for (const m of mains) html += rowsFor(m, 0);
        for (const o of orphan) html += rowsFor(o, 1);
      }
      html += '</div>';
    }
    this.listEl.innerHTML = html;
  }

  row(a, depth) {
    const st = STATUS[a.status] || STATUS.idle;
    const color = a.status === 'tool' && a.category ? STATIONS[a.category].color : st.color;
    const sub = a.status === 'tool' && a.tool
      ? `${esc(a.tool.replace(/^mcp__/, ''))}${a.detail ? ' · ' + esc(a.detail) : ''}`
      : st.label;
    return `<div class="row ${a.key === this.selected ? 'sel' : ''} ${a.status}" data-key="${esc(a.key)}" style="--d:${depth}">
      <span class="av" style="--c:${agentColor(a)}">${a.kind === 'main' ? '<svg viewBox="0 0 32 32"><path d="M16 4 28 16 16 28 4 16Z"/></svg>' : ''}</span>
      <span class="row-main"><span class="row-name">${esc(agentName(a))}</span><span class="row-sub">${sub}</span></span>
      <span class="pulse" style="--c:${color}"></span>
    </div>`;
  }

  select(key) {
    this.selected = key;
    this.renderList();
    this.renderDetail();
    if (key) this.listEl.querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  renderDetail() {
    const a = this.agents.find((x) => x.key === this.selected);
    if (!a) { this.detailEl.classList.add('hidden'); return; }
    const now = (this.now || Date.now()) + (Date.now() - (this.receivedAt || Date.now()));
    const st = STATUS[a.status] || STATUS.idle;
    const parent = a.parentKey && this.agents.find((x) => x.key === a.parentKey);
    const children = this.agents.filter((x) => x.parentKey === a.key);
    const statusColor = a.status === 'tool' && a.category ? STATIONS[a.category].color : st.color;
    const current = a.status === 'tool' && a.tool
      ? `<div class="cur" style="--c:${statusColor}">${svgIcon(STATIONS[a.category]?.icon || ICON.bolt)}<span><b>${esc(a.tool)}</b>${a.detail ? `<em>${esc(a.detail)}</em>` : ''}</span></div>`
      : '';
    const events = [...(a.events || [])].reverse().slice(0, 8).map((e) => {
      const icon = e.kind === 'tool' ? (STATIONS[e.category]?.icon || ICON.bolt) : e.kind === 'prompt' ? ICON.prompt : ICON.text;
      const c = e.kind === 'tool' ? STATIONS[e.category]?.color : e.kind === 'prompt' ? '#f0a33a' : '#8a94a6';
      const label = e.kind === 'tool' ? `<b>${esc(e.tool.replace(/^mcp__/, ''))}</b> ${esc(e.label || '')}` : esc(e.label);
      return `<li style="--c:${c}">${svgIcon(icon)}<span>${label}</span><time>${e.t ? fmtAgo(e.t, now) : ''}</time></li>`;
    }).join('');

    this.detailEl.classList.remove('hidden');
    this.detailEl.innerHTML = `
      <div class="d-head">
        <span class="av lg" style="--c:${agentColor(a)}">${a.kind === 'main' ? '<svg viewBox="0 0 32 32"><path d="M16 4 28 16 16 28 4 16Z"/></svg>' : ''}</span>
        <div class="d-title">
          <div class="d-name">${esc(agentName(a))}</div>
          <div class="d-meta">${a.kind === 'main' ? 'Hauptagent' : esc(a.agentType || 'Subagent')} · ${esc(a.project)}</div>
        </div>
        <button class="icon-btn sm" data-close title="Schließen">${svgIcon(ICON.close)}</button>
      </div>
      <div class="d-status" style="--c:${statusColor}"><i></i>${st.label}<span>seit ${fmtAgo(a.lastActivity, now)}</span></div>
      ${current}
      <div class="kv">
        <div><span>Modell</span><b>${esc(shortModel(a.model))}</b></div>
        <div><span>Werkzeuge</span><b>${a.toolCount}</b></div>
        <div><span>Tokens ein</span><b>${fmtTokens(a.tokens.input + a.tokens.cache)}</b></div>
        <div><span>Tokens aus</span><b>${fmtTokens(a.tokens.output)}</b></div>
        <div><span>Laufzeit</span><b>${a.startedAt ? fmtAgo(a.startedAt, now) : '–'}</b></div>
        <div><span>${parent ? 'Erzeuger' : 'Subagenten'}</span><b>${parent ? `<a data-jump="${esc(parent.key)}">${esc(agentName(parent)).slice(0, 18)}</a>` : children.length}</b></div>
      </div>
      ${a.lastPrompt && a.kind === 'main' ? `<div class="quote"><span>Letzte Anweisung</span>${esc(a.lastPrompt)}</div>` : ''}
      ${a.lastText ? `<div class="quote q2"><span>Zuletzt gesagt</span>${esc(a.lastText)}</div>` : ''}
      ${events ? `<ul class="events">${events}</ul>` : ''}
    `;
  }

  renderLegend() {
    const el = document.getElementById('legend');
    el.innerHTML = Object.values(STATIONS).map((s) => `<span style="--c:${s.color}" title="${s.label}">${svgIcon(s.icon)}<em>${s.label}</em></span>`).join('');
  }
}
