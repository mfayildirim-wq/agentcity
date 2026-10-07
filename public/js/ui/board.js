// Aufgaben-Board (Panel links): Spalten Offen / In Arbeit / Wartet auf dich / Erledigt.
// Karten per Drag zwischen den Spalten verschieben, Bearbeiter über die Avatar-Auswahl zuweisen (als Prompt),
// Klick auf eine Karte wählt den Bearbeiter aus.
import { agentColor, agentName, svgIcon } from '../config.js';
import { ICON, esc, DIAMOND } from './common.js';
import { controllableAgents } from './meeting.js';

export const BOARD_ICON = 'M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z';
// kurzes Alter: 5 s, 3 m, 2 h, 4 T
function age(t, now) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} m`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} T`;
}

const COLUMNS = [
  { id: 'open', label: 'Offen', color: '#8a94a6' },
  { id: 'active', label: 'In Arbeit', color: '#4c8df6' },
  { id: 'waiting', label: 'Wartet auf dich', color: '#f0a33a' },
  { id: 'done', label: 'Erledigt', color: '#3fb67a' },
];

export class Board {
  constructor(el, { store, onCreate, onUpdate, onAssign, onDelete, onSelect }) {
    this.el = el;
    this.store = store;
    this.onCreate = onCreate;
    this.onUpdate = onUpdate;
    this.onAssign = onAssign;
    this.onDelete = onDelete;
    this.onSelect = onSelect;
    this.picker = null; // taskId, für die die Avatar-Auswahl offen ist

    el.innerHTML = `<div class="board">
      <div class="b-head">${svgIcon(BOARD_ICON)}<span>Aufgaben</span><b class="b-count"></b>
        <button class="icon-btn sm b-new" title="Neue Aufgabe">${svgIcon(ICON.plus)}</button>
        <button class="icon-btn sm b-close" title="Schließen">${svgIcon(ICON.x)}</button></div>
      <div class="b-add hidden"><input maxlength="200" spellcheck="false" placeholder="Titel – Enter legt an" /></div>
      <div class="b-cols"></div>
      <div class="b-pick hidden"></div>
    </div>`;
    this.pickEl = el.querySelector('.b-pick');
    this.boardEl = el.querySelector('.board');
    this.pickEl.addEventListener('click', (e) => {
      const pick = e.target.closest('[data-pick]');
      if (!pick || !this.picker) return;
      this.onAssign(this.picker, pick.dataset.pick).catch(() => {});
      this.picker = null;
      this.draw();
    });
    this.cols = el.querySelector('.b-cols');
    this.cols.addEventListener('scroll', () => { if (this.picker) { this.picker = null; this.draw(); } });
    this.addEl = el.querySelector('.b-add');
    this.addInput = this.addEl.querySelector('input');
    el.querySelector('.b-close').addEventListener('click', () => this.close());
    el.querySelector('.b-new').addEventListener('click', () => {
      this.addEl.classList.toggle('hidden');
      if (!this.addEl.classList.contains('hidden')) this.addInput.focus();
    });
    this.addInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') { this.addEl.classList.add('hidden'); return; }
      if (e.key !== 'Enter' || !this.addInput.value.trim()) return;
      const title = this.addInput.value.trim();
      this.addInput.value = '';
      try { await this.onCreate({ title }); } catch { this.addInput.value = title; }
    });

    this.cols.addEventListener('click', (e) => {
      const assign = e.target.closest('[data-assign]');
      if (assign) { this.picker = this.picker === assign.dataset.assign ? null : assign.dataset.assign; this.draw(); return; }
      const del = e.target.closest('[data-del]');
      if (del) {
        // zweiter Klick löscht
        if (del.classList.contains('armed')) { this.onDelete(del.dataset.del).catch(() => {}); return; }
        del.classList.add('armed');
        del.title = 'Nochmal klicken: löschen';
        setTimeout(() => del.classList.remove('armed'), 2500);
        return;
      }
      const card = e.target.closest('[data-task]');
      if (card) {
        const t = this.store.state.tasks.get(card.dataset.task);
        if (t?.assigneeId && this.store.state.agents.has(t.assigneeId)) this.onSelect(t.assigneeId);
      }
    });

    // Drag & Drop zwischen Spalten (HTML5)
    this.cols.addEventListener('dragstart', (e) => {
      const card = e.target.closest('[data-task]');
      if (!card) return;
      e.dataTransfer.setData('text/x-arena-task', card.dataset.task);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
      this.dragId = card.dataset.task;
    });
    this.cols.addEventListener('dragend', (e) => {
      e.target.closest?.('[data-task]')?.classList.remove('dragging');
      for (const c of this.cols.querySelectorAll('.b-col.over')) c.classList.remove('over');
      this.dragId = null;
    });
    this.cols.addEventListener('dragover', (e) => {
      const col = e.target.closest('[data-col]');
      if (!col || !this.dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      for (const c of this.cols.querySelectorAll('.b-col.over')) if (c !== col) c.classList.remove('over');
      col.classList.add('over');
    });
    this.cols.addEventListener('dragleave', (e) => {
      const col = e.target.closest('[data-col]');
      if (col && !col.contains(e.relatedTarget)) col.classList.remove('over');
    });
    this.cols.addEventListener('drop', (e) => {
      const col = e.target.closest('[data-col]');
      const id = e.dataTransfer.getData('text/x-arena-task') || this.dragId;
      col?.classList.remove('over');
      if (!col || !id) return;
      e.preventDefault();
      const t = this.store.state.tasks.get(id);
      if (t && t.status !== col.dataset.col) {
        // sofort anzeigen, Server bestätigt per task.update
        this.store.applyTask({ ...t, status: col.dataset.col });
        this.onUpdate(id, { status: col.dataset.col }).catch(() => this.store.applyTask(t));
      }
    });
    // Alter der Karten regelmäßig auffrischen
    setInterval(() => { if (this.isOpen) this.draw(); }, 30_000);
  }

  get isOpen() { return !this.el.classList.contains('hidden'); }
  open() { this.el.classList.remove('hidden'); document.body.classList.add('has-board'); this.draw(); }
  close() { this.el.classList.add('hidden'); document.body.classList.remove('has-board'); this.picker = null; this.onToggle?.(false); }
  toggle() { if (this.isOpen) this.close(); else this.open(); }

  render() { if (this.isOpen) this.draw(); }

  draw() {
    const tasks = [...this.store.state.tasks.values()].sort((x, y) => (y.updatedAt ?? 0) - (x.updatedAt ?? 0));
    const sel = this.store.state.selected;
    const now = this.store.now();
    this.el.querySelector('.b-count').textContent = tasks.filter((t) => t.status !== 'done').length || '';
    const agents = controllableAgents(this.store);
    const html = COLUMNS.map((c) => {
      const list = tasks.filter((t) => t.status === c.id);
      const cards = list.map((t) => {
        const a = t.assigneeId ? this.store.state.agents.get(t.assigneeId) : null;
        const who = a
          ? `<button class="b-av" data-assign="${esc(t.id)}" title="${esc(agentName(a))} – anderen Bearbeiter wählen"><span class="av sm" style="--c:${agentColor(a)}">${DIAMOND}</span></button>`
          : t.assigneeId
            ? `<button class="b-av gone" data-assign="${esc(t.id)}" title="Session beendet – neu zuweisen"><span class="av sm" style="--c:#4a5160">${DIAMOND}</span></button>`
            : `<button class="b-av none" data-assign="${esc(t.id)}" title="Zuweisen">${svgIcon(ICON.agent)}</button>`;
        return `<div class="b-card ${a && a.id === sel ? 'sel' : ''}" draggable="true" data-task="${esc(t.id)}" title="${esc(t.title)}${t.description ? '\n\n' + esc(t.description) : ''}">
          <div class="b-title">${esc(t.title)}</div>
          <div class="b-foot">${who}<span class="b-age">${age(t.createdAt ?? now, now)}</span>
            <button class="b-del" data-del="${esc(t.id)}" title="Löschen">${svgIcon(ICON.trash)}</button></div></div>`;
      }).join('');
      return `<div class="b-col" data-col="${c.id}" style="--c:${c.color}">
        <div class="b-col-head"><i></i><span>${c.label}</span><b>${list.length || ''}</b></div>${cards}</div>`;
    }).join('');
    if (html !== this.html) { this.html = html; this.cols.innerHTML = html; }
    this.drawPicker(agents);
  }

  // Avatar-Auswahl als Popover unter dem Avatar-Knopf der Karte
  drawPicker(agents) {
    const btn = this.picker && this.cols.querySelector(`[data-assign="${CSS.escape(this.picker)}"]`);
    if (!btn) { this.pickEl.classList.add('hidden'); return; }
    const t = this.store.state.tasks.get(this.picker);
    this.pickEl.innerHTML = agents.length ? agents.map((x) => `<button data-pick="${esc(x.id)}" class="${x.id === t?.assigneeId ? 'on' : ''}">
        <span class="av sm" style="--c:${agentColor(x)}">${DIAMOND}</span><span>${esc(agentName(x))}</span><em>${esc(x.project)}</em></button>`).join('')
      : '<em class="b-none">Keine steuerbaren Sessions</em>';
    this.pickEl.classList.remove('hidden');
    const r = btn.getBoundingClientRect();
    const b = this.boardEl.getBoundingClientRect();
    const w = this.pickEl.offsetWidth;
    this.pickEl.style.left = `${Math.max(6, Math.min(r.left - b.left, b.width - w - 6))}px`;
    this.pickEl.style.top = `${r.bottom - b.top + 4}px`;
  }
}
