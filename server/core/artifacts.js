// Artefakte (v0.3): erkennt Ergebnisse der Agenten aus vorhandenen Bus-Ereignissen – Dateien aus Diffs,
// URLs und Pfade aus Antworttexten, localhost-URLs aus Terminalausgaben und lauschende Ports der Kindprozesse.
// Gleicher Pfad bzw. gleiche URL in derselben Session = dasselbe Artefakt (Update statt neu). Höchstens 50 je Session.
// Bus: artifact.add { artifact }, artifact.update { artifact } (beide Broadcast).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createArtifact, kindOfPath } from './model.js';

export const MAX_PER_SESSION = 50;
export const SCAN_MS = 5000;
const MAX_PTY_BUFFER = 8 * 1024;
const MAX_TEXT = 200 * 1024;

const EXCLUDED_DIRS = /(^|\/)(node_modules|\.git|dist|build)(\/|$)/;
const LOCK_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/;
const URL_RE = /https?:\/\/[^\s<>()[\]"'`]+/g;
// Wörter, die eine fremde URL als Ergebnis kennzeichnen (nicht als Quelle)
const RESULT_WORDS = /\b(erstellt|deployed|deployt|erreichbar|läuft|veröffentlicht|online|created|running|available|live|published|hosted|serving)\b/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);
// relative Pfade nur in Backticks oder am Zeilenanfang; absolute überall
const PATH_BACKTICK_RE = /`([^`\n]{1,300})`/g;
const PATH_LINE_RE = /^\s*(?:[-*•]\s+)?((?:\.{0,2}\/)?[\w.@-][\w.@\-/]*\.[a-z0-9]{1,8})\b/gim;
const PATH_ABS_RE = /(?:^|[\s"'(])(\/[\w.@\-/]+\.[a-z0-9]{1,8})\b/gim;

// stabile Id aus Session und Schlüssel (Pfad bzw. URL)
export const artifactId = (sessionId, key) => `f:${createHash('sha1').update(`${sessionId}\n${key}`).digest('hex').slice(0, 24)}`;

// Pfad ausgeschlossen? (Abhängigkeiten, Git, Build-Ausgaben, Lock-Dateien)
export function excludedPath(p) {
  const s = String(p ?? '').replace(/\\/g, '/');
  return !s || EXCLUDED_DIRS.test(s) || LOCK_FILES.test(s);
}

// URL normalisieren (ohne Satzzeichen am Ende); null bei ungültiger URL
export function cleanUrl(raw) {
  let s = String(raw ?? '').replace(/[.,;:!?)\]}>'"`]+$/, '');
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch { return null; }
}

export const isLocalUrl = (url) => { try { return LOCAL_HOSTS.has(new URL(url).hostname); } catch { return false; } };

// Standard-Portscan: Prozessgruppen der PIDs erweitern, lauschende TCP-Ports per lsof
export function listListeningPorts(pids = []) {
  const all = new Set();
  for (const pid of pids) {
    all.add(Number(pid));
    try {
      for (const p of execFileSync('pgrep', ['-g', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 }).split('\n')) {
        if (p.trim()) all.add(Number(p));
      }
    } catch { /* keine Kinder */ }
  }
  const list = [...all].filter((n) => Number.isInteger(n) && n > 0);
  if (!list.length) return [];
  let out = '';
  try {
    out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', list.join(',')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
  } catch (err) {
    out = err.stdout ? String(err.stdout) : ''; // lsof liefert Exit 1, wenn eine PID nichts offen hat
  }
  const ports = new Set();
  for (const line of out.split('\n')) {
    const m = /:(\d+)\s+\(LISTEN\)/.exec(line);
    if (m) ports.add(Number(m[1]));
  }
  return [...ports];
}

export function createArtifacts({
  bus, state, repo = null, acp = null, pty = null, config = {}, listListeningPorts: scanFn = listListeningPorts, scanMs = SCAN_MS, now = Date.now,
}) {
  const bySession = new Map(); // sessionId → Map(id → artifact)
  const ptyOwner = new Map(); // ptyId → agentId
  const ptyBuffer = new Map(); // ptyId → Rest der letzten Zeile
  const portsSeen = new Map(); // sessionId → Set(port)
  const ownPort = Number(config.port) || null;

  const sessionOf = (agentId) => state?.get(agentId) ?? null;
  const mapOf = (sessionId) => {
    let m = bySession.get(sessionId);
    if (!m) {
      m = new Map();
      // gespeicherte Artefakte der Session (z. B. nach Neustart) übernehmen
      try { for (const a of (repo?.artifacts?.forSession?.(sessionId, MAX_PER_SESSION) ?? []).reverse()) m.set(a.id, a); } catch { /* DB optional */ }
      bySession.set(sessionId, m);
    }
    return m;
  };

  // realer Pfad unter cwd (Symlinks aufgelöst) oder null
  function underCwd(p, cwd) {
    if (!cwd || !p) return null;
    try {
      const root = fs.realpathSync(cwd);
      const abs = path.isAbsolute(p) ? p : path.join(root, p);
      const real = fs.realpathSync(abs);
      if (real !== root && !real.startsWith(root + path.sep)) return null;
      return { real, rel: path.relative(root, real) };
    } catch { return null; }
  }

  const previewUrlFor = (sessionId, rel) => `/preview/${encodeURIComponent(sessionId)}/${rel.split(path.sep).map(encodeURIComponent).join('/')}`;

  function persist(a) {
    try { repo?.artifacts?.upsert?.(a); } catch (err) { console.error('[artifacts]', err.message); }
  }

  // Artefakt anlegen oder aktualisieren; Schlüssel = Pfad bzw. URL
  function upsert({ sessionId, agentId, key, kind, title, url = null, filePath = null, previewUrl = null, source, size = null, ended = false }) {
    if (!sessionId || !key) return null;
    const m = mapOf(sessionId);
    const id = artifactId(sessionId, key);
    const t = now();
    const prev = m.get(id);
    let a;
    if (prev) {
      a = { ...prev, agentId: agentId ?? prev.agentId, updatedAt: t, seen: false, kind, title, url, path: filePath, previewUrl, ended, ...(size != null ? { size } : {}) };
      // jüngstes zuletzt in der Map (Reihenfolge = Alter)
      m.delete(id);
      m.set(id, a);
      persist(a);
      bus.emit('artifact.update', { artifact: a });
      return a;
    }
    a = createArtifact({ id, sessionId, agentId, t, kind, title, url, path: filePath, previewUrl, source, size, ended });
    m.set(id, a);
    // Limit: älteste fallen heraus
    while (m.size > MAX_PER_SESSION) {
      const oldest = m.keys().next().value;
      m.delete(oldest);
      try { repo?.artifacts?.delete?.(oldest); } catch { /* DB optional */ }
    }
    persist(a);
    bus.emit('artifact.add', { artifact: a });
    return a;
  }

  // Datei (absolut oder relativ zu cwd) als Artefakt – nur unter cwd, nicht ausgeschlossen
  function addFile(agent, p, source) {
    if (!agent?.sessionId || typeof p !== 'string' || excludedPath(p)) return null;
    const hit = underCwd(p, agent.cwd);
    if (!hit || excludedPath(hit.rel)) return null;
    let size = null;
    try {
      const st = fs.statSync(hit.real);
      if (!st.isFile()) return null;
      size = st.size;
    } catch { return null; }
    const kind = kindOfPath(hit.real);
    return upsert({
      sessionId: agent.sessionId, agentId: agent.id, key: hit.real, kind, title: path.basename(hit.real), filePath: hit.real,
      previewUrl: kind === 'file' ? null : previewUrlFor(agent.sessionId, hit.rel), source, size,
    });
  }

  function addUrl(agent, raw, source) {
    const url = cleanUrl(raw);
    if (!url || !agent?.sessionId) return null;
    const u = new URL(url);
    if (ownPort && isLocalUrl(url) && Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === ownPort) return null;
    return upsert({ sessionId: agent.sessionId, agentId: agent.id, key: url, kind: 'web', title: u.host + (u.pathname !== '/' ? u.pathname : ''), url, source });
  }

  // ------------------------------------------------------------ Quellen
  function onEvent({ event: e }) {
    if (!e) return;
    const agent = sessionOf(e.agentId);
    if (e.kind === 'diff' && e.path) addFile(agent, e.path, 'diff');
    if (e.kind === 'terminal' && e.ptyId) {
      ptyOwner.set(e.ptyId, e.agentId);
      if (typeof e.command === 'string') scanText(agent, e.command, 'terminal', true);
    }
  }

  // Zugende: URLs und Pfade im Antworttext
  function onTurnEnd({ agentId, text }) {
    const agent = sessionOf(agentId);
    if (!agent || typeof text !== 'string' || !text) return;
    scanText(agent, text.slice(0, MAX_TEXT), 'text');
  }

  // Text nach URLs (localhost immer; fremde nur mit Ergebnis-Wort in derselben Zeile) und Pfaden durchsuchen
  function scanText(agent, text, source, localOnly = false) {
    if (!agent) return;
    for (const line of text.split('\n')) {
      for (const m of line.matchAll(URL_RE)) {
        const url = cleanUrl(m[0]);
        if (!url) continue;
        if (isLocalUrl(url)) addUrl(agent, url, source);
        else if (!localOnly && RESULT_WORDS.test(line)) addUrl(agent, url, source);
      }
    }
    if (localOnly) return;
    const paths = new Set();
    for (const m of text.matchAll(PATH_BACKTICK_RE)) if (/^(\.{0,2}\/)?[\w.@\-/]+\.[a-z0-9]{1,8}$/i.test(m[1]) && m[1].includes('.')) paths.add(m[1]);
    for (const m of text.matchAll(PATH_LINE_RE)) paths.add(m[1]);
    for (const m of text.matchAll(PATH_ABS_RE)) paths.add(m[1]);
    for (const p of paths) {
      if (/^https?:/i.test(p) || p.length > 300) continue;
      addFile(agent, p, source);
    }
  }

  // Terminalausgabe: Puffer je Terminal, Zeilen nach localhost-URLs durchsuchen
  function onPtyOutput({ ptyId, data }) {
    if (typeof data !== 'string' || !data) return;
    let owner = ptyOwner.get(ptyId);
    if (!owner && pty?.get) {
      const t = pty.get(ptyId);
      owner = t?.ownerId ?? t?.agentId ?? null;
      if (owner) ptyOwner.set(ptyId, owner);
    }
    const agent = owner && sessionOf(owner);
    if (!agent) return;
    // ANSI-Steuerzeichen entfernen, dann zeilenweise
    const clean = (ptyBuffer.get(ptyId) ?? '') + data.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n');
    const lines = clean.split('\n');
    const rest = lines.pop();
    ptyBuffer.set(ptyId, rest.length > MAX_PTY_BUFFER ? '' : rest);
    for (const line of lines) if (line.includes('://')) scanText(agent, line, 'terminal', true);
  }

  function onPtyExit({ ptyId }) {
    ptyOwner.delete(ptyId);
    ptyBuffer.delete(ptyId);
  }

  function onAgentRemove({ agentId }) {
    for (const [k, v] of ptyOwner) if (v === agentId) { ptyOwner.delete(k); ptyBuffer.delete(k); }
  }

  // ------------------------------------------------------------ Port-Scan
  // Sessions mit Status tool|thinking: lauschende Ports der Prozessgruppe → web-Artefakt; verschwundene Ports → „beendet“
  function scanPorts() {
    if (!acp?.processGroupPids) return 0;
    let n = 0;
    for (const a of state.all()) {
      if (a.kind !== 'main' || !a.sessionId || !acp.has?.(a.id)) continue;
      const active = a.status === 'tool' || a.status === 'thinking';
      const known = portsSeen.get(a.sessionId) ?? new Set();
      if (!active && !known.size) continue;
      let ports = [];
      if (active || known.size) {
        const pids = acp.processGroupPids(a.id);
        try { ports = pids.length ? scanFn(pids) ?? [] : []; } catch { ports = []; }
      }
      const current = new Set(ports.filter((p) => Number.isInteger(p) && p > 0 && p !== ownPort));
      for (const port of current) {
        if (known.has(port)) continue;
        const url = `http://localhost:${port}/`;
        upsert({ sessionId: a.sessionId, agentId: a.id, key: url, kind: 'web', title: `localhost:${port}`, url, source: 'port' });
        n++;
      }
      for (const port of known) {
        if (current.has(port)) continue;
        const url = `http://localhost:${port}/`;
        const m = mapOf(a.sessionId);
        const art = m.get(artifactId(a.sessionId, url));
        if (art && !art.ended) {
          const next = { ...art, ended: true, updatedAt: now() };
          m.set(art.id, next);
          persist(next);
          bus.emit('artifact.update', { artifact: next });
        }
      }
      portsSeen.set(a.sessionId, current);
    }
    return n;
  }

  // ------------------------------------------------------------ Abfragen
  // neueste zuerst
  const forSession = (sessionId, limit = MAX_PER_SESSION) => [...mapOf(sessionId).values()].sort((x, y) => y.updatedAt - x.updatedAt).slice(0, limit);
  const get = (id) => { for (const m of bySession.values()) if (m.has(id)) return m.get(id); return repo?.artifacts?.get?.(id) ?? null; };

  function markSeen(sessionId) {
    const m = mapOf(sessionId);
    let n = 0;
    for (const [id, a] of m) if (!a.seen) { m.set(id, { ...a, seen: true }); n++; }
    try { repo?.artifacts?.markSeen?.(sessionId); } catch { /* DB optional */ }
    return n;
  }

  // Artefakte der laufenden Sessions (letzte 10 je Session) für den Snapshot
  function snapshot(perSession = 10) {
    const out = [];
    for (const sid of new Set(state.all().map((a) => a.sessionId).filter(Boolean))) out.push(...forSession(sid, perSession));
    return out;
  }

  bus.on('event', onEvent);
  bus.on('session.turnEnd', onTurnEnd);
  bus.on('pty.output', onPtyOutput);
  bus.on('pty.exit', onPtyExit);
  bus.on('agent.remove', onAgentRemove);
  const timer = scanMs ? setInterval(() => { try { scanPorts(); } catch (err) { console.error('[artifacts] Port-Scan', err.message); } }, scanMs) : null;
  timer?.unref?.();

  function stop() {
    if (timer) clearInterval(timer);
    bus.off('event', onEvent);
    bus.off('session.turnEnd', onTurnEnd);
    bus.off('pty.output', onPtyOutput);
    bus.off('pty.exit', onPtyExit);
    bus.off('agent.remove', onAgentRemove);
  }

  return { forSession, get, markSeen, snapshot, scanPorts, scanText: (agentId, text, source = 'text') => scanText(sessionOf(agentId), text, source), stop };
}
