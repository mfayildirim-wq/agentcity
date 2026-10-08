// ACP-Session: übersetzt session/update-Ereignisse in Modell-Ereignisse, führt den Agentenzustand,
// erkennt Subagenten und verwaltet Berechtigungsanfragen.
import { randomUUID } from 'node:crypto';
import { createAgent, createEvent, createPermission, kindToCategory } from '../core/model.js';
import { rpcErrorMessage } from './client.js';
import { trunc } from '../core/util.js';

const MAX_AGENT_EVENTS = 20;
const MAX_DIFF_TEXT = 64 * 1024;
const TEXT_THROTTLE_MS = 300;
const SUB_LINGER_MS = 3 * 60_000;


// letzter (angefangener) Satz für die Sprechblase
function lastSentence(text, n = 160) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const parts = t.split(/(?<=[.!?:])\s+/).filter(Boolean);
  return trunc(parts.length ? parts[parts.length - 1] : t, n);
}

// kurze Detailangabe aus den Werkzeug-Parametern
export function toolDetail(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw.command ?? raw.file_path ?? raw.path ?? raw.pattern ?? raw.url ?? raw.query ?? raw.description ?? raw.prompt;
  if (Array.isArray(v)) return trunc(v.join(' '), 80);
  return typeof v === 'string' ? trunc(v, 80) : null;
}

// Werkzeugaufruf, der einen Subagenten startet?
export function isSubagentCall(u) {
  const name = u._meta?.claudeCode?.toolName;
  return !!(u._meta?.agentcity?.subagent || name === 'Agent' || name === 'Task'
    || /^(Task|Agent):/.test(u.title ?? '')
    || (u.rawInput && typeof u.rawInput === 'object' && u.rawInput.subagent_type));
}

const compact = (e) => ({
  id: e.id, t: e.t, kind: e.kind, label: e.label ?? null, tool: e.tool ?? null, category: e.category ?? null,
  status: e.status ?? null, path: e.path ?? null, toolCallId: e.toolCallId ?? null,
  ...(e.ptyId ? { ptyId: e.ptyId, command: e.command ?? null } : {}),
});

// Diff-Ereignis: Texte auf je 64 KB begrenzt, Zeilenzahlen für die DB (dort ohne Texte)
export function diffPayload(c) {
  const cut = (t) => (typeof t === 'string' && t.length > MAX_DIFF_TEXT ? t.slice(0, MAX_DIFF_TEXT) : t ?? null);
  const lines = (t) => (typeof t === 'string' ? t.split('\n').length : 0);
  const truncated = (c.oldText?.length ?? 0) > MAX_DIFF_TEXT || (c.newText?.length ?? 0) > MAX_DIFF_TEXT;
  return {
    path: c.path, oldText: cut(c.oldText), newText: cut(c.newText) ?? '', oldLines: lines(c.oldText), newLines: lines(c.newText),
    label: c.path, ...(truncated ? { truncated: true } : {}),
  };
}

// Befehlszeile für die Anzeige
export function commandLine(command, args = []) {
  return [command, ...(Array.isArray(args) ? args : [])].filter((x) => x != null && x !== '').join(' ');
}

export function createAcpSession({
  agent, client, state, bus, repo, pty = null, ownsSession = () => true, subLingerMs = SUB_LINGER_MS, textThrottleMs = TEXT_THROTTLE_MS,
}) {
  const id = agent.id;
  let cur = agent;
  const openTools = new Map(); // toolCallId → { owner, title, kind }
  const subByTool = new Map(); // toolCallId (Subagent-Aufruf) → Sub-Agent-Id
  const subBySession = new Map(); // ACP-Kind-Session (subagent_update) → Sub-Agent-Id
  const pending = new Map(); // permissionId → { perm, resolve, key }
  const alwaysAllow = new Set();
  const timers = new Set();
  const displays = new Map(); // terminal_id (Adapter, _meta.terminal_info) → { owner, ptyId, command, toolCallId, fed }
  const doneDisplays = new Set(); // beendete terminal_ids (Nachzügler-Updates ignorieren), begrenzt
  let segment = null; // { id, role, text, owner }
  let turnText = '';
  let busy = false;
  let loading = false;
  let closing = false;
  let currentMeeting = null;
  let textTimer = null;
  let pendingText = null;

  const sessionId = () => get()?.sessionId ?? agent.sessionId;
  // nach close() nie auf den letzten Stand zurückfallen (sonst entstünde ein Geister-Agent)
  function get(aid = id) { return state.get(aid) ?? (aid === id && !closing ? cur : null); }

  // Agent ändern und veröffentlichen
  function patch(changes, aid = id) {
    if (closing) return null;
    const base = get(aid);
    if (!base) return null;
    const next = { ...base, ...changes, lastActivity: Date.now() };
    if (aid === id) cur = next;
    state.upsert(next);
    return next;
  }

  function emitEvent(kind, payload, aid = id) {
    if (closing) return null;
    const event = createEvent(aid, kind, { sessionId: get()?.sessionId ?? agent.sessionId, ...payload });
    bus.emit('event', { event });
    const a = get(aid);
    if (a) patch({ events: [...(a.events ?? []), compact(event)].slice(-MAX_AGENT_EVENTS) }, aid);
    return event;
  }

  function later(fn, ms) {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    t.unref?.();
    timers.add(t);
    return t;
  }

  // ------------------------------------------------------------------ Chat-Segmente
  function closeSegment() {
    if (!segment) return;
    const s = segment;
    segment = null;
    flushText();
    if (!s.text) return;
    const message = { id: s.id, role: s.role, text: s.text, t: s.t, ...(currentMeeting ? { meetingId: currentMeeting } : {}) };
    bus.emit('chat.message', { agentId: s.owner, message });
  }

  function chunk(role, text, owner = id) {
    if (!text) return;
    if (!segment || segment.role !== role || segment.owner !== owner) {
      closeSegment();
      segment = { id: randomUUID(), role, text: '', owner, t: Date.now() };
      if (role === 'agent' && owner === id && turnText && !loading) turnText = turnText.trimEnd() + '\n\n';
    }
    segment.text += text;
    bus.emit('chat.chunk', { agentId: owner, messageId: segment.id, role: role === 'thought' ? 'thought' : role, text });
    if (role === 'agent' && !loading) {
      if (owner === id) turnText += text;
      pendingText = { owner, text: lastSentence(segment.text) };
      if (!textTimer) textTimer = later(flushText, textThrottleMs);
    }
  }

  function flushText() {
    if (textTimer) { clearTimeout(textTimer); timers.delete(textTimer); textTimer = null; }
    if (!pendingText) return;
    const { owner, text } = pendingText;
    pendingText = null;
    const a = get(owner);
    if (!a) return;
    const changes = { lastText: text };
    if (owner === id && busy && a.status !== 'waiting_permission' && !openOf(id)) Object.assign(changes, { status: 'thinking', tool: null, category: null, detail: null });
    patch(changes, owner);
  }

  const openOf = (owner) => [...openTools.values()].filter((t) => t.owner === owner).length;

  // ------------------------------------------------------------------ Subagenten
  function createSub({ key, description, agentType, title }) {
    const main = get();
    const sub = createAgent({
      id: `a:${randomUUID()}`, kind: 'sub', toolId: main.toolId, sessionId: main.sessionId, acpSessionId: main.acpSessionId,
      parentId: id, project: main.project, cwd: main.cwd, description: description || title || 'Subagent',
      agentType: agentType ?? null, model: main.model, source: 'acp', controllable: false, status: 'thinking',
    });
    sub.subKey = key;
    state.upsert(sub);
    return sub.id;
  }

  function finishSub(subId, failed = false) {
    const a = get(subId);
    if (!a || a.status === 'done') return;
    for (const [k, t] of openTools) if (t.owner === subId) openTools.delete(k);
    patch({ status: 'done', tool: null, category: null, detail: null, ...(failed ? { error: { message: 'Subagent fehlgeschlagen' } } : {}) }, subId);
    later(() => {
      state.remove(subId);
      for (const m of [subByTool, subBySession]) for (const [k, v] of m) if (v === subId) m.delete(k);
    }, subLingerMs);
  }

  const ownerOf = (u) => {
    const parent = u._meta?.claudeCode?.parentToolUseId;
    if (parent && subByTool.has(parent)) return subByTool.get(parent);
    return openTools.get(u.toolCallId)?.owner ?? id;
  };

  // ------------------------------------------------------------------ Updates
  function onUpdate(u) {
    if (closing || !u || typeof u !== 'object') return;
    try {
      handleUpdate(u);
    } catch (err) {
      console.warn('[acp] Update nicht verarbeitet:', u.sessionUpdate, err?.message ?? err);
    }
  }

  function handleUpdate(u) {
    switch (u.sessionUpdate) {
      case 'user_message_chunk':
        if (loading && u.content?.type === 'text') chunk('user', u.content.text);
        return;
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        if (u.content?.type !== 'text') return;
        const owner = ownerOf(u);
        const role = u.sessionUpdate === 'agent_thought_chunk' ? 'thought' : 'agent';
        // Text eines Subagenten nur als Sprechblase, nicht im Haupt-Chat
        if (owner !== id) { if (role === 'agent') patch({ lastText: lastSentence(u.content.text) }, owner); return; }
        chunk(role, u.content.text);
        return;
      }
      case 'tool_call': return onToolCall(u);
      case 'tool_call_update': return onToolUpdate(u);
      case 'plan': return setPlan(u.entries ?? []);
      case 'plan_update':
        if (u.plan?.type === 'items') setPlan(u.plan.entries ?? []);
        return;
      case 'plan_removed': return setPlan([]);
      case 'usage_update': {
        const model = u._meta?.['_claude/model'];
        if (get().context?.used === u.used && (!model || model === get().model)) return;
        patch({ context: { used: u.used, size: u.size, cost: u.cost ?? null }, ...(model ? { model } : {}) });
        if (!loading) emitEvent('usage', { used: u.used, size: u.size, cost: u.cost ?? null, label: `${u.used} / ${u.size}` });
        return;
      }
      case 'current_mode_update': patch({ mode: u.currentModeId }); return;
      case 'session_info_update':
        if (u.title) { patch({ title: u.title }); repo?.updateSessionTitle?.(sessionId(), u.title); }
        return;
      case 'available_commands_update':
        patch({ commands: (u.availableCommands ?? []).map((c) => ({ name: c.name, description: c.description ?? '' })) });
        return;
      case 'subagent_update': return onSubagentUpdate(u);
      default:
    }
  }

  function onToolCall(u) {
    if (loading) return;
    // derselbe Aufruf erneut gemeldet → wie ein Update behandeln
    if (openTools.has(u.toolCallId) || subByTool.has(u.toolCallId)) { onToolUpdate(u); return; }
    closeSegment();
    const parentSub = ownerOf(u);
    const kind = u.kind ?? 'other';
    const category = kindToCategory(kind);
    const detail = toolDetail(u.rawInput);
    const title = u.title || u._meta?.claudeCode?.toolName || 'Werkzeug';

    if (isSubagentCall(u)) {
      const raw = u.rawInput ?? {};
      const subId = createSub({
        key: u.toolCallId, title: title.replace(/^(Task|Agent):\s*/, ''),
        description: raw.description, agentType: raw.subagent_type,
      });
      subByTool.set(u.toolCallId, subId);
    }
    openTools.set(u.toolCallId, { owner: parentSub, title, kind });
    const owner = get(parentSub);
    patch({ status: 'tool', tool: title, category, detail, toolCount: (owner?.toolCount ?? 0) + 1 }, parentSub);
    if (parentSub !== id && get().status !== 'waiting_permission') patch({ status: 'tool' });
    emitEvent('tool', { toolCallId: u.toolCallId, tool: title, toolKind: kind, category, detail, label: detail ?? '', status: u.status ?? 'pending' }, parentSub);
    displayTerminal(u, parentSub);
  }

  function onToolUpdate(u) {
    if (loading) return;
    const owner = ownerOf(u);
    const open = openTools.get(u.toolCallId);
    // nachgereichte Parameter eines Subagenten-Aufrufs
    const subId = subByTool.get(u.toolCallId);
    if (subId && u.rawInput && typeof u.rawInput === 'object') {
      const changes = {};
      if (u.rawInput.description) changes.description = u.rawInput.description;
      if (u.rawInput.subagent_type) changes.agentType = u.rawInput.subagent_type;
      if (Object.keys(changes).length) patch(changes, subId);
    }
    if (open && (u.title || u.kind)) {
      open.title = u.title ?? open.title;
      open.kind = u.kind ?? open.kind;
      const a = get(owner);
      const detail = toolDetail(u.rawInput) ?? a?.detail ?? null;
      // nachgereichter Titel (z. B. „Terminal“ → Befehl) auch im kompakten Ereignis
      const events = (a?.events ?? []).map((e) => (e.kind === 'tool' && e.toolCallId === u.toolCallId
        ? { ...e, tool: open.title, category: kindToCategory(open.kind), label: toolDetail(u.rawInput) ?? e.label } : e));
      if (a) patch({ events, ...(a.status === 'tool' ? { tool: open.title, category: kindToCategory(open.kind), detail } : {}) }, owner);
    }
    const content = Array.isArray(u.content) ? u.content : [];
    for (const c of content) {
      if (c?.type === 'diff') emitEvent('diff', { toolCallId: u.toolCallId, ...diffPayload(c) }, owner);
    }
    const finished = u.status === 'completed' || u.status === 'failed';
    displayTerminal(u, owner, finished);
    if (finished || content.length) {
      emitEvent('tool_update', { toolCallId: u.toolCallId, status: u.status ?? null, tool: open?.title ?? u.title ?? null, label: u.status ?? '' }, owner);
    }
    if (!finished) return;
    openTools.delete(u.toolCallId);
    if (subId) finishSub(subId, u.status === 'failed');
    if (owner !== id && get(owner)?.status === 'tool' && !openOf(owner)) patch({ status: 'thinking', tool: null, category: null, detail: null }, owner);
    const main = get();
    if (busy && main.status === 'tool' && !openOf(id) && !subsRunning()) patch({ status: 'thinking', tool: null, category: null, detail: null });
  }

  const subsRunning = () => [...subByTool.values(), ...subBySession.values()].some((s) => {
    const a = get(s);
    return a && a.status !== 'done';
  });

  function onSubagentUpdate(u) {
    let subId = subBySession.get(u.sessionId);
    if (!subId) {
      subId = createSub({ key: u.sessionId, title: u.title, description: u.description });
      subBySession.set(u.sessionId, subId);
    }
    const changes = {};
    if (u.title) changes.description = u.description || u.title;
    const st = u.state?.state;
    if (st === 'running') changes.status = 'thinking';
    if (st === 'requires_action') changes.status = 'waiting_permission';
    if (Object.keys(changes).length) patch(changes, subId);
    if (st === 'idle') finishSub(subId);
  }

  function setPlan(entries) {
    if (!Array.isArray(entries)) return;
    const plan = entries.filter((e) => e && typeof e === 'object').map((e) => ({ content: e.content, status: e.status, priority: e.priority }));
    patch({ plan });
    if (!loading) emitEvent('plan', { entries: plan, label: `${plan.filter((e) => e.status === 'completed').length}/${plan.length}` });
  }

  // ------------------------------------------------------------------ Terminals
  // Terminal-Ereignis (Agenten-Terminal über ACP terminal/create oder Anzeige-Terminal des Adapters);
  // die Figur geht dabei zur Terminal-Station
  function terminalEvent({ ptyId, command, args = [], display = false }, owner = id) {
    const line = commandLine(command, args) || 'Terminal';
    emitEvent('terminal', { ptyId, command: line, args, category: 'terminal', label: trunc(line, 90), ...(display ? { display: true } : {}) }, owner);
    const a = get(owner);
    if (!a || !busy || a.status === 'waiting_permission') return;
    patch({ status: 'tool', category: 'terminal', tool: a.status === 'tool' && a.tool ? a.tool : 'Terminal', detail: trunc(line, 80) }, owner);
  }

  // ACP terminal/create (von acp/terminal.js gemeldet)
  function terminalStarted(t) {
    if (closing || loading) return;
    terminalEvent(t);
  }

  // _meta.terminal_info/_output/_exit (Claude-/Codex-Adapter): Ausgabe als Anzeige-Terminal ohne Prozess
  function displayTerminal(u, owner, finished = false) {
    if (!pty || loading) return;
    const meta = u._meta ?? {};
    const termId = meta.terminal_info?.terminal_id ?? meta.terminal_output?.terminal_id ?? meta.terminal_output_delta?.terminal_id
      ?? meta.terminal_exit?.terminal_id ?? (displays.has(u.toolCallId) ? u.toolCallId : null);
    if (typeof termId !== 'string' || !termId || doneDisplays.has(termId)) return;
    let d = displays.get(termId);
    if (!d) { d = { owner, ptyId: null, command: null, toolCallId: u.toolCallId, fed: '' }; displays.set(termId, d); }
    const cmd = u.rawInput && typeof u.rawInput === 'object' && typeof u.rawInput.command === 'string' ? u.rawInput.command : null;
    if (cmd) d.command = cmd;
    const out = meta.terminal_output_delta ?? meta.terminal_output;
    const exit = meta.terminal_exit;
    // erst anlegen, wenn der Befehl bekannt ist oder Ausgabe/Ende kommt (Parameter streamen nach)
    if (!d.ptyId && (d.command || out || exit || finished)) {
      d.ptyId = pty.openDisplay({ agentId: d.owner, ownerId: id, command: d.command ?? openTools.get(u.toolCallId)?.title ?? null, cwd: get()?.cwd ?? null }).ptyId;
      terminalEvent({ ptyId: d.ptyId, command: d.command ?? openTools.get(u.toolCallId)?.title ?? 'Befehl', display: true }, d.owner);
    }
    if (!d.ptyId) return;
    if (out && typeof out.data === 'string' && out.data) {
      // terminal_output_delta = Zuwachs; terminal_output kann kumuliert sein (der Claude-Adapter schickt die
      // vollständige Ausgabe einmal am Ende) → nur den neuen Teil anhängen
      let data = out.data;
      if (!meta.terminal_output_delta && d.fed && data.startsWith(d.fed)) data = data.slice(d.fed.length);
      d.fed = meta.terminal_output_delta ? d.fed + out.data : out.data;
      if (d.fed.length > 256 * 1024) d.fed = '';
      if (data) pty.feed(d.ptyId, data.replace(/\r?\n/g, '\r\n'));
    }
    if (exit || finished) {
      if (exit) pty.finish(d.ptyId, exit.exit_code ?? null, exit.signal ?? null);
      else pty.finish(d.ptyId, u.status === 'failed' ? 1 : null, null);
      displays.delete(termId);
      doneDisplays.add(termId);
      if (doneDisplays.size > 200) doneDisplays.delete(doneDisplays.values().next().value);
    }
  }

  // ------------------------------------------------------------------ Berechtigungen
  const permKey = (req) => req.toolCall?._meta?.claudeCode?.toolName ?? req.toolCall?.title ?? req.toolCall?.kind ?? 'tool';
  const firstAllow = (options) => options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind?.startsWith('allow'));

  function onPermission(req, resolve) {
    if (closing) { resolve({ outcome: 'cancelled' }); return; }
    flushText();
    const perm = createPermission(id, req);
    const key = permKey(req);
    const owner = ownerOf(req.toolCall ?? {});
    if (owner !== id) perm.subAgentId = owner;
    perm.toolId = get().toolId;
    try { repo?.insertPermission?.(perm, sessionId()); } catch (err) { console.error('[acp] Berechtigung', err.message); }

    // Auto-Freigabe nur aus dem City-Modus, nie aus dem Modus des Tools
    const auto = get().cityMode === 'auto' || alwaysAllow.has(key);
    const allow = auto && firstAllow(req.options ?? []);
    if (allow) {
      resolve({ outcome: 'selected', optionId: allow.optionId });
      try { repo?.resolvePermission?.(perm.id, allow.optionId); } catch { /* DB optional */ }
      emitEvent('permission', { permissionId: perm.id, title: perm.title, optionId: allow.optionId, auto: true, label: `${perm.title} (automatisch)` });
      return;
    }

    pending.set(perm.id, { perm, resolve, key });
    state.permissions.set(perm.id, perm);
    bus.emit('permission.request', { permission: perm });
    patch({ status: 'waiting_permission' });
    if (owner !== id) patch({ status: 'waiting_permission' }, owner);
    emitEvent('permission', { permissionId: perm.id, title: perm.title, label: perm.title });
  }

  // optionId 'cancel' = Abbruch
  function answer(permissionId, optionId) {
    const p = pending.get(permissionId);
    if (!p) throw new Error('Berechtigung nicht (mehr) offen');
    const option = p.perm.options.find((o) => o.optionId === optionId);
    if (optionId !== 'cancel' && !option) throw new Error(`Unbekannte Option: ${optionId}`);
    pending.delete(permissionId);
    state.permissions.delete(permissionId);
    p.resolve(optionId === 'cancel' ? { outcome: 'cancelled' } : { outcome: 'selected', optionId });
    if (option?.kind === 'allow_always') alwaysAllow.add(p.key);
    try { repo?.resolvePermission?.(permissionId, optionId); } catch { /* DB optional */ }
    bus.emit('permission.resolved', { permissionId, optionId });
    emitEvent('permission', { permissionId, optionId, title: p.perm.title, label: `${p.perm.title} → ${option?.name ?? 'abgebrochen'}` });
    if (p.perm.subAgentId && get(p.perm.subAgentId)?.status === 'waiting_permission') patch({ status: 'tool' }, p.perm.subAgentId);
    if (!pending.size && get()?.status === 'waiting_permission') {
      patch(busy ? { status: openOf(id) || subsRunning() ? 'tool' : 'thinking' } : { status: 'waiting_user' });
    }
    return { ok: true };
  }

  function cancelPending() {
    for (const [pid] of pending) answer(pid, 'cancel');
  }

  // ------------------------------------------------------------------ Prompt, Abbruch, Ende
  async function prompt(text, { meetingId = null } = {}) {
    if (closing || !client.running) throw new Error('Session ist beendet');
    if (busy) throw new Error('Agent arbeitet noch – erst abbrechen oder warten');
    busy = true;
    turnText = '';
    currentMeeting = meetingId;
    const message = { id: randomUUID(), role: 'user', text, t: Date.now(), ...(meetingId ? { meetingId } : {}) };
    bus.emit('chat.message', { agentId: id, message });
    try { repo?.insertMessage?.({ ...message, sessionId: sessionId(), agentId: id }); } catch { /* DB optional */ }
    emitEvent('prompt', { text, label: trunc(text, 90), ...(meetingId ? { meetingId } : {}) });
    patch({ status: 'thinking', lastPrompt: trunc(text, 200), lastText: null, error: null, tool: null, category: null, detail: null });

    let res;
    try {
      res = await client.prompt(text);
    } catch (err) {
      busy = false;
      closeSegment();
      cancelPending();
      // endet gerade der Prozess, kümmert sich onExit um den Fehlerzustand
      let wait;
      await Promise.race([client.closed, new Promise((r) => { wait = setTimeout(r, 300); wait.unref?.(); })]);
      clearTimeout(wait);
      if (!client.running || closing) return { stopReason: 'error' };
      const msg = rpcErrorMessage(err);
      patch({ status: 'error', error: { message: msg, stderrTail: client.stderrTail?.(20) ?? '' } });
      emitEvent('error', { message: msg, label: trunc(msg, 90) });
      bus.emit('toast', { level: 'error', text: `${get().title || 'Agent'}: ${trunc(msg, 140)}` });
      return { stopReason: 'error', error: msg };
    }
    busy = false;
    if (closing || !get()) return { stopReason: res?.stopReason ?? 'cancelled' };
    closeSegment();
    for (const [k, t] of openTools) if (t.owner === id) openTools.delete(k);
    const u = res?.usage;
    const tokens = { ...get().tokens };
    if (u) {
      tokens.input += u.inputTokens ?? 0;
      tokens.output += u.outputTokens ?? 0;
      tokens.cache += (u.cachedReadTokens ?? 0) + (u.cachedWriteTokens ?? 0);
    }
    patch({ status: 'waiting_user', tool: null, category: null, detail: null, tokens });
    const stopReason = res?.stopReason ?? 'end_turn';
    if (turnText) {
      const reply = { id: randomUUID(), role: 'agent', text: turnText, t: Date.now(), ...(meetingId ? { meetingId } : {}) };
      try { repo?.insertMessage?.({ ...reply, sessionId: sessionId(), agentId: id }); } catch { /* DB optional */ }
      emitEvent('text', { label: trunc(turnText, 90) });
    }
    emitEvent('status', { status: 'waiting_user', stopReason, label: stopReason });
    if (stopReason === 'cancelled') bus.emit('toast', { level: 'info', text: `${get().title || 'Agent'}: abgebrochen` });
    if (stopReason === 'refusal' || stopReason === 'max_tokens') bus.emit('toast', { level: 'warn', text: `${get().title || 'Agent'}: beendet (${stopReason})` });
    bus.emit('session.turnEnd', { agentId: id, stopReason, text: turnText, meetingId });
    currentMeeting = null;
    return { stopReason };
  }

  async function cancel() {
    cancelPending();
    if (busy) await client.cancel();
  }

  function setCityMode(cityMode) {
    if (cityMode !== 'confirm' && cityMode !== 'auto') throw new Error(`Unbekannter City-Modus: ${cityMode}`);
    patch({ cityMode });
    // offene Rückfragen sofort freigeben, wenn auf Auto umgestellt wird
    if (cityMode === 'auto') {
      for (const [pid, p] of [...pending]) {
        const allow = firstAllow(p.perm.options);
        if (allow) answer(pid, allow.optionId);
      }
    }
  }

  async function setMode(modeId) {
    await client.setMode(modeId);
    patch({ mode: modeId });
  }

  // Verlauf einer geladenen Session (session/load) als Chat wiedergeben, ohne Statuswechsel
  async function load(fn) {
    loading = true;
    try { return await fn(); } finally { closeSegment(); loading = false; }
  }

  function onExit(info) {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const d of displays.values()) if (d.ptyId) pty?.finish(d.ptyId);
    busy = false;
    closeSegment();
    cancelPending();
    for (const s of [...subByTool.values(), ...subBySession.values()]) {
      if (closing) state.remove(s); else if (get(s)?.status !== 'done') patch({ status: 'done' }, s);
    }
    if (closing) return;
    const message = info.error ?? `Agent-Prozess beendet (Code ${info.code ?? info.signal ?? '?'})`;
    patch({ status: 'error', tool: null, category: null, detail: null, error: { message, code: info.code ?? null, signal: info.signal ?? null, stderrTail: info.stderrTail ?? '' } });
    emitEvent('error', { message, code: info.code ?? null, label: trunc(message, 90) });
    try { if (ownsSession()) repo?.endSession?.(sessionId(), 'error'); } catch { /* DB optional */ }
  }

  async function close() {
    closing = true;
    cancelPending();
    for (const t of timers) clearTimeout(t);
    timers.clear();
    await client.stop();
  }

  client.on('update', onUpdate);
  client.on('permission', onPermission);
  client.on('exit', onExit);

  return {
    id, get, prompt, cancel, answer, setMode, setCityMode, load, close, terminalStarted,
    get busy() { return busy; },
    hasPermission: (pid) => pending.has(pid),
    pendingPermissions: () => [...pending.values()].map((p) => p.perm),
  };
}
