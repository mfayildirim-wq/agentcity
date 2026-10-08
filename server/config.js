// Pfade, Port, Zeitfenster und Zugangstoken
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { retentionDays } from './db/retention.js';

// Umgebungsvariable AGENTCITY_<name>, ersatzweise der alte Name ARENA_<name>
export const envVar = (name, env = process.env) => env[`AGENTCITY_${name}`] ?? env[`ARENA_${name}`];

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = envVar('DATA_DIR') || path.join(os.homedir(), '.agentcity');
const LEGACY_DATA_DIR = path.join(os.homedir(), '.agent-arena'); // Datenordner bis v0.2 (Projekt hieß Agent Arena)
export const PORT = Number(process.env.PORT || 4317);
export const HOST = '127.0.0.1';
export const WINDOW_MIN = Number(process.env.WINDOW_MIN || 90);
export const CLAUDE_PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
export const CODEX_SESSIONS_DIR = process.env.CODEX_SESSIONS_DIR || path.join(os.homedir(), '.codex', 'sessions');
export const OPENCODE_DB = process.env.OPENCODE_DB || path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
export const HERMES_DB = process.env.HERMES_DB || path.join(os.homedir(), '.hermes', 'state.db');
export const DB_PATH = envVar('DB') || path.join(DATA_DIR, 'agentcity.db');
export const RETENTION_DAYS = retentionDays();

// Datenordner anlegen; Modus 0700 auch bei einem bereits vorhandenen Ordner
export function ensureDataDir(dir = DATA_DIR) {
  // einmalige Übernahme des alten Datenordners (Token, Tools, Datenbank)
  if (dir === DATA_DIR && !envVar('DATA_DIR') && !fs.existsSync(dir) && fs.existsSync(LEGACY_DATA_DIR)) {
    try { fs.renameSync(LEGACY_DATA_DIR, dir); } catch { /* dann frisch anlegen */ }
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* fremder Ordner – Rechte bleiben */ }
  // Datenbank bis v0.2 hieß arena.db
  if (!fs.existsSync(path.join(dir, 'agentcity.db')) && fs.existsSync(path.join(dir, 'arena.db'))) {
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.renameSync(path.join(dir, `arena.db${ext}`), path.join(dir, `agentcity.db${ext}`)); } catch { /* Datei fehlt */ }
    }
  }
  return dir;
}

// Datenbank samt WAL-Dateien nur für den Nutzer lesbar – zusätzlich zur umask aus start.js
// (ältere Dateien, Start ohne start.js). Fehlende Dateien und Fehler werden ignoriert.
export function secureDbFiles(dbPath) {
  if (!dbPath || dbPath === ':memory:') return;
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.chmodSync(f, 0o600); } catch { /* nicht vorhanden */ }
  }
}

// Liest das Token aus <dir>/token oder erzeugt es (32 Hex-Zeichen, Modus 0600)
export function loadToken(dir = DATA_DIR) {
  ensureDataDir(dir);
  const file = path.join(dir, 'token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{32}$/.test(t)) return t;
  } catch { /* noch nicht vorhanden */ }
  const token = randomBytes(16).toString('hex');
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return token;
}

export function loadConfig() {
  ensureDataDir();
  return {
    appDir: APP_DIR, dataDir: DATA_DIR, port: PORT, host: HOST, windowMin: WINDOW_MIN,
    claudeProjectsDir: CLAUDE_PROJECTS_DIR, codexSessionsDir: CODEX_SESSIONS_DIR, opencodeDb: OPENCODE_DB, hermesDb: HERMES_DB,
    dbPath: DB_PATH, retentionDays: RETENTION_DAYS, token: loadToken(),
  };
}

// Sperrdatei <dir>/server.lock mit PID: { ok, pid, release() }. Lebt der eingetragene Prozess nicht mehr, wird sie übernommen.
export function acquireLock(dir = DATA_DIR, pid = process.pid) {
  ensureDataDir(dir);
  const file = path.join(dir, 'server.lock');
  const alive = (p) => {
    try { process.kill(p, 0); return true; } catch (err) { return err.code === 'EPERM'; }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(pid), { flag: 'wx', mode: 0o600 });
      return { ok: true, pid, release: () => { try { if (fs.readFileSync(file, 'utf8').trim() === String(pid)) fs.unlinkSync(file); } catch { /* weg */ } } };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const other = Number(fs.readFileSync(file, 'utf8').trim());
      if (other && other !== pid && alive(other)) return { ok: false, pid: other, release: () => {} };
      try { fs.unlinkSync(file); } catch { /* bereits entfernt */ }
    }
  }
  return { ok: false, pid: null, release: () => {} };
}

// Befehlszeile eines Prozesses (ps) oder null
export function processCommand(pid) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim() || null;
  } catch { return null; }
}

// sieht die Befehlszeile nach einem Agent-City-Server aus?
export const isAppCommand = (cmd) => !!cmd && /agentcity|agent-arena|server\/(index|start)\.js/.test(cmd);

// Meldung bei belegter Sperrdatei (Zeilen ohne Einrückung)
export function lockMessage(dir, pid, command = processCommand(pid)) {
  const file = path.join(dir, 'server.lock');
  const lines = isAppCommand(command)
    ? [`Agent City läuft bereits mit diesem Datenordner (${dir}, PID ${pid}).`]
    : [`Die Sperrdatei ${file} verweist auf PID ${pid}, das ist aber offenbar kein Agent-City-Prozess${command ? ` (${command.slice(0, 80)})` : ''}.`];
  lines.push(`Anderer Datenordner:  AGENTCITY_DATA_DIR=/pfad agentcity`);
  lines.push(`Läuft sicher kein Server mehr:  rm ${file.replace(os.homedir(), '~')}`);
  return lines;
}
