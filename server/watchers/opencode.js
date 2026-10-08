// OpenCode-Watcher: liest ~/.local/share/opencode/opencode.db (SQLite, nur lesend).
// Tabellen (Stand 1.18): session(id, parent_id, directory, title, agent, model, time_created, time_updated,
// time_archived, tokens_*), message(id, session_id, time_created, data JSON {role, finish, time.completed, modelID}),
// part(id, message_id, session_id, time_created, data JSON {type: text|reasoning|tool|step-*, tool, state{status,input}})
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAgent } from '../core/model.js';
import {
  trunc, base, agedStatus, guessCategory, onceLogger, openReadOnly, dbPrint, errKind, SNAPSHOT_EVENTS,
} from './common.js';

const REFRESH_MS = 15_000; // spätestens so oft neu lesen, auch ohne Dateiänderung
const BACKOFF_MS = 30_000; // nach einem Lesefehler
const PARTS = 40;

export const opencodeId = (sessionId) => `w:opencode:${sessionId}`;
export const opencodeSubId = (sessionId) => `w:opencode:sub:${sessionId}`;

const CATEGORY = {
  bash: 'terminal', shell: 'terminal',
  edit: 'workbench', write: 'workbench', patch: 'workbench', multiedit: 'workbench', apply_patch: 'workbench',
  read: 'library', glob: 'library', grep: 'library', list: 'library', codesearch: 'library', lsp: 'library', skill: 'library',
  webfetch: 'portal', websearch: 'portal',
  task: 'meeting', todowrite: 'meeting', todoread: 'meeting',
  question: 'lounge', plan_enter: 'lounge', plan_exit: 'lounge',
};
export const opencodeCategory = (name) => CATEGORY[name] ?? guessCategory(name);

function modelName(m) {
  if (!m) return null;
  try { const j = JSON.parse(m); return j.id ?? j.modelID ?? null; } catch { return String(m); }
}

export function createOpencodeWatcher({ dbPath, windowMs = 90 * 60_000 }) {
  let db = null;
  let stmts = null;
  let lastPrint = '';
  let lastRead = 0;
  let cache = []; // Rohdaten je Session aus dem letzten Lesen
  let backoffUntil = 0;
  let initial = true; // erster Scan: nur Zustand aufbauen, keine historischen Ereignisse melden
  const counts = new Map(); // Session-Id → { updated, n } (Werkzeugzahl nur bei Änderung neu zählen)
  const seenEvents = new Set();
  let fresh = [];
  const log = onceLogger('opencode');

  function open() {
    db = openReadOnly(DatabaseSync, dbPath);
    stmts = {
      sessions: db.prepare(`SELECT id, parent_id, directory, title, agent, model, time_created, time_updated,
          tokens_input, tokens_output, tokens_cache_read FROM session
        WHERE time_updated > ? AND time_archived IS NULL ORDER BY time_created`),
      lastMessage: db.prepare(`SELECT json_extract(data, '$.role') AS role, json_extract(data, '$.time.completed') AS done,
          json_extract(data, '$.finish') AS finish, json_extract(data, '$.modelID') AS model,
          json_extract(data, '$.error.name') AS error, time_created
        FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 1`),
      parts: db.prepare(`SELECT p.id, p.time_created AS t, json_extract(m.data, '$.role') AS role,
          json_extract(p.data, '$.type') AS type, json_extract(p.data, '$.tool') AS tool,
          json_extract(p.data, '$.state.status') AS st, substr(json_extract(p.data, '$.text'), 1, 600) AS text,
          json_extract(p.data, '$.state.input.command') AS command, json_extract(p.data, '$.state.input.description') AS description,
          json_extract(p.data, '$.state.input.filePath') AS filePath, json_extract(p.data, '$.state.input.pattern') AS pattern,
          json_extract(p.data, '$.state.input.query') AS query, json_extract(p.data, '$.state.input.url') AS url
        FROM (SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 8) m
        JOIN part p ON p.message_id = m.id ORDER BY p.id DESC LIMIT ${PARTS}`),
      toolCount: db.prepare(`SELECT count(*) AS n FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'tool'`),
    };
  }

  function close() {
    try { db?.close(); } catch { /* bereits zu */ }
    db = null;
    stmts = null;
  }

  const detailOf = (r) => {
    if (r.command) return trunc(r.description || r.command, 80);
    if (r.filePath) return base(r.filePath);
    return trunc(r.pattern || r.query || r.url || r.description || '', 60) || null;
  };

  // Zählen über alle Teile ist teuer: nur wenn sich die Session geändert hat
  function toolCount(s) {
    const c = counts.get(s.id);
    if (c && c.updated === s.time_updated) return c.n;
    const n = stmts.toolCount.get(s.id)?.n ?? 0;
    counts.set(s.id, { updated: s.time_updated, n });
    return n;
  }

  function readSession(s) {
    const msg = stmts.lastMessage.get(s.id) ?? {};
    const parts = stmts.parts.all(s.id).reverse(); // älteste zuerst
    const events = [];
    let lastText = null; let lastPrompt = null; let running = null;
    for (const p of parts) {
      if (p.type === 'tool') {
        const category = opencodeCategory(p.tool);
        const detail = detailOf(p);
        events.push({ id: `${opencodeId(s.id)}:${p.id}`, t: p.t, kind: 'tool', tool: p.tool, category, label: detail });
        if (p.st === 'running' || p.st === 'pending') running = { tool: p.tool, category, detail };
      } else if (p.type === 'text' && p.text?.trim()) {
        if (p.role === 'user') {
          lastPrompt = trunc(p.text, 220);
          events.push({ id: `${opencodeId(s.id)}:${p.id}`, t: p.t, kind: 'prompt', label: trunc(p.text, 90) });
        } else {
          lastText = trunc(p.text, 220);
          events.push({ id: `${opencodeId(s.id)}:${p.id}`, t: p.t, kind: 'text', label: trunc(p.text, 90) });
        }
      }
    }
    let status = 'idle';
    if (msg.role === 'user') status = 'thinking';
    else if (msg.role === 'assistant') {
      if (!msg.done) status = running ? 'tool' : 'thinking';
      else if (msg.finish === 'tool-calls') status = 'thinking';
      else status = 'waiting_user';
    }
    return {
      ...s, status, running: status === 'tool' ? running : null, lastText, lastPrompt, events,
      model: msg.model ?? modelName(s.model), toolCount: toolCount(s),
    };
  }

  // Verbindung je Scan öffnen und schließen (hält keine Sperren/Begleitdateien offen)
  async function scan() {
    const now = Date.now();
    if (now < backoffUntil) return;
    const p = dbPrint(dbPath);
    if (p === lastPrint && now - lastRead < REFRESH_MS) return;
    try {
      open();
      const rows = stmts.sessions.all(now - windowMs);
      cache = rows.map(readSession);
      lastPrint = p;
      lastRead = now;
      const ids = new Set(rows.map((r) => r.id));
      for (const id of counts.keys()) if (!ids.has(id)) counts.delete(id);
      for (const s of cache) {
        for (const e of s.events) {
          if (seenEvents.has(e.id)) continue;
          seenEvents.add(e.id);
          if (!initial) fresh.push({ ...e, agentId: s.parent_id ? opencodeSubId(s.id) : opencodeId(s.id), sessionId: s.id });
        }
      }
      initial = false;
      if (seenEvents.size > 20_000) seenEvents.clear();
    } catch (err) {
      // gesperrt, Schema geändert o. Ä.: still überspringen, später erneut versuchen
      log(`Lesen (${errKind(err)})`, err);
      cache = [];
      backoffUntil = now + BACKOFF_MS;
    } finally {
      close();
    }
  }

  function takeEvents() { const out = fresh; fresh = []; return out; }

  function agents(now = Date.now()) {
    const mains = new Map();
    const out = [];
    for (const s of cache) {
      const age = now - s.time_updated;
      if (age > windowMs) continue;
      const sub = !!s.parent_id;
      let status = agedStatus(s.status, age);
      if (sub && (status === 'waiting_user' || status === 'idle')) status = 'done';
      const id = sub ? opencodeSubId(s.id) : opencodeId(s.id);
      const agent = createAgent({
        id, kind: sub ? 'sub' : 'main', toolId: 'opencode', sessionId: s.id, acpSessionId: s.id,
        parentId: sub ? opencodeId(s.parent_id) : null, project: path.basename(s.directory || '') || 'opencode', cwd: s.directory,
        title: sub ? null : s.title || null, description: sub ? s.title : null, agentType: sub ? s.agent : null,
        model: s.model, status, startedAt: s.time_created, source: 'watch', controllable: false,
      });
      const r = status === 'tool' ? s.running : null;
      Object.assign(agent, {
        tool: r?.tool ?? null, category: r?.category ?? null, detail: r?.detail ?? null,
        lastText: s.lastText, lastPrompt: s.lastPrompt, lastActivity: s.time_updated,
        tokens: { input: s.tokens_input ?? 0, output: s.tokens_output ?? 0, cache: s.tokens_cache_read ?? 0 },
        toolCount: s.toolCount, events: s.events.slice(-SNAPSHOT_EVENTS).map((e) => ({ ...e, agentId: id })),
      });
      if (!sub) mains.set(agent.id, agent);
      out.push(agent);
    }
    // Subagenten nur mit sichtbarer Hauptsession, im Raum (Haus) der Hauptsession
    return out.filter((a) => a.kind === 'main' || mains.has(a.parentId))
      .map((a) => (a.kind === 'sub' ? { ...a, project: mains.get(a.parentId).project, house: mains.get(a.parentId).house } : a));
  }

  return { id: 'opencode', adoptable: false, dbPath, scan, agents, takeEvents, close };
}
