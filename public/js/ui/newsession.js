// Dialog „Neue Session“: Tool, Projektordner (mit Ordnerliste und zuletzt verwendeten), Modus, Titel.
import { svgIcon } from '../config.js';
import { ICON, esc, DIAMOND } from './common.js';

const LAST_KEY = 'arena.newSession';
const load = () => { try { return JSON.parse(localStorage.getItem(LAST_KEY) || '{}'); } catch { return {}; } };
const save = (v) => { try { localStorage.setItem(LAST_KEY, JSON.stringify(v)); } catch { /* kein Speicher */ } };

export class NewSessionDialog {
  constructor(el, { store, request, onCreated, toast }) {
    this.el = el;
    this.store = store;
    this.request = request;
    this.onCreated = onCreated;
    this.toast = toast;
    const last = load();
    this.toolId = last.toolId ?? null;
    this.mode = last.mode ?? 'confirm';
    this.cwd = last.cwd ?? '';
    this.listing = null;
    this.busy = false;

    el.addEventListener('click', (e) => {
      if (e.target === el || e.target.closest('[data-close]')) { this.close(); return; }
      const tool = e.target.closest('[data-tool]');
      if (tool) {
        if (tool.getAttribute('aria-disabled') === 'true') { this.toast(`${tool.title}`, 'warn'); return; }
        this.toolId = tool.dataset.tool; this.drawTools(); return;
      }
      const mode = e.target.closest('[data-mode]');
      if (mode) { this.mode = mode.dataset.mode; this.drawMode(); return; }
      const dir = e.target.closest('[data-dir]');
      if (dir) { this.browse(dir.dataset.dir); return; }
      if (e.target.closest('[data-start]')) this.submit();
    });
    el.addEventListener('input', (e) => { if (e.target.matches('.ns-path')) this.cwd = e.target.value; });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this.close(); }
      if (e.key === 'Tab') this.trapFocus(e);
      if (e.key === 'Enter' && e.target.matches('.ns-path')) { e.preventDefault(); this.browse(e.target.value); }
      if (e.key === 'Enter' && e.target.matches('.ns-title')) { e.preventDefault(); this.submit(); }
    });
  }

  get isOpen() { return !this.el.classList.contains('hidden'); }

  open() {
    const tools = this.store.state.tools;
    const usable = (t) => t && t.installed !== false;
    if (!usable(tools.find((t) => t.id === this.toolId))) this.toolId = tools.find(usable)?.id ?? null;
    this.returnFocus = document.activeElement;
    this.el.classList.remove('hidden');
    this.build();
    this.browse(this.cwd || undefined);
    setTimeout(() => this.el.querySelector('.ns-path')?.focus(), 30);
  }

  close() {
    if (!this.isOpen) return;
    this.el.classList.add('hidden');
    // Fokus an den Auslöser zurückgeben
    try { this.returnFocus?.focus?.(); } catch { /* Element weg */ }
    this.returnFocus = null;
  }

  // Tab bleibt im Dialog
  trapFocus(e) {
    const f = [...this.el.querySelectorAll('button:not([disabled]), input')].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  toggle() { if (this.isOpen) this.close(); else this.open(); }

  async browse(start) {
    try {
      const res = await this.request('fs.pickDir', start ? { start } : {});
      this.listing = res;
      this.cwd = res.path;
      const input = this.el.querySelector('.ns-path');
      if (input) input.value = res.path;
    } catch (err) {
      this.toast(err.message, 'warn');
    }
    this.drawDirs();
  }

  async submit() {
    if (this.busy) return;
    const cwd = this.el.querySelector('.ns-path')?.value.trim() || this.cwd;
    const title = this.el.querySelector('.ns-title')?.value.trim() || null;
    if (!this.toolId) { this.toast('Kein Tool verfügbar', 'warn'); return; }
    if (!cwd) { this.toast('Bitte einen Projektordner wählen', 'warn'); return; }
    this.busy = true;
    this.drawButton();
    try {
      const res = await this.request('session.create', { toolId: this.toolId, cwd, mode: this.mode, title }, 90_000);
      save({ toolId: this.toolId, mode: this.mode, cwd });
      this.cwd = cwd;
      this.close();
      this.onCreated(res.agentId);
    } catch (err) {
      this.toast(err.message, 'error', 8000);
    } finally {
      this.busy = false;
      this.drawButton();
    }
  }

  // Gerüst einmal je Öffnen; danach nur Teile aktualisieren (Fokus und Eingaben bleiben erhalten)
  build() {
    this.el.innerHTML = `<div class="ns" role="dialog" aria-modal="true" aria-labelledby="ns-title">
      <div class="ns-head"><span id="ns-title">${svgIcon(ICON.plus)}Neue Session</span><button class="icon-btn sm" data-close title="Schließen (Esc)" aria-label="Schließen">${svgIcon(ICON.close)}</button></div>
      <div class="ns-label">Tool</div>
      <div class="ns-tools" role="radiogroup" aria-label="Tool"></div>
      <div class="ns-label">Projektordner</div>
      <div class="ns-pathrow">
        <button class="icon-btn sm ns-up" data-dir="" title="Übergeordneter Ordner" aria-label="Übergeordneter Ordner">${svgIcon(ICON.up)}</button>
        <input class="ns-path" value="${esc(this.cwd)}" spellcheck="false" placeholder="/Pfad/zum/Projekt" aria-label="Projektordner" />
      </div>
      <div class="ns-dirs"></div>
      <div class="ns-row">
        <div class="seg" role="radiogroup" aria-label="Arena-Modus">
          <button data-mode="confirm" title="Werkzeuge erst nach Bestätigung">Bestätigen</button>
          <button data-mode="auto" title="Berechtigungen automatisch erteilen">Auto</button>
        </div>
        <input class="ns-title" placeholder="Titel (optional)" maxlength="120" aria-label="Titel" />
      </div>
      <div class="ns-foot"><button class="btn primary" data-start></button></div>
    </div>`;
    this.drawTools();
    this.drawDirs();
    this.drawMode();
    this.drawButton();
  }

  drawTools() {
    const box = this.el.querySelector('.ns-tools');
    if (!box) return;
    const tools = this.store.state.tools;
    // nicht installierte Tools ausgegraut; Hinweis im Tooltip bzw. als Meldung beim Klick
    box.innerHTML = tools.length ? tools.map((t) => {
      const off = t.installed === false;
      const title = off ? `${t.name} ist nicht installiert – Befehl in den Einstellungen prüfen` : t.name;
      return `<button class="ns-tool ${t.id === this.toolId ? 'on' : ''} ${off ? 'off' : ''}" data-tool="${esc(t.id)}" role="radio" aria-checked="${t.id === this.toolId}" aria-disabled="${off}" title="${esc(title)}">
        <span class="av sm" style="--c:${esc(t.color || '#8a94a6')}">${DIAMOND}</span><span>${esc(t.name)}</span>${off ? '<em>fehlt</em>' : ''}</button>`;
    }).join('')
      : '<span class="ns-none">Keine Tools konfiguriert</span>';
    this.drawButton();
  }

  drawMode() {
    for (const b of this.el.querySelectorAll('[data-mode]')) {
      b.classList.toggle('on', b.dataset.mode === this.mode);
      b.setAttribute('aria-checked', String(b.dataset.mode === this.mode));
    }
  }

  drawDirs() {
    const box = this.el.querySelector('.ns-dirs');
    if (!box) return;
    const l = this.listing;
    const up = this.el.querySelector('.ns-up');
    up.dataset.dir = l?.parent ?? '';
    up.disabled = !l?.parent;
    const recent = (l?.recent ?? []).filter((r) => r.cwd !== l?.path).slice(0, 5);
    box.innerHTML = `
      ${recent.map((r) => `<button class="ns-dir recent" data-dir="${esc(r.cwd)}" title="${esc(r.cwd)}">${svgIcon(ICON.restart)}<span>${esc(r.name || r.cwd)}</span><em>\u200e${esc(r.cwd)}\u200e</em></button>`).join('')}
      ${(l?.entries ?? []).map((d) => `<button class="ns-dir" data-dir="${esc(d.path)}">${svgIcon(ICON.folder)}<span>${esc(d.name)}</span></button>`).join('')}
      ${l?.truncated ? '<div class="ns-none">… gekürzt</div>' : ''}
      ${l && !l.entries.length && !recent.length ? '<div class="ns-none">Keine Unterordner</div>' : ''}`;
    box.scrollTop = 0;
  }

  drawButton() {
    const b = this.el.querySelector('[data-start]');
    if (!b) return;
    b.disabled = this.busy || !this.toolId;
    b.innerHTML = this.busy ? '<span class="spin"></span>startet …' : `${svgIcon(ICON.send)}Starten`;
  }
}
