// terminal/* für Agenten (ACP): Befehle laufen als PTY über pty/manager, nur im Projektordner.
// Jeder ACP-Client bekommt eigene Handler; er sieht nur die Terminals, die er selbst angelegt hat.
import { RequestError } from '@agentclientprotocol/sdk';
import { resolveInside } from './fs.js';

export const DEFAULT_OUTPUT_LIMIT = 64 * 1024;
export const MAX_OUTPUT_LIMIT = 1024 * 1024;
export const MAX_LIVE_TERMINALS = 16;

const unsupported = () => { throw RequestError.methodNotFound('terminal/* (nicht unterstützt)'); };
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function envObject(list) {
  if (list == null) return {};
  if (!Array.isArray(list)) throw RequestError.invalidParams(undefined, 'env muss eine Liste sein');
  const env = {};
  for (const v of list) {
    if (!v || typeof v.name !== 'string' || !ENV_NAME.test(v.name)) throw RequestError.invalidParams(undefined, `Ungültige Umgebungsvariable: ${v?.name}`);
    env[v.name] = String(v.value ?? '');
  }
  return env;
}

export function outputLimit(v) {
  if (v == null) return DEFAULT_OUTPUT_LIMIT;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_OUTPUT_LIMIT;
  return Math.min(Math.max(Math.floor(n), 1024), MAX_OUTPUT_LIMIT);
}

// Ohne `pty` bleibt alles „nicht unterstützt“ (Client meldet dann terminal: false).
// onCreate({ ptyId, command, args, cwd }) meldet neue Terminals an die Session (Ereignis, Station).
export function createTerminalHandlers({ pty = null, cwd = null, agentId = null, onCreate = () => {}, maxLive = MAX_LIVE_TERMINALS } = {}) {
  if (!pty) {
    return {
      supported: false, dispose() {},
      createTerminal: unsupported, terminalOutput: unsupported, waitForTerminalExit: unsupported,
      killTerminal: unsupported, releaseTerminal: unsupported,
    };
  }
  const own = new Set(); // ptyIds dieses Clients (bis release)
  const mine = (id) => {
    if (typeof id !== 'string' || !own.has(id) || !pty.get(id)) throw RequestError.resourceNotFound(`terminal ${id}`);
    return id;
  };
  const aid = typeof agentId === 'function' ? agentId : () => agentId;

  return {
    supported: true,

    async createTerminal(p) {
      if (typeof p?.command !== 'string' || !p.command.trim()) throw RequestError.invalidParams(undefined, 'command fehlt');
      if (p.args != null && (!Array.isArray(p.args) || p.args.some((a) => typeof a !== 'string'))) {
        throw RequestError.invalidParams(undefined, 'args muss eine Liste von Texten sein');
      }
      const live = [...own].filter((id) => pty.get(id) && !pty.get(id).exited).length;
      if (live >= maxLive) throw RequestError.invalidParams(undefined, `Zu viele laufende Terminals (max. ${maxLive})`);
      const dir = p.cwd ? await resolveInside(cwd, p.cwd) : cwd;
      const { ptyId } = pty.open({
        kind: 'agent', agentId: aid(), cwd: dir, command: p.command, args: p.args ?? [], env: envObject(p.env),
        outputByteLimit: outputLimit(p.outputByteLimit),
      });
      own.add(ptyId);
      try { onCreate({ ptyId, command: p.command, args: p.args ?? [], cwd: dir }); } catch (err) { console.warn('[acp] terminal', err?.message ?? err); }
      return { terminalId: ptyId };
    },

    terminalOutput(p) {
      const { output, truncated, exitStatus } = pty.output(mine(p?.terminalId));
      return { output, truncated, ...(exitStatus ? { exitStatus } : {}) };
    },

    async waitForTerminalExit(p) {
      const st = await pty.waitExit(mine(p?.terminalId));
      return { exitCode: st.exitCode ?? null, signal: st.signal ?? null };
    },

    killTerminal(p) {
      pty.kill(mine(p?.terminalId), 'SIGTERM');
      return {};
    },

    releaseTerminal(p) {
      const id = mine(p?.terminalId);
      own.delete(id);
      pty.release(id);
      return {};
    },

    // Prozessende des Agenten: alle eigenen Terminals freigeben
    dispose() {
      for (const id of own) pty.release(id);
      own.clear();
    },
  };
}
