// Zustand im Browser: Snapshot + Deltas vom Server (oder Demo). Alle UI-Teile lesen daraus.
const MAX_EVENTS = 40;
const MAX_CHAT = 400;
const MAX_DIFFS = 60;
const MAX_TERM_DATA = 64 * 1024; // wie der Ringpuffer des Servers

export function createStore() {
  const state = {
    agents: new Map(),
    tasks: new Map(),
    meetings: new Map(),
    permissions: new Map(),
    tools: [],
    chats: {}, // agentId → [{ id, role, text, t, done }]
    diffs: {}, // agentId → [Diff-Ereignis mit oldText/newText] (Server-Agenten tragen nur kompakte Ereignisse)
    terminals: new Map(), // ptyId → { ptyId, agentId, ownerId, kind, command, t, exited, exitCode, signal, data }
    selected: null,
    meetingView: null, // geöffnete Besprechung (Chat-Leiste im Meeting-Modus) oder null
    connection: 'off', // live | off | demo
    clockOffset: 0, // Serverzeit − Browserzeit
  };
  const subs = new Set();
  const ptySubs = new Set(); // Terminal-Ausgabe geht direkt an die xterm-Ansichten (ohne Neuzeichnen)
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
    state.meetings = toMap((snap.meetings || []).filter((m) => !m.closedAt));
    if (state.meetingView && !state.meetings.has(state.meetingView)) setMeetingView(null);
    state.permissions = toMap(snap.permissions);
    if (snap.tools) { state.tools = snap.tools; changed('tools'); }
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
    delete state.chats[agentId];
    delete state.diffs[agentId];
    for (const [k, t] of state.terminals) if ((t.ownerId ?? t.agentId) === agentId) state.terminals.delete(k);
    changed('agents');
  }

  function applyEvent(event) {
    if (event.kind === 'terminal' && event.ptyId) {
      const owner = state.agents.get(event.agentId)?.parentId ?? event.agentId;
      upsertTerminal({ ptyId: event.ptyId, agentId: event.agentId, ownerId: owner, kind: event.display ? 'display' : 'agent', command: event.command, t: event.t });
    }
    if (event.kind === 'diff') {
      const list = (state.diffs[event.agentId] ??= []);
      if (!list.some((d) => d.id === event.id)) {
        list.push(event);
        if (list.length > MAX_DIFFS) list.splice(0, list.length - MAX_DIFFS);
        changed('diffs');
      }
    }
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
    if (chat.length > MAX_CHAT) chat.splice(0, chat.length - MAX_CHAT);
    changed('chats');
  }

  // gespeicherter Verlauf (nach Neuladen): vor die live empfangenen Nachrichten setzen
  function applyChatHistory(agentId, messages = []) {
    const chat = chatOf(agentId);
    const first = chat[0]?.t ?? Infinity;
    const ids = new Set(chat.map((m) => m.id));
    const older = messages.filter((m) => !ids.has(m.id) && (m.t ?? 0) < first).map((m) => ({ ...m, done: true }));
    if (!older.length) return false;
    chat.unshift(...older);
    if (chat.length > MAX_CHAT) chat.splice(0, chat.length - MAX_CHAT);
    changed('chats');
    return true;
  }

  function applyTools(tools = []) { state.tools = tools; changed('tools'); }

  // ---------------------------------------------------------------- Terminals
  function upsertTerminal(t) {
    const prev = state.terminals.get(t.ptyId);
    state.terminals.set(t.ptyId, { data: '', exited: false, exitCode: null, signal: null, ...prev, ...t });
    changed('terminals');
  }

  // Liste vom Server (pty.list) – ersetzt Puffer und Status
  function applyTerminalList(agentId, list = []) {
    for (const t of list) state.terminals.set(t.ptyId, { ...t, data: t.data ?? '' });
    changed('terminals');
  }

  function applyPtyOutput({ ptyId, data }) {
    const t = state.terminals.get(ptyId);
    if (t) {
      t.data += data;
      if (t.data.length > MAX_TERM_DATA * 1.5) {
        // am Zeilenanfang abschneiden (keine halben Escape-Folgen in der Wiederanzeige)
        const cut = t.data.slice(-MAX_TERM_DATA);
        const nl = cut.indexOf('\n');
        t.data = nl >= 0 && nl < cut.length - 1 ? cut.slice(nl + 1) : cut;
      }
    }
    for (const fn of ptySubs) fn({ type: 'output', ptyId, data });
  }

  function applyPtyExit({ ptyId, code, signal }) {
    const t = state.terminals.get(ptyId);
    if (t) { t.exited = true; t.exitCode = code ?? null; t.signal = signal ?? null; changed('terminals'); }
    for (const fn of ptySubs) fn({ type: 'exit', ptyId, code, signal });
  }

  const onPty = (fn) => { ptySubs.add(fn); return () => ptySubs.delete(fn); };
  const terminalsOf = (agentId) => [...state.terminals.values()]
    .filter((t) => t.kind !== 'user' && (t.ownerId === agentId || t.agentId === agentId))
    .sort((x, y) => (x.t ?? 0) - (y.t ?? 0));

  function applyPermission(permission) { state.permissions.set(permission.id, permission); changed('permissions'); }
  function applyPermissionResolved(permissionId) { state.permissions.delete(permissionId); changed('permissions'); }
  function applyTask(task) { state.tasks.set(task.id, task); changed('tasks'); }
  function applyTaskRemove(taskId) { if (state.tasks.delete(taskId)) changed('tasks'); }
  // geschlossene Besprechungen verschwinden; meeting.update trägt nur Metadaten → Nachrichten behalten
  function applyMeeting(meeting) {
    if (meeting.closedAt) {
      state.meetings.delete(meeting.id);
      if (state.meetingView === meeting.id) setMeetingView(null);
    } else {
      const prev = state.meetings.get(meeting.id);
      state.meetings.set(meeting.id, { ...meeting, messages: meeting.messages ?? prev?.messages ?? [] });
    }
    changed('meetings');
  }
  // neue Nachricht einer Besprechung (meeting.message)
  function applyMeetingMessage({ meetingId, message }) {
    const m = state.meetings.get(meetingId);
    if (!m || m.messages?.some((x) => x.id === message.id)) return;
    const messages = [...(m.messages ?? []), message].slice(-200);
    state.meetings.set(meetingId, { ...m, messages });
    changed('meetings');
  }
  function setMeetingView(id) {
    if (state.meetingView === id) return;
    state.meetingView = id;
    changed('meetingView');
  }
  const openMeetings = () => [...state.meetings.values()].filter((m) => !m.closedAt).sort((x, y) => (x.createdAt ?? 0) - (y.createdAt ?? 0));

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
    state.diffs = {};
    state.terminals = new Map();
    state.tasks = new Map();
    state.meetings = new Map();
    setMeetingView(null);
    select(null);
    changed('agents'); changed('tasks'); changed('meetings');
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
      case 'task.remove': applyTaskRemove(msg.taskId); return true;
      case 'meeting.update': applyMeeting(msg.meeting); return true;
      case 'meeting.message': applyMeetingMessage(msg); return true;
      case 'tools.update': applyTools(msg.tools); return true;
      case 'pty.output': applyPtyOutput(msg); return true;
      case 'pty.exit': applyPtyExit(msg); return true;
      default: return false;
    }
  }

  return {
    state, subscribe, now, agentList, dispatch, clear, chatOf,
    applySnapshot, applyAgentUpdate, applyAgentRemove, applyEvent, applyChatChunk, applyChatMessage,
    applyPermission, applyPermissionResolved, applyTask, applyTaskRemove, applyMeeting, applyMeetingMessage, setMeetingView, openMeetings, applyChatHistory, applyTools, select, setConnection,
    applyTerminalList, applyPtyOutput, applyPtyExit, upsertTerminal, onPty, terminalsOf,
  };
}
