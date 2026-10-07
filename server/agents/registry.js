// Tool-Registry: Standardliste (default-agents.json) + Nutzer-Einträge (<dataDir>/agents.json).
// Nutzer-Einträge mit gleicher id überschreiben Felder des Standards; `disabled: true` blendet aus.
// list() zeigt die Einträge wie konfiguriert (für Einstellungen), get() liefert startfertige Einträge
// (`node` → laufender Node, `<arena>` → Arena-Ordner), publicList() ist ohne Befehl/Argumente/Umgebung.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARENA_DIR } from '../config.js';
import { AcpClient, rpcErrorMessage } from '../acp/client.js';
import { withTimeout } from '../acp/manager.js';

const DEFAULTS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'default-agents.json');
export const AVATAR_STYLES = ['gem', 'cap', 'hoodie', 'scarf', 'visor'];
export const TEST_TIMEOUT_MS = 10_000;
const FIELDS = ['id', 'name', 'command', 'args', 'env', 'color', 'avatarStyle', 'disabled'];

const subst = (s, arenaDir) => (typeof s === 'string' ? s.replaceAll('<arena>', arenaDir) : s);
const unsubst = (s, arenaDir) => (typeof s === 'string' && arenaDir ? s.replaceAll(arenaDir, '<arena>') : s);

// Arena-Pfad vor dem Speichern wieder durch <arena> ersetzen (Datei bleibt verschiebbar)
function unsubstAll(t, arenaDir) {
  const out = { ...t };
  if ('command' in out) out.command = unsubst(out.command, arenaDir);
  if (Array.isArray(out.args)) out.args = out.args.map((a) => unsubst(a, arenaDir));
  if (out.env && typeof out.env === 'object') out.env = Object.fromEntries(Object.entries(out.env).map(([k, v]) => [k, unsubst(v, arenaDir)]));
  return out;
}
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const DIFF_FIELDS = ['name', 'command', 'args', 'env', 'color', 'avatarStyle'];

function substAll(t, arenaDir) {
  const out = { ...t };
  if ('command' in out) out.command = subst(out.command, arenaDir);
  if (Array.isArray(out.args)) out.args = out.args.map((a) => subst(a, arenaDir));
  if (out.env && typeof out.env === 'object') out.env = Object.fromEntries(Object.entries(out.env).map(([k, v]) => [k, subst(v, arenaDir)]));
  return out;
}

export function loadDefaults(arenaDir = ARENA_DIR) {
  const list = JSON.parse(fs.readFileSync(DEFAULTS_FILE, 'utf8'));
  return list.map((t) => substAll(t, arenaDir));
}

// ---------------------------------------------------------------- Validierung
const bad = (msg) => { throw new Error(msg); };
const noBreak = (s) => !/[\r\n\0]/.test(s);

export function validateAgent(a) {
  if (!a || typeof a !== 'object') bad('Eintrag fehlt');
  if (typeof a.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(a.id)) bad('id: nur a–z, 0–9 und -, max. 40 Zeichen');
  if (typeof a.name !== 'string' || !a.name.trim() || a.name.length > 60 || !noBreak(a.name)) bad('Name fehlt (max. 60 Zeichen)');
  if (typeof a.command !== 'string' || !a.command.trim() || a.command.length > 500 || !noBreak(a.command)) bad('Befehl fehlt');
  if (!Array.isArray(a.args) || a.args.length > 50 || !a.args.every((x) => typeof x === 'string' && x.length <= 2000 && noBreak(x))) {
    bad('Argumente müssen eine Liste von Texten sein');
  }
  if (a.env != null) {
    if (typeof a.env !== 'object' || Array.isArray(a.env)) bad('Umgebung muss KEY=VAL-Paare enthalten');
    for (const [k, v] of Object.entries(a.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(k)) bad(`Umgebung: ungültiger Name „${k}“`);
      if (typeof v !== 'string' || v.length > 4000) bad(`Umgebung: Wert für ${k} muss Text sein`);
      if (!noBreak(v)) bad(`Umgebung: Wert für ${k} enthält einen Zeilenumbruch`);
    }
  }
  if (typeof a.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(a.color)) bad('Farbe muss als #rrggbb angegeben werden');
  if (a.avatarStyle != null && !AVATAR_STYLES.includes(a.avatarStyle)) bad(`Figurenstil unbekannt (${AVATAR_STYLES.join(', ')})`);
  return true;
}

// nur bekannte Felder, bereinigt
function clean(a) {
  const out = {};
  for (const k of FIELDS) if (a[k] !== undefined) out[k] = a[k];
  out.name = String(out.name).trim();
  out.command = String(out.command).trim();
  out.env = out.env ?? {};
  out.avatarStyle = out.avatarStyle ?? null;
  out.disabled = !!out.disabled;
  return out;
}

// ---------------------------------------------------------------- installiert?
function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch { return false; }
}

export function findCommand(command, envPath = process.env.PATH ?? '') {
  if (!command) return null;
  if (command.includes('/')) { const abs = path.resolve(command); return executable(abs) ? abs : null; }
  const dirs = new Set([...envPath.split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')]);
  for (const d of dirs) {
    if (!d) continue;
    const f = path.join(d, command);
    if (executable(f)) return f;
  }
  return null;
}

// `node` ist immer da (laufender Prozess); dann muss aber das Skript existieren
export function isInstalled(t) {
  if (t.command === 'node') {
    const script = t.args?.find((a) => !a.startsWith('-'));
    return !script || !path.isAbsolute(script) || fs.existsSync(script);
  }
  return !!findCommand(t.command);
}

// Startfertig: `node` → laufender Node; sonst über PATH (inkl. Homebrew) aufgelöst
function runnable(t) {
  const command = t.command === 'node' ? process.execPath : findCommand(t.command) ?? t.command;
  return { ...t, command, args: t.args ?? [], env: t.env ?? {} };
}

// ---------------------------------------------------------------- Registry
export function createRegistry({
  dataDir = null, arenaDir = ARENA_DIR, tools = null, testTimeoutMs = TEST_TIMEOUT_MS,
  clientFactory = (opts) => new AcpClient(opts),
} = {}) {
  const defaults = (tools ?? loadDefaults(arenaDir)).map((t) => substAll(t, arenaDir));
  const defaultIds = new Set(defaults.map((t) => t.id));
  const file = dataDir ? path.join(dataDir, 'agents.json') : null;
  let user = [];
  let userMtime = -1;
  let warned = false;

  // Nutzer-Datei bei Änderung neu lesen (auch von Hand bearbeitet)
  function loadUser() {
    if (!file) return user;
    let st;
    try { st = fs.statSync(file); } catch { user = []; userMtime = -1; return user; }
    if (st.mtimeMs === userMtime) return user;
    userMtime = st.mtimeMs;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      user = Array.isArray(data) ? data.filter((x) => x && typeof x.id === 'string') : [];
      warned = false;
    } catch (err) {
      if (!warned) { warned = true; console.error(`[registry] ${file} nicht lesbar: ${err.message}`); }
      user = [];
    }
    return user;
  }

  function writeUser(list) {
    if (!file) throw new Error('Keine Nutzer-Datei konfiguriert');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
      fs.chmodSync(file, 0o600);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* bereits umbenannt */ }
    }
    user = list;
    try { userMtime = fs.statSync(file).mtimeMs; } catch { userMtime = -1; }
  }

  // zusammengeführte Einträge (wie konfiguriert, `<arena>` ersetzt)
  function merged() {
    const u = new Map(loadUser().map((x) => [x.id, substAll(x, arenaDir)]));
    const out = [];
    for (const d of defaults) {
      const o = u.get(d.id);
      const e = { ...d, ...(o ?? {}), id: d.id, builtin: true, modified: !!o && DIFF_FIELDS.some((k) => k in o && !same(o[k], d[k] ?? (k === 'env' ? {} : k === 'avatarStyle' ? null : undefined))) };
      out.push(e);
    }
    for (const [id, o] of u) if (!defaultIds.has(id)) out.push({ ...o, builtin: false, modified: false });
    return out.map((e) => ({
      ...e, args: Array.isArray(e.args) ? e.args : [], env: e.env ?? {}, avatarStyle: e.avatarStyle ?? null,
      disabled: !!e.disabled, installed: typeof e.command === 'string' && isInstalled({ command: e.command, args: e.args ?? [] }),
    }));
  }

  // nur gültige Einträge sind startbar; ungültige Nutzer-Einträge erscheinen in den Einstellungen mit Fehler
  function list({ all = false } = {}) {
    return merged().map((e) => {
      try { validateAgent(e); return e; } catch (err) { return { ...e, invalid: err.message }; }
    }).filter((e) => all || (!e.disabled && !e.invalid));
  }

  function get(id) {
    const e = list().find((t) => t.id === id);
    return e ? runnable(e) : null;
  }

  const publicList = () => list().map(({ id, name, color, avatarStyle, installed }) => ({ id, name, color, avatarStyle, installed }));

  // Standard-Tools: nur Abweichungen vom Default speichern (auch Teil-Einträge wie { id, disabled });
  // eigene Tools: vollständiger Eintrag. isNew lehnt vorhandene ids ab.
  function save(agent, { isNew = false } = {}) {
    if (!agent || typeof agent.id !== 'string') throw new Error('id fehlt');
    const cur = loadUser();
    const def = defaults.find((d) => d.id === agent.id);
    if (isNew && (def || cur.some((x) => x.id === agent.id))) throw new Error(`id bereits vergeben: ${agent.id}`);
    let entry;
    if (def) {
      const prev = cur.find((x) => x.id === agent.id) ?? {};
      const full = { ...def, ...substAll(prev, arenaDir), ...agent, id: def.id };
      validateAgent(full);
      const c = clean(full);
      entry = { id: def.id };
      for (const k of DIFF_FIELDS) {
        const dv = def[k] ?? (k === 'env' ? {} : k === 'avatarStyle' ? null : undefined);
        if (!same(c[k], dv)) entry[k] = c[k];
      }
      if (c.disabled) entry.disabled = true;
      entry = unsubstAll(entry, arenaDir);
    } else {
      validateAgent(agent);
      entry = unsubstAll(clean(agent), arenaDir);
    }
    const rest = cur.filter((x) => x.id !== entry.id);
    const keep = Object.keys(entry).length > 1 || !def; // Standard ohne Abweichung → kein Eintrag
    writeUser(keep ? [...rest, entry] : rest);
    return list({ all: true });
  }

  function remove(id) {
    if (typeof id !== 'string') throw new Error('id fehlt');
    const cur = loadUser();
    if (!defaultIds.has(id) && !cur.some((x) => x.id === id)) throw new Error(`Unbekanntes Tool: ${id}`);
    const rest = cur.filter((x) => x.id !== id);
    // Standard-Tools lassen sich nicht löschen, nur deaktivieren (Änderungen verfallen)
    writeUser(defaultIds.has(id) ? [...rest, { id, disabled: true }] : rest);
    return list({ all: true });
  }

  // Startet das Tool kurz und fragt `initialize` ab
  async function test(agent) {
    validateAgent(agent);
    const tool = runnable(substAll(clean(agent), arenaDir));
    const client = clientFactory({ tool, cwd: os.homedir() });
    try {
      client.start();
      const res = await withTimeout(client.initialize(), testTimeoutMs, 'initialize');
      return {
        ok: true,
        info: {
          protocolVersion: res?.protocolVersion ?? null, agentInfo: res?.agentInfo ?? null,
          agentCapabilities: res?.agentCapabilities ?? null, authMethods: (res?.authMethods ?? []).map((m) => ({ id: m.id, name: m.name })),
        },
      };
    } catch (err) {
      const tail = client.stderrTail?.(6);
      return { ok: false, error: rpcErrorMessage(err), stderrTail: tail || null };
    } finally {
      let t;
      await Promise.race([client.stop(), new Promise((r) => { t = setTimeout(r, 3000); t.unref?.(); })]);
      clearTimeout(t);
    }
  }

  return { list, get, publicList, save, delete: remove, test, file };
}
