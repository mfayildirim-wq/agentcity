// WebSocket-Router: Token-Prüfung, Snapshot, Anfrage/Antwort, Bus → alle Clients
import { WebSocketServer } from 'ws';
import { timingSafeEqual } from 'node:crypto';
import { BROADCAST_TYPES } from '../core/bus.js';
import { isLocalHost } from './http.js';

const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

function cookieToken(header = '') {
  const m = header.match(/(?:^|;\s*)arena_token=([0-9a-f]+)/);
  return m ? m[1] : null;
}

// Nur Seiten von 127.0.0.1/localhost dürfen sich verbinden (Origin fehlt bei Nicht-Browsern)
function originAllowed(origin) {
  if (!origin) return true;
  try { return isLocalHost(new URL(origin).host); } catch { return false; }
}

export function attachWs({ server, ctx, handlers = {}, token, pingMs = 15_000, authTimeoutMs = 5_000 }) {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 4 * 1024 * 1024,
    verifyClient: ({ origin, req }) => originAllowed(origin) && isLocalHost(req.headers.host),
  });
  const clients = new Set(); // authentifizierte Verbindungen

  const encode = (msg) => JSON.stringify(msg);
  function broadcast(msg) {
    const data = encode(msg);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  const snapshot = () => ({
    type: 'snapshot',
    ...ctx.state.snapshot({ tools: ctx.registry?.list?.() ?? [] }),
    ...(ctx.permissionsSnapshot ? { permissions: ctx.permissionsSnapshot() } : {}),
  });

  // Bus-Ereignisse an alle Browser weiterreichen
  const forwarders = BROADCAST_TYPES.map((type) => {
    const fn = (payload) => broadcast({ type, ...payload });
    ctx.bus.on(type, fn);
    return [type, fn];
  });

  wss.on('connection', (ws, req) => {
    let authed = false;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const send = (msg) => { if (ws.readyState === ws.OPEN) ws.send(encode(msg)); };
    const conn = { ...ctx, send, broadcast, ws };

    const authenticate = () => {
      authed = true;
      clearTimeout(authTimer);
      clients.add(ws);
      send(snapshot());
    };
    const authTimer = setTimeout(() => { if (!authed) ws.close(4401, 'Token fehlt'); }, authTimeoutMs);
    if (safeEqual(cookieToken(req.headers.cookie), token)) authenticate();

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { send({ type: 'error', message: 'Ungültiges JSON' }); return; }
      if (!msg || typeof msg.type !== 'string') { send({ type: 'error', message: 'Nachricht ohne type' }); return; }

      if (msg.type === 'hello') {
        if (safeEqual(msg.token, token)) { if (authed) send(snapshot()); else authenticate(); }
        else if (!authed) ws.close(4401, 'Token ungültig');
        return;
      }
      if (!authed) { ws.close(4401, 'Nicht angemeldet'); return; }

      const handler = Object.hasOwn(handlers, msg.type) ? handlers[msg.type] : null;
      if (!handler) { send({ type: 'error', id: msg.id, message: `Unbekannter Nachrichtentyp: ${msg.type}` }); return; }
      try {
        const result = await handler(conn, msg);
        if (msg.id !== undefined) send({ type: `${msg.type}.result`, id: msg.id, ...(result ?? {}) });
      } catch (err) {
        send({ type: 'error', id: msg.id, message: err?.message || String(err) });
      }
    });

    ws.on('close', () => { clearTimeout(authTimer); clients.delete(ws); });
    ws.on('error', () => {});
  });

  // Ping alle 15 s, tote Verbindungen schließen
  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* bereits geschlossen */ }
    }
  }, pingMs);
  pinger.unref?.();

  function close() {
    clearInterval(pinger);
    for (const [type, fn] of forwarders) ctx.bus.off(type, fn);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  }

  return { wss, clients, broadcast, close };
}
