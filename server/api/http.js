// HTTP: statische Dateien, Vendor-Pakete aus node_modules, Health-Check, Anmeldung per Login-Link (Cookie)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { ARENA_DIR } from '../config.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

// Nur lokale Hosts – schützt vor DNS-Rebinding (fremde Seite, die auf 127.0.0.1 zeigt)
export function isLocalHost(hostHeader) {
  if (typeof hostHeader !== 'string') return false;
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

export function cookieToken(header = '') {
  const m = String(header).match(/(?:^|;\s*)arena_token=([0-9a-f]+)/);
  return m ? m[1] : null;
}

export const loginUrl = (host, port, token) => `http://${host}:${port}/?t=${token}`;

// Seite für Aufrufe ohne gültiges Cookie – enthält bewusst kein Token
const LOGIN_PAGE = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Agent Arena</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<style>
  body { margin: 0; height: 100vh; display: grid; place-items: center; background: #0f1115; color: #c9ced6;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 360px; padding: 24px; text-align: center; }
  h1 { margin: 0 0 8px; font-size: 16px; font-weight: 600; color: #fff; }
  p { margin: 0; color: #8b929c; }
  code { font: 12px ui-monospace, Menlo, monospace; color: #c9ced6; }
</style></head>
<body><main><h1>Agent Arena</h1><p>Bitte den Link aus dem Terminal öffnen<br><code>http://127.0.0.1:…/?t=…</code></p></main></body></html>
`;

export function createHttpServer({ config, publicDir = path.join(ARENA_DIR, 'public'), routes = {} }) {
  const nm = path.join(config.arenaDir ?? ARENA_DIR, 'node_modules');
  const VENDOR = {
    '/vendor/three/': path.join(nm, 'three'),
    '/vendor/xterm/': path.join(nm, '@xterm', 'xterm'),
    '/vendor/xterm-fit/': path.join(nm, '@xterm', 'addon-fit'),
  };

  function serveFile(res, rootDir, rel, headers = {}, cache = 'no-cache') {
    let decoded;
    try { decoded = decodeURIComponent(rel); } catch { res.writeHead(400).end('Bad request'); return; }
    if (decoded.includes('\0')) { res.writeHead(400).end('Bad request'); return; }
    const fp = path.normalize(path.join(rootDir, decoded));
    if (fp !== rootDir && !fp.startsWith(rootDir + path.sep)) { res.writeHead(404).end('Not found'); return; }
    const onStat = (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404).end('Not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
        'Cache-Control': cache,
        'X-Content-Type-Options': 'nosniff',
        ...headers,
      });
      fs.createReadStream(fp).on('error', () => res.destroy()).pipe(res);
    };
    try { fs.stat(fp, onStat); } catch { res.writeHead(400).end('Bad request'); }
  }

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const unauthorized = (res) => {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(LOGIN_PAGE);
  };

  return http.createServer((req, res) => {
    if (!isLocalHost(req.headers.host)) { res.writeHead(403).end('Forbidden'); return; }
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;

    if (p === '/api/health') { json(res, 200, { ok: true }); return; }

    // Login-Link aus dem Terminal: /?t=<token> setzt das Cookie und leitet auf / um
    if (p === '/' && url.searchParams.has('t')) {
      if (!safeEqual(url.searchParams.get('t'), config.token)) { unauthorized(res); return; }
      url.searchParams.delete('t');
      const qs = url.searchParams.toString();
      res.writeHead(302, {
        Location: qs ? `/?${qs}` : '/',
        'Set-Cookie': `arena_token=${config.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    }
    // alles Weitere nur mit gültigem Cookie
    if (!safeEqual(cookieToken(req.headers.cookie), config.token)) { unauthorized(res); return; }

    if (routes[p]) { routes[p](req, res, url); return; }

    for (const [prefix, dir] of Object.entries(VENDOR)) {
      if (p.startsWith(prefix)) { serveFile(res, dir, p.slice(prefix.length), {}, 'max-age=86400'); return; }
    }

    if (p === '/' || p === '/index.html') { serveFile(res, publicDir, 'index.html'); return; }
    serveFile(res, publicDir, p);
  });
}
