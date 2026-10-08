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
import sessionHandlers from '../server/api/handlers/session.js';
import permissionHandlers from '../server/api/handlers/permission.js';
import fsHandlers from '../server/api/handlers/fs.js';
import chatHandlers from '../server/api/handlers/chat.js';
import historyHandlers from '../server/api/handlers/history.js';
import { createBus } from '../server/core/bus.js';
import { createState } from '../server/core/state.js';
import { openDb } from '../server/db/migrate.js';
import { createRepo } from '../server/db/repo.js';
import { createSessionManager } from '../server/acp/manager.js';
import { createRegistry } from '../server/agents/registry.js';

const TOKEN = 'fedcba9876543210fedcba9876543210';
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-agent.js');
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcity-wss-')));
fs.mkdirSync(path.join(cwd, 'sub-a'));
fs.mkdirSync(path.join(cwd, 'sub-b'));
fs.mkdirSync(path.join(cwd, '.versteckt'));
fs.writeFileSync(path.join(cwd, 'datei.txt'), 'x');

let server; let port; let wsApi; let manager; let state;

before(async () => {
  const bus = createBus();
  state = createState({ bus });
  const repo = createRepo(openDb(':memory:'));
  const registry = createRegistry({ tools: [{ id: 'fake', name: 'Fake', command: 'node', args: [FAKE], color: '#888888' }] });
  manager = createSessionManager({ state, bus, repo, registry });
  const config = { token: TOKEN, port: 0 };
  server = createHttpServer({ config });
  wsApi = attachWs({
    server, token: TOKEN,
    ctx: { state, bus, repo, registry, acp: manager, pty: null, config },
    handlers: createHandlers(sessionHandlers, permissionHandlers, fsHandlers, chatHandlers, historyHandlers),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(async () => {
  await manager.stopAll();
  wsApi.close();
  await new Promise((r) => server.close(r));
  fs.rmSync(cwd, { recursive: true, force: true });
});

function open() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: `http://127.0.0.1:${port}`, Cookie: `agentcity_token=${TOKEN}` } });
  const queue = [];
  const waiters = [];
  let seq = 0;
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    queue.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  ws.next = (pred, ms = 5000) => new Promise((resolve, reject) => {
    const hit = queue.find(pred);
    if (hit) { resolve(hit); return; }
    const t = setTimeout(() => reject(new Error('Zeitüberschreitung')), ms);
    waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
  ws.request = async (type, payload = {}) => {
    const id = `q${++seq}`;
    ws.send(JSON.stringify({ type, id, ...payload }));
    const res = await ws.next((m) => m.id === id);
    if (res.type === 'error') throw new Error(res.message);
    return res;
  };
  ws.queue = queue;
  ws.opened = new Promise((resolve) => ws.on('open', resolve));
  return ws;
}

test('Snapshot enthält Tools und offene Berechtigungen', async () => {
  const ws = open();
  await ws.opened;
  ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
  const snap = await ws.next((m) => m.type === 'snapshot');
  assert.deepEqual(snap.tools.map((t) => t.id), ['fake']);
  assert.equal(snap.tools[0].color, '#888888');
  assert.equal(snap.tools[0].args, undefined, 'Befehlszeile bleibt auf dem Server');
  assert.deepEqual(snap.permissions, []);
  ws.close();
});

test('session.create → agent.update; prompt → permission.request; answer → resolved + chat.message', async () => {
  const ws = open();
  await ws.opened;
  ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
  await ws.next((m) => m.type === 'snapshot');

  const { agentId } = await ws.request('session.create', { toolId: 'fake', cwd, mode: 'confirm', title: 'WS-Test' });
  assert.match(agentId, /^a:/);
  const up = await ws.next((m) => m.type === 'agent.update' && m.agent.id === agentId && m.agent.status === 'waiting_user');
  assert.equal(up.agent.acpSessionId, 'fake-1');

  assert.deepEqual((await ws.request('session.prompt', { agentId, text: 'hi' })).ok, true);
  const req = await ws.next((m) => m.type === 'permission.request');
  assert.equal(req.permission.agentId, agentId);

  // neuer Client sieht die offene Berechtigung im Snapshot
  const ws2 = open();
  await ws2.opened;
  ws2.send(JSON.stringify({ type: 'hello', token: TOKEN }));
  const snap2 = await ws2.next((m) => m.type === 'snapshot');
  assert.equal(snap2.permissions.length, 1);
  assert.equal(snap2.permissions[0].id, req.permission.id);
  ws2.close();

  await assert.rejects(() => ws.request('permission.answer', { permissionId: req.permission.id, optionId: 'gibtsnicht' }), /Unbekannte Option/);
  await ws.request('permission.answer', { permissionId: req.permission.id, optionId: 'allow' });
  const resolved = await ws.next((m) => m.type === 'permission.resolved');
  assert.equal(resolved.optionId, 'allow');
  const reply = await ws.next((m) => m.type === 'chat.message' && m.message.role === 'agent' && m.message.text === 'fertig.');
  assert.equal(reply.agentId, agentId);
  await ws.next((m) => m.type === 'agent.update' && m.agent.id === agentId && m.agent.status === 'waiting_user' && m.agent.plan.length === 2);
  assert.ok(ws.queue.some((m) => m.type === 'chat.message' && m.message.role === 'user' && m.message.text === 'hi'));
  assert.ok(ws.queue.some((m) => m.type === 'event' && m.event.kind === 'diff'));

  await assert.rejects(() => ws.request('permission.answer', { permissionId: req.permission.id, optionId: 'allow' }), /nicht \(mehr\) offen/);

  // gespeicherter Verlauf (für den Browser nach einem Neuladen)
  const hist = await ws.request('chat.history', { agentId });
  assert.deepEqual(hist.messages.map((m) => m.role), ['user', 'agent']);
  assert.equal(hist.messages[0].text, 'hi');
  assert.match(hist.messages[1].text, /fertig\./);
  assert.equal((await ws.request('chat.history', { agentId, limit: 1 })).messages[0].role, 'agent');
  await assert.rejects(() => ws.request('chat.history', {}), /agentId/);
  await ws.request('session.setMode', { agentId, modeId: 'auto' });
  await ws.next((m) => m.type === 'agent.update' && m.agent.id === agentId && m.agent.mode === 'auto');
  await ws.request('session.setCityMode', { agentId, cityMode: 'auto' });
  await ws.next((m) => m.type === 'agent.update' && m.agent.id === agentId && m.agent.cityMode === 'auto');
  await assert.rejects(() => ws.request('session.setCityMode', { agentId, cityMode: 'x' }), /City-Modus/);

  // langsamer Prompt + Abbruch
  await ws.request('session.prompt', { agentId, text: 'langsam' });
  await assert.rejects(() => ws.request('session.prompt', { agentId, text: 'zweiter' }), /arbeitet noch/);
  await ws.request('session.cancel', { agentId });
  await ws.next((m) => m.type === 'toast' && /abgebrochen/.test(m.text));

  await ws.request('session.close', { agentId });
  await ws.next((m) => m.type === 'agent.remove' && m.agentId === agentId);
  await assert.rejects(() => ws.request('session.prompt', { agentId, text: 'hi' }), /Keine steuerbare Session/);
  ws.close();
});

test('Fehler: unbekanntes Tool, leerer Prompt', async () => {
  const ws = open();
  await ws.opened;
  ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
  await ws.next((m) => m.type === 'snapshot');
  await assert.rejects(() => ws.request('session.create', { toolId: 'nope', cwd }), /Unbekanntes Tool/);
  const { agentId } = await ws.request('session.create', { toolId: 'fake', cwd });
  await assert.rejects(() => ws.request('session.prompt', { agentId, text: '  ' }), /Leerer Prompt/);
  await ws.request('session.close', { agentId });
  ws.close();
});

test('fs.pickDir listet sichtbare Unterordner und zuletzt verwendete', async () => {
  const ws = open();
  await ws.opened;
  ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
  await ws.next((m) => m.type === 'snapshot');
  const res = await ws.request('fs.pickDir', { start: cwd });
  assert.equal(res.path, cwd);
  assert.equal(res.parent, path.dirname(cwd));
  assert.deepEqual(res.entries.map((e) => e.name), ['sub-a', 'sub-b']);
  assert.equal(res.entries[0].path, path.join(cwd, 'sub-a'));
  assert.ok(res.recent.some((r) => r.cwd === cwd));
  await assert.rejects(() => ws.request('fs.pickDir', { start: path.join(cwd, 'datei.txt') }), /Kein Ordner/);
  const home = await ws.request('fs.pickDir', {});
  assert.equal(home.path, fs.realpathSync(os.homedir()));
  ws.close();
});

test('Verlauf über WS: Session schließen → im Archiv fortsetzbar → history.resume lädt sie (Fake-Agent)', async () => {
  const ws = open();
  await ws.opened;
  ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
  await ws.next((m) => m.type === 'snapshot');
  const { agentId } = await ws.request('session.create', { toolId: 'fake', cwd, title: 'Archiv-Test' });
  const sessionId = state.get(agentId).sessionId;
  await ws.request('session.close', { agentId });
  const { sessions, hasMore } = await ws.request('history.sessions', { ended: true });
  assert.equal(hasMore, false);
  const s = sessions.find((x) => x.id === sessionId);
  assert.equal(s.title, 'Archiv-Test');
  assert.equal(s.status, 'done');
  assert.equal(s.resumable, true);
  assert.equal(s.toolId, 'fake');
  const res = await ws.request('history.resume', { sessionId });
  assert.match(res.agentId, /^a:/);
  await ws.next((m) => m.type === 'chat.chunk' && m.agentId === res.agentId && m.text === 'alte Antwort');
  const ev = await ws.request('history.events', { sessionId, limit: 10 });
  assert.ok(Array.isArray(ev.events));
  assert.ok(Array.isArray(ev.agents));
  await ws.request('session.close', { agentId: res.agentId });
  ws.close();
});
