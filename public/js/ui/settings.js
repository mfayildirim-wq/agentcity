// Panel „Agenten-Tools“: Tabelle aller Tools (Standard + eigene), Bearbeiten/Neu, Testen inline, Speichern/Löschen.
import { svgIcon, AVATAR_STYLES } from '../config.js';
import { ICON, esc } from './common.js';

const STYLE_NAMES = { gem: 'Raute', cap: 'Mütze', hoodie: 'Kapuze', scarf: 'Schal', visor: 'Visier' };
const TEST_TIMEOUT = 25_000;

// Argumente als eine Zeile: Leerzeichen trennen; "…" mit JSON-Escapes (\" \\), '…' wörtlich
export function parseArgs(line) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(line ?? '')))) {
    if (m[1] !== undefined) {
      try { out.push(JSON.parse(`"${m[1]}"`)); } catch { out.push(m[1]); }
    } else out.push(m[2] ?? m[3]);
  }
  return out;
}
// Rundlauf mit parseArgs: einfache Argumente bleiben roh, alles mit Leerzeichen/Anführungszeichen als JSON-String
export const formatArgs = (args = []) => args.map((a) => (a === '' || /[\s"'\\]/.test(a) ? JSON.stringify(a) : a)).join(' ');
const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(c ?? '') ? c : '#8a94a6');

// KEY=VAL je Zeile; leere Zeilen und #-Kommentare ignorieren
export function parseEnv(text) {
  const env = {};
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) throw new Error(`Umgebung: „${line}“ ist kein KEY=VAL`);
    env[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return env;
}
const formatEnv = (env = {}) => Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');

export class SettingsPanel {
  constructor(el, { request, toast }) {
    this.el = el;
    this.request = request;
    this.toast = toast;
    this.agents = [];
    this.editing = null; // id oder '' (neu)
    this.results = new Map(); // id → { busy } | Ergebnis von settings.agents.test
    this.loading = false;

    el.addEventListener('click', (e) => {
      if (e.target === el || e.target.closest('[data-close]')) { this.close(); return; }
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      const id = b.closest('[data-id]')?.dataset.id ?? null;
      this.act(b.dataset.act, id);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (this.editing !== null) { this.editing = null; this.draw(); } else this.close();
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && this.editing !== null) { e.preventDefault(); this.act('save', this.editing || null); }
    });
    el.addEventListener('input', (e) => {
      // Farbe: Wähler und Textfeld synchron halten
      if (e.target.name === 'colorPick') this.el.querySelector('[name=color]').value = e.target.value;
      if (e.target.name === 'color' && /^#[0-9a-f]{6}$/i.test(e.target.value)) this.el.querySelector('[name=colorPick]').value = e.target.value;
    });
  }

  get isOpen() { return !this.el.classList.contains('hidden'); }
  toggle() { if (this.isOpen) this.close(); else this.open(); }

  async open() {
    this.returnFocus = document.activeElement;
    this.el.classList.remove('hidden');
    this.editing = null;
    this.draw();
    await this.load();
    this.el.querySelector('.st [data-close]')?.focus();
  }

  close() {
    if (!this.isOpen) return;
    this.el.classList.add('hidden');
    try { this.returnFocus?.focus?.(); } catch { /* Element weg */ }
  }

  async load() {
    this.loading = true;
    try {
      this.agents = (await this.request('settings.agents.list', {})).agents ?? [];
    } catch (err) {
      this.toast(err.message, 'error');
    } finally {
      this.loading = false;
      this.draw();
    }
  }

  find(id) { return this.agents.find((a) => a.id === id) ?? null; }

  // Formular → Eintrag (wirft bei unlesbaren Feldern)
  readForm() {
    const f = this.el.querySelector('.st-form');
    const v = (n) => f.querySelector(`[name=${n}]`)?.value ?? '';
    const cur = this.editing ? this.find(this.editing) : null;
    return {
      id: v('id').trim(), name: v('name').trim(), command: v('command').trim(), args: parseArgs(v('args')),
      env: parseEnv(v('env')), color: v('color').trim(), avatarStyle: v('avatarStyle') || null, disabled: cur?.disabled ?? false,
    };
  }

  async act(kind, id) {
    try {
      if (kind === 'new') { this.editing = ''; this.draw(); this.focusForm(); return; }
      if (kind === 'edit') { this.editing = this.editing === id ? null : id; this.draw(); this.focusForm(); return; }
      if (kind === 'cancel') { this.editing = null; this.draw(); return; }
      if (kind === 'toggle') {
        const a = this.find(id);
        // Standard-Tool: nur den Schalter senden (Server speichert nur Abweichungen)
        await this.save(a.builtin ? { id: a.id, disabled: !a.disabled } : { ...a, disabled: !a.disabled }, false);
        return;
      }
      if (kind === 'test') {
        const key = id ?? '';
        const agent = this.editing !== null && (this.editing || '') === key ? this.readForm() : this.find(id);
        this.results.set(key, { busy: true });
        this.draw();
        try {
          const res = await this.request('settings.agents.test', { agent }, TEST_TIMEOUT);
          this.results.set(key, res);
        } catch (err) {
          this.results.set(key, { ok: false, error: err.message });
        }
        this.draw();
        return;
      }
      if (kind === 'save') { await this.save(this.readForm(), true, this.editing === ''); return; }
      if (kind === 'delete') {
        const a = this.find(id);
        if (this.confirmDelete !== id) {
          this.confirmDelete = id;
          this.draw();
          setTimeout(() => { if (this.confirmDelete === id) { this.confirmDelete = null; this.draw(); } }, 3000);
          return;
        }
        this.confirmDelete = null;
        this.agents = (await this.request('settings.agents.delete', { toolId: id })).agents ?? this.agents;
        this.editing = null;
        this.results.delete(id);
        this.toast(a?.builtin ? `${a.name} zurückgesetzt und deaktiviert` : `${a?.name ?? id} gelöscht`, 'info');
        this.draw();
      }
    } catch (err) {
      this.toast(err.message, 'error', 7000);
    }
  }

  async save(agent, closeForm, isNew = false) {
    const res = await this.request('settings.agents.save', { agent, isNew });
    this.agents = res.agents ?? this.agents;
    if (closeForm) this.editing = null;
    this.draw();
  }

  focusForm() {
    setTimeout(() => this.el.querySelector('.st-form [name=' + (this.editing ? 'name' : 'id') + ']')?.focus(), 20);
  }

  draw() {
    // Eingaben im offenen Formular über das Neuzeichnen retten
    const f = this.el.querySelector('.st-form');
    const kept = f && f.dataset.id === (this.editing ?? '\0')
      ? [...f.querySelectorAll('[name]')].map((x) => [x.name, x.value]) : null;
    const act = document.activeElement;
    const focused = act?.closest?.('.st-form') ? { name: act.name, start: act.selectionStart, end: act.selectionEnd } : null;
    this.render();
    if (kept) {
      const nf = this.el.querySelector('.st-form');
      for (const [n, val] of kept) { const x = nf?.querySelector(`[name="${n}"]`); if (x) x.value = val; }
      const x = focused && nf?.querySelector(`[name="${focused.name}"]`);
      if (x) {
        x.focus();
        try { if (focused.start != null) x.setSelectionRange(focused.start, focused.end); } catch { /* Feld ohne Auswahl */ }
      }
    }
  }

  render() {
    const rows = this.agents.map((a) => this.row(a)).join('');
    this.el.innerHTML = `<div class="st" role="dialog" aria-modal="true" aria-labelledby="st-title">
      <div class="ns-head"><span id="st-title">${svgIcon(ICON.gear)}Agenten-Tools</span>
        <span class="st-acts">
          <button class="icon-btn sm" data-act="new" title="Neues Tool" aria-label="Neues Tool">${svgIcon(ICON.plus)}</button>
          <button class="icon-btn sm" data-close title="Schließen (Esc)" aria-label="Schließen">${svgIcon(ICON.close)}</button>
        </span>
      </div>
      ${this.editing === '' ? `<div class="st-new" data-id="">${this.form(null)}${this.result('')}</div>` : ''}
      <div class="st-table" role="table">
        <div class="st-row st-th" role="row"><span></span><span>Name</span><span>Befehl</span><span title="installiert">inst.</span><span>aktiv</span><span></span></div>
        ${rows || `<div class="ns-none">${this.loading ? 'lädt …' : 'Keine Tools'}</div>`}
      </div>
      <div class="st-foot">Eigene Einträge: <code>~/.agentcity/agents.json</code> · Standard-Tools lassen sich ändern und deaktivieren</div>
    </div>`;
  }

  row(a) {
    const open = this.editing === a.id;
    const cmd = [a.command, formatArgs(a.args)].filter(Boolean).join(' ');
    return `<div class="st-item ${a.disabled ? 'disabled' : ''} ${open ? 'open' : ''}" data-id="${esc(a.id)}">
      <div class="st-row" role="row">
        <span class="st-dot" style="--c:${safeColor(a.color)}"></span>
        <span class="st-name" title="${esc(a.id)}">${esc(a.name || a.id)}${a.invalid ? `<em class="bad" title="${esc(a.invalid)}">ungültig</em>` : a.modified ? '<em>geändert</em>' : !a.builtin ? '<em>eigen</em>' : ''}</span>
        <code class="st-cmd" title="${esc(cmd)}">‎${esc(cmd)}‎</code>
        <span class="st-inst ${a.installed ? 'yes' : 'no'}" title="${a.installed ? 'installiert' : 'Befehl nicht gefunden'}">${svgIcon(a.installed ? ICON.check : ICON.x)}</span>
        <button class="st-switch ${a.disabled ? '' : 'on'}" data-act="toggle" role="switch" aria-checked="${!a.disabled}" title="${a.disabled ? 'aktivieren' : 'deaktivieren'}"><i></i></button>
        <span class="st-btns">
          <button class="icon-btn sm" data-act="test" title="Testen (initialize)" aria-label="Testen">${svgIcon(ICON.test)}</button>
          <button class="icon-btn sm ${open ? 'on' : ''}" data-act="edit" title="Bearbeiten" aria-label="Bearbeiten">${svgIcon(ICON.edit)}</button>
        </span>
      </div>
      ${this.result(a.id)}
      ${open ? this.form(a) : ''}
    </div>`;
  }

  result(key) {
    const r = this.results.get(key);
    if (!r) return '';
    if (r.busy) return '<div class="st-res"><span class="spin"></span>startet und fragt initialize ab …</div>';
    if (r.ok) {
      const i = r.info ?? {};
      const who = [i.agentInfo?.title || i.agentInfo?.name, i.agentInfo?.version].filter(Boolean).join(' ');
      const caps = [i.agentCapabilities?.loadSession ? 'Sessions laden' : null, i.authMethods?.length ? `Anmeldung: ${i.authMethods.map((m) => m.name || m.id).join(', ')}` : null].filter(Boolean);
      return `<div class="st-res ok">${svgIcon(ICON.check)}<span><b>ok</b>${who ? ` · ${esc(who)}` : ''}${i.protocolVersion != null ? ` · ACP v${esc(i.protocolVersion)}` : ''}${caps.length ? ` · ${esc(caps.join(' · '))}` : ''}</span></div>`;
    }
    return `<div class="st-res err">${svgIcon(ICON.x)}<span>${esc(r.error || 'Fehler')}</span>${r.stderrTail ? `<pre>${esc(r.stderrTail)}</pre>` : ''}</div>`;
  }

  form(a) {
    const isNew = !a;
    const v = a ?? { id: '', name: '', command: '', args: [], env: {}, color: '#8a94a6', avatarStyle: 'gem' };
    const del = a && (a.builtin ? (a.modified || !a.disabled) : true);
    const confirm = a && this.confirmDelete === a.id;
    return `<div class="st-form" data-id="${esc(a?.id ?? '')}">
      <label><span>id</span><input name="id" value="${esc(v.id)}" ${isNew ? '' : 'readonly'} placeholder="mein-tool" spellcheck="false" autocomplete="off" /></label>
      <label><span>Name</span><input name="name" value="${esc(v.name)}" placeholder="Mein Tool" maxlength="60" /></label>
      <label class="wide"><span>Befehl</span><input name="command" class="mono" value="${esc(v.command)}" placeholder="node oder mein-tool" spellcheck="false" /></label>
      <label class="wide"><span>Argumente</span><input name="args" class="mono" value="${esc(formatArgs(v.args))}" placeholder="acp --flag &quot;mit Leerzeichen&quot;" spellcheck="false" /></label>
      <label class="wide"><span>Umgebung</span><textarea name="env" class="mono" rows="2" placeholder="KEY=VAL je Zeile" spellcheck="false">${esc(formatEnv(v.env))}</textarea></label>
      <label><span>Farbe</span><span class="st-color"><input type="color" name="colorPick" value="${safeColor(v.color)}" /><input name="color" class="mono" value="${esc(v.color)}" maxlength="7" spellcheck="false" /></span></label>
      <label><span>Figur</span><select name="avatarStyle">${AVATAR_STYLES.map((s) => `<option value="${s}" ${s === (v.avatarStyle ?? 'gem') ? 'selected' : ''}>${STYLE_NAMES[s]}</option>`).join('')}</select></label>
      <div class="st-form-act wide">
        <button class="btn sm ghost" data-act="test" title="Mit diesen Werten testen">${svgIcon(ICON.test)}Testen</button>
        ${del ? `<button class="btn sm ghost ${confirm ? 'danger' : ''}" data-act="delete" title="${a.builtin ? 'Änderungen verwerfen und deaktivieren' : 'Eintrag löschen'}">${svgIcon(ICON.trash)}${confirm ? 'Sicher?' : a.builtin ? 'Zurücksetzen' : 'Löschen'}</button>` : ''}
        <span class="sp"></span>
        <button class="btn sm ghost" data-act="cancel">Abbrechen</button>
        <button class="btn sm primary" data-act="save" title="Speichern (⌘↵)">${svgIcon(ICON.check)}Speichern</button>
      </div>
    </div>`;
  }
}
