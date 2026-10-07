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

test('HTTP: /api/health und Cookie auf /', async () => {
  const h = await get('/api/health');
  assert.equal(h.status, 200);
  assert.deepEqual(JSON.parse(h.body), { ok: true });
  const idx = await get('/');
  assert.equal(idx.status, 200);
  assert.match(idx.headers['set-cookie'][0], new RegExp(`arena_token=${TOKEN}; SameSite=Strict; Path=/`));
  const three = await get('/vendor/three/build/three.module.js');
  assert.equal(three.status, 200);
  const xterm = await get('/vendor/xterm/css/xterm.css');
  assert.equal(xterm.status, 200);
  assert.equal((await get('/../package.json')).status, 404);
});

test('HTTP: fremder Host-Header wird abgewiesen', async () => {
  const r = await get('/', { Host: 'evil.example:4317' });
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

test('WS mit Token → snapshot, Router, Fehler, Broadcast', async () => {
  const ws = open();
  await ws.opened;
  ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
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

test('WS mit fremdem Origin wird abgelehnt', async () => {
  const ws = open({ headers: { Origin: 'http://evil.example' } });
  ws.on('error', () => {});
  const code = await ws.closed;
  assert.notEqual(code, 1000);
});
