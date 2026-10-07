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
      if (tool) { this.toolId = tool.dataset.tool; this.draw(); return; }
      const mode = e.target.closest('[data-mode]');
      if (mode) { this.mode = mode.dataset.mode; this.draw(); return; }
      const dir = e.target.closest('[data-dir]');
      if (dir) { this.browse(dir.dataset.dir); return; }
      if (e.target.closest('[data-start]')) this.submit();
    });
    el.addEventListener('input', (e) => { if (e.target.matches('.ns-path')) this.cwd = e.target.value; });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this.close(); }
      if (e.key === 'Enter' && e.target.matches('.ns-path')) { e.preventDefault(); this.browse(e.target.value); }
      if (e.key === 'Enter' && e.target.matches('.ns-title')) { e.preventDefault(); this.submit(); }
    });
  }

  get isOpen() { return !this.el.classList.contains('hidden'); }

  open() {
    const tools = this.store.state.tools;
    if (!tools.some((t) => t.id === this.toolId)) this.toolId = tools[0]?.id ?? null;
    this.el.classList.remove('hidden');
    this.draw();
    this.browse(this.cwd || undefined);
    setTimeout(() => this.el.querySelector('.ns-path')?.focus(), 30);
  }

  close() { this.el.classList.add('hidden'); }
  toggle() { if (this.isOpen) this.close(); else this.open(); }

  async browse(start) {
    try {
      const res = await this.request('fs.pickDir', start ? { start } : {});
      this.listing = res;
      this.cwd = res.path;
    } catch (err) {
      this.toast(err.message, 'warn');
    }
    this.draw();
  }

  async submit() {
    if (this.busy) return;
    const cwd = this.el.querySelector('.ns-path')?.value.trim() || this.cwd;
    const title = this.el.querySelector('.ns-title')?.value.trim() || null;
    if (!this.toolId) { this.toast('Kein Tool verfügbar', 'warn'); return; }
    if (!cwd) { this.toast('Bitte einen Projektordner wählen', 'warn'); return; }
    this.busy = true;
    this.draw();
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
      this.draw();
    }
  }

  draw() {
    if (!this.isOpen) return;
    const tools = this.store.state.tools;
    const l = this.listing;
    const title = this.el.querySelector('.ns-title')?.value ?? '';
    const recent = (l?.recent ?? []).filter((r) => r.cwd !== l?.path).slice(0, 5);
    this.el.innerHTML = `<div class="ns" role="dialog" aria-label="Neue Session">
      <div class="ns-head"><span>${svgIcon(ICON.plus)}Neue Session</span><button class="icon-btn sm" data-close title="Schließen (Esc)">${svgIcon(ICON.close)}</button></div>
      <div class="ns-label">Tool</div>
      <div class="ns-tools">${tools.length ? tools.map((t) => `<button class="ns-tool ${t.id === this.toolId ? 'on' : ''}" data-tool="${esc(t.id)}" title="${esc(t.name)}">
          <span class="av sm" style="--c:${esc(t.color || '#8a94a6')}">${DIAMOND}</span><span>${esc(t.name)}</span></button>`).join('')
        : '<span class="ns-none">Keine Tools konfiguriert</span>'}</div>
      <div class="ns-label">Projektordner</div>
      <div class="ns-pathrow">
        <button class="icon-btn sm" data-dir="${esc(l?.parent ?? '')}" ${l?.parent ? '' : 'disabled'} title="Übergeordneter Ordner">${svgIcon(ICON.up)}</button>
        <input class="ns-path" value="${esc(this.cwd)}" spellcheck="false" placeholder="/Pfad/zum/Projekt" />
      </div>
      <div class="ns-dirs">
        ${recent.map((r) => `<button class="ns-dir recent" data-dir="${esc(r.cwd)}" title="${esc(r.cwd)}">${svgIcon(ICON.restart)}<span>${esc(r.name || r.cwd)}</span><em>\u200e${esc(r.cwd)}\u200e</em></button>`).join('')}
        ${(l?.entries ?? []).map((d) => `<button class="ns-dir" data-dir="${esc(d.path)}">${svgIcon(ICON.folder)}<span>${esc(d.name)}</span></button>`).join('')}
        ${l && !l.entries.length && !recent.length ? '<div class="ns-none">Keine Unterordner</div>' : ''}
      </div>
      <div class="ns-row">
        <div class="seg">
          <button data-mode="confirm" class="${this.mode === 'confirm' ? 'on' : ''}" title="Werkzeuge erst nach Bestätigung">Bestätigen</button>
          <button data-mode="auto" class="${this.mode === 'auto' ? 'on' : ''}" title="Berechtigungen automatisch erteilen">Auto</button>
        </div>
        <input class="ns-title" placeholder="Titel (optional)" value="${esc(title)}" maxlength="120" />
      </div>
      <div class="ns-foot">
        <button class="btn primary" data-start ${this.busy || !this.toolId ? 'disabled' : ''}>${this.busy ? '<span class="spin"></span>startet …' : `${svgIcon(ICON.send)}Starten`}</button>
      </div>
    </div>`;
  }
}
