// Codex-Watcher: liest ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl inkrementell mit.
// Zeilen: { timestamp, type: session_meta|turn_context|response_item|event_msg|…, payload: { type, … } }
//   response_item: message (role user|assistant|developer), reasoning, function_call(+_output),
//                  custom_tool_call(+_output), local_shell_call, web_search_call, tool_search_call
//   event_msg:     task_started, user_message, agent_message, token_count, task_complete, turn_aborted
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createAgent } from '../core/model.js';
import {
  trunc, base, lineHash, agedStatus, guessCategory, readRange, onceLogger, MAX_EVENTS, SNAPSHOT_EVENTS,
} from './common.js';

const HEAD_BYTES = 512 * 1024;
const TAIL_BYTES = 1024 * 1024;
const FULL_LIMIT = 4 * 1024 * 1024;
const ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export const codexId = (sessionId) => `w:codex:${sessionId}`;

const CATEGORY = {
  exec_command: 'terminal', exec: 'terminal', shell: 'terminal', local_shell: 'terminal', local_shell_call: 'terminal',
  write_stdin: 'terminal', wait: 'terminal', unified_exec: 'terminal', container_exec: 'terminal',
  apply_patch: 'workbench',
  update_plan: 'meeting', spawn_agent: 'meeting', wait_agent: 'meeting', send_input: 'meeting', close_agent: 'meeting',
  tool_search: 'library', view_image: 'library', read_file: 'library', list_dir: 'library', grep_files: 'library',
  web_search: 'portal', web_search_call: 'portal',
  request_user_input: 'lounge',
};
export const codexCategory = (name) => CATEGORY[name] ?? guessCategory(name);

function parseArgs(s) {
  if (s && typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return {}; }
}

// Kurzbeschreibung eines Werkzeugaufrufs
function toolDetail(name, p) {
  if (name === 'apply_patch') {
    const text = typeof p.input === 'string' ? p.input : parseArgs(p.arguments).patch ?? parseArgs(p.arguments).input ?? '';
    const m = String(text).match(/\*\*\* (?:Update|Add|Delete) File: (.+)/) ?? String(text).match(/^\+\+\+ (?:b\/)?(.+)$/m);
    return m ? base(m[1].trim()) : null;
  }
  const a = p.type === 'local_shell_call' ? p.action ?? {} : parseArgs(p.arguments ?? p.input);
  const cmd = a.cmd ?? a.command;
  if (cmd) return trunc(Array.isArray(cmd) ? cmd.filter((x) => !/^(bash|zsh|sh|\/bin\/\w+sh)$/.test(x) && x !== '-lc').join(' ') : cmd, 80);
  return trunc(a.description ?? a.query ?? a.path ?? a.prompt ?? a.message ?? '', 60) || null;
}

const textOf = (content) => (Array.isArray(content) ? content : [])
  .filter((c) => c && (c.type === 'output_text' || c.type === 'text' || c.type === 'Text') && c.text)
  .map((c) => c.text).join('\n');

function newRaw(sessionId) {
  return {
    id: codexId(sessionId), sessionId, cwd: null, title: null, model: null, status: 'idle', tool: null, category: null,
    detail: null, lastText: null, lastPrompt: null, lastActivity: 0, startedAt: null,
    tokens: { input: 0, output: 0, cache: 0 }, toolCount: 0, events: [], pending: new Map(),
  };
}

export function createCodexWatcher({ root, windowMs = 90 * 60_000 }) {
  const trackers = new Map(); // Datei → { offset, rest, agent, lineId, lineSeq, mtime }
  let fresh = [];
  const log = onceLogger('codex');

  function pushEvent(tr, ev) {
    const a = tr.agent;
    const event = { id: `${a.id}:${tr.lineId}:${tr.lineSeq++}`, agentId: a.id, ...ev };
    a.events.push(event);
    if (a.events.length > MAX_EVENTS) a.events.shift();
    fresh.push({ ...event, sessionId: a.sessionId });
  }

  function takeEvents() { const out = fresh; fresh = []; return out; }

  const idle = (a) => { a.tool = null; a.category = null; a.detail = null; };

  function applyLine(tr, d) {
    const a = tr.agent;
    const p = d.payload ?? {};
    const t = d.timestamp ? Date.parse(d.timestamp) : NaN;
    const touch = () => {
      if (Number.isNaN(t)) return;
      a.lastActivity = Math.max(a.lastActivity, t);
      if (!a.startedAt) a.startedAt = t;
    };

    if (d.type === 'session_meta') {
      if (p.cwd) a.cwd = p.cwd;
      const st = Date.parse(p.timestamp ?? d.timestamp);
      if (!Number.isNaN(st)) a.startedAt = st;
      touch();
      return;
    }
    if (d.type === 'turn_context') {
      if (p.cwd && !a.cwd) a.cwd = p.cwd;
      if (p.model) a.model = p.model;
      return;
    }
    if (d.type === 'event_msg') {
      switch (p.type) {
        case 'task_started':
          touch(); a.status = 'thinking'; idle(a); return;
        case 'user_message': {
          touch();
          const text = p.message ?? '';
          if (!text.trim()) return;
          a.lastPrompt = trunc(text, 220);
          if (!a.title) a.title = trunc(text, 60);
          a.pending.clear(); a.status = 'thinking'; idle(a);
          pushEvent(tr, { t, kind: 'prompt', label: trunc(text, 90) });
          return;
        }
        case 'item_completed': {
          // neueres Format: Nutzer-Nachricht als Item
          const it = p.item ?? {};
          if (it.type !== 'UserMessage') return;
          const text = textOf(it.content);
          if (!text.trim()) return;
          touch();
          a.lastPrompt = trunc(text, 220);
          if (!a.title) a.title = trunc(text, 60);
          a.status = 'thinking';
          pushEvent(tr, { t, kind: 'prompt', label: trunc(text, 90) });
          return;
        }
        case 'token_count': {
          const u = p.info?.total_token_usage;
          if (u) {
            const cached = u.cached_input_tokens ?? 0;
            a.tokens = { input: Math.max(0, (u.input_tokens ?? 0) - cached), output: u.output_tokens ?? 0, cache: cached };
          }
          return;
        }
        case 'task_complete':
        case 'turn_aborted':
          touch(); a.pending.clear(); a.status = 'waiting_user'; idle(a); return;
        default:
          return;
      }
    }
    if (d.type !== 'response_item') return;
    switch (p.type) {
      case 'message': {
        if (p.role !== 'assistant') return;
        touch();
        const text = textOf(p.content);
        if (!text.trim()) return;
        a.lastText = trunc(text, 220);
        if (a.pending.size === 0 && a.status !== 'waiting_user') { a.status = 'thinking'; idle(a); }
        pushEvent(tr, { t, kind: 'text', label: trunc(text, 90) });
        return;
      }
      case 'reasoning':
        touch();
        if (a.pending.size === 0) { a.status = 'thinking'; idle(a); }
        return;
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call':
      case 'web_search_call':
      case 'tool_search_call': {
        touch();
        const name = p.name ?? (p.type === 'local_shell_call' ? 'shell' : p.type === 'web_search_call' ? 'web_search' : p.type === 'tool_search_call' ? 'tool_search' : 'tool');
        const category = codexCategory(name);
        const detail = toolDetail(name, p);
        const callId = p.call_id ?? p.id ?? `${tr.lineId}`;
        // Websuche/Toolsuche haben keine eigene Ausgabezeile → nicht offen halten
        if (p.type !== 'web_search_call' && p.type !== 'tool_search_call') a.pending.set(callId, { name, category, detail });
        a.tool = name; a.category = category; a.detail = detail; a.status = 'tool';
        a.toolCount++;
        pushEvent(tr, { t, kind: 'tool', tool: name, category, label: detail });
        return;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'tool_search_output': {
        touch();
        a.pending.delete(p.call_id);
        if (a.pending.size === 0) { a.status = 'thinking'; idle(a); } else {
          const last = [...a.pending.values()].pop();
          a.tool = last.name; a.category = last.category; a.detail = last.detail;
        }
        return;
      }
      default:
        return;
    }
  }

  function feed(tr, buf, pos, { skipFirst = false } = {}) {
    const data = tr.rest.length ? Buffer.concat([tr.rest, buf]) : buf;
    const dataPos = pos - tr.rest.length;
    let start = 0;
    if (skipFirst) {
      const nl = data.indexOf(10);
      if (nl === -1) { tr.rest = Buffer.alloc(0); return; }
      start = nl + 1;
    }
    let idx;
    while ((idx = data.indexOf(10, start)) !== -1) {
      const line = data.subarray(start, idx).toString('utf8');
      const linePos = dataPos + start;
      start = idx + 1;
      if (!line.trim()) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      tr.lineId = `${linePos.toString(36)}.${lineHash(line)}`;
      tr.lineSeq = 0;
      try { applyLine(tr, d); } catch (err) { log('Zeile', err); }
    }
    tr.rest = Buffer.from(data.subarray(start));
  }

  async function syncFile(file, st, sessionId) {
    let tr = trackers.get(file);
    if (tr && st.size < tr.offset) { trackers.delete(file); tr = null; }
    if (!tr) {
      tr = { file, offset: 0, rest: Buffer.alloc(0), agent: newRaw(sessionId), lineId: '', lineSeq: 0, mtime: st.mtimeMs };
      trackers.set(file, tr);
      if (st.size <= FULL_LIMIT) {
        feed(tr, await readRange(file, 0, st.size), 0);
      } else {
        // große Session: Anfang (Metadaten, erster Prompt) und Ende (aktueller Zustand)
        feed(tr, await readRange(file, 0, HEAD_BYTES), 0);
        tr.rest = Buffer.alloc(0);
        tr.agent.pending.clear();
        feed(tr, await readRange(file, st.size - TAIL_BYTES, st.size), st.size - TAIL_BYTES, { skipFirst: true });
      }
      tr.offset = st.size;
      return;
    }
    tr.mtime = st.mtimeMs;
    if (st.size > tr.offset) {
      feed(tr, await readRange(file, tr.offset, st.size), tr.offset);
      tr.offset = st.size;
    }
  }

  // Tagesordner im Zeitfenster (lokal und UTC, Dateien liegen nach Ortszeit)
  function dayDirs(now) {
    const dirs = new Set();
    const pad = (n) => String(n).padStart(2, '0');
    for (let t = now - windowMs - 3_600_000; t <= now + 3_600_000; t += 1_800_000) {
      const d = new Date(t);
      dirs.add(path.join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())));
      dirs.add(path.join(root, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())));
    }
    return [...dirs];
  }

  let scanning = false;
  async function scan() {
    if (scanning) return;
    scanning = true;
    const now = Date.now();
    try {
      const seen = new Set();
      // bereits verfolgte Dateien (auch aus älteren Tagesordnern) und neue im Fenster
      const files = new Set(trackers.keys());
      for (const dir of dayDirs(now)) {
        let names;
        try { names = await fsp.readdir(dir); } catch { continue; }
        for (const n of names) if (n.startsWith('rollout-') && n.endsWith('.jsonl')) files.add(path.join(dir, n));
      }
      for (const file of files) {
        const m = file.match(ID_RE);
        if (!m) continue;
        let st;
        try { st = await fsp.stat(file); } catch { trackers.delete(file); continue; }
        if (now - st.mtimeMs > windowMs && !trackers.has(file)) continue;
        seen.add(file);
        try { await syncFile(file, st, m[1].toLowerCase()); } catch (err) { log(path.basename(file), err); }
      }
      // aus dem Fenster gefallene Tracker entfernen
      for (const [file, tr] of trackers) {
        if (!seen.has(file) || now - Math.max(tr.agent.lastActivity || 0, tr.mtime || 0) > windowMs) trackers.delete(file);
      }
    } finally {
      scanning = false;
    }
  }

  function agents(now = Date.now()) {
    const out = [];
    for (const tr of trackers.values()) {
      const a = tr.agent;
      if (!a.lastActivity) continue;
      const age = now - a.lastActivity;
      if (age > windowMs) continue;
      const status = agedStatus(a.status, age);
      const active = status === 'tool';
      const agent = createAgent({
        id: a.id, kind: 'main', toolId: 'codex', sessionId: a.sessionId, acpSessionId: a.sessionId,
        project: a.cwd ? path.basename(a.cwd) : 'codex', cwd: a.cwd, title: a.title, model: a.model, status,
        startedAt: a.startedAt ?? a.lastActivity, source: 'watch', controllable: false,
      });
      Object.assign(agent, {
        tool: active ? a.tool : null, category: active ? a.category : null, detail: active ? a.detail : null,
        lastText: a.lastText, lastPrompt: a.lastPrompt, lastActivity: a.lastActivity, tokens: { ...a.tokens },
        toolCount: a.toolCount, events: a.events.slice(-SNAPSHOT_EVENTS),
      });
      out.push(agent);
    }
    out.sort((x, y) => x.startedAt - y.startedAt);
    return out;
  }

  return { id: 'codex', adoptable: true, root, scan, agents, takeEvents, trackerCount: () => trackers.size };
}
