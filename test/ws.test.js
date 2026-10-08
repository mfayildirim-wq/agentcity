import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { createHttpServer } from '../server/api/http.js';
import { attachWs } from '../server/api/ws.js';
import { createBus } from '../server/core/bus.js';
import { createState } from '../server/core/state.js';
import { createAgent } from '../server/core/model.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
let server; let port; let bus; let state; let wsApi;

before(async () => {
  bus = createBus();
  state = createState({ bus });
  state.upsert(createAgent({ id: 'a1', toolId: 'claude', project: 'p' }));
  const config = { token: TOKEN, port: 0 };
  server = createHttpServer({ config });
  wsApi = attachWs({
    server, token: TOKEN, authTimeoutMs: 200,
    ctx: { state, bus, config },
    handlers: {
      echo: (ctx, msg) => ({ text: msg.text }),
      boom: () => { throw new Error('kaputt'); },
      'session.create': () => ({ ok: true }),
      'history.sessions': () => ({ sessions: [] }),
      'history.resume': () => ({ ok: true }),
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(async () => {
  wsApi.close();
  await new Promise((r) => server.close(r));
});

const get = (path, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
    let body = '';
    res.on('data', (d) => (body += d));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  }).on('error', reject);
});

function open(opts) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, opts);
  const queue = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    const w = waiters.findIndex((x) => x.pred(m));
    if (w >= 0) waiters.splice(w, 1)[0].resolve(m); else queue.push(m);
  });
  ws.next = (pred = () => true) => new Promise((resolve) => {
    const i = queue.findIndex(pred);
    if (i >= 0) resolve(queue.splice(i, 1)[0]); else waiters.push({ pred, resolve });
  });
  ws.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  ws.opened = new Promise((resolve) => ws.on('open', resolve));
  return ws;
}

const COOKIE = { Cookie: `arena_token=${TOKEN}` };

test('HTTP: /api/health frei, / ohne Cookie → 401 ohne Token', async () => {
  const h = await get('/api/health');
  assert.equal(h.status, 200);
  assert.deepEqual(JSON.parse(h.body), { ok: true });
  const idx = await get('/');
  assert.equal(idx.status, 401);
  assert.equal(idx.headers['set-cookie'], undefined);
  assert.match(idx.body, /Link aus dem Terminal/);
  assert.ok(!idx.body.includes(TOKEN), 'kein Token in der Seite');
  assert.equal((await get('/index.html')).status, 401);
  assert.equal((await get('/js/main.js')).status, 401);
  assert.equal((await get('/vendor/three/build/three.module.js')).status, 401);
  assert.equal((await get('/', { Cookie: 'arena_token=ffffffffffffffffffffffffffffffff' })).status, 401);
});

test('HTTP: /?t=falsch → 401 ohne Cookie; /?t=richtig → 302 + Set-Cookie', async () => {
  for (const t of ['falsch', 'ffffffffffffffffffffffffffffffff', '']) {
    const r = await get(`/?t=${t}`);
    assert.equal(r.status, 401, t);
    assert.equal(r.headers['set-cookie'], undefined, t);
  }
  const ok = await get(`/?t=${TOKEN}`);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.location, '/');
  assert.match(ok.headers['set-cookie'][0], new RegExp(`^arena_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`));
  // weitere Parameter bleiben erhalten
  assert.equal((await get(`/?demo&t=${TOKEN}`)).headers.location, '/?demo=');
});

test('HTTP: mit Cookie → Seite, statische Dateien und Vendor', async () => {
  const idx = await get('/', COOKIE);
  assert.equal(idx.status, 200);
  assert.equal(idx.headers['set-cookie'], undefined);
  assert.match(idx.body, /<html/i);
  assert.equal((await get('/js/main.js', COOKIE)).status, 200);
  assert.equal((await get('/vendor/three/build/three.module.js', COOKIE)).status, 200);
  assert.equal((await get('/vendor/xterm/css/xterm.css', COOKIE)).status, 200);
});

test('HTTP: Nullbyte und Traversal', async () => {
  assert.equal((await get('/a%00b', COOKIE)).status, 400);
  assert.equal((await get('/vendor/three/a%00b', COOKIE)).status, 400);
  assert.equal((await get('/%E0%A4%A', COOKIE)).status, 400); // ungültige Kodierung
  assert.equal((await get('/api/health')).status, 200); // Server lebt noch
  assert.equal((await get('/..%2fpackage.json', COOKIE)).status, 404);
  assert.equal((await get('/..%2f..%2fpackage.json', COOKIE)).status, 404);
  assert.equal((await get('/vendor/three/..%2f..%2fpackage.json', COOKIE)).status, 404);
  assert.equal((await get('/vendor/three/..%2f..%2f..%2fpackage.json', COOKIE)).status, 404);
  assert.equal((await get('/css/..%2f..%2fpackage.json', COOKIE)).status, 404);
});

test('HTTP: fremder Host-Header wird abgewiesen', async () => {
  const r = await get(`/?t=${TOKEN}`, { Host: 'evil.example:4317' });
  assert.equal(r.status, 403);
  assert.equal(r.headers['set-cookie'], undefined);
});

test('WS ohne gültiges Token → 4401', async () => {
  const ws = open();
  await ws.opened;
  ws.send(JSON.stringify({ type: 'hello', token: 'falsch' }));
  assert.equal(await ws.closed, 4401);
  const silent = open();
  assert.equal(await silent.closed, 4401); // Zeitüberschreitung ohne hello
});

test('WS mit Token per hello → snapshot', async () => {
  const ws = open();
  await ws.opened;
  ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
  assert.equal((await ws.next((m) => m.type === 'snapshot')).agents.length, 1);
  ws.close();
});

test('WS (Browser) → snapshot, Router, Fehler, Broadcast', async () => {
  const ws = open({ headers: { Origin: `http://127.0.0.1:${port}`, ...COOKIE } });
  const snap = await ws.next((m) => m.type === 'snapshot');
  assert.equal(snap.agents.length, 1);
  assert.ok(Array.isArray(snap.permissions) && Array.isArray(snap.tools));
  ws.send(JSON.stringify({ type: 'echo', id: 'r1', text: 'hi' }));
  assert.deepEqual(await ws.next((m) => m.id === 'r1'), { type: 'echo.result', id: 'r1', text: 'hi' });
  ws.send(JSON.stringify({ type: 'boom', id: 'r2' }));
  assert.deepEqual(await ws.next((m) => m.id === 'r2'), { type: 'error', id: 'r2', message: 'kaputt' });
  ws.send(JSON.stringify({ type: 'gibtsnicht', id: 'r3' }));
  assert.equal((await ws.next((m) => m.id === 'r3')).type, 'error');
  state.upsert(createAgent({ id: 'a2', toolId: 'claude', project: 'p' }));
  const up = await ws.next((m) => m.type === 'agent.update');
  assert.equal(up.agent.id, 'a2');
  ws.close();
});

test('WS mit Cookie → snapshot ohne hello', async () => {
  const ws = open({ headers: { Cookie: `arena_token=${TOKEN}` } });
  const snap = await ws.next((m) => m.type === 'snapshot');
  assert.ok(snap.agents.length >= 1);
  ws.close();
});

test('WS mit fremdem Origin oder anderem Port wird abgelehnt', async () => {
  for (const origin of ['http://evil.example', 'http://127.0.0.1:3000', 'http://localhost:3000']) {
    const ws = open({ headers: { Origin: origin, Cookie: `arena_token=${TOKEN}` } });
    let opened = false;
    ws.on('open', () => { opened = true; });
    ws.on('error', () => {});
    const code = await ws.closed;
    assert.equal(opened, false, origin);
    assert.notEqual(code, 1000);
  }
});

test('WS mit eigenem Origin + Cookie → snapshot; ohne Cookie → 4401 sofort', async () => {
  const origin = `http://127.0.0.1:${port}`;
  const ok = open({ headers: { Origin: origin, Cookie: `arena_token=${TOKEN}` } });
  assert.equal((await ok.next((m) => m.type === 'snapshot')).type, 'snapshot');
  // hello ohne Token liefert bei Cookie-Anmeldung einen frischen Snapshot
  ok.send(JSON.stringify({ type: 'hello' }));
  assert.equal((await ok.next((m) => m.type === 'snapshot')).type, 'snapshot');
  ok.close();
  const t0 = Date.now();
  const no = open({ headers: { Origin: origin } });
  assert.equal(await no.closed, 4401);
  assert.ok(Date.now() - t0 < 150, 'ohne Wartezeit');
});

test('WS über Login-Link: Cookie aus /?t= → Snapshot', async () => {
  const login = await get(`/?t=${TOKEN}`);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const ws = open({ headers: { Origin: `http://127.0.0.1:${port}`, Cookie: cookie } });
  assert.equal((await ws.next((m) => m.type === 'snapshot')).type, 'snapshot');
  ws.close();
});

test('WS ohne Origin darf nur lesen', async () => {
  const ws = open();
  await ws.opened;
  ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
  await ws.next((m) => m.type === 'snapshot');
  ws.send(JSON.stringify({ type: 'session.create', id: 'w1', toolId: 'x' }));
  const denied = await ws.next((m) => m.id === 'w1');
  assert.equal(denied.type, 'error');
  assert.match(denied.message, /nur lesend/);
  ws.send(JSON.stringify({ type: 'echo', id: 'w2', text: 'x' }));
  assert.equal((await ws.next((m) => m.id === 'w2')).type, 'error');
  ws.send(JSON.stringify({ type: 'history.sessions', id: 'w3' }));
  assert.deepEqual(await ws.next((m) => m.id === 'w3'), { type: 'history.sessions.result', id: 'w3', sessions: [] });
  ws.send(JSON.stringify({ type: 'history.resume', id: 'w4' }));
  assert.match((await ws.next((m) => m.id === 'w4')).message, /nur lesend/);
  ws.close();
  // mit Browser-Origin dieselbe Anfrage erlaubt
  const b = open({ headers: { Origin: `http://127.0.0.1:${port}`, ...COOKIE } });
  await b.next((m) => m.type === 'snapshot');
  b.send(JSON.stringify({ type: 'session.create', id: 'w5' }));
  assert.deepEqual(await b.next((m) => m.id === 'w5'), { type: 'session.create.result', id: 'w5', ok: true });
  b.close();
});
