// ACP-Client: startet ein Agenten-Tool als Prozess und spricht JSON-RPC über stdio.
// Ereignisse: 'update' (SessionUpdate, notification), 'permission' (request, resolve), 'exit' ({ code, signal, error, stderrTail })
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { readTextFile, writeTextFile } from './fs.js';
import { createTerminalHandlers } from './terminal.js';

const STDERR_LINES = 200;
const CLIENT_INFO = { name: 'agent-arena', title: 'Agent Arena', version: '0.2.0' };

export class AcpClient extends EventEmitter {
  constructor({ tool, cwd, env = {}, terminal = createTerminalHandlers() }) {
    super();
    this.tool = tool;
    this.cwd = cwd;
    this.env = env;
    this.terminal = terminal;
    this.proc = null;
    this.conn = null;
    this.sessionId = null;
    this.info = null; // InitializeResponse
    this.stderr = [];
    this.exited = null; // { code, signal, error, stderrTail } nach Prozessende
    this.closed = new Promise((resolve) => { this._onClosed = resolve; });
  }

  get running() { return !!this.proc && !this.exited; }
  stderrTail(n = 40) { return this.stderr.slice(-n).join('\n'); }

  start() {
    if (this.proc) return this;
    const env = { ...process.env, ...this.tool.env, ...this.env };
    delete env.CLAUDECODE; // von der Arena gestartete Agenten sind keine verschachtelten Sessions
    const proc = spawn(this.tool.command, this.tool.args ?? [], { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;

    let partial = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      const lines = (partial + chunk).split('\n');
      partial = lines.pop();
      this.pushStderr(lines);
    });
    proc.stderr.on('end', () => { if (partial) this.pushStderr([partial]); partial = ''; });
    proc.stdin.on('error', () => {}); // EPIPE nach Prozessende
    proc.on('error', (err) => this.finish({ code: null, signal: null, error: err.code === 'ENOENT' ? `Befehl nicht gefunden (ENOENT): ${this.tool.command}` : err.message }));
    proc.on('close', (code, signal) => this.finish({ code, signal }));

    const stream = ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout));
    this.conn = new ClientSideConnection(() => this.handlers(), stream);
    return this;
  }

  pushStderr(lines) {
    for (const l of lines) if (l.trim()) this.stderr.push(l);
    if (this.stderr.length > STDERR_LINES) this.stderr.splice(0, this.stderr.length - STDERR_LINES);
  }

  finish(info) {
    if (this.exited) return;
    this.exited = { ...info, stderrTail: this.stderrTail() };
    this._onClosed(this.exited);
    this.emit('exit', this.exited);
  }

  // Client-Seite der Verbindung: Anfragen des Agenten an uns
  handlers() {
    const t = this.terminal;
    return {
      sessionUpdate: (params) => { this.emit('update', params.update, params); },
      requestPermission: (params) => new Promise((resolve) => {
        let done = false;
        const answer = (outcome) => {
          if (done) return;
          done = true;
          resolve({ outcome: outcome?.outcome === 'selected' ? { outcome: 'selected', optionId: outcome.optionId } : { outcome: 'cancelled' } });
        };
        if (!this.listenerCount('permission')) { answer({ outcome: 'cancelled' }); return; }
        this.closed.then(() => answer({ outcome: 'cancelled' }));
        this.emit('permission', params, answer);
      }),
      readTextFile: (params) => readTextFile(this.cwd, params),
      writeTextFile: (params) => writeTextFile(this.cwd, params),
      createTerminal: (p) => t.createTerminal(p),
      terminalOutput: (p) => t.terminalOutput(p),
      waitForTerminalExit: (p) => t.waitForTerminalExit(p),
      killTerminal: (p) => t.killTerminal(p),
      releaseTerminal: (p) => t.releaseTerminal(p),
    };
  }

  // Anfrage an den Agenten; scheitert sofort, wenn der Prozess endet
  call(fn) {
    if (!this.conn) return Promise.reject(new Error('ACP-Client nicht gestartet'));
    if (this.exited) return Promise.reject(new Error(this.exitMessage()));
    return Promise.race([
      Promise.resolve().then(fn),
      this.closed.then(() => { throw new Error(this.exitMessage()); }),
    ]);
  }

  exitMessage() {
    const e = this.exited ?? {};
    return e.error ?? `Agent-Prozess beendet (Code ${e.code ?? e.signal ?? '?'})`;
  }

  async initialize() {
    this.info = await this.call(() => this.conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: !!this.terminal?.supported },
      clientInfo: CLIENT_INFO,
    }));
    return this.info;
  }

  async newSession() {
    const res = await this.call(() => this.conn.newSession({ cwd: this.cwd, mcpServers: [] }));
    this.sessionId = res.sessionId;
    return res;
  }

  async loadSession(sessionId) {
    this.sessionId = sessionId;
    return (await this.call(() => this.conn.loadSession({ sessionId, cwd: this.cwd, mcpServers: [] }))) ?? {};
  }

  prompt(text) {
    return this.call(() => this.conn.prompt({ sessionId: this.sessionId, prompt: [{ type: 'text', text }] }));
  }

  cancel() {
    if (!this.running || !this.sessionId) return Promise.resolve();
    return this.call(() => this.conn.cancel({ sessionId: this.sessionId }));
  }

  setMode(modeId) {
    return this.call(() => this.conn.setSessionMode({ sessionId: this.sessionId, modeId }));
  }

  // Prozess beenden: erst SIGTERM, nach 2 s SIGKILL
  stop() {
    const proc = this.proc;
    if (!proc || this.exited) return this.closed;
    try { proc.kill('SIGTERM'); } catch { /* bereits beendet */ }
    const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* bereits beendet */ } }, 2000);
    t.unref?.();
    return this.closed;
  }
}
