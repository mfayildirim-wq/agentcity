// Detailkarte unten links für den ausgewählten Agenten: Kopf, Status, Kennzahlen und Reiter
// Aktivität · Plan · Änderungen · Terminalausgaben · Subagenten. Bei Fehler: stderr und Neu starten / Schließen.
// Externe (Watcher-)Sessions, die sich übernehmen lassen, zeigen den Knopf „Übernehmen“.
import { STATIONS, STATUS, agentColor, agentName, shortModel, fmtTokens, fmtAgo, svgIcon } from '../config.js';
import { ICON, esc, DIAMOND, diffHtml } from './common.js';

const TABS = [
  ['activity', ICON.activity, 'Aktivität'],
  ['plan', ICON.plan, 'Plan'],
  ['diffs', ICON.diff, 'Änderungen'],
  ['terms', ICON.terminal, 'Terminalausgaben'],
  ['subs', ICON.sub, 'Subagenten'],
];
// Zeitangabe, die der Sekunden-Takt aktualisiert, ohne die Karte neu zu bauen
const ago = (ms, now) => `<span data-ago="${Number(ms) || 0}">${fmtAgo(ms, now)}</span>`;
const AGO_RE = /(<span data-ago="\d+">)[^<]*/g;

const PLAN_ICON = { completed: ICON.check, in_progress: ICON.half, pending: ICON.circle };

export class DetailCard {
  constructor(el, { onSelect, onAction = () => {}, getDiffs = () => [], getTerminals = () => [], onTerminals = () => {}, output = null }) {
    this.el = el;
    this.onSelect = onSelect;
    this.onAction = onAction;
    this.getDiffs = getDiffs;
    this.getTerminals = getTerminals;
    this.onTerminals = onTerminals; // Liste der Agenten-Terminals vom Server holen
    this.output = output; // OutputView (schreibgeschützte xterm-Ansicht)
    this.openTerm = null;
    this.busyAction = null;
    this.agents = [];
    this.selected = null;
    this.tab = 'activity';
    this.openDiffs = new Set();
    this.confirmClose = null;
    this.now = () => Date.now();
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) { this.onSelect(null); return; }
      const jump = e.target.closest('[data-jump]');
      if (jump) { this.onSelect(jump.dataset.jump); return; }
      const tab = e.target.closest('[data-tab]');
      if (tab) {
        this.tab = tab.dataset.tab;
        if (this.tab === 'terms' && this.selected) this.onTerminals(this.selected);
        this.draw();
        return;
      }
      const term = e.target.closest('[data-term]');
      if (term) { this.openTerm = term.dataset.term; this.draw(); return; }
      const diff = e.target.closest('[data-diff]');
      if (diff) {
        const k = diff.dataset.diff;
        if (this.openDiffs.has(k)) this.openDiffs.delete(k); else this.openDiffs.add(k);
        this.draw();
        return;
      }
      const act = e.target.closest('[data-action]');
      if (act) this.action(act.dataset.action);
    });
    // Zeitangaben laufend aktualisieren (nicht während Text markiert wird)
    setInterval(() => this.tickTimes(), 1000);
  }

  action(kind) {
    const a = this.agents.find((x) => x.id === this.selected);
    if (!a) return;
    if (kind === 'end' && this.confirmClose !== a.id) {
      // zweiter Klick bestätigt
      this.confirmClose = a.id;
      this.draw();
      setTimeout(() => { if (this.confirmClose === a.id) { this.confirmClose = null; this.draw(); } }, 3000);
      return;
    }
    this.confirmClose = null;
    if (kind === 'adopt') {
      if (this.busyAction) return;
      this.busyAction = a.id;
      this.draw();
      Promise.resolve(this.onAction('adopt', a)).finally(() => { this.busyAction = null; this.draw(); });
      return;
    }
    this.onAction(kind === 'end' ? 'close' : kind, a);
  }

  render(agents, selected, now) {
    if (selected !== this.selected) {
      this.openDiffs.clear(); this.confirmClose = null; this.openTerm = null;
      if (selected && this.tab === 'terms') this.onTerminals(selected);
    }
    this.agents = agents;
    this.selected = selected;
    if (now) this.now = now;
    this.draw();
  }

  draw() {
    const a = this.agents.find((x) => x.id === this.selected);
    if (!a) { this.el.classList.add('hidden'); this.sig = null; return; }
    const now = this.now();
    const st = STATUS[a.status] || STATUS.idle;
    const parent = a.parentId && this.agents.find((x) => x.id === a.parentId);
    const children = this.agents.filter((x) => x.parentId === a.id);
    const statusColor = a.status === 'tool' && a.category ? (STATIONS[a.category]?.color ?? st.color) : st.color;
    const current = a.status === 'tool' && a.tool
      ? `<div class="cur" style="--c:${statusColor}">${svgIcon(STATIONS[a.category]?.icon || ICON.bolt)}<span><b>${esc(a.tool)}</b>${a.detail ? `<em>${esc(a.detail)}</em>` : ''}</span></div>`
      : '';
    const tokens = a.tokens || { input: 0, output: 0, cache: 0 };
    const acp = a.source === 'acp' && a.kind === 'main' && !a.replay; // Wiedergabe: keine Aktionen
    const diffs = this.diffsOf(a);
    const terms = this.getTerminals(a.id);
    const counts = { plan: a.plan?.length || 0, diffs: diffs.length, terms: terms.length, subs: children.length };
    const tabs = TABS.filter(([k]) => k === 'activity' || counts[k] || (acp && k !== 'subs'));
    if (!tabs.some(([k]) => k === this.tab)) this.tab = 'activity';

    this.el.classList.remove('hidden');
    const html = `
      <div class="d-head">
        <span class="av lg" style="--c:${agentColor(a)}">${a.kind === 'main' ? DIAMOND : ''}</span>
        <div class="d-title">
          <div class="d-name">${esc(agentName(a))}</div>
          <div class="d-meta">${a.kind === 'main' ? (acp ? 'Session' : 'Hauptagent') : esc(a.agentType || 'Subagent')} · ${esc(a.project)}</div>
        </div>
        ${a.adoptable && a.source === 'watch' ? `<button class="icon-btn sm adopt ${this.busyAction === a.id ? 'busy' : ''}" data-action="adopt" title="Übernehmen – Session in Agent City fortsetzen" ${this.busyAction === a.id ? 'disabled' : ''}>${svgIcon(ICON.adopt)}</button>` : ''}
        ${acp ? `<button class="icon-btn sm" data-action="terminal" title="Terminal (Shell im Projektordner)">${svgIcon(ICON.terminal)}</button>` : ''}
        ${acp ? `<button class="icon-btn sm ${this.confirmClose === a.id ? 'danger' : ''}" data-action="end" title="${this.confirmClose === a.id ? 'Nochmal klicken: Session beenden' : 'Session beenden'}">${svgIcon(ICON.power)}</button>` : ''}
        <button class="icon-btn sm" data-close title="Schließen">${svgIcon(ICON.close)}</button>
      </div>
      <div class="d-status" style="--c:${statusColor}"><i></i>${st.label}<span>seit ${ago(a.lastActivity, now)}</span></div>
      ${current}
      ${a.status === 'error' && a.error ? this.errorBox(a) : ''}
      <div class="kv">
        <div><span>Modell</span><b>${esc(shortModel(a.model))}</b></div>
        <div><span>Werkzeuge</span><b>${a.toolCount}</b></div>
        <div><span>Tokens ein</span><b>${fmtTokens(tokens.input + tokens.cache)}</b></div>
        <div><span>Tokens aus</span><b>${fmtTokens(tokens.output)}</b></div>
        <div><span>Laufzeit</span><b>${a.startedAt ? ago(a.startedAt, now) : '–'}</b></div>
        <div><span>${parent ? 'Erzeuger' : 'Subagenten'}</span><b>${parent ? `<a data-jump="${esc(parent.id)}">${esc(agentName(parent)).slice(0, 18)}</a>` : children.length}</b></div>
      </div>
      ${a.lastPrompt && a.kind === 'main' && !acp ? `<div class="quote"><span>Letzte Anweisung</span>${esc(a.lastPrompt)}</div>` : ''}
      ${a.lastText && !acp ? `<div class="quote q2"><span>Zuletzt gesagt</span>${esc(a.lastText)}</div>` : ''}
      <div class="d-tabs">${tabs.map(([k, ic, label]) => `<button class="d-tab ${k === this.tab ? 'on' : ''}" data-tab="${k}" title="${label}">${svgIcon(ic)}${counts[k] ? `<b>${counts[k]}</b>` : ''}</button>`).join('')}</div>
      <div class="d-pane">${this.pane(a, children, diffs, now, terms)}</div>
    `;
    // nur neu bauen, wenn sich mehr als Zeitangaben geändert haben (Knöpfe, Fokus und Auswahl bleiben erhalten)
    const sig = html.replace(AGO_RE, '$1');
    if (sig === this.sig && this.el.firstElementChild) { this.tickTimes(); this.attachOutput(); return; }
    this.sig = sig;
    this.el.innerHTML = html;
    this.attachOutput();
  }

  // xterm-Ansicht des offenen Agenten-Terminals in den Platzhalter hängen
  attachOutput() {
    const slot = this.el.querySelector('.term-slot');
    if (slot && this.output) this.output.attach(slot, slot.dataset.pty);
  }

  tickTimes() {
    if (!this.selected || this.el.classList.contains('hidden')) return;
    const now = this.now();
    for (const el of this.el.querySelectorAll('[data-ago]')) {
      const t = fmtAgo(Number(el.dataset.ago), now);
      if (el.textContent !== t) el.textContent = t;
    }
  }

  errorBox(a) {
    const e = a.error;
    const canRestart = a.source === 'acp' && a.kind === 'main' && a.launch && !a.replay;
    return `<div class="d-error">
      <div class="d-err-msg">${svgIcon(ICON.close)}<span>${esc(e.message || 'Fehler')}</span></div>
      ${e.stderrTail ? `<pre>${esc(e.stderrTail.split('\n').slice(-12).join('\n'))}</pre>` : ''}
      ${canRestart ? `<div class="d-err-act">
        <button class="btn sm" data-action="restart">${svgIcon(ICON.restart)}Neu starten</button>
        <button class="btn sm ghost" data-action="close">${svgIcon(ICON.power)}Schließen</button>
      </div>` : ''}
    </div>`;
  }

  // Diffs: volle Live-Ereignisse aus dem Store, sonst kompakte (nur Pfad) aus dem Agenten
  diffsOf(a) {
    const live = this.getDiffs(a.id) ?? [];
    const ids = new Set(live.map((d) => d.id));
    const compact = (a.events ?? []).filter((e) => e.kind === 'diff' && !ids.has(e.id));
    return [...compact, ...live].sort((x, y) => y.t - x.t);
  }

  pane(a, children, diffs, now, terms = []) {
    if (this.tab === 'terms') {
      if (!terms.length) return '<div class="d-none">Noch keine Terminalausgaben</div>';
      const open = terms.find((t) => t.ptyId === this.openTerm) ?? terms[terms.length - 1];
      const rows = [...terms].reverse().slice(0, 20).map((t) => {
        const st = !t.exited ? 'run' : t.exitCode === 0 ? 'ok' : t.exitCode == null && !t.signal ? 'done' : 'fail';
        const icon = st === 'ok' ? ICON.check : st === 'fail' ? ICON.close : st === 'done' ? ICON.circle : ICON.terminal;
        const code = st === 'fail' ? `<em>${t.signal ? esc(t.signal) : `Code ${esc(t.exitCode)}`}</em>` : '';
        return `<li class="${st} ${t.ptyId === open.ptyId ? 'on' : ''}"><button data-term="${esc(t.ptyId)}" title="${esc(t.command)}">${svgIcon(icon)}<b>${esc(t.command || 'Befehl')}</b>${code}<time>${t.t ? ago(t.t, now) : ''}</time></button></li>`;
      }).join('');
      return `<ul class="terms">${rows}</ul><div class="term-slot" data-pty="${esc(open.ptyId)}"></div>`;
    }
    if (this.tab === 'plan') {
      if (!a.plan?.length) return '<div class="d-none">Noch kein Plan</div>';
      return `<ul class="plan">${a.plan.map((e) => `<li class="${esc(e.status)}">${svgIcon(PLAN_ICON[e.status] ?? ICON.circle)}<span>${esc(e.content)}</span></li>`).join('')}</ul>`;
    }
    if (this.tab === 'diffs') {
      if (!diffs.length) return '<div class="d-none">Noch keine Änderungen</div>';
      return `<ul class="diffs">${diffs.slice(0, 30).map((d) => {
        const open = this.openDiffs.has(d.id);
        const name = String(d.path ?? '').split('/').pop();
        const body = open ? ('newText' in d ? diffHtml(d.oldText, d.newText, 40) : '<div class="d-none">Inhalt nur live verfügbar</div>') : '';
        return `<li><button data-diff="${esc(d.id)}" title="${esc(d.path)}">${svgIcon(open ? ICON.chevDown : ICON.diff)}<b>${esc(name)}</b><em>\u200e${esc(d.path)}\u200e</em><time>${ago(d.t, now)}</time></button>${body}</li>`;
      }).join('')}</ul>`;
    }
    if (this.tab === 'subs') {
      if (!children.length) return '<div class="d-none">Keine Subagenten</div>';
      return `<ul class="subs">${children.map((c) => {
        const cs = STATUS[c.status] || STATUS.idle;
        return `<li data-jump="${esc(c.id)}"><span class="av" style="--c:${agentColor(c)}"></span><span class="sb-name">${esc(agentName(c))}<em>${esc(c.agentType ?? '')}</em></span><i style="--c:${cs.color}" title="${cs.label}"></i></li>`;
      }).join('')}</ul>`;
    }
    const shown = (a.events || []).filter((e) => !['usage', 'status', 'diff'].includes(e.kind) && !(e.kind === 'tool_update' && e.status !== 'failed'));
    const events = [...shown].reverse().slice(0, 10).map((e) => {
      const icon = e.kind === 'tool' || e.kind === 'terminal' ? (STATIONS[e.category]?.icon || ICON.bolt)
        : e.kind === 'prompt' ? ICON.prompt : e.kind === 'permission' ? ICON.hand : e.kind === 'plan' ? ICON.plan
          : e.kind === 'error' || e.kind === 'tool_update' ? ICON.close : ICON.text;
      const c = e.kind === 'tool' || e.kind === 'terminal' ? STATIONS[e.category]?.color : e.kind === 'prompt' || e.kind === 'permission' ? '#f0a33a'
        : e.kind === 'error' || e.kind === 'tool_update' ? '#e5534b' : '#8a94a6';
      const label = e.kind === 'tool' ? `<b>${esc((e.tool || '').replace(/^mcp__/, ''))}</b> ${esc(e.label && e.label !== e.tool ? e.label : '')}`
        : e.kind === 'tool_update' ? `<b>${esc(e.tool || 'Werkzeug')}</b> fehlgeschlagen` : esc(e.label);
      return `<li style="--c:${c}">${svgIcon(icon)}<span>${label}</span><time>${e.t ? ago(e.t, now) : ''}</time></li>`;
    }).join('');
    return events ? `<ul class="events">${events}</ul>` : '<div class="d-none">Noch keine Aktivität</div>';
  }
}
