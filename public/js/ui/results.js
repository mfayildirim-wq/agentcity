// Ergebnis-Frame (v0.3): rechts neben der Chat-Leiste, zeigt die Artefakte der Session des ausgewählten Agenten –
// Liste (neueste oben) und Vorschau je Art (Webseite/HTML/PDF im iframe, Text gerendert, Bild, sonst Hinweiskarte).
// Einklappbar (Chevron), Zustand in localStorage. Öffnen des Frames markiert die Artefakte der Session als gesehen.
import { fmtAgo, svgIcon } from '../config.js';
import { ICON, KIND_ICON, KIND_LABEL, SOURCE_LABEL, esc, renderMarkdown, fmtBytes } from './common.js';

const STATE_KEY = 'agentcity.results';
const LOAD_TIMEOUT_MS = 4000;
const MIN_HEIGHT = 240;

// iframe-Sandbox: eigene Dateien ohne allow-same-origin (kein Zugriff auf Cookie/WS), fremde/localhost-Seiten mit
export const sandboxFor = (a) => (a.kind === 'web' ? 'allow-scripts allow-forms allow-same-origin allow-popups' : 'allow-scripts allow-forms');
export const frameSrc = (a) => a.previewUrl ?? a.url ?? null;
const isMarkdown = (a) => /\.(md|markdown)$/i.test(a.title ?? a.path ?? '');

export class ResultsFrame {
  // wrap: die Chat-Leiste (#chat); der Frame hängt sich rechts daneben.
  constructor(wrap, { store, onOpen, onSeen = () => {}, toast = () => {}, toggleEl = null }) {
    this.store = store;
    this.onOpen = onOpen;
    this.onSeen = onSeen;
    this.toast = toast;
    this.toggleEl = toggleEl; // Knopf in der Chat-Kopfzeile (Zähler)
    this.sessionId = null;
    this.pick = null; // vom Nutzer gewählte Artefakt-Id (null = neuestes)
    this.shownKey = null; // Vorschau-Signatur (Id + updatedAt)
    this.collapsed = (localStorage.getItem(STATE_KEY) ?? 'open') === 'closed';
    this.textCache = new Map(); // previewUrl → { key, text }

    const el = document.createElement('div');
    el.className = 'results';
    el.innerHTML = `
      <button class="r-strip" title="Ergebnisse einblenden">${svgIcon(ICON.chevLeft)}${svgIcon(ICON.results)}<i class="r-dot"></i><b></b></button>
      <div class="r-body">
        <div class="r-head">
          ${svgIcon(ICON.results)}<span class="r-title">Ergebnisse</span><b class="r-n"></b>
          <button class="icon-btn sm r-collapse" title="Ergebnisse ausblenden">${svgIcon(ICON.chevRight)}</button>
        </div>
        <div class="r-list"></div>
        <div class="r-phead">
          <span class="r-pk"></span><span class="r-ptitle"></span>
          <button class="icon-btn sm" data-act="open" title="Öffnen (Finder bzw. Browser)">${svgIcon(ICON.folder)}</button>
          <button class="icon-btn sm" data-act="copy" title="Link kopieren">${svgIcon(ICON.link)}</button>
          <button class="icon-btn sm" data-act="tab" title="In neuem Tab öffnen">${svgIcon(ICON.external)}</button>
          <button class="icon-btn sm" data-act="reload" title="Neu laden">${svgIcon(ICON.restart)}</button>
        </div>
        <div class="r-view"></div>
      </div>`;
    wrap.appendChild(el);
    this.el = el;
    this.chatEl = wrap.querySelector('.chat');
    this.listEl = el.querySelector('.r-list');
    this.viewEl = el.querySelector('.r-view');
    this.nEl = el.querySelector('.r-n');
    this.stripN = el.querySelector('.r-strip b');
    this.pheadEl = el.querySelector('.r-phead');
    this.ptitleEl = el.querySelector('.r-ptitle');
    this.pkEl = el.querySelector('.r-pk');

    el.querySelector('.r-strip').addEventListener('click', () => this.setCollapsed(false));
    el.querySelector('.r-collapse').addEventListener('click', () => this.setCollapsed(true));
    this.listEl.addEventListener('click', (e) => {
      const row = e.target.closest('[data-id]');
      if (!row) return;
      this.pick = row.dataset.id;
      this.draw();
    });
    this.pheadEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b) this.action(b.dataset.act);
    });
    this.viewEl.addEventListener('click', (e) => { if (e.target.closest('[data-card="open"]')) this.action('open'); });
    toggleEl?.addEventListener('click', () => this.toggle());
    // gleiche Höhe wie die Chat-Leiste
    if (typeof ResizeObserver === 'function' && this.chatEl) {
      new ResizeObserver(() => this.fitHeight()).observe(this.chatEl);
    }
    this.applyCollapsed();
  }

  get artifacts() { return this.sessionId ? this.store.artifactsOf(this.sessionId) : []; }
  get current() {
    const list = this.artifacts;
    return (this.pick && list.find((a) => a.id === this.pick)) || list[0] || null;
  }

  toggle() { this.setCollapsed(!this.collapsed); }

  setCollapsed(v) {
    if (this.collapsed === v) return;
    this.collapsed = v;
    try { localStorage.setItem(STATE_KEY, v ? 'closed' : 'open'); } catch { /* kein Speicher */ }
    this.applyCollapsed();
    this.draw();
  }

  applyCollapsed() {
    this.el.classList.toggle('collapsed', this.collapsed);
    this.toggleEl?.classList.toggle('on', !this.collapsed);
    this.fitHeight();
  }

  fitHeight() {
    if (this.collapsed || !this.chatEl) { this.el.style.height = ''; return; }
    const h = this.chatEl.offsetHeight;
    this.el.style.height = h ? `${Math.max(h, MIN_HEIGHT)}px` : '';
  }

  // sessionId: Session des in der Chat-Leiste gezeigten Agenten (null = Frame aus)
  render(sessionId, changes) {
    const switched = sessionId !== this.sessionId;
    this.sessionId = sessionId;
    if (switched) { this.pick = null; this.shownKey = null; }
    this.el.classList.toggle('hidden', !sessionId);
    if (!sessionId) return;
    if (switched || changes.has('artifacts') || changes.has('selected')) this.draw();
    if (switched) this.fitHeight();
  }

  draw() {
    const list = this.artifacts;
    const unseen = list.filter((a) => !a.seen).length;
    const n = list.length;
    this.nEl.textContent = n ? String(n) : '';
    this.stripN.textContent = n ? String(n) : '';
    this.el.classList.toggle('unseen', unseen > 0);
    if (this.toggleEl) {
      this.toggleEl.querySelector('b').textContent = n ? String(n) : '';
      this.toggleEl.classList.toggle('unseen', unseen > 0);
      this.toggleEl.title = n ? `Ergebnisse: ${n}${unseen ? ` (${unseen} neu)` : ''}` : 'Ergebnisse';
    }
    if (this.collapsed) return;
    const now = this.store.now();
    const cur = this.current;
    const sig = list.map((a) => `${a.id}:${a.updatedAt}:${a.seen ? 1 : 0}:${a.ended ? 1 : 0}`).join('|') + `#${cur?.id}`;
    if (sig !== this.listSig) {
      this.listSig = sig;
      this.listEl.innerHTML = list.length ? list.map((a) => `
        <button class="r-row ${a.id === cur?.id ? 'on' : ''} ${a.seen ? '' : 'new'}" data-id="${esc(a.id)}"
          title="${esc(KIND_LABEL[a.kind] ?? a.kind)} · ${esc(SOURCE_LABEL[a.source] ?? a.source)}${a.path ? `\n${esc(a.path)}` : a.url ? `\n${esc(a.url)}` : ''}">
          ${svgIcon(ICON[KIND_ICON[a.kind]] ?? ICON.file)}<span>${esc(a.title ?? a.url ?? a.path ?? '?')}</span>
          ${a.ended ? '<em>beendet</em>' : ''}<time>${esc(fmtAgo(a.updatedAt ?? a.t, now))}</time><i></i>
        </button>`).join('') : '<div class="r-empty">Noch keine Ergebnisse – Dateien, Webseiten und Links des Agenten erscheinen hier.</div>';
    }
    this.pheadEl.classList.toggle('hidden', !cur);
    if (cur) {
      this.ptitleEl.textContent = cur.title ?? cur.url ?? '';
      this.ptitleEl.title = cur.path ?? cur.url ?? '';
      this.pkEl.textContent = KIND_LABEL[cur.kind] ?? cur.kind;
      this.pheadEl.querySelector('[data-act="tab"]').classList.toggle('hidden', !frameSrc(cur));
      this.pheadEl.querySelector('[data-act="copy"]').classList.toggle('hidden', !frameSrc(cur) && !cur.path);
      this.pheadEl.querySelector('[data-act="reload"]').classList.toggle('hidden', !frameSrc(cur) && !cur.content);
    }
    const key = cur ? `${cur.id}:${cur.updatedAt}` : null;
    if (key !== this.shownKey) { this.shownKey = key; this.showPreview(cur); }
    // sichtbarer, aufgeklappter Frame: Artefakte gelten als gesehen
    if (unseen && !this.el.classList.contains('hidden') && !document.hidden) {
      const sid = this.sessionId;
      this.store.markArtifactsSeen(sid);
      this.onSeen(sid);
    }
  }

  // ------------------------------------------------------------ Vorschau
  showPreview(a) {
    clearTimeout(this.loadTimer);
    const v = this.viewEl;
    if (!a) { v.innerHTML = ''; return; }
    if (a.content != null && a.kind === 'text') { v.innerHTML = this.textHtml(a, a.content); return; }
    const src = frameSrc(a);
    if (a.kind === 'web' || a.kind === 'html' || a.kind === 'pdf') {
      if (!src) { v.innerHTML = this.cardHtml(a); return; }
      // localhost-Seiten vorab anfragen: nicht erreichbar (Server beendet) → Karte statt Browser-Fehlerseite
      if (a.kind === 'web' && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(src) && !a.probed) {
        v.innerHTML = '<div class="r-empty">prüft …</div>';
        fetch(src, { mode: 'no-cors', cache: 'no-store', credentials: 'omit' }).then(
          () => { if (this.current?.id === a.id) this.showPreview({ ...a, probed: true }); },
          () => { if (this.current?.id === a.id) v.innerHTML = this.cardHtml(a, 'Die Seite ist zurzeit nicht erreichbar.', true); },
        );
        return;
      }
      const f = document.createElement('iframe');
      f.className = 'r-frame';
      if (a.kind !== 'pdf') f.setAttribute('sandbox', sandboxFor(a));
      f.setAttribute('referrerpolicy', 'no-referrer');
      f.title = a.title ?? 'Vorschau';
      let loaded = false;
      f.addEventListener('load', () => { loaded = true; clearTimeout(this.loadTimer); });
      f.addEventListener('error', () => this.loadFailed(a));
      v.innerHTML = '';
      v.appendChild(f);
      f.src = src;
      // keine load-Meldung nach 4 s (z. B. X-Frame-Options der Zielseite) → Karte „im neuen Tab öffnen“
      this.loadTimer = setTimeout(() => { if (!loaded && this.current?.id === a.id) this.loadFailed(a); }, LOAD_TIMEOUT_MS);
      return;
    }
    if (a.kind === 'image' && src) { v.innerHTML = `<div class="r-img"><img src="${esc(src)}" alt="${esc(a.title ?? '')}"></div>`; return; }
    if (a.kind === 'text' && src) {
      const cached = this.textCache.get(src);
      if (cached?.key === a.updatedAt) { v.innerHTML = this.textHtml(a, cached.text); return; }
      v.innerHTML = '<div class="r-empty">lädt …</div>';
      fetch(src, { credentials: 'same-origin', cache: 'no-store' }).then(async (r) => {
        if (!r.ok) throw new Error(r.status === 413 ? 'Datei zu groß für die Vorschau' : `Vorschau nicht verfügbar (${r.status})`);
        return r.text();
      }).then((text) => {
        this.textCache.set(src, { key: a.updatedAt, text });
        if (this.textCache.size > 30) this.textCache.delete(this.textCache.keys().next().value);
        if (this.current?.id === a.id) v.innerHTML = this.textHtml(a, text);
      }).catch((err) => { if (this.current?.id === a.id) v.innerHTML = this.cardHtml(a, err.message); });
      return;
    }
    v.innerHTML = this.cardHtml(a);
  }

  loadFailed(a) {
    if (this.current?.id !== a.id) return;
    this.viewEl.innerHTML = this.cardHtml(a, 'Die Seite lässt sich hier nicht einbetten.', true);
  }

  textHtml(a, text) {
    if (isMarkdown(a)) return `<div class="r-md">${renderMarkdown(text)}</div>`;
    return `<pre class="r-code">${esc(text)}</pre>`;
  }

  // Hinweiskarte: Name, Art, Größe, Pfad/URL; optional Fehlertext und „im neuen Tab öffnen“
  cardHtml(a, note = null, tab = false) {
    const src = frameSrc(a);
    return `<div class="r-card">
      ${svgIcon(ICON[KIND_ICON[a.kind]] ?? ICON.file)}
      <b>${esc(a.title ?? a.url ?? '')}</b>
      <span>${esc(KIND_LABEL[a.kind] ?? a.kind)}${a.size != null ? ` · ${esc(fmtBytes(a.size))}` : ''}${a.ended ? ' · beendet' : ''}</span>
      ${a.path ? `<code>${esc(a.path)}</code>` : a.url ? `<code>${esc(a.url)}</code>` : ''}
      ${note ? `<em>${esc(note)}</em>` : ''}
      <div class="r-card-act">
        ${tab && src ? `<a class="btn sm" href="${esc(src)}" target="_blank" rel="noopener noreferrer">${svgIcon(ICON.external)}im neuen Tab öffnen</a>` : ''}
        <button class="btn sm ghost" data-card="open">${svgIcon(ICON.folder)}Öffnen</button>
      </div>
    </div>`;
  }

  action(kind) {
    const a = this.current;
    if (!a) return;
    const src = frameSrc(a);
    if (kind === 'open') { Promise.resolve(this.onOpen(a.id)).catch(() => {}); return; }
    if (kind === 'tab' && src) { window.open(src, '_blank', 'noopener'); return; }
    if (kind === 'copy') {
      const link = a.url ?? (src ? new URL(src, location.href).href : a.path);
      navigator.clipboard?.writeText(link).then(() => this.toast('Link kopiert', 'info'), () => this.toast('Kopieren nicht möglich', 'warn'));
      return;
    }
    if (kind === 'reload') {
      if (src) this.textCache.delete(src);
      this.shownKey = null;
      this.draw();
    }
  }
}
