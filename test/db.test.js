import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db/migrate.js';
import { createRepo } from '../server/db/repo.js';
import { createRecorder } from '../server/db/recorder.js';
import { createBus } from '../server/core/bus.js';
import { createState } from '../server/core/state.js';
import { createAgent, createEvent, createPermission } from '../server/core/model.js';

const setup = () => {
  const db = openDb(':memory:');
  return { db, repo: createRepo(db) };
};

test('Schema ist idempotent', () => {
  const { db } = setup();
  openDb(db); // zweite Migration auf derselben Verbindung
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of ['projects', 'sessions', 'agents', 'events', 'messages', 'permissions', 'tasks', 'meetings', 'meta']) {
    assert.ok(tables.includes(t), t);
  }
});

test('Session + Agent anlegen, Ereignisse bündeln, history.events sortiert', () => {
  const { repo } = setup();
  const projectId = repo.upsertProject({ cwd: '/tmp/p', name: 'p' });
  assert.equal(repo.upsertProject({ cwd: '/tmp/p', name: 'p2' }), projectId);
  repo.createSession({ id: 's1', toolId: 'claude', projectId, title: 'Test', source: 'acp', startedAt: 100 });
  repo.upsertAgent(createAgent({ id: 'a1', sessionId: 's1', toolId: 'claude', project: 'p' }));
  repo.insertEvents([
    { ...createEvent('a1', 'tool', { tool: 'Bash' }, 30), sessionId: 's1' },
    { ...createEvent('a1', 'prompt', { label: 'hi' }, 10), sessionId: 's1' },
    { ...createEvent('a1', 'text', { label: 'ok' }, 20), sessionId: 's1' },
  ]);
  const evs = repo.history.events('s1');
  assert.deepEqual(evs.map((e) => e.t), [10, 20, 30]);
  assert.equal(evs[2].tool, 'Bash');
  assert.equal(evs[0].agentId, 'a1');
  assert.deepEqual(repo.history.events('s1', 15, 25).map((e) => e.t), [20]);
  const sessions = repo.history.sessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].eventCount, 3);
  repo.endSession('s1', 'done');
  assert.equal(repo.history.sessions()[0].status, 'done');
});

test('resolvePermission setzt option_id', () => {
  const { db, repo } = setup();
  const p = createPermission('a1', { toolCall: { title: 'ls', kind: 'execute', rawInput: { command: 'ls' } }, options: [] });
  repo.insertPermission(p, 's1');
  repo.resolvePermission(p.id, 'allow');
  const row = db.prepare('SELECT * FROM permissions WHERE id = ?').get(p.id);
  assert.equal(row.option_id, 'allow');
  assert.ok(row.resolved_at > 0);
  assert.equal(JSON.parse(row.raw_input).command, 'ls');
});

test('Tasks und Meetings', () => {
  const { repo } = setup();
  const t = repo.tasks.create({ title: 'A', description: 'B' });
  assert.equal(t.status, 'open');
  const u = repo.tasks.update(t.id, { status: 'active', assigneeId: 'a1' });
  assert.equal(u.status, 'active');
  assert.equal(u.assigneeId, 'a1');
  assert.equal(repo.tasks.list().length, 1);
  const m = repo.meetings.create({ title: 'M', participantIds: ['a1', 'a2'] });
  assert.deepEqual(m.participantIds, ['a1', 'a2']);
  const m2 = repo.meetings.update(m.id, { participantIds: ['a1'], closed: true });
  assert.deepEqual(m2.participantIds, ['a1']);
  assert.ok(m2.closedAt);
  repo.insertMessage({ id: 'x', sessionId: 's1', agentId: 'a1', meetingId: m.id, role: 'user', text: 'hi', t: 1 });
  assert.equal(repo.meetings.list()[0].messages.length, 1);
});

test('Recorder schreibt Ereignisse gebündelt und Agenten sofort', async () => {
  const { repo } = setup();
  const bus = createBus();
  const state = createState({ bus });
  const rec = createRecorder({ bus, repo, state, flushMs: 20, debounceMs: 50 });
  const a = createAgent({ id: 'a1', sessionId: 's1', toolId: 'claude', project: 'p', cwd: '/tmp/p' });
  state.upsert(a);
  assert.equal(repo.getAgent('a1').session_id, 's1');
  assert.equal(repo.history.sessions().length, 1); // Session-Zeile wird angelegt
  for (let i = 0; i < 3; i++) bus.emit('event', { event: createEvent('a1', 'text', { label: String(i) }, i) });
  assert.equal(repo.history.events('s1').length, 0);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(repo.history.events('s1').length, 3);
  state.upsert({ ...a, model: 'x' });
  state.upsert({ ...a, model: 'y' }); // entprellt
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(repo.getAgent('a1').model, 'y');
  rec.stop();
});
