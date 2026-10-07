#!/usr/bin/env node
// Agent Arena – liest die Claude-Code-Transkripte live mit und streamt den
// Zustand aller Agenten/Subagenten per Server-Sent Events an den Browser.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4317);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const WINDOW_MS = Number(process.env.WINDOW_MIN || 90) * 60_000; // Sessions dieses Zeitfensters zeigen
const SCAN_MS = 1500;
const IDLE_MS = 2 * 60_000;
const STALE_MS = 15 * 60_000;
const DONE_LINGER_MS = 3 * 60_000;
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 1024 * 1024;
const FULL_LIMIT = 4 * 1024 * 1024;
const MAX_EVENTS = 40;

/** @type {Map<string, any>} Dateipfad → Tracker */
const trackers = new Map();
/** toolUseId → Agent-Key, um Subagenten ihrem Erzeuger zuzuordnen */
const toolOwner = new Map();

// ---------------------------------------------------------------- Hilfen
const trunc = (s, n) => {
  if (s == null) return null;
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const base = (p) => (p ? path.basename(String(p)) : '');

function toolCategory(name = '') {
  if (name.startsWith('mcp__')) return 'portal';
  switch (name) {
    case 'Bash': case 'BashOutput': case 'KillShell': case 'Monitor': case 'TaskStop':
      return 'terminal';
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
      return 'workbench';
    case 'Read': case 'Grep': case 'Glob': case 'LSP': case 'ToolSearch': case 'Skill':
      return 'library';
    case 'WebSearch': case 'WebFetch': case 'Artifact':
      return 'portal';
    case 'Agent': case 'Task': case 'SendMessage': case 'Workflow': case 'TodoWrite':
    case 'TaskCreate': case 'TaskUpdate': case 'ListAgents':
      return 'meeting';
    case 'AskUserQuestion': case 'ExitPlanMode': case 'EnterPlanMode':
      return 'lounge';
    default:
      return 'workbench';
  }
}

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

// ---------------------------------------------------------------- Agent-Zustand
function newAgent(opts) {
  const key = opts.kind === 'main' ? `m:${opts.sessionId}` : `s:${opts.agentId}`;
  return {
    key,
    kind: opts.kind,
    sessionId: opts.sessionId,
    agentId: opts.agentId || null,
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

function pushEvent(a, ev) {
  a.events.push(ev);
  if (a.events.length > MAX_EVENTS) a.events.shift();
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
          toolOwner.set(c.id, a.key);
          a.tool = c.name; a.detail = detail; a.category = category;
          a.status = c.name === 'AskUserQuestion' ? 'waiting' : 'tool';
          a.toolCount++;
          pushEvent(a, { t: ts, kind: 'tool', tool: c.name, category, label: detail });
        } else if (c.type === 'text' && c.text?.trim()) {
          a.lastText = trunc(c.text, 220);
          pushEvent(a, { t: ts, kind: 'text', label: trunc(c.text, 90) });
        } else if (c.type === 'thinking' && !usedTool && a.pending.size === 0) {
          a.status = 'thinking'; a.tool = null; a.category = null; a.detail = null;
        }
      }
      if (m.stop_reason === 'end_turn' && !usedTool && a.pending.size === 0) {
        a.status = 'waiting'; a.tool = null; a.category = null; a.detail = null;
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
        pushEvent(a, { t: ts, kind: 'prompt', label: trunc(c, 90) });
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
            pushEvent(a, { t: ts, kind: 'prompt', label: trunc(part.text, 90) });
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
  try { await fh.read(buf, 0, len, start); } finally { await fh.close(); }
  return buf;
}

function feed(tr, buf, { skipFirst = false } = {}) {
  let data = tr.rest.length ? Buffer.concat([tr.rest, buf]) : buf;
  let start = 0;
  if (skipFirst) {
    const nl = data.indexOf(10);
    if (nl === -1) { tr.rest = Buffer.alloc(0); return; }
    start = nl + 1;
  }
  let idx;
  while ((idx = data.indexOf(10, start)) !== -1) {
    const line = data.subarray(start, idx).toString('utf8');
    start = idx + 1;
    if (!line.trim()) continue;
    try { applyLine(tr, JSON.parse(line)); } catch { /* unvollständige Zeile */ }
  }
  tr.rest = Buffer.from(data.subarray(start));
}

async function syncFile(file, st, opts) {
  let tr = trackers.get(file);
  if (tr && st.size < tr.offset) { trackers.delete(file); tr = null; } // Datei wurde neu geschrieben
  if (!tr) {
    tr = { file, kind: opts.kind, offset: 0, rest: Buffer.alloc(0), agent: newAgent(opts) };
    trackers.set(file, tr);
    if (st.size <= FULL_LIMIT) {
      feed(tr, await readRange(file, 0, st.size));
    } else {
      // Große Session: Anfang (Titel, cwd) und Ende (aktueller Zustand) lesen
      feed(tr, await readRange(file, 0, HEAD_BYTES));
      tr.rest = Buffer.alloc(0);
      tr.agent.pending.clear();
      feed(tr, await readRange(file, st.size - TAIL_BYTES, st.size), { skipFirst: true });
    }
    tr.offset = st.size;
    return;
  }
  if (st.size > tr.offset) {
    feed(tr, await readRange(file, tr.offset, st.size));
    tr.offset = st.size;
  }
}

async function readMeta(file) {
  try { return JSON.parse(await fsp.readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')); }
  catch { return null; }
}

let scanning = false;
async function scan() {
  if (scanning) return;
  scanning = true;
  const now = Date.now();
  try {
    let projects = [];
    try { projects = await fsp.readdir(ROOT, { withFileTypes: true }); } catch { return; }
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const pdir = path.join(ROOT, p.name);
      let files;
      try { files = await fsp.readdir(pdir, { withFileTypes: true }); } catch { continue; }
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const fp = path.join(pdir, f.name);
        const sessionId = f.name.slice(0, -6);
        let st;
        try { st = await fsp.stat(fp); } catch { continue; }
        if (now - st.mtimeMs > WINDOW_MS && !trackers.has(fp)) continue;
        await syncFile(fp, st, { kind: 'main', sessionId, projectDir: p.name });

        const sdir = path.join(pdir, sessionId, 'subagents');
        let subs;
        try { subs = await fsp.readdir(sdir); } catch { continue; }
        for (const s of subs) {
          if (!s.startsWith('agent-') || !s.endsWith('.jsonl')) continue;
          const sp = path.join(sdir, s);
          let sst;
          try { sst = await fsp.stat(sp); } catch { continue; }
          if (now - sst.mtimeMs > WINDOW_MS && !trackers.has(sp)) continue;
          const meta = trackers.has(sp) ? null : await readMeta(sp);
          await syncFile(sp, sst, { kind: 'sub', sessionId, agentId: s.slice(6, -6), projectDir: p.name, meta });
        }
      }
    }
  } catch (err) {
    console.error('[scan]', err.message);
  } finally {
    scanning = false;
  }
}

// ---------------------------------------------------------------- Snapshot
function snapshot() {
  const now = Date.now();
  const agents = [];
  const mains = new Set();
  for (const tr of trackers.values()) {
    const a = tr.agent;
    if (!a.lastActivity) continue;
    const age = now - a.lastActivity;
    let status = a.status;
    if (a.kind === 'sub') {
      if (status === 'waiting') status = 'done';
      else if (age > STALE_MS) status = 'done';
      else if (status !== 'tool' && age > IDLE_MS) status = 'done';
      if (status === 'done' && age > DONE_LINGER_MS) continue;
    } else {
      if (age > WINDOW_MS) continue;
      if (status === 'waiting' && age > 10 * 60_000) status = 'idle';
      else if ((status === 'thinking' || status === 'tool') && age > STALE_MS) status = 'idle';
      else if (status === 'thinking' && age > IDLE_MS) status = 'idle';
      mains.add(a.key);
    }
    agents.push({
      key: a.key,
      kind: a.kind,
      sessionId: a.sessionId,
      parentKey: a.kind === 'sub' ? (toolOwner.get(a.spawnToolUseId) || `m:${a.sessionId}`) : null,
      project: prettyProject(a.projectDir, a.cwd),
      cwd: a.cwd,
      title: a.title,
      description: a.description,
      agentType: a.agentType,
      model: a.model,
      status,
      tool: status === 'tool' || status === 'waiting' ? a.tool : null,
      category: status === 'tool' || status === 'waiting' ? a.category : null,
      detail: status === 'tool' || status === 'waiting' ? a.detail : null,
      lastText: a.lastText,
      lastPrompt: a.lastPrompt,
      lastActivity: a.lastActivity,
      startedAt: a.startedAt,
      tokens: a.tokens,
      toolCount: a.toolCount,
      events: a.events.slice(-14),
    });
  }
  // Subagenten wohnen im Raum ihrer Hauptsession und verschwinden mit ihr
  const projectOf = new Map(agents.filter((a) => a.kind === 'main').map((a) => [a.sessionId, a.project]));
  const visible = agents.filter((a) => a.kind === 'main' || mains.has(`m:${a.sessionId}`));
  for (const a of visible) if (a.kind === 'sub') a.project = projectOf.get(a.sessionId) || a.project;
  visible.sort((x, y) => (x.kind === y.kind ? x.startedAt - y.startedAt : x.kind === 'main' ? -1 : 1));
  return { now, root: ROOT, agents: visible };
}

// ---------------------------------------------------------------- HTTP / SSE
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
};
const PUBLIC = path.join(__dirname, 'public');
const VENDOR = path.join(__dirname, 'node_modules', 'three');
const clients = new Set();
let lastPayload = '';

function serveFile(res, rootDir, rel) {
  const fp = path.normalize(path.join(rootDir, rel));
  if (!fp.startsWith(rootDir)) { res.writeHead(403).end(); return; }
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
      'Cache-Control': rootDir === VENDOR ? 'max-age=86400' : 'no-cache',
    });
    fs.createReadStream(fp).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${lastPayload || JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(snapshot()));
    return;
  }
  if (url.pathname.startsWith('/vendor/three/')) {
    serveFile(res, VENDOR, decodeURIComponent(url.pathname.slice('/vendor/three/'.length)));
    return;
  }
  serveFile(res, PUBLIC, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
});

async function tick() {
  await scan();
  const payload = JSON.stringify(snapshot());
  // `now` ändert sich immer – nur senden, wenn sich inhaltlich etwas getan hat
  const strip = (s) => s.replace(/^\{"now":\d+,/, '{');
  if (strip(payload) !== strip(lastPayload)) {
    lastPayload = payload;
    for (const c of clients) c.write(`data: ${payload}\n\n`);
  }
}

setInterval(tick, SCAN_MS);
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 15_000);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} ist schon belegt – läuft Agent Arena bereits? Dann einfach http://${HOST}:${PORT} öffnen.`);
    console.error(`  Beenden:  kill $(lsof -ti tcp:${PORT})   ·   Anderer Port:  PORT=4318 npm start\n`);
    process.exit(1);
  }
  throw err;
});

await tick();
server.listen(PORT, HOST, () => {
  const n = snapshot().agents.length;
  console.log(`\n  Agent Arena läuft auf  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  Quelle: ${ROOT}  ·  ${n} Agent(en) im Zeitfenster von ${WINDOW_MS / 60000} min\n`);
});
