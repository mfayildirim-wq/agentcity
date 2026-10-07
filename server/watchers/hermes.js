// Hermes-Watcher: liest ~/.hermes/state.db (SQLite, nur lesend).
// Tabellen (Stand 0.14): sessions(id, source, model, parent_session_id, started_at, ended_at, title, system_prompt,
// tool_call_count, input_tokens, output_tokens, cache_read_tokens, …), messages(id, session_id, role user|assistant|tool,
// content, tool_calls JSON [{ function: { name, arguments } }], finish_reason, timestamp). Zeiten in Sekunden.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAgent } from '../core/model.js';
import {
  trunc, base, agedStatus, guessCategory, onceLogger, openReadOnly, dbPrint, errKind, SNAPSHOT_EVENTS, IDLE_MS,
} from './common.js';

const REFRESH_MS = 15_000;
const BACKOFF_MS = 30_000;
const MESSAGES = 30;

export const hermesId = (sessionId) => `w:hermes:${sessionId}`;

const CATEGORY = {
  terminal: 'terminal', execute_code: 'terminal', process: 'terminal',
  read_file: 'library', search_files: 'library', skill_view: 'library', skills_list: 'library', session_search: 'library',
  write_file: 'workbench', patch: 'workbench',
  web_search: 'portal', web_extract: 'portal',
  delegate_task: 'meeting', todo: 'meeting', send_message: 'meeting', memory: 'meeting',
  clarify: 'lounge',
};
export const hermesCategory = (name) => CATEGORY[name] ?? (String(name).startsWith('browser_') ? 'portal' : guessCategory(name));

const parse = (s, d = null) => { try { return JSON.parse(s); } catch { return d; } };

function toolDetail(name, args = {}) {
  if (args.command) return trunc(args.command, 80);
  if (args.path || args.file_path) return base(args.path || args.file_path);
  return trunc(args.query || args.pattern || args.url || args.goal || args.name || args.action || '', 60) || null;
}

// Hermes schreibt das Arbeitsverzeichnis in den System-Prompt
const cwdOf = (line) => line?.match(/Current working directory:\s*(\S.*)/)?.[1]?.trim() ?? null;

export function createHermesWatcher({ dbPath, windowMs = 90 * 60_000 }) {
  let db = null;
  let stmts = null;
  let lastPrint = '';
  let lastRead = 0;
  let cache = [];
  let backoffUntil = 0;
  let initial = true;
  const seenEvents = new Set();
  let fresh = [];
  const log = onceLogger('hermes');

  function open() {
    db = openReadOnly(DatabaseSync, dbPath);
    stmts = {
      active: db.prepare(`SELECT s.id, s.source, s.model, s.parent_session_id, s.started_at, s.ended_at, s.title,
          s.tool_call_count, s.input_tokens, s.output_tokens, s.cache_read_tokens,
          substr(s.system_prompt, instr(s.system_prompt, 'Current working directory:'), 400) AS cwd_line,
          MAX(s.started_at, COALESCE(s.ended_at, 0), COALESCE((SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id), 0)) AS last
        FROM sessions s WHERE (s.ended_at IS NULL OR s.ended_at > ?1) AND last > ?1 ORDER BY s.started_at`),
      messages: db.prepare(`SELECT id, role, substr(content, 1, 600) AS content, tool_calls, tool_name, finish_reason, timestamp
        FROM messages WHERE session_id = ? ORDER BY timestamp DESC, id DESC LIMIT ${MESSAGES}`),
    };
  }

  function close() {
    try { db?.close(); } catch { /* bereits zu */ }
    db = null;
    stmts = null;
  }

  function readSession(s) {
    const msgs = stmts.messages.all(s.id).reverse();
    const events = [];
    let lastText = null; let lastPrompt = null; let status = 'idle'; let running = null;
    for (const m of msgs) {
      const t = Math.round(m.timestamp * 1000);
      const eid = `${hermesId(s.id)}:${m.id}`;
      if (m.role === 'user') {
        const text = String(m.content ?? '').replace(/^\[Note:[^\]]*\]\s*/, '');
        if (text.trim()) {
          lastPrompt = trunc(text, 220);
          events.push({ id: eid, t, kind: 'prompt', label: trunc(text, 90) });
        }
        status = 'thinking'; running = null;
      } else if (m.role === 'assistant') {
        const calls = parse(m.tool_calls, []) ?? [];
        if (Array.isArray(calls) && calls.length) {
          calls.forEach((c, i) => {
            const name = c.function?.name ?? c.name ?? 'tool';
            const category = hermesCategory(name);
            const detail = toolDetail(name, parse(c.function?.arguments, {}) ?? {});
            events.push({ id: `${eid}:${i}`, t, kind: 'tool', tool: name, category, label: detail });
            running = { tool: name, category, detail };
          });
          status = 'tool';
        } else {
          if (m.content?.trim()) {
            lastText = trunc(m.content, 220);
            events.push({ id: eid, t, kind: 'text', label: trunc(m.content, 90) });
          }
          status = m.finish_reason === 'tool_calls' ? 'thinking' : 'waiting_user';
          running = null;
        }
      } else if (m.role === 'tool') {
        status = 'thinking'; running = null;
      }
    }
    const lastMs = Math.round(s.last * 1000);
    // beendete Session (CLI geschlossen) → pausiert
    if (s.ended_at) { status = 'idle'; running = null; }
    // Hermes schreibt Werkzeugaufrufe erst nach Abschluss – ohne neue Zeilen nicht ewig „arbeitet“ zeigen
    else if (status === 'tool' && Date.now() - lastMs > IDLE_MS) status = 'thinking';
    const cwd = cwdOf(s.cwd_line);
    return { ...s, cwd, lastMs, status, running: status === 'tool' ? running : null, lastText, lastPrompt, events };
  }

  // Verbindung je Scan öffnen und schließen
  async function scan() {
    const now = Date.now();
    if (now < backoffUntil) return;
    const p = dbPrint(dbPath);
    if (p === lastPrint && now - lastRead < REFRESH_MS) return;
    try {
      open();
      cache = stmts.active.all((now - windowMs) / 1000).map(readSession);
      lastPrint = p;
      lastRead = now;
      for (const s of cache) {
        for (const e of s.events) {
          if (seenEvents.has(e.id)) continue;
          seenEvents.add(e.id);
          if (!initial) fresh.push({ ...e, agentId: hermesId(s.id), sessionId: s.id });
        }
      }
      initial = false;
      if (seenEvents.size > 20_000) seenEvents.clear();
    } catch (err) {
      log(`Lesen (${errKind(err)})`, err);
      cache = [];
      backoffUntil = now + BACKOFF_MS;
    } finally {
      close();
    }
  }

  function takeEvents() { const out = fresh; fresh = []; return out; }

  function agents(now = Date.now()) {
    const out = [];
    for (const s of cache) {
      const age = now - s.lastMs;
      if (age > windowMs) continue;
      const status = agedStatus(s.status, age);
      const id = hermesId(s.id);
      const agent = createAgent({
        id, kind: 'main', toolId: 'hermes', sessionId: s.id, acpSessionId: s.id,
        project: s.cwd ? path.basename(s.cwd) : 'hermes', cwd: s.cwd, title: s.title || (s.lastPrompt ? trunc(s.lastPrompt, 60) : null),
        model: s.model, status, startedAt: Math.round(s.started_at * 1000), source: 'watch', controllable: false,
      });
      const r = status === 'tool' ? s.running : null;
      Object.assign(agent, {
        tool: r?.tool ?? null, category: r?.category ?? null, detail: r?.detail ?? null,
        lastText: s.lastText, lastPrompt: s.lastPrompt, lastActivity: s.lastMs,
        tokens: { input: s.input_tokens ?? 0, output: s.output_tokens ?? 0, cache: s.cache_read_tokens ?? 0 },
        toolCount: s.tool_call_count ?? 0, events: s.events.slice(-SNAPSHOT_EVENTS).map((e) => ({ ...e, agentId: id })),
      });
      out.push(agent);
    }
    return out;
  }

  return { id: 'hermes', adoptable: false, dbPath, scan, agents, takeEvents, close };
}
