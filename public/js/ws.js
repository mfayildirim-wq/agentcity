// WebSocket-Verbindung zum Server: Anmeldung per Token, Wiederverbindung, Anfrage/Antwort
const BACKOFF = [1000, 2000, 4000, 8000, 10000];

// Token aus dem Cookie; zuletzt gültiges merken, falls das Cookie verloren geht
let cachedToken = null;
function readToken() {
  const m = document.cookie.match(/(?:^|;\s*)arena_token=([0-9a-f]+)/);
  if (m) cachedToken = m[1];
  return cachedToken;
}

// Startseite neu abrufen, damit der Server das Cookie erneut setzt
async function refreshCookie() {
  try { await fetch('/', { credentials: 'same-origin', cache: 'no-store' }); } catch { /* Server nicht erreichbar */ }
}

export function createConnection({ onMessage, onStatus } = {}) {
  let ws = null;
  let attempt = 0;
  let timer = null;
  let seq = 0;
  let stopped = false;
  const pending = new Map(); // id → { resolve, reject }

  function status(s, info) { onStatus?.(s, info); }

  function connect() {
    clearTimeout(timer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: readToken() }));
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'snapshot') { attempt = 0; status('live'); }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.type === 'error') p.reject(new Error(msg.message)); else p.resolve(msg);
        return;
      }
      onMessage?.(msg);
    };
    ws.onclose = (e) => {
      for (const p of pending.values()) p.reject(new Error('Verbindung getrennt'));
      pending.clear();
      status('off', { code: e.code });
      if (stopped) return;
      const delay = BACKOFF[Math.min(attempt++, BACKOFF.length - 1)];
      if (e.code === 4401) cachedToken = null;
      timer = setTimeout(async () => { if (e.code === 4401) await refreshCookie(); connect(); }, delay);
    };
    ws.onerror = () => {};
  }

  const isOpen = () => ws?.readyState === WebSocket.OPEN;

  function send(type, payload = {}) {
    if (!isOpen()) return false;
    ws.send(JSON.stringify({ type, ...payload }));
    return true;
  }

  function request(type, payload = {}, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      if (!isOpen()) { reject(new Error('Keine Verbindung')); return; }
      const id = `r${++seq}`;
      const t = setTimeout(() => { pending.delete(id); reject(new Error('Zeitüberschreitung')); }, timeoutMs);
      pending.set(id, {
        resolve: (m) => { clearTimeout(t); resolve(m); },
        reject: (err) => { clearTimeout(t); reject(err); },
      });
      ws.send(JSON.stringify({ type, id, ...payload }));
    });
  }

  // Erneut anmelden → Server schickt einen frischen Snapshot
  function resync() { if (isOpen()) ws.send(JSON.stringify({ type: 'hello', token: readToken() })); }

  function close() { stopped = true; clearTimeout(timer); ws?.close(); }

  connect();
  return { send, request, resync, close, isOpen };
}
