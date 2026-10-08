// Chat-Leiste unten: Verlauf (gestreamt) und Eingabe für den ausgewählten steuerbaren Agenten.
import { STATIONS, agentColor, agentName, isBusy, svgIcon } from '../config.js';
import { ICON, esc, renderText, fmtTime, DIAMOND } from './common.js';

const HISTORY_KEY = 'agentcity.chatHistory';
const MAX_HISTORY = 50;

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]').slice(-MAX_HISTORY); } catch { return []; }
}
function saveHistory(h) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(-MAX_HISTORY))); } catch { /* kein Speicher */ }
}

export class ChatBar {
  constructor(el, { store, onSend, onCancel, onMode, onCityMode, onDeselect, shell = null }) {
    this.el = el;
    this.store = store;
    this.onSend = onSend;
    this.onCancel = onCancel;
    this.onMode = onMode;
    this.onCityMode = onCityMode;
    this.onDeselect = onDeselect;
    this.agentId = null;
    this.history = loadHistory();
    this.hIndex = -1;
    this.draft = '';
    this.openThoughts = new Set();
    this.collapsed = false;
    this.shell = shell; // ShellView (Nutzer-Terminal) oder null
    this.view = 'chat'; // chat | term

    el.innerHTML = `<div class="chat">
      <div class="c-head">
        <span class="av sm"></span><span class="c-name"></span>
        <div class="seg mini c-city" title="City-Modus: Rückfragen bestätigen oder automatisch freigeben">
          <button data-city="confirm">Bestätigen</button><button data-city="auto">Auto</button>
        </div>
        <select class="c-mode" title="Modus des Tools"></select>
        ${shell ? `<div class="seg mini icons c-view" title="Chat ⇄ Terminal">
          <button data-view="chat" class="on" title="Chat">${svgIcon(ICON.prompt)}</button><button data-view="term" title="Terminal (Shell im Projektordner)">${svgIcon(ICON.terminal)}</button>
        </div>
        <button class="icon-btn sm c-kill" title="Shell beenden">${svgIcon(ICON.close)}</button>` : ''}
        <button class="icon-btn sm c-results" title="Ergebnisse">${svgIcon(ICON.results)}<b></b></button>
        <button class="icon-btn sm c-toggle" title="Verlauf ein/aus">${svgIcon(ICON.chevDown)}</button>
      </div>
      <div class="c-log"></div>
      <div class="c-term"></div>
      <div class="c-input">
        <textarea rows="1" spellcheck="false"></textarea>
        <button class="icon-btn c-send" title="Senden (Enter)">${svgIcon(ICON.send)}</button>
      </div>
    </div>`;
    this.chat = el.querySelector('.chat');
    this.log = el.querySelector('.c-log');
    this.input = el.querySelector('textarea');
    this.sendBtn = el.querySelector('.c-send');
    this.modeSel = el.querySelector('.c-mode');
    this.nameEl = el.querySelector('.c-name');
    this.avEl = el.querySelector('.av');
    this.termEl = el.querySelector('.c-term');
    this.resultsBtn = el.querySelector('.c-results'); // Umschalter für den Ergebnis-Frame (ui/results.js)
    el.querySelector('.c-kill')?.addEventListener('click', () => this.shell?.close());
    el.querySelector('.c-view')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-view]');
      if (b) this.setView(b.dataset.view);
    });

    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('input', () => this.autosize());
    this.sendBtn.addEventListener('click', () => (this.busy ? this.onCancel(this.agentId) : this.send()));
    el.querySelector('.c-city').addEventListener('click', (e) => {
      const b = e.target.closest('[data-city]');
      if (b && this.agent?.cityMode !== b.dataset.city) this.onCityMode(this.agentId, b.dataset.city);
    });
    this.modeSel.addEventListener('change', () => this.onMode(this.agentId, this.modeSel.value));
    el.querySelector('.c-toggle').addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.chat.classList.toggle('collapsed', this.collapsed);
      if (!this.collapsed) { this.scrollDown(true); if (this.view === 'term') this.shell?.focusSoon(); }
    });
    this.log.addEventListener('toggle', (e) => {
      const d = e.target.closest?.('[data-thought]');
      if (!d) return;
      if (d.open) this.openThoughts.add(d.dataset.thought); else this.openThoughts.delete(d.dataset.thought);
    }, true);
  }

  get agent() { return this.agentId ? this.store.state.agents.get(this.agentId) : null; }

  // Umschalter Chat ⇄ Terminal
  setView(view) {
    if (!this.shell) return;
    this.view = view === 'term' ? 'term' : 'chat';
    this.chat.classList.toggle('term-mode', this.view === 'term');
    for (const b of this.el.querySelectorAll('[data-view]')) b.classList.toggle('on', b.dataset.view === this.view);
    if (this.collapsed) { this.collapsed = false; this.chat.classList.remove('collapsed'); }
    if (this.view === 'term') {
      if (this.shell.el.parentNode !== this.termEl) this.termEl.appendChild(this.shell.el);
      if (this.agentId) this.shell.show(this.agentId);
    } else {
      this.input.focus({ preventScroll: true });
      this.scrollDown(true);
    }
  }
  get busy() { return isBusy(this.agent); }

  autosize() {
    this.input.style.height = 'auto';
    this.input.style.height = Math.min(this.input.scrollHeight, 132) + 'px';
  }

  scrollDown(force = false) {
    const nearBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 40;
    if (force || nearBottom) this.log.scrollTop = this.log.scrollHeight;
  }

  onKey(e) {
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); return; }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (this.busy) this.onCancel(this.agentId);
      else { this.input.blur(); this.onDeselect(); }
      return;
    }
    const v = this.input.value;
    const atStart = this.input.selectionStart === 0 && this.input.selectionEnd === 0;
    const atEnd = this.input.selectionStart === v.length;
    if (e.key === 'ArrowUp' && (atStart || !v) && this.history.length) {
      e.preventDefault();
      if (this.hIndex === -1) { this.draft = v; this.hIndex = this.history.length; }
      this.hIndex = Math.max(0, this.hIndex - 1);
      this.setInput(this.history[this.hIndex]);
    } else if (e.key === 'ArrowDown' && atEnd && this.hIndex !== -1) {
      e.preventDefault();
      this.hIndex += 1;
      if (this.hIndex >= this.history.length) { this.hIndex = -1; this.setInput(this.draft); } else this.setInput(this.history[this.hIndex]);
    }
  }

  setInput(v) {
    this.input.value = v ?? '';
    this.autosize();
    const n = this.input.value.length;
    this.input.setSelectionRange(n, n);
  }

  async send() {
    const text = this.input.value;
    if (!text.trim() || !this.agentId || this.busy) return;
    if (this.history[this.history.length - 1] !== text) { this.history.push(text); saveHistory(this.history); }
    this.hIndex = -1;
    this.setInput('');
    this.stick = true;
    try {
      await this.onSend(this.agentId, text);
    } catch {
      if (!this.input.value) this.setInput(text); // Text nicht verlieren
    }
  }

  // Sichtbar nur bei steuerbarem, ausgewähltem Agenten
  render(selected, changes) {
    const a = selected ? this.store.state.agents.get(selected) : null;
    // im Meeting-Modus übernimmt die Besprechungs-Leiste (ui/meeting.js) den Platz
    const show = !!(a && a.controllable && a.kind === 'main') && !this.suppressed;
    this.el.classList.toggle('hidden', !show);
    document.body.classList.toggle('has-chat', show);
    if (!show) { this.agentId = null; this.shell?.detach(); return; }
    const switched = this.agentId !== a.id;
    this.agentId = a.id;
    if (switched && this.view === 'term') this.shell?.show(a.id);
    if (switched || changes.has('agents')) this.renderHead(a);
    if (switched || changes.has('chats') || changes.has('agents')) {
      // vor dem Neuzeichnen messen: nur mitscrollen, wenn der Nutzer unten war
      const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 40;
      this.renderLog(a);
      if (switched || atBottom || this.stick) this.log.scrollTop = this.log.scrollHeight;
      this.stick = false;
    }
    if (switched && this.view === 'chat' && !document.activeElement?.closest?.('input, textarea, select')) this.input.focus({ preventScroll: true });
  }

  renderHead(a) {
    this.avEl.style.setProperty('--c', agentColor(a));
    this.avEl.innerHTML = DIAMOND;
    const name = `${agentName(a)} · ${a.project}`;
    if (this.nameEl.textContent !== name) this.nameEl.textContent = name;
    const modes = a.modes ?? [];
    const sig = modes.map((m) => m.id).join('|') + '#' + a.mode;
    if (this.modeSel.dataset.sig !== sig) {
      this.modeSel.dataset.sig = sig;
      this.modeSel.innerHTML = modes.map((m) => `<option value="${esc(m.id)}" ${m.id === a.mode ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
    }
    this.modeSel.classList.toggle('hidden', modes.length < 2);
    for (const b of this.el.querySelectorAll('[data-city]')) b.classList.toggle('on', b.dataset.city === (a.cityMode ?? 'confirm'));
    const busy = isBusy(a);
    const dead = a.status === 'error';
    this.input.disabled = dead;
    this.input.placeholder = dead ? 'Session beendet – siehe Detailkarte'
      : busy ? 'arbeitet … (Esc bricht ab)' : `Nachricht an ${agentName(a)} – Enter senden, Shift+Enter Zeile, / Befehle`;
    this.sendBtn.innerHTML = svgIcon(busy ? ICON.stop : ICON.send);
    this.sendBtn.title = busy ? 'Abbrechen (Esc)' : 'Senden (Enter)';
    this.sendBtn.classList.toggle('stop', busy);
    this.sendBtn.disabled = dead;
  }

  renderLog(a) {
    const chat = this.store.state.chats[a.id] ?? [];
    const tools = (a.events ?? []).filter((e) => e.kind === 'tool').map((e) => ({ ...e, role: 'tool' }));
    const items = [...chat, ...tools].sort((x, y) => (x.t ?? 0) - (y.t ?? 0));
    const last = items[items.length - 1];
    const sig = `${a.id}|${items.length}|${last?.id}|${last?.text?.length ?? 0}|${last?.done}|${last?.tool}|${last?.label}|${this.openThoughts.size}`;
    if (sig === this.logSig) return;
    this.logSig = sig;
    if (!items.length) {
      this.log.innerHTML = `<div class="c-empty">Noch keine Nachrichten. Schreib unten eine Aufgabe.</div>`;
      return;
    }
    this.log.innerHTML = items.slice(-160).map((m) => {
      if (m.role === 'user') return `<div class="c-msg user"><div>${esc(m.text)}</div><time>${fmtTime(m.t)}</time></div>`;
      if (m.role === 'thought') {
        const open = this.openThoughts.has(m.id) ? 'open' : '';
        return `<details class="c-thought" data-thought="${esc(m.id)}" ${open}><summary>${svgIcon(ICON.thought)}Gedanke</summary><div>${esc(m.text)}</div></details>`;
      }
      if (m.role === 'tool') {
        const st = STATIONS[m.category] ?? STATIONS.workbench;
        return `<div class="c-tool" style="--c:${st.color}">${svgIcon(st.icon)}<b>${esc(m.tool)}</b>${m.label && m.label !== m.tool ? `<span>${esc(m.label)}</span>` : ''}</div>`;
      }
      return `<div class="c-msg agent ${m.done ? '' : 'live'}">${renderText(m.text)}</div>`;
    }).join('');
  }
}
