// Gemeinsame Hilfen der Watcher für Codex, OpenCode und Hermes.
import fsp from 'node:fs/promises';
import path from 'node:path';

export const IDLE_MS = 2 * 60_000;
export const STALE_MS = 15 * 60_000;
export const SNAPSHOT_EVENTS = 14;
export const MAX_EVENTS = 40;

export const trunc = (s, n) => {
  if (s == null) return null;
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
export const base = (p) => (p ? path.basename(String(p)) : '');

// kurzer Inhalts-Hash (FNV-1a) für stabile Ereignis-Ids
export function lineHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

// Status einer Hauptsession nach Alter der letzten Aktivität (wie beim Claude-Watcher)
export function agedStatus(status, age) {
  if (status === 'waiting_user' && age > 10 * 60_000) return 'idle';
  if ((status === 'thinking' || status === 'tool') && age > STALE_MS) return 'idle';
  if (status === 'thinking' && age > IDLE_MS) return 'idle';
  return status;
}

// Werkzeugname → Station, wenn kein eigenes Mapping greift
export function guessCategory(name = '') {
  const n = String(name).toLowerCase();
  if (n.startsWith('mcp__') || n.includes('__')) return 'portal';
  if (/(^|_)(bash|shell|terminal|exec|process|command|stdin|run)(_|$)/.test(n)) return 'terminal';
  if (/web|browser|fetch|url|http/.test(n)) return 'portal';
  if (/write|patch|edit|create|delete|move|rename/.test(n)) return 'workbench';
  if (/read|search|grep|glob|list|view|find|lsp|skill/.test(n)) return 'library';
  if (/agent|delegate|task|todo|plan|message/.test(n)) return 'meeting';
  if (/question|clarify|ask/.test(n)) return 'lounge';
  return 'workbench';
}

export async function readRange(file, start, end) {
  const len = Math.max(0, end - start);
  const buf = Buffer.alloc(len);
  if (!len) return buf;
  const fh = await fsp.open(file, 'r');
  try {
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return bytesRead < len ? buf.subarray(0, bytesRead) : buf;
  } finally { await fh.close(); }
}

// einmalige Fehlermeldung je Watcher und Schlüssel
export function onceLogger(tag) {
  const seen = new Set();
  return (key, err) => {
    if (seen.has(key)) return;
    seen.add(key);
    console.error(`[watch:${tag}] ${key}: ${err?.message ?? err}`);
  };
}
