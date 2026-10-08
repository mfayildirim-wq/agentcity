// WebSocket-Router: Token-Prüfung, Snapshot, Anfrage/Antwort, Bus → alle Clients
import { WebSocketServer } from 'ws';
import { BROADCAST_TYPES } from '../core/bus.js';
import { isLocalHost, safeEqual, cookieToken } from './http.js';

// Verbindungen ohne Origin (Nicht-Browser, z. B. Skripte mit dem Token) dürfen nur lesen.
// history.resume startet einen Agenten-Prozess und zählt deshalb nicht dazu; artifact.open (öffnet Dateien/URLs
// auf dem Rechner) geht nur aus dem Browser.
export function readOnlyAllowed(type) {
  if (type === 'history.resume') return false;
  return type === 'chat.history' || type === 'pty.list' || type === 'fs.pickDir' || type === 'artifact.list' || type.startsWith('history.');
}

// Nur Agent City-Seite selbst darf sich verbinden: Origin (Host + Port) muss dem Host-Header
// entsprechen. Ohne Origin (Nicht-Browser) entscheidet allein das Token.
export function originAllowed(origin, hostHeader) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && isLocalHost(u.host)
      && u.host.toLowerCase() === String(hostHeader).toLowerCase();
  } catch { return false; }
}

const MAX_BUFFERED = 4 * 1024 * 1024;
// Terminal-Ausgabe ist verzichtbar (Puffer per pty.list/pty.open nachladbar) – früher überspringen
const PTY_MAX_BUFFERED = 1024 * 1024;

export function attachWs({ server, ctx, handlers = {}, token, pingMs = 15_000, authTimeoutMs = 5_000 }) {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 4 * 1024 * 1024,
    verifyClient: ({ origin, req }) => isLocalHost(req.headers.host) && originAllowed(origin, req.headers.host),
  });
  // Fehler des HTTP-Servers (z. B. EADDRINUSE) reicht ws weiter – dort behandelt
  wss.on('error', () => {});
  const clients = new Set(); // authentifizierte Verbindungen

  const encode = (msg) => JSON.stringify(msg);
  function broadcast(msg, maxBuffered = MAX_BUFFERED) {
    const data = encode(msg);
    for (const ws of clients) {
      // langsame Clients überspringen statt Speicher zu stauen
      if (ws.readyState === ws.OPEN && ws.bufferedAmount <= maxBuffered) ws.send(data);
    }
  }

  const snapshot = () => ({
    type: 'snapshot',
    ...ctx.state.snapshot({ tools: ctx.registry?.publicList?.() ?? ctx.registry?.list?.() ?? [] }),
    ...(ctx.permissionsSnapshot ? { permissions: ctx.permissionsSnapshot() } : {}),
    // Artefakte der laufenden Sessions (letzte 10 je Session)
    ...(ctx.artifacts?.snapshot ? { artifacts: ctx.artifacts.snapshot() } : {}),
  });

  // Bus-Ereignisse an alle Browser weiterreichen
  const forwarders = BROADCAST_TYPES.map((type) => {
    const limit = type === 'pty.output' ? PTY_MAX_BUFFERED : MAX_BUFFERED;
    const fn = (payload) => broadcast({ type, ...payload }, limit);
    ctx.bus.on(type, fn);
    return [type, fn];
  });

  wss.on('connection', (ws, req) => {
    let authed = false;
    const readOnly = !req.headers.origin;
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
    // Browser (mit Origin) melden sich nur per Cookie an – fehlt es, sofort abweisen
    else if (req.headers.origin) ws.close(4401, 'Cookie fehlt');

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { send({ type: 'error', message: 'Ungültiges JSON' }); return; }
      if (!msg || typeof msg.type !== 'string') { send({ type: 'error', message: 'Nachricht ohne type' }); return; }

      // hello: Anmeldung per Token (Nicht-Browser) bzw. bei Cookie-Anmeldung Bitte um frischen Snapshot
      if (msg.type === 'hello') {
        if (authed) send(snapshot());
        else if (safeEqual(msg.token, token)) authenticate();
        else if (!authed) ws.close(4401, 'Token ungültig');
        return;
      }
      if (!authed) { ws.close(4401, 'Nicht angemeldet'); return; }

      if (readOnly && !readOnlyAllowed(msg.type)) {
        send({ type: 'error', id: msg.id, message: `Verbindung ohne Browser-Origin ist nur lesend: ${msg.type}` });
        return;
      }
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
