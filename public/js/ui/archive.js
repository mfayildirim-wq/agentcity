// Archiv (Panel links): beendete Sessions mit Projekt, Tool-Farbe, Datum, Dauer und Titel.
// Klick klappt die Ereignisliste auf; „Fortsetzen“ (nur bei resumable) lädt die Session per session/load neu.
// Bereits fortgesetzte Sessions (resumedBy) zeigen statt des Knopfs den Hinweis „fortgesetzt“.
import { STATIONS, STATUS, svgIcon, toolOf } from '../config.js';
import { ICON, esc, DIAMOND } from './common.js';

export const ARCHIVE_ICON = 'M3 4h18v4H3zM5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4';
const PLAY = 'M7 4v16l13-8z';
const PAGE = 50;
const EVENT_PAGE = 200;

const fmtDate = (t) => new Date(t).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtClock = (t) => new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function fmtDuration(ms) {
  if (ms == null) return '–';
  const m = Math.round(ms / 60_000);
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
const basename = (p) => String(p ?? '').replace(/\/+$/, '').split('/').pop();
const STATUS_LABEL = { done: 'beendet', ended: 'beendet (Server)', error: 'mit Fehler beendet', active: 'läuft' };

// Icon je Ereignisart
function eventIcon(e) {
  if (e.kind === 'tool' || e.kind === 'terminal') return STATIONS[e.category]?.icon ?? ICON.bolt;
  return { prompt: ICON.prompt, text: ICON.text, permission: ICON.hand, error: ICON.close, plan: ICON.plan, diff: ICON.diff, status: ICON.check }[e.kind] ?? ICON.activity;
}
const SKIP = new Set(['usage', 'tool_update']);

export class Archive {
  constructor(el, { request, onResume, toast = () => {} }) {
    this.el = el;
    this.request = request;
    this.onResume = onResume;
    this.toast = toast;
    this.sessions = [];
    this.hasMore = false;
    this.open = null; // aufgeklappte Session-Id
    this.events = new Map(); // sessionId → { list[], hasMore }
    this.busy = null; // Session-Id, die gerade fortgesetzt wird

    el.innerHTML = `<div class="archive">
      <div class="b-head">${svgIcon(ARCHIVE_ICON)}<span>Archiv</span><b class="b-count"></b>
        <button class="icon-btn sm ar-reload" title="Neu laden">${svgIcon(ICON.restart)}</button>
        <button class="icon-btn sm ar-close" title="Schließen (A)">${svgIcon(ICON.x)}</button></div>
      <div class="ar-list"></div>
    </div>`;
    this.listEl = el.querySelector('.ar-list');
    this.countEl = el.querySelector('.b-count');
    el.querySelector('.ar-close').addEventListener('click', () => this.close());
    el.querySelector('.ar-reload').addEventListener('click', () => this.load(true));
    this.listEl.addEventListener('click', (e) => {
      const resume = e.target.closest('[data-resume]');
      if (resume) { e.stopPropagation(); this.resume(resume.dataset.resume); return; }
      if (e.target.closest('[data-more]')) { this.load(false); return; }
      const more = e.target.closest('[data-evmore]');
      if (more) { this.loadEvents(more.dataset.evmore, true); return; }
      const row = e.target.closest('[data-sid]');
      if (row) this.toggleRow(row.dataset.sid);
    });
  }

  get isOpen() { return !this.el.classList.contains('hidden'); }
  toggle() { if (this.isOpen) this.close(); else this.show(); }
  show() {
    this.el.classList.remove('hidden');
    document.body.classList.add('has-archive');
    this.onToggle?.(true);
    this.load(true);
  }
  close() {
    this.el.classList.add('hidden');
    document.body.classList.remove('has-archive');
    this.onToggle?.(false);
  }

  async load(reset) {
    const offset = reset ? 0 : this.sessions.length;
    if (reset && !this.sessions.length) this.listEl.innerHTML = '<div class="ar-none">lädt …</div>';
    try {
      const res = await this.request('history.sessions', { ended: true, limit: PAGE, offset });
      this.sessions = reset ? res.sessions : [...this.sessions, ...res.sessions.filter((s) => !this.sessions.some((x) => x.id === s.id))];
      this.hasMore = res.hasMore;
      if (reset) this.events.clear();
      if (this.open && this.events.size === 0 && this.sessions.some((s) => s.id === this.open)) this.loadEvents(this.open);
      this.draw();
    } catch (err) {
      this.listEl.innerHTML = `<div class="ar-none">Archiv nicht verfügbar: ${esc(err.message)}</div>`;
    }
  }

  toggleRow(id) {
    this.open = this.open === id ? null : id;
    if (this.open && !this.events.has(id)) this.loadEvents(id);
    this.draw();
  }

  async loadEvents(id, more = false) {
    const cur = this.events.get(id);
    const offset = more && cur ? cur.offset : 0;
    try {
      const res = await this.request('history.events', { sessionId: id, limit: EVENT_PAGE, offset });
      const list = (more && cur ? cur.list : []).concat(res.events.filter((e) => !SKIP.has(e.kind)));
      this.events.set(id, { list, hasMore: res.hasMore, offset: offset + res.events.length });
    } catch (err) {
      this.events.set(id, { list: [], hasMore: false, offset: 0, error: err.message });
    }
    this.draw();
  }

  async resume(id) {
    if (this.busy) return;
    this.busy = id;
    this.draw();
    try {
      await this.onResume(id);
      this.load(true);
    } catch { /* Hinweis kam als Toast */ } finally {
      this.busy = null;
      this.draw();
    }
  }

  draw() {
    this.countEl.textContent = this.sessions.length ? `${this.sessions.length}${this.hasMore ? '+' : ''}` : '';
    if (!this.sessions.length) { this.listEl.innerHTML = '<div class="ar-none">Noch keine beendeten Sessions</div>'; return; }
    const rows = this.sessions.map((s) => {
      const tool = toolOf({ toolId: s.toolId });
      const color = tool?.color ?? '#8a94a6';
      const project = s.project || basename(s.cwd) || 'Projekt';
      const st = s.status === 'error' ? STATUS.error.color : '#6b7587';
      const isOpen = this.open === s.id;
      const resumeBtn = s.resumable
        ? `<button class="icon-btn sm ar-resume" data-resume="${esc(s.id)}" title="Fortsetzen" ${this.busy ? 'disabled' : ''}>${this.busy === s.id ? '<span class="spin"></span>' : svgIcon(PLAY)}</button>`
        : s.resumedBy ? '<span class="ar-cont" title="Bereits fortgesetzt – die neuere Session steht weiter oben">fortgesetzt</span>' : '';
      return `<div class="ar-row ${isOpen ? 'open' : ''}" data-sid="${esc(s.id)}">
          <span class="av sm" style="--c:${color}" title="${esc(tool?.name ?? s.toolId ?? '')}">${DIAMOND}</span>
          <div class="ar-main"><b>${esc(s.title || 'Ohne Titel')}</b>
            <span><em class="ar-tool" style="--c:${color}">${esc(tool?.name ?? s.toolId ?? '?')}</em> · ${esc(project)} · ${fmtDate(s.startedAt)} · ${fmtDuration(s.duration)}</span></div>
          <i class="ar-st" style="--c:${st}" title="${esc(STATUS_LABEL[s.status] ?? s.status ?? '')}${s.source === 'watch' ? ' · extern' : ''}"></i>
          ${resumeBtn}
        </div>${isOpen ? this.eventsHtml(s) : ''}`;
    }).join('');
    const more = this.hasMore ? '<button class="btn ghost sm ar-more" data-more>Weitere laden</button>' : '';
    const top = this.listEl.scrollTop;
    this.listEl.innerHTML = rows + more;
    this.listEl.scrollTop = top;
  }

  eventsHtml(s) {
    const ev = this.events.get(s.id);
    const head = `<div class="ar-ev-head"><span>${s.eventCount ?? 0} Ereignisse${s.cwd ? ` · <em title="${esc(s.cwd)}">${esc(s.cwd)}</em>` : ''}</span>
      ${s.resumable ? `<button class="btn sm" data-resume="${esc(s.id)}" ${this.busy ? 'disabled' : ''}>${svgIcon(PLAY)}Fortsetzen</button>` : s.resumedBy ? '<span class="ar-cont">fortgesetzt</span>' : ''}</div>`;
    if (!ev) return `<div class="ar-events">${head}<div class="ar-none">lädt …</div></div>`;
    if (ev.error) return `<div class="ar-events">${head}<div class="ar-none">${esc(ev.error)}</div></div>`;
    const items = ev.list.map((e) => `<li>${svgIcon(eventIcon(e))}<span>${e.kind === 'tool' && e.tool ? `<b>${esc(e.tool)}</b> ` : ''}${esc(e.label ?? e.title ?? e.message ?? e.kind)}</span><time>${fmtClock(e.t)}</time></li>`).join('');
    return `<div class="ar-events">${head}<ul class="events ar-evlist">${items || '<li class="ar-none">keine Ereignisse</li>'}</ul>
      ${ev.hasMore ? `<button class="btn ghost sm ar-more" data-evmore="${esc(s.id)}">Weitere Ereignisse</button>` : ''}</div>`;
  }
}
