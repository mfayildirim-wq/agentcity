import { test, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBus } from '../server/core/bus.js';
import { createState } from '../server/core/state.js';
import { createAgent } from '../server/core/model.js';
import { openDb } from '../server/db/migrate.js';
import { createRepo } from '../server/db/repo.js';
import { createSessionManager } from '../server/acp/manager.js';
import { EventEmitter } from 'node:events';
import { isSubagentCall, toolDetail, diffPayload, createAcpSession } from '../server/acp/session.js';
import { createRecorder } from '../server/db/recorder.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-agent.js');
const TOOLS = { fake: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE] } };
const registry = { get: (id) => TOOLS[id] ?? null, list: () => Object.values(TOOLS) };
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arena-sess-')));

let bus; let state; let repo; let manager; let seen;
beforeEach(() => {
  bus = createBus();
  state = createState({ bus });
  repo = createRepo(openDb(':memory:'));
  manager = createSessionManager({ state, bus, repo, registry, sessionOptions: { subLingerMs: 50, textThrottleMs: 5 } });
  seen = [];
  for (const type of ['agent.update', 'agent.remove', 'event', 'chat.chunk', 'chat.message', 'permission.request', 'permission.resolved', 'toast', 'session.turnEnd']) {
    bus.on(type, (p) => seen.push({ type, ...p }));
  }
});
afterEach(async () => { await manager?.stopAll(); });
after(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

const waitFor = async (pred, ms = 3000) => {
  const t0 = Date.now();
  for (;;) {
    const r = pred();
    if (r) return r;
    if (Date.now() - t0 > ms) throw new Error('Zeitüberschreitung');
    await new Promise((res) => setTimeout(res, 5));
  }
};
const events = (kind, agentId) => seen.filter((m) => m.type === 'event' && m.event.kind === kind && (!agentId || m.event.agentId === agentId)).map((m) => m.event);

test('createSession: Agent mit Ids, Modi und DB-Zeile', async () => {
  const id = await manager.createSession({ toolId: 'fake', cwd, mode: 'confirm', title: 'Test' });
  assert.match(id, /^a:[0-9a-f-]{36}$/);
  const a = state.get(id);
  assert.equal(a.source, 'acp');
  assert.equal(a.controllable, true);
  assert.equal(a.acpSessionId, 'fake-1');
  assert.ok(a.sessionId && a.sessionId !== a.acpSessionId);
  assert.equal(a.status, 'waiting_user');
  assert.equal(a.mode, 'confirm');
  assert.equal(a.arenaMode, 'confirm');
  assert.deepEqual(a.modes.map((m) => m.id), ['confirm', 'auto']);
  assert.equal(a.project, path.basename(cwd));
  assert.deepEqual(a.launch, { toolId: 'fake', cwd, mode: 'confirm', title: 'Test' });
  const row = repo.getSession(a.sessionId);
  assert.equal(row.acp_session_id, 'fake-1');
  assert.equal(row.tool_id, 'fake');
  assert.deepEqual(repo.recentProjects().map((p) => p.cwd), [cwd]);
  await manager.close(id);
  assert.equal(state.get(id), undefined);
  assert.equal(repo.getSession(a.sessionId).status, 'done');
});

test('Prompt → waiting_permission, allow → Plan, Diff, waiting_user', async () => {
  const id = await manager.createSession({ toolId: 'fake', cwd });
  const done = manager.prompt(id, 'hi');
  await waitFor(() => state.get(id).status === 'waiting_permission');
  assert.equal(state.permissions.size, 1);
  const perm = [...state.permissions.values()][0];
  assert.equal(perm.agentId, id);
  assert.equal(perm.toolCallId, 't1');
  assert.deepEqual(perm.rawInput, { command: 'ls -la' });
  assert.equal(state.snapshot().permissions.length, 1);
  assert.equal(state.get(id).tool, 'ls');
  assert.equal(state.get(id).category, 'terminal');
  assert.equal(seen.filter((m) => m.type === 'permission.request').length, 1);

  manager.answerPermission(perm.id, 'allow');
  assert.equal(state.permissions.size, 0);
  assert.deepEqual(seen.find((m) => m.type === 'permission.resolved'), { type: 'permission.resolved', permissionId: perm.id, optionId: 'allow' });
  assert.equal((await done).stopReason, 'end_turn');

  const a = state.get(id);
  assert.equal(a.status, 'waiting_user');
  assert.equal(a.plan.length, 2);
  assert.equal(a.title, 'Fake-Sitzung');
  assert.equal(a.context.used, 1200);
  assert.equal(a.toolCount, 1);
  assert.equal(a.lastPrompt, 'hi');
  assert.match(a.lastText, /fertig\./);
  const diff = events('diff', id)[0];
  assert.equal(diff.path, path.join(cwd, 'hallo.txt'));
  assert.equal(diff.newText, 'neu');
  assert.equal(events('tool_update', id).at(-1).status, 'completed');
  assert.ok(events('prompt', id).length === 1 && events('plan', id).length === 1);

  // Chat: Nutzer-Nachricht, Gedanke, Antwortsegmente
  const chunks = seen.filter((m) => m.type === 'chat.chunk');
  assert.ok(chunks.some((c) => c.role === 'thought' && c.text === 'überlege'));
  const msgs = seen.filter((m) => m.type === 'chat.message').map((m) => m.message);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].text, 'hi');
  assert.equal(msgs.filter((m) => m.role === 'agent').map((m) => m.text).join(''), 'Hallo fertig.');
  const turn = seen.find((m) => m.type === 'session.turnEnd');
  assert.equal(turn.text, 'Hallo\n\nfertig.');
  // DB: Berechtigung aufgelöst, Nachrichten gespeichert
  assert.equal(repo.db.prepare('SELECT option_id FROM permissions WHERE id = ?').get(perm.id).option_id, 'allow');
  assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2);
  // Agent trägt kompakte Ereignisse für den Snapshot
  assert.ok(a.events.some((e) => e.kind === 'tool' && e.tool === 'ls'));
});

test('reject → tool_update failed', async () => {
  const id = await manager.createSession({ toolId: 'fake', cwd });
  const done = manager.prompt(id, 'hi');
  await waitFor(() => state.permissions.size === 1);
  manager.answerPermission([...state.permissions.keys()][0], 'reject');
  await done;
  assert.equal(events('tool_update', id).at(-1).status, 'failed');
  assert.equal(state.get(id).plan.length, 0);
  assert.equal(state.get(id).status, 'waiting_user');
});

test('Prompt „subagent“ → Sub-Agent mit parentId, wird done und verschwindet', async () => {
  const id = await manager.createSession({ toolId: 'fake', cwd });
  const done = manager.prompt(id, 'subagent bitte');
  await waitFor(() => state.permissions.size === 1);
  const sub = state.all().find((a) => a.kind === 'sub');
  assert.ok(sub);
  assert.equal(sub.parentId, id);
  assert.equal(sub.source, 'acp');
  assert.equal(sub.description, 'Recherche');
  assert.equal(sub.agentType, 'Explore');
  assert.equal(sub.sessionId, state.get(id).sessionId);
  assert.equal(sub.status, 'done');
  // Werkzeug des Subagenten (parentToolUseId) zählt beim Sub, nicht beim Hauptagenten
  assert.equal(sub.toolCount, 1);
  assert.ok(events('tool', sub.id).some((e) => e.tool === 'Read README.md'));
  manager.answerPermission([...state.permissions.keys()][0], 'allow');
  await done;
  await waitFor(() => !state.get(sub.id));
});

test('Immer erlauben merkt sich das Werkzeug; Auto-Modus bestätigt sofort', async () => {
  const id = await manager.createSession({ toolId: 'fake', cwd });
  let done = manager.prompt(id, 'hi');
  await waitFor(() => state.permissions.size === 1);
  manager.answerPermission([...state.permissions.keys()][0], 'always');
  await done;
  const before = seen.filter((m) => m.type === 'permission.request').length;
  done = manager.prompt(id, 'nochmal');
  assert.equal((await done).stopReason, 'end_turn');
  assert.equal(seen.filter((m) => m.type === 'permission.request').length, before);
  assert.ok(events('permission', id).some((e) => e.auto && e.optionId === 'allow'));

  const auto = await manager.createSession({ toolId: 'fake', cwd, mode: 'auto' });
  assert.equal(state.get(auto).arenaMode, 'auto');
  assert.equal(state.get(auto).mode, 'confirm', 'Tool-Modus bleibt unberührt');
  assert.equal((await manager.prompt(auto, 'hi')).stopReason, 'end_turn');
  assert.equal(state.get(auto).plan.length, 2);
});

test('cancel während Berechtigung → cancelled, Toast', async () => {
  const id = await manager.createSession({ toolId: 'fake', cwd });
  const done = manager.prompt(id, 'hi');
  await waitFor(() => state.permissions.size === 1);
  await manager.cancel(id);
  assert.equal((await done).stopReason, 'cancelled');
  assert.equal(state.permissions.size, 0);
  assert.equal(seen.find((m) => m.type === 'permission.resolved').optionId, 'cancel');
  assert.ok(seen.some((m) => m.type === 'toast' && /abgebrochen/.test(m.text)));
  assert.equal(state.get(id).status, 'waiting_user');
});

test('setMode und paralleler Prompt wird abgelehnt', async () => {
  const id = await manager.createSession({ toolId: 'fake', cwd });
  await manager.setMode(id, 'auto');
  assert.equal(state.get(id).mode, 'auto');
  assert.equal(state.get(id).arenaMode, 'confirm');
  const p = manager.prompt(id, 'langsam');
  await assert.rejects(() => manager.prompt(id, 'zweiter'), /arbeitet noch/);
  await manager.cancel(id);
  assert.equal((await p).stopReason, 'cancelled');
});

test('Prozess-Absturz → Status error mit stderrTail', async () => {
  const id = await manager.createSession({ toolId: 'fake', cwd });
  await manager.prompt(id, 'absturz');
  await waitFor(() => state.get(id).status === 'error');
  const a = state.get(id);
  assert.equal(a.error.code, 3);
  assert.match(a.error.stderrTail, /Absturz wie bestellt/);
  assert.equal(events('error', id).length, 1);
  assert.equal(repo.getSession(a.sessionId).status, 'error');
  await assert.rejects(() => manager.prompt(id, 'hi'), /beendet/);
  await manager.close(id);
  assert.equal(state.get(id), undefined);
});

test('Fehlerfälle beim Start', async () => {
  await assert.rejects(() => manager.createSession({ toolId: 'gibtsnicht', cwd }), /Unbekanntes Tool/);
  await assert.rejects(() => manager.createSession({ toolId: 'fake', cwd: 'relativ' }), /absolut/);
  await assert.rejects(() => manager.createSession({ toolId: 'fake', cwd: path.join(cwd, 'fehlt') }), /nicht gefunden/);
  TOOLS.kaputt = { id: 'kaputt', name: 'Kaputt', command: 'gibt-es-nicht-arena', args: [] };
  await assert.rejects(() => manager.createSession({ toolId: 'kaputt', cwd }), /konnte nicht starten/);
  const failed = state.all().find((a) => a.toolId === 'kaputt');
  assert.equal(failed.status, 'error');
  assert.match(failed.error.message, /ENOENT|nicht gefunden/);
  delete TOOLS.kaputt;
});

test('adopt: Watcher-Agent wird durch steuerbaren ersetzt (loadSession)', async () => {
  const w = createAgent({ id: 'w:fake:ext-7', toolId: 'fake', sessionId: 'ext-7', acpSessionId: 'ext-7', project: 'p', cwd, source: 'watch', controllable: false });
  state.upsert(w);
  const pending = manager.adopt(w.id);
  await assert.rejects(() => manager.adopt(w.id), /bereits übernommen/, 'Doppelklick startet keinen zweiten Prozess');
  const id = await pending;
  assert.equal(state.get(w.id), undefined);
  const hint = seen.find((m) => m.type === 'toast' && /fortgesetzt/.test(m.text));
  assert.equal(hint.level, 'warn');
  assert.match(hint.text, /CLI-Sitzung sollte beendet werden/);
  assert.equal(state.get(id).cwd, cwd, 'läuft im Ordner der externen Session');
  const a = state.get(id);
  assert.equal(a.sessionId, 'ext-7');
  assert.equal(a.acpSessionId, 'ext-7');
  assert.equal(a.controllable, true);
  assert.equal(a.status, 'waiting_user');
  // Verlauf wird als Chat wiedergegeben, ohne Statuswechsel
  const msgs = seen.filter((m) => m.type === 'chat.message' && m.agentId === id).map((m) => `${m.message.role}:${m.message.text}`);
  assert.deepEqual(msgs, ['user:alte Frage', 'agent:alte Antwort']);
  await assert.rejects(() => manager.adopt(id), /externe/);
});

test('Hilfsfunktionen: Subagent-Erkennung und Details', () => {
  assert.equal(isSubagentCall({ title: 'Task: x' }), true);
  assert.equal(isSubagentCall({ title: 'y', _meta: { claudeCode: { toolName: 'Agent' } } }), true);
  assert.equal(isSubagentCall({ title: 'y', kind: 'other', rawInput: { subagent_type: 'Explore' } }), true);
  assert.equal(isSubagentCall({ title: 'Read', kind: 'read' }), false);
  assert.equal(toolDetail({ command: 'ls -la' }), 'ls -la');
  assert.equal(toolDetail({ file_path: '/a/b.txt' }), '/a/b.txt');
  assert.equal(toolDetail(null), null);
});

test('Tool-Modus „auto“ gibt nichts frei; Arena-Modus auto beantwortet offene Rückfragen', async () => {
  const id = await manager.createSession({ toolId: 'fake', cwd });
  await manager.setMode(id, 'auto');
  const done = manager.prompt(id, 'hi');
  await waitFor(() => state.permissions.size === 1);
  manager.setArenaMode(id, 'auto');
  assert.equal(state.permissions.size, 0);
  assert.equal((await done).stopReason, 'end_turn');
  assert.equal(state.get(id).plan.length, 2);
  assert.equal(repo.getSession(state.get(id).sessionId).mode, 'auto');
  assert.throws(() => manager.setArenaMode(id, 'quatsch'), /Arena-Modus/);
});

test('Unbekannte und bereits beantwortete Permission-Id', async () => {
  assert.throws(() => manager.answerPermission('gibt-es-nicht', 'allow'), /nicht \(mehr\) offen/);
  const id = await manager.createSession({ toolId: 'fake', cwd });
  const done = manager.prompt(id, 'hi');
  await waitFor(() => state.permissions.size === 1);
  const pid = [...state.permissions.keys()][0];
  assert.throws(() => manager.answerPermission(pid, 'nope'), /Unbekannte Option/);
  manager.answerPermission(pid, 'allow');
  assert.throws(() => manager.answerPermission(pid, 'allow'), /nicht \(mehr\) offen/);
  await done;
});

test('Agent stirbt bei offener Berechtigung → abgebrochen, Status error', async () => {
  const id = await manager.createSession({ toolId: 'fake', cwd });
  manager.prompt(id, 'stirb');
  await waitFor(() => state.permissions.size === 1);
  const pid = [...state.permissions.keys()][0];
  await waitFor(() => state.get(id).status === 'error');
  assert.equal(state.permissions.size, 0);
  assert.equal(seen.find((m) => m.type === 'permission.resolved' && m.permissionId === pid).optionId, 'cancel');
  assert.equal(state.get(id).error.code, 4);
});

test('initialize hängt → Zeitlimit, Prozess wird beendet', async () => {
  TOOLS.haengt = { id: 'haengt', name: 'Hängt', command: process.execPath, args: [FAKE], env: { FAKE_HANG_INIT: '1' } };
  const m = createSessionManager({ state, bus, repo, registry, startTimeoutMs: 200 });
  await assert.rejects(() => m.createSession({ toolId: 'haengt', cwd }), /initialize: keine Antwort/);
  const a = state.all().find((x) => x.toolId === 'haengt');
  assert.equal(a.status, 'error');
  const { client } = m.sessions.get(a.id);
  await client.closed;
  assert.ok(client.exited);
  await m.stopAll();
  assert.equal(state.get(a.id), undefined);
  delete TOOLS.haengt;
});

test('close während des Starts → kein Geister-Agent', async () => {
  TOOLS.haengt = { id: 'haengt', name: 'Hängt', command: process.execPath, args: [FAKE], env: { FAKE_HANG_INIT: '1' } };
  const starting = manager.createSession({ toolId: 'haengt', cwd }).then(() => null, (err) => err);
  const a = state.all().find((x) => x.toolId === 'haengt');
  assert.ok(a, 'Agent erscheint sofort');
  await manager.close(a.id);
  assert.match((await starting)?.message ?? '', /abgebrochen/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(state.get(a.id), undefined);
  assert.equal(manager.has(a.id), false);
  delete TOOLS.haengt;
});

test('Updates nach close legen den Agenten nicht neu an', async () => {
  const client = new EventEmitter();
  client.running = true;
  client.stop = async () => {};
  client.stderrTail = () => '';
  const agent = createAgent({ id: 'a:stub', toolId: 'fake', sessionId: 's1', project: 'p', cwd });
  agent.arenaMode = 'confirm';
  state.upsert(agent);
  const s = createAcpSession({ agent, client, state, bus, repo });
  await s.close();
  state.remove(agent.id);
  client.emit('update', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'spät' } });
  client.emit('update', { sessionUpdate: 'tool_call', toolCallId: 'x', title: 'ls', kind: 'execute' });
  client.emit('update', null);
  client.emit('exit', { code: 1 });
  let answered = null;
  client.emit('permission', { toolCall: { toolCallId: 'x' }, options: [] }, (o) => { answered = o; });
  assert.equal(state.get(agent.id), undefined);
  assert.deepEqual(answered, { outcome: 'cancelled' });
});

test('Kaputte Updates werden abgefangen; doppelter tool_call zählt einmal', async () => {
  const client = new EventEmitter();
  client.running = true;
  client.stop = async () => {};
  const agent = createAgent({ id: 'a:stub2', toolId: 'fake', sessionId: 's2', project: 'p', cwd });
  state.upsert(agent);
  createAcpSession({ agent, client, state, bus, repo });
  client.emit('update', { sessionUpdate: 'plan', entries: 'kein Array' });
  client.emit('update', { sessionUpdate: 'tool_call_update', toolCallId: 'q', content: 'kein Array', status: 'completed' });
  client.emit('update', { sessionUpdate: 'tool_call', toolCallId: 't', title: 'ls', kind: 'execute' });
  client.emit('update', { sessionUpdate: 'tool_call', toolCallId: 't', title: 'ls -la', kind: 'execute' });
  assert.equal(state.get(agent.id).toolCount, 1);
  assert.equal(state.get(agent.id).tool, 'ls -la');
  assert.deepEqual(state.get(agent.id).plan, []);
});

test('Diffs: Texte auf 64 KB gekürzt, DB speichert nur Pfad und Zeilen', () => {
  const big = 'x'.repeat(70 * 1024);
  const d = diffPayload({ path: '/p/a.txt', oldText: 'a\nb', newText: big });
  assert.equal(d.newText.length, 64 * 1024);
  assert.equal(d.truncated, true);
  assert.equal(d.oldLines, 2);
  assert.equal(diffPayload({ path: '/p/b', oldText: null, newText: 'n' }).truncated, undefined);
  const rec = createRecorder({ bus, repo, state, flushMs: 1e6 });
  bus.emit('event', { event: { id: 'e-diff', agentId: 'x', sessionId: 's9', t: 1, kind: 'diff', ...d } });
  rec.stop();
  const row = repo.db.prepare('SELECT payload FROM events WHERE id = ?').get('e-diff');
  const payload = JSON.parse(row.payload);
  assert.equal(payload.path, '/p/a.txt');
  assert.equal(payload.newLines, 1);
  assert.equal('newText' in payload || 'oldText' in payload, false);
});
