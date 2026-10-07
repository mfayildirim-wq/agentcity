// Claude-Code-Watcher (aus v1): liest ~/.claude/projects/**/*.jsonl inkrementell mit,
// inkl. <session>/subagents/agent-*.jsonl + .meta.json, und liefert Agenten mit source=watch.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createAgent, toolCategory } from '../core/model.js';

const IDLE_MS = 2 * 60_000;
const STALE_MS = 15 * 60_000;
const DONE_LINGER_MS = 3 * 60_000;
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 1024 * 1024;
const FULL_LIMIT = 4 * 1024 * 1024;
const MAX_EVENTS = 40;
const SNAPSHOT_EVENTS = 14;
// Subagenten sind spätestens nach STALE + LINGER unsichtbar; so lange bleiben ihre Tracker
const SUB_KEEP_MS = STALE_MS + DONE_LINGER_MS;

// ---------------------------------------------------------------- Hilfen
const trunc = (s, n) => {
  if (s == null) return null;
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const base = (p) => (p ? path.basename(String(p)) : '');

// kurzer Inhalts-Hash (FNV-1a) für stabile, eindeutige Ereignis-Ids
function lineHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

export const mainId = (sessionId) => `w:claude:${sessionId}`;
export const subId = (agentId) => `w:claude:sub:${agentId}`;

function toolDetail(name, input = {}) {
  switch (name) {
    case 'Bash': return trunc(input.description || input.command, 80);
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': return base(input.file_path);
    case 'NotebookEdit': return base(input.notebook_path);
    case 'Grep': case 'Glob': return trunc(input.pattern, 60);
    case 'WebSearch': return trunc(input.query, 80);
    case 'WebFetch': try { return new URL(input.url).hostname; } catch { return trunc(input.url, 60); }
    case 'Agent': case 'Task': return trunc(input.description, 60);
    case 'Skill': return trunc(input.skill, 60);
    case 'AskUserQuestion': return trunc(input.questions?.[0]?.question, 80);
    default: return trunc(input.description || input.query || input.prompt || input.command || '', 60);
  }
}

function prettyProject(dirName, cwd) {
  if (cwd) return path.basename(cwd);
  return dirName.replace(/^-/, '').split('-').filter(Boolean).pop() || dirName;
}

// ---------------------------------------------------------------- Rohzustand je Datei
function newRaw(opts) {
  return {
    id: opts.kind === 'main' ? mainId(opts.sessionId) : subId(opts.agentId),
    kind: opts.kind,
    sessionId: opts.sessionId,
    projectDir: opts.projectDir,
    cwd: null,
    title: null,
    description: opts.meta?.description || null,
    agentType: opts.meta?.agentType || null,
    spawnToolUseId: opts.meta?.toolUseId || null,
    model: null,
    status: 'idle',
    tool: null,
    category: null,
    detail: null,
    lastText: null,
    lastPrompt: null,
    lastActivity: 0,
    startedAt: null,
    tokens: { input: 0, output: 0, cache: 0 },
    toolCount: 0,
    events: [],
    pending: new Map(),
  };
}

export function createClaudeWatcher({ root, windowMs = 90 * 60_000 }) {
  /** @type {Map<string, any>} Dateipfad → Tracker */
  const trackers = new Map();
  /** toolUseId → Agent-Id, um Subagenten ihrem Erzeuger zuzuordnen */
  const toolOwner = new Map();
  /** neue Ereignisse seit dem letzten takeEvents() (für die Datenbank) */
  let fresh = [];
  let loggedApplyError = false;

  function pushEvent(tr, ev) {
    const a = tr.agent;
    // Id aus Byte-Offset + Inhalts-Hash der Zeile: stabil über Neustarts (DB dedupliziert),
    // eindeutig auch nach Neuschreiben der Datei
    const event = { id: `${a.id}:${tr.lineId}:${tr.lineSeq++}`, agentId: a.id, ...ev };
    a.events.push(event);
    if (a.events.length > MAX_EVENTS) a.events.shift();
    fresh.push({ ...event, sessionId: a.sessionId });
  }

  function takeEvents() {
    const out = fresh;
    fresh = [];
    return out;
  }

  function applyLine(tr, d) {
    const a = tr.agent;
    // Ältere Versionen schreiben Subagenten als Sidechain in die Hauptdatei
    if (tr.kind === 'main' && d.isSidechain) return;
    const ts = d.timestamp ? Date.parse(d.timestamp) : NaN;
    const touch = () => {
      if (!Number.isNaN(ts)) {
        a.lastActivity = Math.max(a.lastActivity, ts);
        if (!a.startedAt) a.startedAt = ts;
      }
    };
    if (d.cwd && !a.cwd) a.cwd = d.cwd;

    switch (d.type) {
      case 'ai-title':
      case 'summary':
        a.title = trunc(d.aiTitle || d.summary, 70);
        return;
      case 'assistant': {
        touch();
        const m = d.message || {};
        if (m.model && m.model !== '<synthetic>') a.model = m.model;
        const u = m.usage;
        if (u) {
          a.tokens.input += u.input_tokens || 0;
          a.tokens.output += u.output_tokens || 0;
          a.tokens.cache += (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        }
        let usedTool = false;
        for (const c of m.content || []) {
          if (c.type === 'tool_use') {
            usedTool = true;
            const detail = toolDetail(c.name, c.input);
            const category = toolCategory(c.name);
            a.pending.set(c.id, { name: c.name, detail, category });
            toolOwner.set(c.id, a.id);
            tr.toolIds.add(c.id);
            a.tool = c.name; a.detail = detail; a.category = category;
            a.status = c.name === 'AskUserQuestion' ? 'waiting_user' : 'tool';
            a.toolCount++;
            pushEvent(tr, { t: ts, kind: 'tool', tool: c.name, category, label: detail });
          } else if (c.type === 'text' && c.text?.trim()) {
            a.lastText = trunc(c.text, 220);
            pushEvent(tr, { t: ts, kind: 'text', label: trunc(c.text, 90) });
          } else if (c.type === 'thinking' && !usedTool && a.pending.size === 0) {
            a.status = 'thinking'; a.tool = null; a.category = null; a.detail = null;
          }
        }
        if (m.stop_reason === 'end_turn' && !usedTool && a.pending.size === 0) {
          a.status = 'waiting_user'; a.tool = null; a.category = null; a.detail = null;
        }
        return;
      }
      case 'user': {
        const c = d.message?.content;
        if (typeof c === 'string') {
          touch();
          if (d.isMeta || c.startsWith('<')) return;
          a.lastPrompt = trunc(c, 220);
          a.pending.clear();
          a.status = 'thinking'; a.tool = null; a.category = null; a.detail = null;
          pushEvent(tr, { t: ts, kind: 'prompt', label: trunc(c, 90) });
          return;
        }
        if (Array.isArray(c)) {
          touch();
          let hadResult = false;
          for (const part of c) {
            if (part.type === 'tool_result') {
              hadResult = true;
              a.pending.delete(part.tool_use_id);
            } else if (part.type === 'text' && !d.isMeta && part.text && !part.text.startsWith('<') && tr.kind === 'main') {
              a.lastPrompt = trunc(part.text, 220);
              pushEvent(tr, { t: ts, kind: 'prompt', label: trunc(part.text, 90) });
              a.status = 'thinking';
            }
          }
          if (hadResult) {
            if (a.pending.size === 0) {
              a.status = 'thinking'; a.tool = null; a.category = null; a.detail = null;
            } else {
              const last = [...a.pending.values()].pop();
              a.tool = last.name; a.detail = last.detail; a.category = last.category;
            }
          }
        }
        return;
      }
      case 'system':
        touch();
        return;
      default:
        return;
    }
  }

  // ---------------------------------------------------------------- Dateien lesen
  async function readRange(file, start, end) {
    const len = Math.max(0, end - start);
    const buf = Buffer.alloc(len);
    if (!len) return buf;
    const fh = await fsp.open(file, 'r');
    try {
      const { bytesRead } = await fh.read(buf, 0, len, start);
      return bytesRead < len ? buf.subarray(0, bytesRead) : buf;
    } finally { await fh.close(); }
  }

  // pos = Byte-Position von buf in der Datei
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
      try { d = JSON.parse(line); } catch { continue; /* unvollständige Zeile */ }
      tr.lineId = `${linePos.toString(36)}.${lineHash(line)}`;
      tr.lineSeq = 0;
      try { applyLine(tr, d); } catch (err) {
        if (!loggedApplyError) { loggedApplyError = true; console.error('[watch:claude] Zeile nicht verarbeitet:', err.message); }
      }
    }
    tr.rest = Buffer.from(data.subarray(start));
  }

  async function syncFile(file, st, opts) {
    let tr = trackers.get(file);
    if (tr && st.size < tr.offset) { dropTracker(file, tr); tr = null; } // Datei wurde neu geschrieben
    if (!tr) {
      tr = { file, kind: opts.kind, offset: 0, rest: Buffer.alloc(0), agent: newRaw(opts), toolIds: new Set(), mtime: st.mtimeMs };
      trackers.set(file, tr);
      if (st.size <= FULL_LIMIT) {
        feed(tr, await readRange(file, 0, st.size), 0);
      } else {
        // Große Session: Anfang (Titel, cwd) und Ende (aktueller Zustand) lesen
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

  async function readMeta(file) {
    try { return JSON.parse(await fsp.readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')); }
    catch { return null; }
  }

  function dropTracker(file, tr) {
    trackers.delete(file);
    for (const id of tr.toolIds) if (toolOwner.get(id) === tr.agent.id) toolOwner.delete(id);
  }

  // Alte Tracker entfernen, damit Speicher nicht unbegrenzt wächst. Die Grenzen entsprechen
  // den Kriterien, nach denen scan() Dateien neu aufnimmt (sonst würden sie ständig neu gelesen).
  function prune(now) {
    for (const [file, tr] of trackers) {
      const age = now - Math.max(tr.agent.lastActivity || 0, tr.mtime || 0);
      if (age > (tr.kind === 'sub' ? SUB_KEEP_MS : windowMs)) dropTracker(file, tr);
    }
  }

  let scanning = false;
  async function scan() {
    if (scanning) return;
    scanning = true;
    const now = Date.now();
    try {
      let projects = [];
      try { projects = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
      for (const p of projects) {
        if (!p.isDirectory()) continue;
        const pdir = path.join(root, p.name);
        let files;
        try { files = await fsp.readdir(pdir, { withFileTypes: true }); } catch { continue; }
        for (const f of files) {
          if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
          const fp = path.join(pdir, f.name);
          const sessionId = f.name.slice(0, -6);
          let st;
          try { st = await fsp.stat(fp); } catch { continue; }
          if (now - st.mtimeMs > windowMs && !trackers.has(fp)) continue;
          await syncFile(fp, st, { kind: 'main', sessionId, projectDir: p.name });

          const sdir = path.join(pdir, sessionId, 'subagents');
          let subs;
          try { subs = await fsp.readdir(sdir); } catch { continue; }
          for (const s of subs) {
            if (!s.startsWith('agent-') || !s.endsWith('.jsonl')) continue;
            const sp = path.join(sdir, s);
            let sst;
            try { sst = await fsp.stat(sp); } catch { continue; }
            if (now - sst.mtimeMs > Math.min(windowMs, SUB_KEEP_MS) && !trackers.has(sp)) continue;
            const meta = trackers.has(sp) ? null : await readMeta(sp);
            await syncFile(sp, sst, { kind: 'sub', sessionId, agentId: s.slice(6, -6), projectDir: p.name, meta });
          }
        }
      }
      prune(now);
    } catch (err) {
      console.error('[watch:claude]', err.message);
    } finally {
      scanning = false;
    }
  }

  // ---------------------------------------------------------------- Agenten im neuen Modell
  function agents(now = Date.now()) {
    const out = [];
    const mains = new Set();
    for (const tr of trackers.values()) {
      const a = tr.agent;
      if (!a.lastActivity) continue;
      const age = now - a.lastActivity;
      let status = a.status;
      if (a.kind === 'sub') {
        if (status === 'waiting_user') status = 'done';
        else if (age > STALE_MS) status = 'done';
        else if (status !== 'tool' && age > IDLE_MS) status = 'done';
        if (status === 'done' && age > DONE_LINGER_MS) continue;
      } else {
        if (age > windowMs) continue;
        if (status === 'waiting_user' && age > 10 * 60_000) status = 'idle';
        else if ((status === 'thinking' || status === 'tool') && age > STALE_MS) status = 'idle';
        else if (status === 'thinking' && age > IDLE_MS) status = 'idle';
        mains.add(a.id);
      }
      const active = status === 'tool' || status === 'waiting_user';
      const agent = createAgent({
        id: a.id,
        kind: a.kind,
        toolId: 'claude',
        sessionId: a.sessionId,
        acpSessionId: a.sessionId,
        parentId: a.kind === 'sub' ? (toolOwner.get(a.spawnToolUseId) || mainId(a.sessionId)) : null,
        project: prettyProject(a.projectDir, a.cwd),
        cwd: a.cwd,
        title: a.title,
        description: a.description,
        agentType: a.agentType,
        model: a.model,
        status,
        startedAt: a.startedAt,
        source: 'watch',
        controllable: false,
      });
      Object.assign(agent, {
        tool: active ? a.tool : null,
        category: active ? a.category : null,
        detail: active ? a.detail : null,
        lastText: a.lastText,
        lastPrompt: a.lastPrompt,
        lastActivity: a.lastActivity,
        tokens: { ...a.tokens },
        toolCount: a.toolCount,
        events: a.events.slice(-SNAPSHOT_EVENTS),
      });
      out.push(agent);
    }
    // Subagenten wohnen im Raum ihrer Hauptsession und verschwinden mit ihr
    const projectOf = new Map(out.filter((a) => a.kind === 'main').map((a) => [a.sessionId, a.project]));
    const visible = out.filter((a) => a.kind === 'main' || mains.has(mainId(a.sessionId)));
    for (const a of visible) if (a.kind === 'sub') a.project = projectOf.get(a.sessionId) || a.project;
    visible.sort((x, y) => (x.kind === y.kind ? x.startedAt - y.startedAt : x.kind === 'main' ? -1 : 1));
    return visible;
  }

  return { id: 'claude', root, scan, agents, takeEvents, trackerCount: () => trackers.size, ownerCount: () => toolOwner.size };
}
