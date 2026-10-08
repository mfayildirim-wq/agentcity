import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createHttpServer } from '../server/api/http.js';
import { attachWs } from '../server/api/ws.js';
import { createHandlers } from '../server/api/handlers/index.js';
import settingsHandlers from '../server/api/handlers/settings.js';
import { createBus } from '../server/core/bus.js';
import { createState } from '../server/core/state.js';
import { createRegistry } from '../server/agents/registry.js';

const TOKEN = 'abcdefabcdefabcdefabcdefabcdef12';
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-agent.js');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-wsset-'));
let server; let port; let wsApi;

before(async () => {
  const bus = createBus();
  const state = createState({ bus });
  const registry = createRegistry({ dataDir, arenaDir: '/x/arena' });
  const config = { token: TOKEN, port: 0 };
  server = createHttpServer({ config });
  wsApi = attachWs({ server, token: TOKEN, ctx: { state, bus, registry, config }, handlers: createHandlers(settingsHandlers) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(async () => {
  wsApi.close();
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function open() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: `http://127.0.0.1:${port}`, Cookie: `arena_token=${TOKEN}` } });
  const queue = [];
  const waiters = [];
  let seq = 0;
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    queue.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  ws.next = (pred, ms = 8000) => new Promise((resolve, reject) => {
    const hit = queue.find(pred);
    if (hit) { resolve(hit); return; }
    const t = setTimeout(() => reject(new Error('Zeitüberschreitung')), ms);
    waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
  ws.request = async (type, payload = {}) => {
    const id = `q${++seq}`;
    ws.send(JSON.stringify({ type, id, ...payload }));
    const res = await ws.next((m) => m.id === id, 15000);
    if (res.type === 'error') throw new Error(res.message);
    return res;
  };
  ws.opened = new Promise((resolve) => ws.on('open', resolve));
  return ws;
}

test('settings.agents.*: Liste, Speichern (mit tools.update), Testen, Löschen', async () => {
  const ws = open();
  await ws.opened;
  ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
  const snap = await ws.next((m) => m.type === 'snapshot');
  assert.deepEqual(snap.tools.map((t) => t.id), ['claude', 'codex', 'opencode', 'hermes', 'gemini']);
  assert.ok(snap.tools.every((t) => t.command === undefined));

  const { agents } = await ws.request('settings.agents.list');
  assert.equal(agents.length, 5);
  assert.ok(agents[0].args.length, 'Einstellungen sehen Argumente');

  const fake = { id: 'fake', name: 'Fake', command: 'node', args: [FAKE], env: {}, color: '#888888', avatarStyle: 'visor' };
  const saved = await ws.request('settings.agents.save', { agent: fake });
  assert.equal(saved.agents.length, 6);
  const upd = await ws.next((m) => m.type === 'tools.update');
  assert.ok(upd.tools.some((t) => t.id === 'fake' && t.avatarStyle === 'visor' && t.installed));

  await assert.rejects(() => ws.request('settings.agents.save', { agent: { ...fake, id: 'Böse ID' } }), /id/);

  const res = await ws.request('settings.agents.test', { agent: fake });
  assert.equal(res.ok, true);
  assert.equal(res.info.agentInfo.name, 'fake-agent');
  const byId = await ws.request('settings.agents.test', { toolId: 'fake' });
  assert.equal(byId.ok, true);

  const del = await ws.request('settings.agents.delete', { toolId: 'fake' });
  assert.ok(!del.agents.some((t) => t.id === 'fake'));
  const del2 = await ws.request('settings.agents.delete', { toolId: 'gemini' });
  assert.equal(del2.agents.find((t) => t.id === 'gemini').disabled, true);
  const upd2 = await ws.next((m) => m.type === 'tools.update' && !m.tools.some((t) => t.id === 'gemini'));
  assert.ok(upd2);
  ws.close();
});
