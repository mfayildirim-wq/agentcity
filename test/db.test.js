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
  for (const t of ['projects', 'sessions', 'agents', 'events', 'messages', 'permissions', 'tasks', 'meetings', 'meeting_messages', 'meta']) {
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
  // Prompts an die einzelnen Agenten (messages) zählen nicht als Besprechungsbeiträge
  repo.insertMessage({ id: 'x', sessionId: 's1', agentId: 'a1', meetingId: m.id, role: 'user', text: 'hi', t: 1 });
  assert.equal(repo.meetings.list()[0].messages.length, 0);
  repo.meetings.addMessage(m.id, { id: 'y', role: 'user', text: 'hallo', targetIds: ['a1'], t: 2 });
  repo.meetings.addMessage(m.id, { id: 'z', role: 'agent', agentId: 'a1', text: 'antwort', t: 3 });
  assert.deepEqual(repo.meetings.get(m.id).messages, [
    { id: 'y', role: 'user', text: 'hallo', t: 2, targetIds: ['a1'] },
    { id: 'z', role: 'agent', agentId: 'a1', text: 'antwort', t: 3 },
  ]);
  assert.equal(repo.meetings.list({ open: true }).length, 0);
  assert.equal(repo.meetings.update(m.id, { closed: false }).closedAt, null);
  assert.equal(repo.meetings.list({ open: true }).length, 1);
  assert.equal(repo.tasks.delete(t.id), true);
  assert.equal(repo.tasks.list().length, 0);
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

test('Recorder.stop schreibt entprellte Agenten und gepufferte Ereignisse noch weg', () => {
  const { repo } = setup();
  const bus = createBus();
  const state = createState({ bus });
  const rec = createRecorder({ bus, repo, state, flushMs: 10_000, debounceMs: 10_000 });
  const a = createAgent({ id: 'a1', sessionId: 's1', toolId: 'claude', project: 'p' });
  state.upsert(a);
  state.upsert({ ...a, model: 'spät' });
  state.remove('a1'); // auch wenn der Agent schon weg ist
  bus.emit('event', { event: { ...createEvent('a1', 'text', { label: 'x' }, 1), sessionId: 's1' } });
  rec.stop();
  assert.equal(repo.getAgent('a1').model, 'spät');
  assert.equal(repo.history.events('s1').length, 1);
});

test('insertEvents ignoriert doppelte Ids', () => {
  const { repo } = setup();
  const e = { ...createEvent('a1', 'text', { label: 'x' }, 1), sessionId: 's1' };
  repo.insertEvents([e]);
  repo.insertEvents([e, e]);
  assert.equal(repo.history.events('s1').length, 1);
});

test('Indizes für agents(session_id) und sessions(parent_session_id)', () => {
  const { db } = setup();
  const idx = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index'").all();
  const has = (tbl, cols) => idx.some((i) => i.tbl_name === tbl
    && db.prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`).all().map((c) => c.name).join(',') === cols);
  assert.ok(has('messages', 'agent_id,t'));
  assert.ok(has('agents', 'session_id'));
  assert.ok(has('sessions', 'parent_session_id'));
});

test('Datenbankdateien 0600 (auch -wal/-shm), fehlende Dateien ohne Fehler', async () => {
  const fsm = await import('node:fs');
  const osm = await import('node:os');
  const pathm = await import('node:path');
  const { secureDbFiles } = await import('../server/config.js');
  const dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'arena-perm-'));
  const file = pathm.join(dir, 'arena.db');
  const db = openDb(file);
  db.exec('CREATE TABLE IF NOT EXISTS x (a)'); db.exec('INSERT INTO x VALUES (1)');
  const files = [file, `${file}-wal`, `${file}-shm`].filter((f) => fsm.existsSync(f));
  assert.ok(files.length >= 2, 'WAL-Datei vorhanden');
  for (const f of files) fsm.chmodSync(f, 0o644);
  secureDbFiles(file);
  for (const f of files) assert.equal(fsm.statSync(f).mode & 0o777, 0o600, f);
  secureDbFiles(pathm.join(dir, 'gibtsnicht.db'));
  secureDbFiles(':memory:');
  db.close();
  fsm.rmSync(dir, { recursive: true, force: true });
});

test('Aufräumregel: erledigte Aufgaben nach 30 Tagen, offene bleiben', async () => {
  const { runRetention, DONE_TASK_DAYS } = await import('../server/db/retention.js');
  assert.equal(DONE_TASK_DAYS, 30);
  const { db, repo } = setup();
  const DAY = 86_400_000;
  const now = 1000 * DAY;
  const old = repo.tasks.create({ title: 'alt fertig', status: 'done' });
  const fresh = repo.tasks.create({ title: 'neu fertig', status: 'done' });
  const open = repo.tasks.create({ title: 'alt offen' });
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id IN (?, ?)').run(now - 31 * DAY, old.id, open.id);
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now - 29 * DAY, fresh.id);
  const n = runRetention(db, { now });
  assert.equal(n.tasks, 1);
  assert.equal(repo.tasks.get(old.id), undefined);
  assert.ok(repo.tasks.get(fresh.id));
  assert.ok(repo.tasks.get(open.id));
});
