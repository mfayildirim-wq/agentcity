// Zustand im Browser: Snapshot + Deltas vom Server (oder Demo). Alle UI-Teile lesen daraus.
const MAX_EVENTS = 40;
const MAX_CHAT = 400;

export function createStore() {
  const state = {
    agents: new Map(),
    tasks: new Map(),
    meetings: new Map(),
    permissions: new Map(),
    tools: [],
    chats: {}, // agentId → [{ id, role, text, t, done }]
    selected: null,
    connection: 'off', // live | off | demo
    clockOffset: 0, // Serverzeit − Browserzeit
  };
  const subs = new Set();
  let changes = new Set();
  let scheduled = false;

  // Änderungen bündeln (ein Rendern pro Frame)
  function changed(kind) {
    changes.add(kind);
    if (scheduled) return;
    scheduled = true;
    const run = () => {
      scheduled = false;
      const c = changes;
      changes = new Set();
      for (const fn of subs) fn(state, c);
    };
    if (typeof requestAnimationFrame === 'function' && !document.hidden) requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
  const now = () => Date.now() + state.clockOffset;

  // Hauptagenten zuerst, dann nach Startzeit (wie v1)
  function agentList() {
    return [...state.agents.values()].sort((x, y) =>
      x.kind === y.kind ? (x.startedAt || 0) - (y.startedAt || 0) : x.kind === 'main' ? -1 : 1);
  }

  const toMap = (list = []) => new Map(list.map((x) => [x.id, x]));

  function applySnapshot(snap) {
    if (snap.now) state.clockOffset = snap.now - Date.now();
    const prev = state.agents;
    state.agents = new Map((snap.agents || []).map((a) => [a.id, mergeAgent(prev.get(a.id), a)]));
    state.tasks = toMap(snap.tasks);
    state.meetings = toMap(snap.meetings);
    state.permissions = toMap(snap.permissions);
    if (snap.tools) state.tools = snap.tools;
    if (state.selected && !state.agents.has(state.selected)) select(null);
    changed('agents'); changed('tasks'); changed('meetings'); changed('permissions');
  }

  // Server-Agenten tragen nicht immer ihre Ereignisse mit – vorhandene behalten
  function mergeAgent(prev, a) {
    if (a.events?.length || !prev?.events?.length) return a;
    return { ...a, events: prev.events };
  }

  function applyAgentUpdate(agent) {
    state.agents.set(agent.id, mergeAgent(state.agents.get(agent.id), agent));
    changed('agents');
  }

  function applyAgentRemove(agentId) {
    if (!state.agents.delete(agentId)) return;
    if (state.selected === agentId) select(null);
    changed('agents');
  }

  function applyEvent(event) {
    const a = state.agents.get(event.agentId);
    if (!a || a.events?.some((e) => e.id === event.id)) return;
    const events = [...(a.events || []), event];
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    state.agents.set(a.id, { ...a, events });
    changed('agents');
  }

  function chatOf(agentId) {
    return (state.chats[agentId] ??= []);
  }

  function applyChatChunk({ agentId, messageId, role, text }) {
    const chat = chatOf(agentId);
    const last = chat[chat.length - 1];
    if (last && last.id === messageId && last.role === role && !last.done) last.text += text;
    else chat.push({ id: messageId, role, text, t: now(), done: false });
    if (chat.length > MAX_CHAT) chat.splice(0, chat.length - MAX_CHAT);
    changed('chats');
  }

  function applyChatMessage({ agentId, message }) {
    const chat = chatOf(agentId);
    const i = chat.findIndex((m) => m.id === message.id && m.role === message.role);
    const entry = { ...message, done: true };
    if (i >= 0) chat[i] = entry; else chat.push(entry);
    changed('chats');
  }

  function applyPermission(permission) { state.permissions.set(permission.id, permission); changed('permissions'); }
  function applyPermissionResolved(permissionId) { state.permissions.delete(permissionId); changed('permissions'); }
  function applyTask(task) { state.tasks.set(task.id, task); changed('tasks'); }
  function applyMeeting(meeting) { state.meetings.set(meeting.id, meeting); changed('meetings'); }

  function select(id) {
    if (state.selected === id) return;
    state.selected = id;
    changed('selected');
  }

  function setConnection(c) {
    if (state.connection === c) return;
    state.connection = c;
    changed('connection');
  }

  // Leert alle Agenten-Daten (z. B. beim Wechsel Demo ↔ Live)
  function clear() {
    state.agents = new Map();
    state.permissions = new Map();
    state.chats = {};
    select(null);
    changed('agents');
  }

  // Server-Nachricht → passende apply-Funktion
  function dispatch(msg) {
    switch (msg.type) {
      case 'snapshot': applySnapshot(msg); return true;
      case 'agent.update': applyAgentUpdate(msg.agent); return true;
      case 'agent.remove': applyAgentRemove(msg.agentId); return true;
      case 'event': applyEvent(msg.event); return true;
      case 'chat.chunk': applyChatChunk(msg); return true;
      case 'chat.message': applyChatMessage(msg); return true;
      case 'permission.request': applyPermission(msg.permission); return true;
      case 'permission.resolved': applyPermissionResolved(msg.permissionId); return true;
      case 'task.update': applyTask(msg.task); return true;
      case 'meeting.update': applyMeeting(msg.meeting); return true;
      default: return false;
    }
  }

  return {
    state, subscribe, now, agentList, dispatch, clear,
    applySnapshot, applyAgentUpdate, applyAgentRemove, applyEvent, applyChatChunk, applyChatMessage,
    applyPermission, applyPermissionResolved, applyTask, applyMeeting, select, setConnection,
  };
}
