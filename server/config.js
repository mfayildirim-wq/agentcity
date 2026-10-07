// Pfade, Port, Zeitfenster und Zugangstoken
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ARENA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.ARENA_DATA_DIR || path.join(os.homedir(), '.agent-arena');
export const PORT = Number(process.env.PORT || 4317);
export const HOST = '127.0.0.1';
export const WINDOW_MIN = Number(process.env.WINDOW_MIN || 90);
export const CLAUDE_PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
export const DB_PATH = process.env.ARENA_DB || path.join(DATA_DIR, 'arena.db');

export function ensureDataDir(dir = DATA_DIR) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
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
    arenaDir: ARENA_DIR, dataDir: DATA_DIR, port: PORT, host: HOST, windowMin: WINDOW_MIN,
    claudeProjectsDir: CLAUDE_PROJECTS_DIR, dbPath: DB_PATH, token: loadToken(),
  };
}
