// PTY-Manager: Terminals über node-pty – Nutzer-Shells (eine je Agent) und Agenten-Terminals (ACP terminal/*),
// dazu „Anzeige-Terminals“ ohne Prozess (Ausgabe, die ein Adapter per _meta.terminal_* meldet).
// Jedes Terminal hat einen Ringpuffer (Standard 64 KB) für die Wiederanzeige nach einem Neuladen.
// Bus: pty.output { ptyId, data } (gebündelt), pty.exit { ptyId, code, signal }.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

export const RING_BYTES = 64 * 1024;
export const MAX_FINISHED_PER_AGENT = 20; // beendete Agenten-Terminals, die zur Anzeige erhalten bleiben
const FLUSH_MS = 12;

const require = createRequire(import.meta.url);

// node-pty bringt für macOS ein vorgebautes spawn-helper mit, dem nach `npm install` manchmal das
// Ausführungsrecht fehlt („posix_spawnp failed“) – einmalig nachsetzen.
function ensureSpawnHelper() {
  let root;
  try { root = path.dirname(require.resolve('node-pty/package.json')); } catch { return; }
  let warned = false;
  for (const dir of [path.join(root, 'prebuilds', `${process.platform}-${process.arch}`), path.join(root, 'build', 'Release')]) {
    try {
      const helper = path.join(dir, 'spawn-helper');
      if (!fs.existsSync(helper)) continue;
      const mode = fs.statSync(helper).mode;
      if (!(mode & 0o111)) fs.chmodSync(helper, mode | 0o755);
    } catch (err) {
      // keine Rechte o. Ä. – spawn meldet dann selbst den Fehler
      if (!warned) console.warn(`[pty] spawn-helper nicht ausführbar zu machen (${dir}): ${err.message}`);
      warned = true;
    }
  }
}

let ptyModule = null;
function loadPty() {
  if (!ptyModule) {
    ensureSpawnHelper();
    ptyModule = require('node-pty');
  }
  return ptyModule;
}

// Byte-Puffer mit Obergrenze: schneidet vorne ab, an einer Zeichengrenze (UTF-8)
export class ByteRing {
  constructor(limit = RING_BYTES) {
    this.limit = Math.max(1024, limit | 0);
    this.chunks = [];
    this.bytes = 0;
    this.truncated = false;
  }

  push(text) {
    if (!text) return;
    const n = Buffer.byteLength(text);
    this.chunks.push(text);
    this.bytes += n;
    if (this.bytes > this.limit * 2 || this.chunks.length > 512) this.compact();
  }

  compact() {
    if (this.bytes <= this.limit) {
      if (this.chunks.length > 1) this.chunks = [this.chunks.join('')]; // viele kleine Stücke zusammenfassen
      return;
    }
    const buf = Buffer.from(this.chunks.join(''));
    let start = buf.length - this.limit;
    while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++; // keine halben Zeichen
    const text = buf.subarray(start).toString('utf8');
    this.chunks = [text];
    this.bytes = Buffer.byteLength(text);
    this.truncated = true;
  }

  toString() {
    this.compact();
    return this.chunks.join('');
  }
}

const cleanEnv = (extra = {}) => {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...extra };
  delete env.CLAUDECODE; // Shells der Arena sind keine verschachtelten Claude-Sessions
  return env;
};
const clampSize = (v, def, max) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 2 ? Math.min(n, max) : def;
};

export function createPtyManager({ bus = null, shell = process.env.SHELL || '/bin/zsh', ringBytes = RING_BYTES, spawn = null } = {}) {
  const emitter = new EventEmitter();
  const terms = new Map(); // ptyId → Eintrag
  const userShells = new Map(); // agentId → ptyId
  const doSpawn = spawn ?? ((file, args, opts) => loadPty().spawn(file, args, opts));

  function info(t) {
    return {
      ptyId: t.ptyId, agentId: t.agentId, ownerId: t.ownerId, kind: t.kind, command: t.command, args: t.args,
      cwd: t.cwd, t: t.t, exited: !!t.exitStatus, exitCode: t.exitStatus?.exitCode ?? null, signal: t.exitStatus?.signal ?? null,
      released: t.released,
    };
  }

  // Ausgabe bündeln: höchstens eine pty.output-Nachricht je Terminal und ~12 ms
  function flush(t) {
    t.flushTimer = null;
    if (!t.pending) return;
    const data = t.pending;
    t.pending = '';
    bus?.emit('pty.output', { ptyId: t.ptyId, data });
  }

  function onData(t, data) {
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    if (!text) return;
    t.ring.push(text);
    t.out?.push(text);
    t.pending += text;
    emitter.emit('data', { ptyId: t.ptyId, data: text });
    if (!t.flushTimer) {
      t.flushTimer = setTimeout(() => flush(t), FLUSH_MS);
      t.flushTimer.unref?.();
    }
  }

  function onExit(t, exitCode, signal) {
    if (t.exitStatus) return;
    clearTimeout(t.flushTimer);
    flush(t);
    t.exitStatus = { exitCode: exitCode ?? null, signal: signal ? String(signal) : null };
    t.proc = null;
    for (const w of t.waiters) w(t.exitStatus);
    t.waiters = [];
    bus?.emit('pty.exit', { ptyId: t.ptyId, code: t.exitStatus.exitCode, signal: t.exitStatus.signal });
    emitter.emit('exit', { ptyId: t.ptyId, ...t.exitStatus });
    if (t.kind === 'user' && userShells.get(t.agentId) === t.ptyId) userShells.delete(t.agentId);
    prune(t.ownerId);
  }

  // je Agent nur die letzten beendeten Agenten-Terminals behalten
  function prune(ownerId) {
    const done = [...terms.values()].filter((x) => x.ownerId === ownerId && x.kind !== 'user' && x.exitStatus && x.released !== false);
    const extra = done.length - MAX_FINISHED_PER_AGENT;
    for (let i = 0; i < extra; i++) terms.delete(done[i].ptyId);
    // beendete Nutzer-Shells werden nicht aufgehoben
    for (const x of [...terms.values()]) if (x.ownerId === ownerId && x.kind === 'user' && x.exitStatus) terms.delete(x.ptyId);
  }

  function entry({ kind, agentId, ownerId, command, args, cwd, outputByteLimit }) {
    const t = {
      ptyId: `p:${randomUUID()}`, kind, agentId: agentId ?? null, ownerId: ownerId ?? agentId ?? null,
      command: command ?? null, args: args ?? [], cwd: cwd ?? null, t: Date.now(),
      ring: new ByteRing(ringBytes), out: outputByteLimit != null ? new ByteRing(outputByteLimit) : null,
      pending: '', flushTimer: null, proc: null, exitStatus: null, waiters: [], released: kind === 'agent' ? false : null,
    };
    terms.set(t.ptyId, t);
    return t;
  }

  // Prozess-Terminal starten. Ohne args und mit Leerzeichen im Befehl → über die Shell (`sh -c`).
  function open({ cwd, cols, rows, command, args, env, kind = 'user', agentId = null, ownerId = null, outputByteLimit = null } = {}) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('Terminal braucht einen absoluten Ordner');
    let file = command;
    let argv = Array.isArray(args) ? args.map(String) : [];
    if (!file) { file = shell; argv = ['-l']; }
    else if (!argv.length && /\s/.test(file)) { argv = ['-c', file]; file = '/bin/sh'; }
    const shown = command ? { command, args: Array.isArray(args) ? args.map(String) : [] } : { command: path.basename(shell), args: [] };
    const t = entry({ kind, agentId, ownerId, ...shown, cwd, outputByteLimit });
    try {
      t.proc = doSpawn(file, argv, {
        name: 'xterm-256color', cwd, env: cleanEnv(env),
        cols: clampSize(cols, 100, 500), rows: clampSize(rows, 30, 200),
      });
    } catch (err) {
      terms.delete(t.ptyId);
      throw new Error(`Terminal konnte nicht starten (${file}): ${err.message}`);
    }
    t.proc.onData((d) => onData(t, d));
    t.pid = t.proc.pid;
    // Ende einen Tick später verarbeiten, damit Nachzügler-Daten des PTY noch ankommen
    t.proc.onExit(({ exitCode, signal }) => setImmediate(() => onExit(t, exitCode, signal || null)));
    if (kind === 'user' && agentId) userShells.set(agentId, t.ptyId);
    return { ptyId: t.ptyId };
  }

  // Anzeige-Terminal ohne Prozess (Ausgabe kommt von außen über feed/finish)
  function openDisplay({ agentId, ownerId = null, command = null, cwd = null }) {
    const t = entry({ kind: 'display', agentId, ownerId, command, args: [], cwd });
    t.released = true;
    return { ptyId: t.ptyId };
  }

  function feed(ptyId, data) {
    const t = terms.get(ptyId);
    if (t && !t.exitStatus) onData(t, String(data ?? ''));
  }

  function finish(ptyId, exitCode = null, signal = null) {
    const t = terms.get(ptyId);
    if (t && !t.proc) onExit(t, exitCode, signal);
  }

  const get = (ptyId) => { const t = terms.get(ptyId); return t ? info(t) : null; };
  const must = (ptyId) => {
    const t = terms.get(ptyId);
    if (!t) throw new Error('Terminal nicht gefunden');
    return t;
  };

  function write(ptyId, data) {
    const t = must(ptyId);
    if (!t.proc) throw new Error('Terminal ist beendet');
    if (typeof data !== 'string') throw new Error('Eingabe muss Text sein');
    t.proc.write(data);
  }

  function resize(ptyId, cols, rows) {
    const t = must(ptyId);
    if (!t.proc) return;
    try { t.proc.resize(clampSize(cols, 100, 500), clampSize(rows, 30, 200)); } catch { /* bereits beendet */ }
  }

  // Prozess beenden (Eintrag und Puffer bleiben)
  function kill(ptyId, signal = 'SIGHUP') {
    const t = terms.get(ptyId);
    if (!t?.proc) return;
    const proc = t.proc;
    signalGroup(proc, signal);
    // hartnäckige Prozesse nach 1,5 s hart beenden
    const hard = setTimeout(() => { if (t.proc === proc) signalGroup(proc, 'SIGKILL'); }, 1500);
    hard.unref?.();
  }

  // ganze Prozessgruppe (der PTY-Prozess ist Sitzungsführer), sonst nur den Prozess
  function signalGroup(proc, sig) {
    try { process.kill(-proc.pid, sig); } catch { try { proc.kill(sig); } catch { /* bereits beendet */ } }
  }

  // Beenden und entfernen
  function close(ptyId) {
    const t = terms.get(ptyId);
    if (!t) return false;
    kill(ptyId);
    terms.delete(ptyId);
    if (userShells.get(t.agentId) === ptyId) userShells.delete(t.agentId);
    return true;
  }

  // ACP release: Prozess beenden, Eintrag bleibt zur Anzeige (bis zum Aufräumen)
  function release(ptyId) {
    const t = terms.get(ptyId);
    if (!t) return;
    t.released = true;
    if (t.proc) kill(ptyId); else prune(t.ownerId);
  }

  function waitExit(ptyId) {
    const t = must(ptyId);
    if (t.exitStatus) return Promise.resolve(t.exitStatus);
    return new Promise((resolve) => t.waiters.push(resolve));
  }

  // Ausgabe für ACP terminal/output (Zeilenenden des PTY als \n)
  function output(ptyId) {
    const t = must(ptyId);
    const buf = t.out ?? t.ring;
    return { output: buf.toString().replace(/\r\n/g, '\n'), truncated: buf.truncated, exitStatus: t.exitStatus };
  }

  const buffer = (ptyId) => terms.get(ptyId)?.ring.toString() ?? '';

  // Nutzer-Shell eines Agenten (läuft sie noch?)
  function userShell(agentId) {
    const id = userShells.get(agentId);
    const t = id && terms.get(id);
    return t && t.proc ? id : null;
  }

  const list = (filter = () => true) => [...terms.values()].filter(filter).map(info);
  const listFor = (agentId) => list((t) => t.ownerId === agentId || t.agentId === agentId);

  // Session geschlossen: alle Terminals des Agenten (und seiner Subagenten) beenden und vergessen
  function closeAgent(agentId) {
    for (const t of [...terms.values()]) if (t.ownerId === agentId || t.agentId === agentId) close(t.ptyId);
  }

  // Server-Ende: SIGHUP an alle, bis graceMs auf das Ende warten, übrige Prozessgruppen hart beenden
  async function closeAll({ graceMs = 1000 } = {}) {
    const live = [...terms.values()].filter((t) => t.proc);
    const exits = live.map((t) => new Promise((resolve) => t.waiters.push(resolve)));
    for (const t of live) signalGroup(t.proc, 'SIGHUP');
    terms.clear();
    userShells.clear();
    if (!live.length) return;
    let timer;
    await Promise.race([Promise.all(exits), new Promise((r) => { timer = setTimeout(r, graceMs); })]);
    clearTimeout(timer);
    for (const t of live) if (t.proc) signalGroup(t.proc, 'SIGKILL');
  }

  return {
    open, openDisplay, feed, finish, write, resize, kill, close, release, waitExit, output, buffer, get, list, listFor,
    userShell, closeAgent, closeAll, on: emitter.on.bind(emitter), off: emitter.off.bind(emitter),
    get size() { return terms.size; },
  };
}
