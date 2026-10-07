// Detailkarte unten links für den ausgewählten Agenten
import { STATIONS, STATUS, agentColor, agentName, shortModel, fmtTokens, fmtAgo, svgIcon } from '../config.js';
import { ICON, esc, DIAMOND } from './common.js';

export class DetailCard {
  constructor(el, { onSelect }) {
    this.el = el;
    this.onSelect = onSelect;
    this.agents = [];
    this.selected = null;
    this.now = () => Date.now();
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) this.onSelect(null);
      const jump = e.target.closest('[data-jump]');
      if (jump) this.onSelect(jump.dataset.jump);
    });
    // Zeitangaben laufend aktualisieren
    setInterval(() => this.selected && this.draw(), 1000);
  }

  render(agents, selected, now) {
    this.agents = agents;
    this.selected = selected;
    if (now) this.now = now;
    this.draw();
  }

  draw() {
    const a = this.agents.find((x) => x.id === this.selected);
    if (!a) { this.el.classList.add('hidden'); return; }
    const now = this.now();
    const st = STATUS[a.status] || STATUS.idle;
    const parent = a.parentId && this.agents.find((x) => x.id === a.parentId);
    const children = this.agents.filter((x) => x.parentId === a.id);
    const statusColor = a.status === 'tool' && a.category ? (STATIONS[a.category]?.color ?? st.color) : st.color;
    const current = a.status === 'tool' && a.tool
      ? `<div class="cur" style="--c:${statusColor}">${svgIcon(STATIONS[a.category]?.icon || ICON.bolt)}<span><b>${esc(a.tool)}</b>${a.detail ? `<em>${esc(a.detail)}</em>` : ''}</span></div>`
      : '';
    const events = [...(a.events || [])].reverse().slice(0, 8).map((e) => {
      const icon = e.kind === 'tool' ? (STATIONS[e.category]?.icon || ICON.bolt) : e.kind === 'prompt' ? ICON.prompt : ICON.text;
      const c = e.kind === 'tool' ? STATIONS[e.category]?.color : e.kind === 'prompt' ? '#f0a33a' : '#8a94a6';
      const label = e.kind === 'tool' ? `<b>${esc((e.tool || '').replace(/^mcp__/, ''))}</b> ${esc(e.label || '')}` : esc(e.label);
      return `<li style="--c:${c}">${svgIcon(icon)}<span>${label}</span><time>${e.t ? fmtAgo(e.t, now) : ''}</time></li>`;
    }).join('');
    const tokens = a.tokens || { input: 0, output: 0, cache: 0 };

    this.el.classList.remove('hidden');
    this.el.innerHTML = `
      <div class="d-head">
        <span class="av lg" style="--c:${agentColor(a)}">${a.kind === 'main' ? DIAMOND : ''}</span>
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
        <div><span>Tokens ein</span><b>${fmtTokens(tokens.input + tokens.cache)}</b></div>
        <div><span>Tokens aus</span><b>${fmtTokens(tokens.output)}</b></div>
        <div><span>Laufzeit</span><b>${a.startedAt ? fmtAgo(a.startedAt, now) : '–'}</b></div>
        <div><span>${parent ? 'Erzeuger' : 'Subagenten'}</span><b>${parent ? `<a data-jump="${esc(parent.id)}">${esc(agentName(parent)).slice(0, 18)}</a>` : children.length}</b></div>
      </div>
      ${a.lastPrompt && a.kind === 'main' ? `<div class="quote"><span>Letzte Anweisung</span>${esc(a.lastPrompt)}</div>` : ''}
      ${a.lastText ? `<div class="quote q2"><span>Zuletzt gesagt</span>${esc(a.lastText)}</div>` : ''}
      ${events ? `<ul class="events">${events}</ul>` : ''}
    `;
  }
}
