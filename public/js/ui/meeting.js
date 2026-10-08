// Besprechung: Auswahl (Popover in der Kopfleiste) und Chat-Leiste im Meeting-Modus mit Teilnehmern,
// Beiträgen (Avatar + Name) und „Aufgabe daraus“ (Mini-Formular: Titel, Beschreibung, Zuweisen an …).
import { STATUS, agentColor, agentName, svgIcon } from '../config.js';
import { ICON, esc, renderText, fmtTime, DIAMOND } from './common.js';

export const MEETING_ICON = 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8';
const TASK_ICON = 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9';
const WARN_ICON = 'M12 3 2 20h20zM12 9v5M12 17h.01';
export const AUTO_WARNING = 'Teilnehmer im Auto-Modus: Beiträge anderer Agenten können Werkzeuge ohne Rückfrage auslösen';
const ADD_PERSON = 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M22 11h-6';

// steuerbare Hauptagenten (Teilnehmer bzw. Bearbeiter möglich)
export const controllableAgents = (store) => [...store.state.agents.values()]
  .filter((a) => a.source === 'acp' && a.kind === 'main' && a.controllable && a.status !== 'error')
  .sort((x, y) => (x.startedAt ?? 0) - (y.startedAt ?? 0));

export const meetingTitle = (m) => m?.title || 'Besprechung';
const avatar = (a, cls = 'sm') => `<span class="av ${cls}" style="--c:${a ? agentColor(a) : '#6b7587'}">${DIAMOND}</span>`;

// ---------------------------------------------------------------- Auswahl
export class MeetingPicker {
  constructor(el, { store, onCreate, onOpen }) {
    this.el = el;
    this.store = store;
    this.onCreate = onCreate;
    this.onOpen = onOpen;
    this.picked = new Set();
    el.addEventListener('click', (e) => {
      const open = e.target.closest('[data-open]');
      if (open) { this.close(); this.onOpen(open.dataset.open); return; }
      const row = e.target.closest('[data-pick]');
      if (row) {
        const id = row.dataset.pick;
        this.picked.has(id) ? this.picked.delete(id) : this.picked.add(id);
        this.draw();
        return;
      }
      if (e.target.closest('[data-start]')) this.start();
    });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input')) this.start(); });
  }

  get isOpen() { return !this.el.classList.contains('hidden'); }
  close() { this.el.classList.add('hidden'); }
  toggle() {
    if (this.isOpen) { this.close(); return; }
    this.picked = new Set();
    const sel = this.store.state.selected;
    if (sel && controllableAgents(this.store).some((a) => a.id === sel)) this.picked.add(sel);
    this.el.classList.remove('hidden');
    this.draw(true);
  }

  draw(fresh = false) {
    const agents = controllableAgents(this.store);
    const meetings = this.store.openMeetings();
    const title = fresh ? '' : this.el.querySelector('.mp-title')?.value ?? '';
    const open = meetings.map((m) => `<button class="mp-row" data-open="${esc(m.id)}">${svgIcon(MEETING_ICON)}
        <span class="mp-name">${esc(meetingTitle(m))}</span><span class="mp-n">${m.participantIds.length}</span></button>`).join('');
    const people = agents.map((a) => `<button class="mp-row ${this.picked.has(a.id) ? 'on' : ''}" data-pick="${esc(a.id)}">
        <span class="mp-check">${this.picked.has(a.id) ? svgIcon(ICON.check) : ''}</span>${avatar(a)}
        <span class="mp-name">${esc(agentName(a))}</span><span class="mp-proj">${esc(a.project)}</span></button>`).join('');
    this.el.innerHTML = `
      ${open ? `<div class="mp-label">Offen</div>${open}` : ''}
      <div class="mp-label">Neue Besprechung</div>
      ${agents.length ? `${people}
        <div class="mp-foot"><input class="mp-title" placeholder="Thema (optional)" maxlength="80" spellcheck="false" />
        <button class="btn primary sm" data-start ${this.picked.size ? '' : 'disabled'}>${svgIcon(MEETING_ICON)}Starten</button></div>`
        : '<div class="mp-empty">Keine steuerbaren Sessions – zuerst eine Session starten (+).</div>'}`;
    const input = this.el.querySelector('.mp-title');
    if (input) input.value = title;
  }

  async start() {
    if (!this.picked.size) return;
    const title = this.el.querySelector('.mp-title')?.value.trim() || null;
    try {
      await this.onCreate({ title, participantIds: [...this.picked] });
      this.close();
    } catch { /* Hinweis kam als Toast */ }
  }
}

// ---------------------------------------------------------------- Chat-Leiste im Meeting-Modus
export class MeetingBar {
  constructor(el, { store, onSend, onParticipants, onCloseMeeting, onLeave, onCreateTask, onSelect }) {
    this.el = el;
    this.store = store;
    this.onSend = onSend;
    this.onParticipants = onParticipants;
    this.onCloseMeeting = onCloseMeeting;
    this.onLeave = onLeave;
    this.onCreateTask = onCreateTask;
    this.onSelect = onSelect;
    this.meetingId = null;
    this.form = null; // { messageId }

    el.innerHTML = `<div class="chat meet">
      <div class="c-head">
        <span class="m-ic">${svgIcon(MEETING_ICON)}</span><span class="c-name"></span>
        <span class="m-auto hidden" title="${AUTO_WARNING}">${svgIcon(WARN_ICON)}</span>
        <div class="m-people"></div>
        <button class="icon-btn sm m-add" title="Teilnehmer hinzufügen/entfernen">${svgIcon(ADD_PERSON)}</button>
        <button class="icon-btn sm m-end" title="Besprechung beenden">${svgIcon(ICON.power)}</button>
        <button class="icon-btn sm m-leave" title="Ausblenden (Esc) – über das Besprechungs-Icon wieder öffnen">${svgIcon(ICON.x)}</button>
      </div>
      <div class="m-menu hidden"></div>
      <div class="c-log"></div>
      <div class="m-form hidden"></div>
      <div class="c-input">
        <textarea rows="1" spellcheck="false"></textarea>
        <button class="icon-btn c-send" title="Senden (Enter)">${svgIcon(ICON.send)}</button>
      </div>
    </div>`;
    this.log = el.querySelector('.c-log');
    this.input = el.querySelector('textarea');
    this.nameEl = el.querySelector('.c-name');
    this.peopleEl = el.querySelector('.m-people');
    this.autoEl = el.querySelector('.m-auto');
    this.menu = el.querySelector('.m-menu');
    this.formEl = el.querySelector('.m-form');

    this.input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
      if (e.key === 'Escape') { e.preventDefault(); this.input.blur(); this.onLeave(); }
    });
    this.input.addEventListener('input', () => this.autosize());
    el.querySelector('.c-send').addEventListener('click', () => this.send());
    el.querySelector('.m-leave').addEventListener('click', () => this.onLeave());
    // Beenden mit Bestätigung durch zweiten Klick
    const end = el.querySelector('.m-end');
    end.addEventListener('click', () => {
      const m = this.meeting;
      if (!m) return;
      if (!end.classList.contains('armed')) {
        end.classList.add('armed');
        end.title = 'Nochmal klicken: Besprechung beenden';
        clearTimeout(this.armTimer);
        this.armTimer = setTimeout(() => { end.classList.remove('armed'); end.title = 'Besprechung beenden'; }, 2500);
        return;
      }
      end.classList.remove('armed');
      this.onCloseMeeting(m.id);
    });
    el.querySelector('.m-add').addEventListener('click', () => this.toggleMenu());
    this.menu.addEventListener('click', (e) => {
      const row = e.target.closest('[data-toggle]');
      const m = this.meeting;
      if (!row || !m) return;
      const id = row.dataset.toggle;
      const ids = m.participantIds.includes(id) ? m.participantIds.filter((x) => x !== id) : [...m.participantIds, id];
      this.onParticipants(m.id, ids).catch(() => {});
    });
    // Teilnehmer anklicken: @Name in die Eingabe; Doppelklick wählt den Agenten aus
    this.peopleEl.addEventListener('click', (e) => {
      const p = e.target.closest('[data-handle]');
      if (!p) return;
      this.insert(`@${p.dataset.handle} `);
    });
    this.peopleEl.addEventListener('dblclick', (e) => {
      const p = e.target.closest('[data-agent]');
      if (p) this.onSelect(p.dataset.agent);
    });
    this.log.addEventListener('click', (e) => {
      const b = e.target.closest('[data-task]');
      if (b) { this.openForm(b.dataset.task); return; }
      const who = e.target.closest('[data-agent]');
      if (who) this.onSelect(who.dataset.agent);
    });
    this.formEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-cancel]')) this.closeForm();
      if (e.target.closest('[data-create]')) this.createTask();
    });
    this.formEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.closeForm(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || e.target.matches('input'))) { e.preventDefault(); this.createTask(); }
    });
  }

  get meeting() { return this.meetingId ? this.store.state.meetings.get(this.meetingId) : null; }
  get isOpen() { return !this.el.classList.contains('hidden'); }

  autosize() {
    this.input.style.height = 'auto';
    this.input.style.height = Math.min(this.input.scrollHeight, 132) + 'px';
  }

  insert(text) {
    const v = this.input.value;
    this.input.value = v && !v.endsWith(' ') ? `${v} ${text}` : v + text;
    this.autosize();
    this.input.focus();
  }

  async send() {
    const text = this.input.value;
    if (!text.trim() || !this.meetingId) return;
    this.input.value = '';
    this.autosize();
    this.stick = true;
    try { await this.onSend(this.meetingId, text); } catch { if (!this.input.value) { this.input.value = text; this.autosize(); } }
  }

  toggleMenu(force) {
    const show = force ?? this.menu.classList.contains('hidden');
    this.menu.classList.toggle('hidden', !show);
    if (show) this.drawMenu();
  }

  drawMenu() {
    const m = this.meeting;
    if (!m) return;
    const agents = controllableAgents(this.store);
    // Teilnehmer, deren Session nicht steuerbar ist, bleiben entfernbar
    const extra = m.participantIds.filter((id) => !agents.some((a) => a.id === id)).map((id) => this.store.state.agents.get(id)).filter(Boolean);
    const rows = [...agents, ...extra].map((a) => {
      const on = m.participantIds.includes(a.id);
      return `<button class="mp-row ${on ? 'on' : ''}" data-toggle="${esc(a.id)}"><span class="mp-check">${on ? svgIcon(ICON.check) : ''}</span>
        ${avatar(a)}<span class="mp-name">${esc(agentName(a))}</span><span class="mp-proj">${esc(a.project)}</span></button>`;
    }).join('');
    this.menu.innerHTML = rows || '<div class="mp-empty">Keine steuerbaren Sessions.</div>';
  }

  render(meetingId, changes) {
    const m = meetingId ? this.store.state.meetings.get(meetingId) : null;
    this.el.classList.toggle('hidden', !m);
    document.body.classList.toggle('has-meeting', !!m);
    if (!m) { this.meetingId = null; this.closeForm(); this.toggleMenu(false); return; }
    const switched = this.meetingId !== m.id;
    this.meetingId = m.id;
    if (switched) { this.closeForm(); this.toggleMenu(false); this.logSig = null; }
    const title = meetingTitle(m);
    if (this.nameEl.textContent !== title) this.nameEl.textContent = title;
    this.renderPeople(m);
    const auto = m.participantIds.some((id) => this.store.state.agents.get(id)?.cityMode === 'auto');
    this.autoEl.classList.toggle('hidden', !auto);
    if (!this.menu.classList.contains('hidden') && (changes.has('agents') || changes.has('meetings'))) this.drawMenu();
    const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 40;
    this.renderLog(m);
    if (switched || atBottom || this.stick) this.log.scrollTop = this.log.scrollHeight;
    this.stick = false;
    const names = m.participantIds.map((id) => m.handles?.[id]).filter(Boolean);
    this.input.placeholder = names.length
      ? `Nachricht an alle (${names.join(', ')}) – @Name für Einzelne, Enter senden`
      : 'Keine Teilnehmer – über das Personen-Icon oder per Drag auf den Tisch hinzufügen';
    if (switched && !document.activeElement?.closest?.('input, textarea, select')) this.input.focus({ preventScroll: true });
  }

  renderPeople(m) {
    const html = m.participantIds.map((id) => {
      const a = this.store.state.agents.get(id);
      const st = STATUS[a?.status] ?? STATUS.idle;
      const pending = m.pending?.includes(id);
      const handle = m.handles?.[id] ?? (a ? agentName(a) : '?');
      return `<span class="m-person ${pending ? 'pending' : ''}" data-handle="${esc(handle)}" data-agent="${esc(id)}"
        title="${esc(handle)} · ${esc(a ? agentName(a) : 'beendet')} – ${esc(st.label)} (Klick: @${esc(handle)}, Doppelklick: auswählen)" style="--s:${st.color}">
        ${avatar(a)}<i></i></span>`;
    }).join('');
    if (html !== this.peopleHtml) { this.peopleHtml = html; this.peopleEl.innerHTML = html; }
  }

  renderLog(m) {
    const msgs = m.messages ?? [];
    const pending = (m.pending ?? []).map((id) => {
      const a = this.store.state.agents.get(id);
      return `${id}:${a?.status}:${a?.tool ?? ''}`;
    }).join(',');
    const sig = `${m.id}|${msgs.length}|${msgs[msgs.length - 1]?.id}|${pending}|${JSON.stringify(m.handles)}|${this.form?.messageId}`;
    if (sig === this.logSig) return;
    this.logSig = sig;
    const handle = (id) => m.handles?.[id] ?? agentName(this.store.state.agents.get(id) ?? { kind: 'main', title: 'Agent' });
    let html = msgs.map((x) => {
      const mark = this.form?.messageId === x.id ? 'marked' : '';
      const act = `<button class="m-act" data-task="${esc(x.id)}" title="Aufgabe daraus">${svgIcon(TASK_ICON)}</button>`;
      if (x.role === 'user') {
        const to = x.targetIds?.length ? `<span class="m-to">an ${x.targetIds.map((id) => '@' + esc(handle(id))).join(', ')}</span>` : '';
        return `<div class="c-msg user m-user ${mark}"><div>${esc(x.text)}</div><time>${to}${fmtTime(x.t)}</time>${act}</div>`;
      }
      const a = this.store.state.agents.get(x.agentId);
      return `<div class="m-msg ${mark}">
        <div class="m-who" data-agent="${esc(x.agentId)}">${avatar(a)}<b>${esc(handle(x.agentId))}</b><time>${fmtTime(x.t)}</time>${act}</div>
        <div class="c-msg agent">${renderText(x.text)}</div></div>`;
    }).join('');
    for (const id of m.pending ?? []) {
      const a = this.store.state.agents.get(id);
      const what = a?.status === 'tool' && a.tool ? `arbeitet: ${esc(a.tool)}` : a?.status === 'waiting_permission' ? 'braucht Erlaubnis' : 'schreibt';
      html += `<div class="m-pending" data-agent="${esc(id)}">${avatar(a)}<b>${esc(handle(id))}</b><span>${what}</span><i></i><i></i><i></i></div>`;
    }
    this.log.innerHTML = html || '<div class="c-empty">Noch keine Beiträge. Frag die Runde – alle Teilnehmer antworten.</div>';
  }

  // ---------------------------------------------------------------- Aufgabe aus einem Beitrag
  openForm(messageId) {
    const m = this.meeting;
    const msg = m?.messages.find((x) => x.id === messageId);
    if (!msg) return;
    this.form = { messageId };
    const text = msg.text.trim();
    const nl = text.indexOf('\n');
    const first = (nl < 0 ? text : text.slice(0, nl)).replace(/^[#>*\-\s]+/, '').replace(/\*\*/g, '').trim();
    const title = first.length > 120 ? first.slice(0, 119) + '…' : first;
    const desc = (nl < 0 ? (first.length > 120 ? text : '') : text.slice(nl + 1)).trim();
    const agents = controllableAgents(this.store);
    // Vorschlag: ein anderer Teilnehmer als der Verfasser
    const other = m.participantIds.find((id) => id !== msg.agentId && agents.some((a) => a.id === id)) ?? '';
    const opts = agents.map((a) => `<option value="${esc(a.id)}" ${a.id === other ? 'selected' : ''}>${esc(m.handles?.[a.id] ?? agentName(a))} · ${esc(a.project)}</option>`).join('');
    this.formEl.innerHTML = `<div class="m-form-head">${svgIcon(TASK_ICON)}Aufgabe aus ${msg.role === 'user' ? 'deiner Nachricht' : `dem Beitrag von ${esc(m.handles?.[msg.agentId] ?? 'Agent')}`}</div>
      <input class="m-f-title" maxlength="200" spellcheck="false" placeholder="Titel" />
      <textarea class="m-f-desc" rows="3" spellcheck="false" placeholder="Beschreibung (optional)"></textarea>
      <div class="m-form-foot"><label>Zuweisen an <select class="m-f-who"><option value="">– niemand (Offen) –</option>${opts}</select></label>
      <button class="btn ghost sm" data-cancel>Abbrechen</button><button class="btn primary sm" data-create>${svgIcon(ICON.plus)}Anlegen</button></div>`;
    this.formEl.querySelector('.m-f-title').value = title;
    this.formEl.querySelector('.m-f-desc').value = desc;
    this.formEl.classList.remove('hidden');
    this.logSig = null;
    this.renderLog(m);
    this.formEl.querySelector('.m-f-title').focus();
  }

  closeForm() {
    if (!this.form) return;
    this.form = null;
    this.formEl.classList.add('hidden');
    this.formEl.innerHTML = '';
    this.logSig = null;
    if (this.meeting) this.renderLog(this.meeting);
  }

  async createTask() {
    if (!this.form || this.creating) return;
    const title = this.formEl.querySelector('.m-f-title').value.trim();
    if (!title) { this.formEl.querySelector('.m-f-title').focus(); return; }
    const description = this.formEl.querySelector('.m-f-desc').value.trim() || null;
    const assigneeId = this.formEl.querySelector('.m-f-who').value || null;
    this.creating = true;
    try {
      await this.onCreateTask({ title, description, meetingId: this.meetingId, sourceMessageId: this.form.messageId, assigneeId });
      this.closeForm();
    } catch { /* Hinweis kam als Toast */ } finally { this.creating = false; }
  }
}
