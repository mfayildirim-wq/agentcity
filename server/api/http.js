// HTTP: statische Dateien, Vendor-Pakete aus node_modules, Health-Check, Token-Cookie
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
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
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export function createHttpServer({ config, publicDir = path.join(ARENA_DIR, 'public'), routes = {} }) {
  const nm = path.join(config.arenaDir ?? ARENA_DIR, 'node_modules');
  const VENDOR = {
    '/vendor/three/': path.join(nm, 'three'),
    '/vendor/xterm/': path.join(nm, '@xterm', 'xterm'),
    '/vendor/xterm-fit/': path.join(nm, '@xterm', 'addon-fit'),
  };

  function serveFile(res, rootDir, rel, headers = {}, cache = 'no-cache') {
    let fp;
    try { fp = path.normalize(path.join(rootDir, decodeURIComponent(rel))); } catch { res.writeHead(400).end(); return; }
    if (fp !== rootDir && !fp.startsWith(rootDir + path.sep)) { res.writeHead(404).end('Not found'); return; }
    fs.stat(fp, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404).end('Not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
        'Cache-Control': cache,
        'X-Content-Type-Options': 'nosniff',
        ...headers,
      });
      fs.createReadStream(fp).pipe(res);
    });
  }

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  return http.createServer((req, res) => {
    if (!isLocalHost(req.headers.host)) { res.writeHead(403).end('Forbidden'); return; }
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;

    if (p === '/api/health') { json(res, 200, { ok: true }); return; }
    if (routes[p]) { routes[p](req, res, url); return; }

    for (const [prefix, dir] of Object.entries(VENDOR)) {
      if (p.startsWith(prefix)) { serveFile(res, dir, p.slice(prefix.length), {}, 'max-age=86400'); return; }
    }

    if (p === '/' || p === '/index.html') {
      serveFile(res, publicDir, 'index.html', {
        'Set-Cookie': `arena_token=${config.token}; SameSite=Strict; Path=/; Max-Age=31536000`,
      });
      return;
    }
    serveFile(res, publicDir, p);
  });
}
