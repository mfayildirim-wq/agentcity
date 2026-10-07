// Zeitstrahl über der Chat-Leiste: eine Spur je Raum (Projekt) mit Markern für Prompts, Berechtigungen, Fehler und
// (gebündelt) Werkzeuge. Scrubben lädt die Ereignisse bis zum Zeitpunkt (Cache je Session), rekonstruiert den Zustand
// der Figuren und schaltet den Store in den Wiedergabemodus; „Live“ kehrt zurück.
import { svgIcon, toolOf } from '../config.js';
import { ICON, esc } from './common.js';
import { reconstruct, markerKind, bundleTools, sessionAt, mergeEvents, createScrubGate } from '../replay.js';

export const CLOCK_ICON = 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2';
const ZOOMS = [15, 30, 60, 90, 180, 360, 720, 1440]; // Fensterbreite in Minuten
const PAGE = 500; // Ereignisse je Anfrage (Server-Maximum)
const MAX_PAGES = 20; // je Session und Ladevorgang
const SETTLE_MS = 2000; // Recorder schreibt gebündelt – die letzten Sekunden erneut laden
const REFRESH_MS = 10_000;
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360]; // Achsenabstände in Minuten

const fmtClock = (t) => new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtHm = (t) => new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const fmtRange = (min) => (min < 60 ? `${min} min` : `${min / 60} h`);
const basename = (p) => String(p ?? '').replace(/\/+$/, '').split('/').pop();

export class Timeline {
  constructor(el, { store, request, onLive, toast = () => {} }) {
    this.el = el;
    this.store = store;
    this.request = request;
    this.onLive = onLive;
    this.toast = toast;
    this.zoom = ZOOMS.indexOf(90);
    this.sessions = [];
    this.cache = new Map(); // sessionId → { events[], ids:Set, agents[], loadedTo, complete }
    this.loading = null;
    this.dragging = false;
    this.cursorT = null;
    this.gate = createScrubGate(); // verwirft veraltete Scrub-Ergebnisse (auch nach „Live“)
    this.again = false;

    el.innerHTML = `<div class="tl">
      <div class="tl-head">${svgIcon(CLOCK_ICON)}<span class="tl-title">Zeitstrahl</span>
        <button class="icon-btn sm" data-zoom="out" title="Größerer Zeitraum">${svgIcon('M5 12h14')}</button>
        <b class="tl-range"></b>
        <button class="icon-btn sm" data-zoom="in" title="Kleinerer Zeitraum">${svgIcon(ICON.plus)}</button>
        <span class="tl-legend"><i class="prompt"></i>Prompt<i class="permission"></i>Erlaubnis<i class="error"></i>Fehler<i class="tool"></i>Werkzeuge</span>
        <span class="tl-state"></span>
        <button class="tl-live hidden" title="Zurück zu Live (Esc)"><i></i>Live</button>
        <button class="icon-btn sm" data-close title="Schließen (Z)">${svgIcon(ICON.x)}</button>
      </div>
      <div class="tl-body">
        <div class="tl-lanes"></div>
        <div class="tl-axis"></div>
        <div class="tl-over"><div class="tl-hover hidden"><span></span></div><div class="tl-cursor hidden"><span></span></div></div>
      </div>
    </div>`;
    this.lanesEl = el.querySelector('.tl-lanes');
    this.axisEl = el.querySelector('.tl-axis');
    this.overEl = el.querySelector('.tl-over');
    this.cursorEl = el.querySelector('.tl-cursor');
    this.hoverEl = el.querySelector('.tl-hover');
    this.rangeEl = el.querySelector('.tl-range');
    this.stateEl = el.querySelector('.tl-state');
    this.liveBtn = el.querySelector('.tl-live');

    el.querySelector('[data-close]').addEventListener('click', () => this.close());
    this.liveBtn.addEventListener('click', () => this.onLive());
    el.querySelector('.tl-head').addEventListener('click', (e) => {
      const z = e.target.closest('[data-zoom]');
      if (z) this.setZoom(this.zoom + (z.dataset.zoom === 'in' ? -1 : 1));
    });
    // Rad: Spuren scrollen; mit Strg/⌘ (oder Pinch) zoomen
    this.overEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) this.setZoom(this.zoom + (e.deltaY > 0 ? 1 : -1));
      else this.lanesEl.scrollTop += e.deltaY;
    }, { passive: false });
    this.overEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.dragging = true;
      this.overEl.setPointerCapture(e.pointerId);
      this.scrubTo(this.timeAt(e.clientX));
    });
    this.overEl.addEventListener('pointermove', (e) => {
      const t = this.timeAt(e.clientX);
      this.showHover(t);
      if (this.dragging) this.scrubTo(t);
    });
    this.overEl.addEventListener('pointerleave', () => this.hoverEl.classList.add('hidden'));
    const end = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      try { this.overEl.releasePointerCapture(e.pointerId); } catch { /* bereits frei */ }
      this.scrubTo(this.timeAt(e.clientX), true);
    };
    this.overEl.addEventListener('pointerup', end);
    this.overEl.addEventListener('pointercancel', end);
    this.banner = document.createElement('div');
    this.banner.className = 'pb-banner hidden';
    this.banner.innerHTML = `${svgIcon(CLOCK_ICON)}<span>Wiedergabe <b></b> <em></em></span><button class="tl-live" title="Zurück zu Live (Esc)"><i></i>Live</button>`;
    this.banner.querySelector('button').addEventListener('click', () => this.onLive());
    document.body.appendChild(this.banner);
  }

  get isOpen() { return !this.el.classList.contains('hidden'); }
  get minutes() { return ZOOMS[this.zoom]; }
  // Fenster: die letzten N Minuten bis jetzt
  range() {
    const to = this.store.now();
    return { from: to - this.minutes * 60_000, to };
  }

  toggle() { if (this.isOpen) this.close(); else this.open(); }

  open() {
    this.el.classList.remove('hidden');
    document.body.classList.add('has-timeline');
    this.refresh();
    clearInterval(this.timer);
    this.timer = setInterval(() => { if (!this.dragging) this.refresh(); }, REFRESH_MS);
  }

  close() {
    if (!this.isOpen) return;
    this.el.classList.add('hidden');
    document.body.classList.remove('has-timeline');
    clearInterval(this.timer);
    if (this.store.state.playback) this.onLive();
  }

  setZoom(i) {
    const z = Math.max(0, Math.min(ZOOMS.length - 1, i));
    if (z === this.zoom) return;
    this.zoom = z;
    this.refresh();
  }

  // ---------------------------------------------------------------- Daten
  async refresh() {
    // läuft schon ein Ladevorgang (z. B. Zoom währenddessen): danach erneut laden
    if (this.loading) { this.again = true; return this.loading; }
    this.render();
    this.loading = (async () => {
      const { from, to } = this.range();
      try {
        const sessions = [];
        for (let offset = 0, page = 0; page < 4; page++, offset += PAGE) {
          const res = await this.request('history.sessions', { since: from, limit: PAGE, offset, counts: false });
          sessions.push(...res.sessions);
          if (!res.hasMore) break;
        }
        this.sessions = sessions.filter((s) => (s.startedAt ?? 0) <= to);
        this.stateEl.textContent = '';
        this.render();
        await this.ensureAll(this.sessions, to);
      } catch (err) {
        this.stateEl.textContent = 'Verlauf nicht verfügbar';
        this.stateEl.title = err.message;
      } finally {
        this.loading = null;
      }
      this.render();
      if (this.again && this.isOpen) { this.again = false; this.refresh(); }
    })();
    return this.loading;
  }

  // höchstens 4 Sessions gleichzeitig laden
  async ensureAll(sessions, to) {
    const queue = [...sessions];
    const worker = async () => { while (queue.length) await this.ensure(queue.shift(), to).catch(() => {}); };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  // Ereignisse einer Session bis `to` in den Cache laden (inkrementell, Duplikate per Id verworfen)
  async ensure(s, to) {
    let c = this.cache.get(s.id);
    if (!c) { c = { events: [], ids: new Set(), agents: [], loadedTo: (s.startedAt ?? 0) - 1, complete: false }; this.cache.set(s.id, c); }
    if (c.complete || c.loadedTo >= to) return c;
    const upto = s.endedAt != null ? Math.min(to, s.endedAt + SETTLE_MS) : to;
    let truncated = false;
    let lastT = null;
    for (let offset = 0, page = 0; ; page++, offset += PAGE) {
      if (page >= MAX_PAGES) { truncated = true; break; }
      const res = await this.request('history.events', { sessionId: s.id, from: Math.max(0, c.loadedTo), to: upto, limit: PAGE, offset });
      if (res.agents?.length) c.agents = res.agents;
      mergeEvents(c, res.events);
      if (res.events.length) lastT = res.events[res.events.length - 1].t;
      if (!res.hasMore) break;
    }
    if (truncated) {
      // Seitenlimit erreicht: nur bis zum letzten geladenen Ereignis als geladen markieren
      if (lastT != null) c.loadedTo = Math.max(c.loadedTo, lastT);
      return c;
    }
    // die letzten Sekunden später erneut abfragen (gebündeltes Schreiben)
    c.loadedTo = Math.max(c.loadedTo, upto - SETTLE_MS);
    if (s.endedAt != null && upto >= s.endedAt + SETTLE_MS && this.store.now() > s.endedAt + 5000) c.complete = true;
    return c;
  }

  // ---------------------------------------------------------------- Wiedergabe
  timeAt(clientX) {
    const r = this.overEl.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
    const { from, to } = this.range();
    return from + f * (to - from);
  }

  // Zeitpunkt anzeigen; ganz rechts (jetzt) = zurück zu Live
  async scrubTo(t, final = false) {
    const { to } = this.range();
    if (t >= to - 1500) {
      if (final && this.store.state.playback) this.onLive();
      this.setCursor(null);
      return;
    }
    this.setCursor(t);
    const token = this.gate.begin();
    // während des Ziehens gedrosselt rekonstruieren
    if (!final && this.lastReplay && performance.now() - this.lastReplay < 90) {
      clearTimeout(this.pendingReplay);
      this.pendingReplay = setTimeout(() => { this.pendingReplay = null; this.scrubTo(t, true); }, 100);
      return;
    }
    this.lastReplay = performance.now();
    const active = this.sessions.filter((s) => sessionAt(s, t));
    this.pending = token;
    try {
      await this.ensureAll(active, t);
    } catch { /* Teilweise geladen – mit dem Vorhandenen weiter */ }
    if (this.pending === token) this.pending = null;
    if (!this.gate.valid(token)) return; // inzwischen weitergezogen oder zurück zu Live
    this.store.setPlaybackAgents(t, reconstruct(active, this.cache, t));
  }

  // Schritt in der Wiedergabe (Pfeiltasten)
  step(ms) {
    const { from, to } = this.range();
    const base = this.store.state.playback?.t ?? to;
    this.scrubTo(Math.max(from, Math.min(to, base + ms)), true);
  }

  // laufende/geplante Wiedergabe-Schritte verwerfen (vor der Rückkehr zu Live)
  // Scrub läuft noch (Ereignisse werden geladen) oder ist geplant
  get busy() { return this.pending != null || this.pendingReplay != null || this.dragging; }

  cancel() {
    this.pending = null;
    this.gate.cancel();
    clearTimeout(this.pendingReplay);
    this.pendingReplay = null;
    this.dragging = false;
  }

  setCursor(t) {
    this.cursorT = t;
    this.positionCursor();
  }

  positionCursor() {
    const t = this.cursorT ?? this.store.state.playback?.t ?? null;
    if (t == null) { this.cursorEl.classList.add('hidden'); return; }
    const { from, to } = this.range();
    const f = (t - from) / (to - from);
    this.cursorEl.classList.toggle('hidden', f < 0 || f > 1);
    this.cursorEl.style.left = `${(f * 100).toFixed(3)}%`;
    this.cursorEl.querySelector('span').textContent = fmtClock(t);
  }

  showHover(t) {
    const { from, to } = this.range();
    this.hoverEl.classList.remove('hidden');
    this.hoverEl.style.left = `${(((t - from) / (to - from)) * 100).toFixed(3)}%`;
    this.hoverEl.querySelector('span').textContent = fmtHm(t);
  }

  // Store-Wechsel Live ⇄ Wiedergabe
  onPlayback(pb) {
    const on = !!pb;
    if (!on) this.cancel();
    this.liveBtn.classList.toggle('hidden', !on);
    this.banner.classList.toggle('hidden', !on || pb.t == null);
    if (on && pb.t != null) {
      const n = this.store.heldPermissions?.() ?? 0;
      this.banner.querySelector('b').textContent = fmtClock(pb.t);
      this.banner.querySelector('em').textContent = n ? `· ${n} ${n === 1 ? 'Rückfrage wartet' : 'Rückfragen warten'}` : '';
    }
    if (!on) this.cursorT = null;
    this.positionCursor();
  }

  // ---------------------------------------------------------------- Darstellung
  render() {
    if (!this.isOpen) return;
    const { from, to } = this.range();
    const span = to - from;
    this.rangeEl.textContent = fmtRange(this.minutes);
    const pct = (t) => `${(((t - from) / span) * 100).toFixed(3)}%`;
    const width = this.overEl.getBoundingClientRect().width || 600;
    const bucketMs = Math.max(1000, (span / width) * 5); // Werkzeuge: ein Marker je ~5 px

    // Spuren je Raum (Projekt), älteste Session zuerst
    const lanes = new Map();
    for (const s of this.sessions) {
      const name = s.project || basename(s.cwd) || 'Projekt';
      if (!lanes.has(name)) lanes.set(name, []);
      lanes.get(name).push(s);
    }
    const html = [...lanes.entries()].sort((x, y) => Math.min(...x[1].map((s) => s.startedAt)) - Math.min(...y[1].map((s) => s.startedAt)))
      .map(([name, list]) => {
        const parts = [];
        for (const s of list) {
          const color = toolOf({ toolId: s.toolId })?.color ?? '#8a94a6';
          const a = Math.max(from, s.startedAt ?? from);
          const b = Math.min(to, s.endedAt ?? to);
          if (b > a) parts.push(`<i class="tl-bar" style="left:${pct(a)};width:${(((b - a) / span) * 100).toFixed(3)}%;--c:${color}" title="${esc(s.title || 'Session')}"></i>`);
          const events = this.cache.get(s.id)?.events ?? [];
          for (const e of events) {
            if (e.t < from || e.t > to) continue;
            const k = markerKind(e);
            if (k && k !== 'tool') parts.push(`<b class="tl-m ${k}" style="left:${pct(e.t)}"></b>`);
          }
          for (const g of bundleTools(events.filter((e) => e.t <= to), from, bucketMs)) {
            parts.push(`<b class="tl-m tool" style="left:${pct(g.t)};opacity:${Math.min(1, 0.35 + g.count * 0.15).toFixed(2)}"></b>`);
          }
        }
        return `<div class="tl-lane"><span class="tl-name" title="${esc(name)}">${esc(name)}</span><div class="tl-track">${parts.join('')}</div></div>`;
      }).join('');
    this.lanesEl.innerHTML = html || `<div class="tl-none">${this.loading ? 'lädt …' : 'Keine Sessions in diesem Zeitraum'}</div>`;

    // Achse: ~6 Markierungen
    const stepMin = TICK_STEPS.find((m) => span / (m * 60_000) <= 7) ?? TICK_STEPS[TICK_STEPS.length - 1];
    const step = stepMin * 60_000;
    const ticks = [];
    // auf volle Abstände (Ortszeit) runden
    const tz = new Date(from).getTimezoneOffset() * 60_000;
    for (let t = Math.ceil((from - tz) / step) * step + tz; t <= to; t += step) ticks.push(`<span style="left:${pct(t)}">${fmtHm(t)}</span>`);
    this.axisEl.innerHTML = ticks.join('');
    this.positionCursor();
  }
}
