// Vorschau-Auslieferung (v0.3): GET /preview/<sessionId>/<relpfad> liefert eine Datei aus dem Projektordner der
// Session (laufend oder aus der DB). Nur mit gültigem Cookie (prüft http.js vorab), Pfad per Realpath unter cwd,
// Content-Type nach Endung, HTML in einer Sandbox (kein allow-same-origin → kein Zugriff auf Cookie oder WS),
// Textdateien bis 2 MB, Bilder bis 20 MB, sonst 413. Dateien ohne Vorschau-Art (kind file) → 404.
import fs from 'node:fs';
import path from 'node:path';
import { kindOfPath, extOf } from '../core/model.js';

export const PREVIEW_PREFIX = '/preview/';
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8', '.yml': 'text/yaml; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.xml': 'text/xml; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

// Content-Type nach Endung; Code-Dateien als reiner Text
export function contentTypeOf(p) {
  const ext = extOf(p);
  if (MIME[ext]) return MIME[ext];
  return kindOfPath(p) === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream';
}

// Pfad der Anfrage zerlegen: { sessionId, rel } oder null
export function parsePreviewPath(pathname) {
  if (!pathname.startsWith(PREVIEW_PREFIX)) return null;
  const rest = pathname.slice(PREVIEW_PREFIX.length);
  const i = rest.indexOf('/');
  if (i <= 0) return null;
  let sessionId;
  let rel;
  try {
    sessionId = decodeURIComponent(rest.slice(0, i));
    rel = rest.slice(i + 1).split('/').map(decodeURIComponent).join('/');
  } catch { return null; }
  if (!sessionId || !rel || rel.includes('\0') || sessionId.includes('\0')) return null;
  return { sessionId, rel };
}

// Projektordner einer Session: laufender Hauptagent, sonst DB
export function cwdOfSession(sessionId, { state, repo }) {
  const a = state?.all?.().find((x) => x.sessionId === sessionId && x.kind === 'main' && x.cwd);
  if (a) return a.cwd;
  try { return repo?.history?.session?.(sessionId)?.cwd ?? null; } catch { return null; }
}

// Realpath der Datei, wenn sie unter cwd liegt (Symlinks nach außen → null)
export function resolveUnder(cwd, rel) {
  try {
    const root = fs.realpathSync(cwd);
    const real = fs.realpathSync(path.resolve(root, rel));
    if (real === root || !real.startsWith(root + path.sep)) return null;
    return real;
  } catch { return null; }
}

export function createPreviewHandler({ state, repo }) {
  const fail = (res, status, text) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(text); };
  return function preview(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { fail(res, 405, 'Method not allowed'); return; }
    const parsed = parsePreviewPath(url.pathname);
    if (!parsed) { fail(res, 404, 'Not found'); return; }
    const cwd = cwdOfSession(parsed.sessionId, { state, repo });
    if (!cwd) { fail(res, 404, 'Session unbekannt'); return; }
    const real = resolveUnder(cwd, parsed.rel);
    if (!real) { fail(res, 404, 'Not found'); return; }
    const kind = kindOfPath(real);
    if (kind === 'file') { fail(res, 404, 'Keine Vorschau für diese Dateiart'); return; }
    let st;
    try { st = fs.statSync(real); } catch { fail(res, 404, 'Not found'); return; }
    if (!st.isFile()) { fail(res, 404, 'Not found'); return; }
    const limit = kind === 'image' || kind === 'pdf' ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
    if (st.size > limit) { fail(res, 413, `Datei zu groß für die Vorschau (${st.size} Bytes)`); return; }
    const headers = {
      'Content-Type': contentTypeOf(real), 'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    };
    // HTML: Sandbox ohne allow-same-origin – die Seite erreicht weder Cookie noch WebSocket von Agent City
    if (kind === 'html') headers['Content-Security-Policy'] = 'sandbox allow-scripts allow-forms';
    // SVG kann Skripte enthalten: ebenfalls isolieren
    if (extOf(real) === '.svg') headers['Content-Security-Policy'] = 'sandbox';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(real).on('error', () => res.destroy()).pipe(res);
  };
}
