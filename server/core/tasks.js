// Aufgaben: anlegen, ändern, an steuerbare Agenten zuweisen (als Prompt). Der Status der zuletzt
// zugewiesenen Aufgabe eines Agenten folgt dem Agenten: arbeitet er → „In Arbeit“ (active), wartet er auf
// den Nutzer (Zugende, Rückfrage, Fehler) → „Wartet auf dich“ (waiting). „Erledigt“ (done) setzt nur der Nutzer.
import { randomUUID } from 'node:crypto';
import { isControllable } from './meetings.js';

export const TASK_STATUS = ['open', 'active', 'waiting', 'done'];
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 10_000;
const DONE_KEEP_MS = 7 * 24 * 3600_000; // erledigte Aufgaben so lange im Snapshot

// Agentenstatus → Aufgabenstatus (nur für die aktuelle Aufgabe des Agenten)
const FOLLOW = {
  thinking: 'active', tool: 'active',
  waiting_permission: 'waiting', waiting_user: 'waiting', error: 'waiting', done: 'waiting',
};

export function assignPrompt(task) {
  const desc = typeof task.description === 'string' && task.description.trim() ? `\n\n${task.description.trim()}` : '';
  return `Aufgabe: ${task.title}${desc}\n\nMelde dich, wenn du fertig bist oder etwas brauchst.`;
}

export function createTasks({ state, bus, repo, acp }) {
  const current = new Map(); // agentId → taskId (zuletzt zugewiesene, noch nicht erledigte Aufgabe)
  const lastStatus = new Map(); // agentId → zuletzt gesehener Agentenstatus
  const meetingTurn = new Set(); // Agenten, deren laufender/letzter Zug aus einer Besprechung stammt

  const need = (id) => {
    const t = state.tasks.get(id);
    if (!t) throw new Error('Aufgabe nicht gefunden');
    return t;
  };

  function save(id, patch) {
    let next = { ...state.tasks.get(id), ...patch, updatedAt: Date.now() };
    try { next = repo?.tasks?.update(id, patch) ?? next; } catch (err) { console.error('[tasks]', err.message); }
    state.tasks.set(id, next);
    bus.emit('task.update', { task: next });
    return next;
  }

  function cleanTitle(title) {
    if (typeof title !== 'string' || !title.trim()) throw new Error('Titel fehlt');
    return title.trim().replace(/\s+/g, ' ').slice(0, MAX_TITLE);
  }
  function cleanDescription(d) {
    if (d == null) return null;
    if (typeof d !== 'string') throw new Error('Beschreibung muss Text sein');
    if (d.length > MAX_DESCRIPTION) throw new Error('Beschreibung zu lang');
    return d.trim() || null;
  }

  // gespeicherte Aufgaben; „In Arbeit“ ohne laufende Session (Neustart) → „Wartet auf dich“
  function load() {
    let rows = [];
    try { rows = repo?.tasks?.list() ?? []; } catch (err) { console.error('[tasks]', err.message); }
    const now = Date.now();
    for (const t of rows) {
      if (t.status === 'done' && now - (t.updatedAt ?? 0) > DONE_KEEP_MS) continue;
      state.tasks.set(t.id, t);
      if (t.status === 'active') save(t.id, { status: 'waiting' });
    }
    return state.tasks.size;
  }

  function create({ title, description = null, meetingId = null, sourceMessageId = null } = {}) {
    const fields = {
      title: cleanTitle(title), description: cleanDescription(description), status: 'open', assigneeId: null,
      meetingId: typeof meetingId === 'string' && meetingId ? meetingId : null,
      sourceMessageId: typeof sourceMessageId === 'string' && sourceMessageId ? sourceMessageId : null,
    };
    let task;
    try { task = repo?.tasks?.create(fields); } catch (err) { throw new Error(`Aufgabe nicht gespeichert: ${err.message}`); }
    task ??= { id: randomUUID(), ...fields, createdAt: Date.now(), updatedAt: Date.now() };
    state.tasks.set(task.id, task);
    bus.emit('task.update', { task });
    return task;
  }

  function update(taskId, { status, title, description } = {}) {
    const t = need(taskId);
    const patch = {};
    if (status !== undefined) {
      if (!TASK_STATUS.includes(status)) throw new Error(`Unbekannter Status: ${status}`);
      patch.status = status;
      // erledigt oder zurück nach „Offen“: folgt dem Agenten nicht mehr
      if ((status === 'done' || status === 'open') && t.assigneeId && current.get(t.assigneeId) === t.id) current.delete(t.assigneeId);
    }
    if (title !== undefined) patch.title = cleanTitle(title);
    if (description !== undefined) patch.description = cleanDescription(description);
    if (!Object.keys(patch).length) return t;
    return save(taskId, patch);
  }

  // Aufgabe als Prompt an den Agenten; Status „In Arbeit“
  async function assign(taskId, agentId) {
    const t = need(taskId);
    if (t.status === 'done') throw new Error('Aufgabe ist erledigt');
    const agent = state.get(agentId);
    if (!isControllable(agent, acp)) throw new Error('Nur steuerbare Agenten (Arena-Sessions) können Aufgaben übernehmen');
    let early = null;
    let run;
    try { run = Promise.resolve(acp.prompt(agentId, assignPrompt(t))); } catch (err) { run = Promise.reject(err); }
    run.catch((err) => { early = err; });
    await new Promise((r) => setImmediate(r));
    if (early) throw early;
    meetingTurn.delete(agentId);
    // bisherige Aufgabe des Agenten folgt ihm nicht mehr (lief sie noch, wartet sie jetzt auf den Nutzer)
    const prevId = current.get(agentId);
    const prevTask = prevId && prevId !== t.id ? state.tasks.get(prevId) : null;
    if (prevTask?.status === 'active') save(prevTask.id, { status: 'waiting' });
    // Neu-Zuweisung: der bisherige Bearbeiter verliert die Aufgabe
    if (t.assigneeId && t.assigneeId !== agentId && current.get(t.assigneeId) === t.id) current.delete(t.assigneeId);
    current.set(agentId, t.id);
    lastStatus.set(agentId, state.get(agentId)?.status);
    // Zug schon vorbei (sehr schneller Agent) oder Rückfrage offen → wartet auf den Nutzer
    const done = acp.get?.(agentId) && !acp.get(agentId).busy;
    const st = done || state.get(agentId)?.status === 'waiting_permission' ? 'waiting' : 'active';
    return save(t.id, { status: st, assigneeId: agentId });
  }

  function remove(taskId) {
    const t = need(taskId);
    if (t.assigneeId && current.get(t.assigneeId) === t.id) current.delete(t.assigneeId);
    state.tasks.delete(taskId);
    try { repo?.tasks?.delete?.(taskId); } catch (err) { console.error('[tasks]', err.message); }
    bus.emit('task.remove', { taskId });
    return { ok: true };
  }

  // Züge aus einer Besprechung (Prompt mit meetingId) verändern den Aufgabenstatus nicht
  function onChatMessage({ agentId, message }) {
    if (message?.role !== 'user') return;
    if (message.meetingId) meetingTurn.add(agentId); else meetingTurn.delete(agentId);
  }

  function onAgentUpdate({ agent }) {
    const prev = lastStatus.get(agent.id);
    if (prev === agent.status) return;
    lastStatus.set(agent.id, agent.status);
    if (meetingTurn.has(agent.id) && agent.status !== 'error') return;
    const taskId = current.get(agent.id);
    if (!taskId) return;
    const t = state.tasks.get(taskId);
    if (!t || t.status === 'done' || t.status === 'open') { current.delete(agent.id); return; }
    const next = FOLLOW[agent.status];
    if (next && next !== t.status) save(t.id, { status: next });
  }

  function onAgentRemove({ agentId }) {
    lastStatus.delete(agentId);
    meetingTurn.delete(agentId);
    const taskId = current.get(agentId);
    current.delete(agentId);
    const t = taskId && state.tasks.get(taskId);
    if (t && t.status === 'active') save(t.id, { status: 'waiting' });
  }

  bus.on('agent.update', onAgentUpdate);
  bus.on('agent.remove', onAgentRemove);
  bus.on('chat.message', onChatMessage);
  function stop() {
    bus.off('chat.message', onChatMessage);
    bus.off('agent.update', onAgentUpdate);
    bus.off('agent.remove', onAgentRemove);
  }

  const get = (id) => state.tasks.get(id) ?? null;
  const list = () => [...state.tasks.values()];

  return { load, create, update, assign, remove, get, list, stop };
}
