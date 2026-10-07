// Berechtigungskarten unten rechts: Titel, Werkzeugart, Details, Knöpfe aus den Optionen. Y/N per Tastatur.
import { STATIONS, agentColor, agentName, kindToCategory, svgIcon } from '../config.js';
import { ICON, esc, diffHtml } from './common.js';

const LABEL = { allow_once: 'Erlauben', allow_always: 'Immer', reject_once: 'Ablehnen', reject_always: 'Nie' };

// Leiser Doppelton (WebAudio); scheitert still ohne Nutzerinteraktion
let audio = null;
function chime() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const t0 = audio.currentTime;
    [[660, 0], [880, 0.12]].forEach(([f, dt]) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(0.05, t0 + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.22);
      o.connect(g).connect(audio.destination);
      o.start(t0 + dt);
      o.stop(t0 + dt + 0.25);
    });
  } catch { /* kein Ton möglich */ }
}

function details(p) {
  const raw = p.rawInput && typeof p.rawInput === 'object' ? p.rawInput : {};
  let html = '';
  const cmd = Array.isArray(raw.command) ? raw.command.join(' ') : raw.command;
  if (cmd) html += `<pre class="p-cmd">${esc(cmd)}</pre>`;
  if (raw.description && raw.description !== p.title) html += `<div class="p-desc">${esc(raw.description)}</div>`;
  const paths = [...new Set([...(p.locations ?? []).map((l) => l.path), raw.file_path, raw.path].filter(Boolean))];
  if (paths.length) html += `<div class="p-paths">${paths.slice(0, 4).map((x) => `<span>${svgIcon(ICON.folder)}\u200e${esc(x)}\u200e</span>`).join('')}</div>`;
  for (const c of p.content ?? []) {
    if (c.type === 'diff') html += diffHtml(c.oldText, c.newText, 12);
    else if (c.type === 'content' && c.content?.type === 'text' && !cmd) html += `<div class="p-desc">${esc(c.content.text.slice(0, 400))}</div>`;
  }
  return html;
}

export class PermissionStack {
  constructor(el, { onAnswer, onSelect }) {
    this.el = el;
    this.onAnswer = onAnswer;
    this.onSelect = onSelect;
    this.known = null; // bereits angezeigte Ids (Ton nur für neue)
    this.list = [];
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-opt]');
      if (btn) { this.answer(btn.dataset.perm, btn.dataset.opt, btn); return; }
      const who = e.target.closest('[data-agent]');
      if (who) this.onSelect(who.dataset.agent);
    });
    window.addEventListener('keydown', (e) => {
      if (!this.list.length || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.body.classList.contains('playback')) return; // Karten in der Wiedergabe ausgeblendet
      if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
      if (!document.getElementById('newsession')?.classList.contains('hidden')) return;
      const k = e.key.toLowerCase();
      if (k !== 'y' && k !== 'n') return;
      const p = this.list[0];
      const opt = p.options.find((o) => o.kind?.startsWith(k === 'y' ? 'allow' : 'reject'));
      if (!opt) return;
      e.preventDefault();
      this.answer(p.id, opt.optionId);
    });
  }

  answer(permissionId, optionId, btn) {
    const card = this.el.querySelector(`[data-card="${CSS.escape(permissionId)}"]`);
    card?.classList.add('busy');
    btn?.classList.add('on');
    Promise.resolve(this.onAnswer(permissionId, optionId)).catch(() => card?.classList.remove('busy'));
  }

  // Nur bei geänderten Ids oder Agentennamen neu zeichnen; bestehende Karten bleiben erhalten
  render(permissions, agents) {
    const list = [...permissions.values()].sort((a, b) => a.t - b.t);
    const who = (p) => agents.get(p.subAgentId ?? p.agentId) ?? agents.get(p.agentId);
    const sig = list.map((p) => { const a = who(p); return `${p.id}:${a ? agentName(a) : ''}:${a?.project ?? ''}`; }).join('|');
    this.list = list;
    if (sig === this.sig) return;
    this.sig = sig;
    if (this.known && list.some((p) => !this.known.has(p.id))) chime();
    this.known = new Set(list.map((p) => p.id));
    document.body.classList.toggle('has-perms', list.length > 0);

    this.cards ??= new Map(); // permissionId → { el, head }
    for (const [pid, c] of this.cards) if (!this.known.has(pid)) { c.el.remove(); this.cards.delete(pid); }
    list.forEach((p, i) => {
      let c = this.cards.get(p.id);
      if (!c) {
        const el = document.createElement('div');
        el.className = 'perm-card';
        el.dataset.card = p.id;
        el.setAttribute('role', 'alertdialog');
        el.setAttribute('aria-label', `Berechtigung: ${p.title}`);
        el.style.setProperty('--c', (STATIONS[kindToCategory(p.kind)] ?? STATIONS.workbench).color);
        el.innerHTML = `<div class="p-head"></div>${details(p)}<div class="p-opts"></div>`;
        c = { el };
        this.cards.set(p.id, c);
      }
      const a = who(p);
      const st = STATIONS[kindToCategory(p.kind)] ?? STATIONS.workbench;
      c.el.querySelector('.p-head').innerHTML = `
          <span class="p-ic">${svgIcon(st.icon)}</span>
          <div class="p-title"><b>${esc(p.title)}</b>
            <span data-agent="${esc(a?.id ?? p.agentId)}"><i style="--c:${a ? agentColor(a) : '#888'}"></i>${esc(a ? agentName(a) : 'Agent')}${a?.project ? ` · ${esc(a.project)}` : ''}</span>
          </div>
          <span class="p-hand" title="wartet auf dich">${svgIcon(ICON.hand)}</span>`;
      const firstAllow = p.options.find((x) => x.kind?.startsWith('allow'));
      const firstReject = p.options.find((x) => x.kind?.startsWith('reject'));
      c.el.querySelector('.p-opts').innerHTML = p.options.map((o) => {
        const key = i === 0 ? (o === firstAllow ? 'Y' : o === firstReject ? 'N' : '') : '';
        return `<button class="p-btn ${o.kind?.startsWith('allow') ? 'allow' : 'reject'}" data-perm="${esc(p.id)}" data-opt="${esc(o.optionId)}" title="${esc(o.name)}">${esc(LABEL[o.kind] ?? o.name)}${key ? `<kbd>${key}</kbd>` : ''}</button>`;
      }).join('');
      // Reihenfolge: älteste unten (column-reverse)
      if (this.el.children[i] !== c.el) this.el.insertBefore(c.el, this.el.children[i] ?? null);
    });
  }
}
