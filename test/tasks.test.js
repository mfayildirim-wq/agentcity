import { test, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createBus } from '../server/core/bus.js';
import { createState } from '../server/core/state.js';
import { createAgent } from '../server/core/model.js';
import { openDb } from '../server/db/migrate.js';
import { createRepo } from '../server/db/repo.js';
import { createSessionManager } from '../server/acp/manager.js';
import { createTasks, assignPrompt } from '../server/core/tasks.js';
import { createMeetings } from '../server/core/meetings.js';
import { createHttpServer } from '../server/api/http.js';
import { attachWs } from '../server/api/ws.js';
import { createHandlers } from '../server/api/handlers/index.js';
import taskHandlers from '../server/api/handlers/task.js';
import meetingHandlers from '../server/api/handlers/meeting.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-agent.js');
const TOOLS = { fake: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE] } };
const registry = { get: (id) => TOOLS[id] ?? null, list: () => Object.values(TOOLS), publicList: () => [] };
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arena-task-')));

let bus; let state; let repo; let manager; let tasks; let updates;
beforeEach(() => {
  bus = createBus();
  state = createState({ bus });
  repo = createRepo(openDb(':memory:'));
  manager = createSessionManager({ state, bus, repo, registry, sessionOptions: { textThrottleMs: 5 } });
  tasks = createTasks({ state, bus, repo, acp: manager });
  updates = [];
  bus.on('task.update', ({ task }) => updates.push(task.status));
});
afterEach(async () => { await manager?.stopAll(); tasks?.stop(); });
after(() => fs.rmSync(cwd, { recursive: true, force: true }));

const waitFor = async (pred, ms = 4000) => {
  const t0 = Date.now();
  for (;;) {
    const r = pred();
    if (r) return r;
    if (Date.now() - t0 > ms) throw new Error('Zeitüberschreitung');
    await new Promise((res) => setTimeout(res, 5));
  }
};

test('anlegen, ändern, löschen, Prüfungen', () => {
  assert.throws(() => tasks.create({ title: '  ' }), /Titel/);
  const t = tasks.create({ title: 'README  verbessern', description: 'Abschnitt Start', meetingId: 'm1', sourceMessageId: 'x1' });
  assert.equal(t.status, 'open');
  assert.equal(t.title, 'README verbessern');
  assert.equal(repo.tasks.get(t.id).meetingId, 'm1');
  assert.equal(state.snapshot().tasks.length, 1);
  assert.throws(() => tasks.update(t.id, { status: 'kaputt' }), /Status/);
  assert.equal(tasks.update(t.id, { status: 'done' }).status, 'done');
  assert.equal(repo.tasks.get(t.id).status, 'done');
  let removed = null;
  bus.on('task.remove', (p) => { removed = p.taskId; });
  tasks.remove(t.id);
  assert.equal(removed, t.id);
  assert.equal(state.tasks.size, 0);
  assert.equal(repo.tasks.list().length, 0);
  assert.throws(() => tasks.update(t.id, { status: 'open' }), /nicht gefunden/);
  assert.equal(assignPrompt({ title: 'T', description: null }), 'Aufgabe: T\n\nMelde dich, wenn du fertig bist oder etwas brauchst.');
});

test('zuweisen: nur steuerbare Agenten', async () => {
  const t = tasks.create({ title: 'X' });
  state.upsert(createAgent({ id: 'w:claude:x', source: 'watch', toolId: 'claude', project: 'p' }));
  await assert.rejects(() => tasks.assign(t.id, 'w:claude:x'), /steuerbare/);
  await assert.rejects(() => tasks.assign(t.id, 'gibtsnicht'), /steuerbare/);
});

test('assign → active (Prompt), nach Zugende waiting; done nur manuell', async () => {
  const a = await manager.createSession({ toolId: 'fake', cwd, mode: 'auto' });
  const prompts = [];
  bus.on('chat.message', (p) => { if (p.agentId === a && p.message.role === 'user') prompts.push(p.message.text); });
  const t = tasks.create({ title: 'Liste', description: 'Dateien zeigen' });
  const r = await tasks.assign(t.id, a);
  assert.equal(r.status, 'active');
  assert.equal(r.assigneeId, a);
  assert.equal(prompts[0], 'Aufgabe: Liste\n\nDateien zeigen\n\nMelde dich, wenn du fertig bist oder etwas brauchst.');
  await waitFor(() => state.tasks.get(t.id).status === 'waiting');
  assert.equal(state.get(a).status, 'waiting_user');
  assert.equal(repo.tasks.get(t.id).status, 'waiting');
  // Nutzer antwortet dem Agenten → wieder in Arbeit, danach wartet er wieder
  await manager.prompt(a, 'weiter');
  assert.ok(updates.filter((s) => s === 'active').length >= 2);
  assert.equal(state.tasks.get(t.id).status, 'waiting');
  tasks.update(t.id, { status: 'done' });
  await manager.prompt(a, 'noch was');
  assert.equal(state.tasks.get(t.id).status, 'done', 'erledigt bleibt erledigt');
  // erledigte Aufgabe lässt sich nicht zuweisen
  await assert.rejects(() => tasks.assign(t.id, a), /erledigt/);
});

test('Rückfrage → waiting, Antwort → active; beschäftigter Agent → Fehler; Session weg → waiting', async () => {
  const a = await manager.createSession({ toolId: 'fake', cwd, mode: 'confirm' });
  const t = tasks.create({ title: 'Mit Rückfrage' });
  await tasks.assign(t.id, a);
  await waitFor(() => state.get(a).status === 'waiting_permission');
  await waitFor(() => state.tasks.get(t.id).status === 'waiting');
  const perm = [...state.permissions.values()][0];
  manager.answerPermission(perm.id, 'allow');
  await waitFor(() => updates.at(-2) === 'active' || state.tasks.get(t.id).status === 'active');
  await waitFor(() => state.get(a).status === 'waiting_user' && state.tasks.get(t.id).status === 'waiting');

  const t2 = tasks.create({ title: 'Zweite' });
  const slow = manager.prompt(a, 'langsam');
  await waitFor(() => manager.get(a).busy);
  await assert.rejects(() => tasks.assign(t2.id, a), /arbeitet noch/);
  assert.equal(state.tasks.get(t2.id).status, 'open');
  await manager.cancel(a);
  await slow;

  await tasks.assign(t2.id, a);
  assert.equal(state.tasks.get(t2.id).status, 'active');
  await manager.close(a);
  assert.equal(state.tasks.get(t2.id).status, 'waiting');
});

test('zweite Aufgabe: bisherige wartet; Neu-Zuweisung X→Y; Besprechungszüge ändern nichts', async () => {
  const x = await manager.createSession({ toolId: 'fake', cwd, mode: 'confirm' });
  const y = await manager.createSession({ toolId: 'fake', cwd, mode: 'auto' });
  const t1 = tasks.create({ title: 'Eins' });
  await tasks.assign(t1.id, x);
  await waitFor(() => state.get(x).status === 'waiting_permission');
  // Rückfrage → waiting; Antwort → active (läuft weiter)
  manager.answerPermission([...state.permissions.values()][0].id, 'allow');
  await waitFor(() => state.get(x).status === 'waiting_user');
  // t1 von X zu Y verschieben: X folgt t1 danach nicht mehr
  await tasks.assign(t1.id, y);
  assert.equal(state.tasks.get(t1.id).assigneeId, y);
  await waitFor(() => state.tasks.get(t1.id).status === 'waiting');
  const run = manager.prompt(x, 'hi');
  // X arbeitet (Rückfrage) – t1 bleibt bei Y „waiting“
  await waitFor(() => state.get(x).status === 'waiting_permission');
  assert.equal(state.tasks.get(t1.id).status, 'waiting');
  await manager.cancel(x);
  await run;

  // zweite Aufgabe für Y, während die erste noch läuft → erste wartet
  const t2 = tasks.create({ title: 'Zwei' });
  const t3 = tasks.create({ title: 'Drei' });
  await tasks.assign(t2.id, y);
  assert.equal(state.tasks.get(t2.id).status, 'active');
  await waitFor(() => state.tasks.get(t2.id).status === 'waiting');
  tasks.update(t2.id, { status: 'active' }); // Nutzer zieht sie zurück nach „In Arbeit“
  await tasks.assign(t3.id, y);
  assert.equal(state.tasks.get(t2.id).status, 'waiting', 'bisherige aktive Aufgabe wartet');
  await waitFor(() => state.tasks.get(t3.id).status === 'waiting');

  // Besprechungszug: t3 bleibt unverändert
  const meetings = createMeetings({ state, bus, repo, acp: manager, registry });
  const m = meetings.create({ participantIds: [y] });
  const before = updates.length;
  await meetings.message(m.id, 'kurze Frage');
  await waitFor(() => meetings.get(m.id).messages.some((x2) => x2.role === 'agent'));
  assert.equal(state.tasks.get(t3.id).status, 'waiting');
  assert.equal(updates.length, before, 'kein task.update durch den Besprechungszug');
  meetings.stop();
});

test('load: aktive Aufgaben ohne Session → waiting', () => {
  const t = repo.tasks.create({ title: 'Alt' });
  repo.tasks.update(t.id, { status: 'active', assigneeId: 'a:weg' });
  tasks.load();
  assert.equal(state.tasks.get(t.id).status, 'waiting');
  assert.equal(repo.tasks.get(t.id).status, 'waiting');
});

test('WS: task.* und meeting.* über den Router', async () => {
  const meetings = createMeetings({ state, bus, repo, acp: manager, registry });
  const TOKEN = '0123456789abcdef0123456789abcdef';
  const server = createHttpServer({ config: { token: TOKEN, port: 0 } });
  const api = attachWs({
    server, token: TOKEN, ctx: { state, bus, repo, registry, acp: manager, meetings, tasks },
    handlers: createHandlers(taskHandlers, meetingHandlers),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const wsPort = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/ws`, { headers: { Origin: `http://127.0.0.1:${wsPort}`, Cookie: `arena_token=${TOKEN}` } });
  const queue = [];
  ws.on('message', (d) => queue.push(JSON.parse(d)));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
  let seq = 0;
  const next = (pred) => waitFor(() => queue.find(pred));
  const request = async (type, payload) => {
    const id = `r${++seq}`;
    ws.send(JSON.stringify({ type, id, ...payload }));
    const res = await next((m) => m.id === id);
    if (res.type === 'error') throw new Error(res.message);
    return res;
  };
  try {
    await next((m) => m.type === 'snapshot');
    const a = await manager.createSession({ toolId: 'fake', cwd, mode: 'auto' });
    const { meeting } = await request('meeting.create', { title: 'WS', participantIds: [a] });
    await next((m) => m.type === 'meeting.update' && m.meeting.id === meeting.id);
    await request('meeting.message', { meetingId: meeting.id, text: 'Hallo Runde' });
    await next((m) => m.type === 'meeting.message' && m.meetingId === meeting.id && m.message.role === 'agent');
    assert.ok(!queue.some((m) => m.type === 'meeting.update' && m.meeting.messages), 'meeting.update ohne Nachrichten');
    await assert.rejects(() => request('meeting.message', { meetingId: meeting.id, text: '' }), /Leere/);

    const { task } = await request('task.create', { title: 'Aus WS', meetingId: meeting.id, assigneeId: a });
    assert.equal(task.status, 'active');
    await next((m) => m.type === 'task.update' && m.task.id === task.id && m.task.status === 'waiting');
    await request('task.update', { taskId: task.id, status: 'done' });
    await next((m) => m.type === 'task.update' && m.task.status === 'done');
    await request('task.delete', { taskId: task.id });
    await next((m) => m.type === 'task.remove' && m.taskId === task.id);
    await assert.rejects(() => request('task.create', { title: '' }), /Titel/);
    await request('meeting.update', { meetingId: meeting.id, closed: true });
    await next((m) => m.type === 'meeting.update' && m.meeting.closedAt);
  } finally {
    ws.close();
    meetings.stop();
    api.close();
    await new Promise((r) => server.close(r));
  }
});
