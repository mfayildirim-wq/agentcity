// Paket 6.1: Verlauf – Repo (Sessions/Ereignisse, Pagination, Session-Ende), Handler, Fortsetzen, Watcher-Ende
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db/migrate.js';
import { createRepo } from '../server/db/repo.js';
import { createBus } from '../server/core/bus.js';
import { createState } from '../server/core/state.js';
import { createAgent, createEvent } from '../server/core/model.js';
import { createSessionManager } from '../server/acp/manager.js';
import { createRegistry } from '../server/agents/registry.js';
import { startWatchers } from '../server/watchers/index.js';
import historyHandlers from '../server/api/handlers/history.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-agent.js');
const setup = () => createRepo(openDb(':memory:'));
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('Zeitüberschreitung');
};

let manager = null;
afterEach(async () => { await manager?.stopAll(); manager = null; });

test('history.sessions: sortiert nach started_at desc, Projekt, Dauer, Ereignisse, Filter', () => {
  const repo = setup();
  const p = repo.upsertProject({ cwd: '/tmp/proj', name: 'proj' });
  repo.createSession({ id: 's1', toolId: 'claude', projectId: p, title: 'Eins', startedAt: 1000 });
  repo.createSession({ id: 's2', toolId: 'codex', projectId: p, title: 'Zwei', startedAt: 5000 });
  repo.insertEvents([{ ...createEvent('a1', 'prompt', { label: 'x' }, 1100), sessionId: 's1' }]);
  repo.endSession('s1', 'done', 3000);
  const all = repo.history.sessions();
  assert.deepEqual(all.map((s) => s.id), ['s2', 's1']);
  assert.equal(all[1].project, 'proj');
  assert.equal(all[1].cwd, '/tmp/proj');
  assert.equal(all[1].duration, 2000);
  assert.equal(all[1].eventCount, 1);
  assert.equal(all[1].status, 'done');
  assert.equal(all[0].endedAt, null);
  assert.deepEqual(repo.history.sessions({ ended: true }).map((s) => s.id), ['s1']);
  // since: laufende oder nach dem Zeitpunkt beendete Sessions
  assert.deepEqual(repo.history.sessions({ since: 4000 }).map((s) => s.id), ['s2']);
  assert.deepEqual(repo.history.sessions({ limit: 1, offset: 1 }).map((s) => s.id), ['s1']);
});

test('endSession setzt das Ende nur einmal; reopenSession und endDangling', () => {
  const repo = setup();
  repo.createSession({ id: 's1', toolId: 'claude', startedAt: 100 });
  repo.endSession('s1', 'error', 200);
  repo.endSession('s1', 'done', 300); // späteres Schließen überschreibt den Fehler nicht
  let s = repo.getSession('s1');
  assert.equal(s.status, 'error');
  assert.equal(s.ended_at, 200);
  repo.reopenSession('s1');
  s = repo.getSession('s1');
  assert.equal(s.status, 'active');
  assert.equal(s.ended_at, null);
  // nach einem Absturz offene Sessions: Ende = letztes Ereignis
  repo.createSession({ id: 's2', toolId: 'claude', startedAt: 1000 });
  repo.insertEvents([{ ...createEvent('a', 'tool', {}, 1500), sessionId: 's2' }]);
  assert.equal(repo.endDangling(), 2);
  assert.equal(repo.getSession('s2').ended_at, 1500);
  assert.equal(repo.getSession('s2').status, 'ended');
  assert.equal(repo.getSession('s1').ended_at, 100);
});

test('parent_session_id wird gespeichert (Spalte per Migration)', () => {
  const db = openDb(':memory:');
  openDb(db);
  const repo = createRepo(db);
  repo.createSession({ id: 'neu', toolId: 'claude', parentSessionId: 'alt', startedAt: 1 });
  assert.equal(repo.getSession('neu').parent_session_id, 'alt');
  assert.equal(repo.history.sessions()[0].parentSessionId, 'alt');
});

test('history.events: Zeitbereich, sortiert, limit/offset; Agenten der Session', () => {
  const repo = setup();
  repo.createSession({ id: 's1', toolId: 'claude', startedAt: 0 });
  repo.upsertAgent(createAgent({ id: 'a1', sessionId: 's1', toolId: 'claude', project: 'p' }));
  repo.upsertAgent(createAgent({ id: 'a2', sessionId: 's1', toolId: 'claude', project: 'p', kind: 'sub', parentId: 'a1' }));
  repo.insertEvents([50, 10, 40, 20, 30].map((t) => ({ ...createEvent('a1', 'tool', { tool: `T${t}` }, t), sessionId: 's1' })));
  assert.deepEqual(repo.history.events('s1', { from: 15, to: 45 }).map((e) => e.t), [20, 30, 40]);
  assert.deepEqual(repo.history.events('s1', { limit: 2, offset: 2 }).map((e) => e.t), [30, 40]);
  // alte Signatur bleibt gültig
  assert.deepEqual(repo.history.events('s1', 15, 25).map((e) => e.t), [20]);
  const agents = repo.history.agents('s1');
  assert.equal(agents.length, 2);
  assert.equal(agents.find((a) => a.id === 'a2').parentId, 'a1');
  assert.equal(agents.find((a) => a.id === 'a2').kind, 'sub');
});

test('Handler: Standard 50, max. 500, hasMore; resumable nur für beendete Sessions mit ACP-Id und fähigem Tool', async () => {
  const repo = setup();
  for (let i = 0; i < 60; i++) repo.createSession({ id: `s${i}`, toolId: 'claude', startedAt: i, acpSessionId: `acp${i}` });
  repo.endSession('s59', 'done', 100);
  repo.createSession({ id: 'x', toolId: 'unbekannt', startedAt: 200, acpSessionId: 'acp-x' });
  repo.endSession('x', 'done', 300);
  const registry = createRegistry({ tools: [{ id: 'claude', name: 'Claude', command: 'node', args: [FAKE], color: '#d97757' }] });
  const ctx = { repo, registry, acp: { canLoad: (toolId) => toolId === 'claude' } };
  let res = await historyHandlers['history.sessions'](ctx, {});
  assert.equal(res.sessions.length, 50);
  assert.equal(res.hasMore, true);
  res = await historyHandlers['history.sessions'](ctx, { limit: 9999 });
  assert.equal(res.sessions.length, 61);
  assert.equal(res.hasMore, false);
  const byId = new Map(res.sessions.map((s) => [s.id, s]));
  assert.equal(byId.get('s59').resumable, true);
  assert.equal(byId.get('s0').resumable, false); // läuft noch
  assert.equal(byId.get('x').resumable, false); // Tool unbekannt
  res = await historyHandlers['history.sessions'](ctx, { ended: true });
  assert.deepEqual(res.sessions.map((s) => s.id), ['x', 's59']);

  repo.insertEvents(Array.from({ length: 600 }, (_, i) => ({ ...createEvent('a', 'tool', {}, i), sessionId: 's1' })));
  res = await historyHandlers['history.events'](ctx, { sessionId: 's1' });
  assert.equal(res.events.length, 50);
  assert.equal(res.hasMore, true);
  res = await historyHandlers['history.events'](ctx, { sessionId: 's1', limit: 1000, offset: 100 });
  assert.equal(res.events.length, 500);
  assert.equal(res.events[0].t, 100);
  res = await historyHandlers['history.events'](ctx, { sessionId: 's1', from: 590, limit: 500 });
  assert.equal(res.events.length, 10);
  assert.equal(res.hasMore, false);
  await assert.rejects(() => historyHandlers['history.events'](ctx, {}), /sessionId/);
  await assert.rejects(() => historyHandlers['history.resume']({ ...ctx, acp: null }, { sessionId: 's1' }), /nicht verfügbar/);
});

test('Fortsetzen: beendete Session per loadSession im gespeicherten Ordner, neue Session-Zeile mit Verweis', async () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arena-hist-')));
  const bus = createBus();
  const state = createState({ bus });
  const repo = setup();
  const registry = createRegistry({ tools: [{ id: 'fake', name: 'Fake', command: 'node', args: [FAKE], color: '#888888' }] });
  manager = createSessionManager({ state, bus, repo, registry });
  const chunks = [];
  bus.on('chat.chunk', (c) => chunks.push(c));

  const first = await manager.createSession({ toolId: 'fake', cwd, title: 'Erste' });
  const oldSession = state.get(first).sessionId;
  assert.equal(manager.canLoad('fake'), true); // aus initialize gemerkt
  await manager.close(first);
  const row = repo.getSession(oldSession);
  assert.equal(row.status, 'done');
  assert.ok(row.ended_at > 0);
  assert.equal(row.acp_session_id, 'fake-1');

  const listed = await historyHandlers['history.sessions']({ repo, registry, acp: manager }, { ended: true });
  assert.equal(listed.sessions[0].resumable, true);

  const { agentId } = await historyHandlers['history.resume']({ repo, registry, acp: manager }, { sessionId: oldSession });
  const a = state.get(agentId);
  assert.equal(a.acpSessionId, 'fake-1');
  assert.equal(a.cwd, cwd);
  assert.equal(a.title, 'Erste');
  assert.notEqual(a.sessionId, oldSession);
  const newRow = repo.getSession(a.sessionId);
  assert.equal(newRow.parent_session_id, oldSession);
  assert.equal(newRow.acp_session_id, 'fake-1');
  assert.equal(newRow.status, 'active');
  // geladener Verlauf als Chat
  assert.ok(chunks.some((c) => c.agentId === agentId && c.text === 'alte Antwort'));
  // ein zweites Fortsetzen derselben Session wird abgelehnt, solange sie läuft
  await assert.rejects(() => manager.resume(oldSession), /bereits/);
  await assert.rejects(() => manager.resume('gibt-es-nicht'), /nicht gefunden/);

  // Server-Ende: laufende Sessions als „ended“
  await manager.stopAll();
  assert.equal(repo.getSession(a.sessionId).status, 'ended');
  manager = null;
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('Prozess-Exit beendet die Session mit Status error', async () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arena-hist-')));
  const bus = createBus();
  const state = createState({ bus });
  const repo = setup();
  const registry = createRegistry({ tools: [{ id: 'fake', name: 'Fake', command: 'node', args: [FAKE], color: '#888888' }] });
  manager = createSessionManager({ state, bus, repo, registry });
  const id = await manager.createSession({ toolId: 'fake', cwd });
  const sid = state.get(id).sessionId;
  manager.prompt(id, 'absturz').catch(() => {});
  await until(() => repo.getSession(sid).ended_at);
  assert.equal(repo.getSession(sid).status, 'error');
  await manager.close(id);
  assert.equal(repo.getSession(sid).status, 'error');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('Watcher-Agent verschwindet → Session beendet (ended); taucht er wieder auf → wieder offen', async () => {
  const bus = createBus();
  const state = createState({ bus });
  const repo = setup();
  let list = [createAgent({ id: 'w:x:s1', kind: 'main', toolId: 'x', sessionId: 's1', project: 'p', source: 'watch' })];
  list[0].lastActivity = 4242;
  const watcher = { id: 'x', adoptable: false, scan: async () => {}, agents: () => list };
  repo.createSession({ id: 's1', toolId: 'x', source: 'watch', startedAt: 1 });
  const w = startWatchers({ state, bus, repo, config: {}, watchers: [watcher], autoStart: false });
  await w.tick();
  assert.ok(state.get('w:x:s1'));
  const keep = list;
  list = [];
  await w.tick();
  assert.equal(repo.getSession('s1').status, 'ended');
  assert.equal(repo.getSession('s1').ended_at, 4242);
  list = keep;
  await w.tick();
  assert.equal(repo.getSession('s1').ended_at, null);
  // von einem ACP-Agenten übernommen → nicht beenden
  state.upsert(createAgent({ id: 'a:1', toolId: 'x', sessionId: 's1', project: 'p', source: 'acp' }));
  await w.tick();
  assert.equal(state.get('w:x:s1'), undefined);
  assert.equal(repo.getSession('s1').ended_at, null);
  w.stop();
});

test('Fortsetzen ersetzt einen Watcher-Agenten derselben (Arena-)Session statt sie zu übernehmen', async () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arena-hist-')));
  const bus = createBus();
  const state = createState({ bus });
  const repo = setup();
  const registry = createRegistry({ tools: [{ id: 'fake', name: 'Fake', command: 'node', args: [FAKE], color: '#888888' }] });
  manager = createSessionManager({ state, bus, repo, registry });
  const first = await manager.createSession({ toolId: 'fake', cwd });
  const oldSession = state.get(first).sessionId;
  await manager.close(first);
  // Watcher meldet die Sitzungsdatei der geschlossenen Session
  state.upsert(createAgent({ id: 'w:fake:fake-1', kind: 'main', toolId: 'fake', sessionId: 'fake-1', project: 'p', cwd, source: 'watch' }));
  const id = await manager.resume(oldSession);
  assert.equal(state.get('w:fake:fake-1'), undefined);
  assert.equal(repo.getSession(state.get(id).sessionId).parent_session_id, oldSession);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('Fortsetzen: Fehlerpfad beendet die neue Zeile mit error, blockiert kein weiteres Fortsetzen; nur beendete Sessions', async () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arena-hist-')));
  const bus = createBus();
  const state = createState({ bus });
  const repo = setup();
  const tools = [
    { id: 'fake', name: 'Fake', command: 'node', args: [FAKE], color: '#888888' },
    { id: 'hang', name: 'Hang', command: 'node', args: [FAKE], env: { FAKE_HANG_INIT: '1' }, color: '#888888' },
  ];
  const registry = createRegistry({ tools });
  manager = createSessionManager({ state, bus, repo, registry, startTimeoutMs: 400 });
  repo.createSession({ id: 'laeuft', toolId: 'fake', acpSessionId: 'x', projectId: repo.upsertProject({ cwd, name: 'p' }), startedAt: 1 });
  await assert.rejects(() => manager.resume('laeuft'), /läuft noch/);
  // beendete Session eines Tools, dessen Start hängt
  repo.createSession({ id: 'alt', toolId: 'hang', acpSessionId: 'acp-alt', projectId: repo.upsertProject({ cwd, name: 'p' }), startedAt: 2 });
  repo.endSession('alt', 'done', 3);
  repo.meta.set('loadSession:hang', '1');
  await assert.rejects(() => manager.resume('alt'), /konnte nicht starten/);
  const child = repo.history.sessions().find((x) => x.parentSessionId === 'alt');
  assert.equal(child.status, 'error');
  assert.ok(child.endedAt);
  // der fehlgeschlagene Agent (Status error) blockiert ein weiteres Fortsetzen nicht
  assert.ok(state.all().some((a) => a.status === 'error' && a.acpSessionId === 'acp-alt'));
  await assert.rejects(() => manager.resume('alt'), /konnte nicht starten/);
  for (const a of state.all()) if (a.source === 'acp') await manager.close(a.id).catch(() => {});
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('endDangling lässt übergebene (laufende) Sessions offen', () => {
  const repo = setup();
  repo.createSession({ id: 'tot', toolId: 'claude', startedAt: 10 });
  repo.createSession({ id: 'aktiv', toolId: 'claude', source: 'watch', startedAt: 20 });
  assert.equal(repo.endDangling(['aktiv', null]), 1);
  assert.equal(repo.getSession('tot').status, 'ended');
  assert.equal(repo.getSession('aktiv').ended_at, null);
});

test('Watcher blendet Sitzungsdateien geschlossener Arena-Sessions aus (außer spätere CLI-Nutzung > 5 s)', async () => {
  const bus = createBus();
  const state = createState({ bus });
  const repo = setup();
  const events = [];
  bus.on('event', ({ event }) => events.push(event));
  repo.createSession({ id: 'arena-1', toolId: 'claude', acpSessionId: 'ext-1', source: 'acp', startedAt: 1000 });
  repo.endSession('arena-1', 'done', 5000);
  const mk = (lastActivity) => {
    const a = createAgent({ id: 'w:claude:ext-1', kind: 'main', toolId: 'claude', sessionId: 'ext-1', project: 'p', source: 'watch' });
    a.lastActivity = lastActivity;
    return a;
  };
  let list = [mk(5800)];
  let fresh = [{ id: 'e1', agentId: 'w:claude:ext-1', sessionId: 'ext-1', t: 5800, kind: 'text' }];
  const watcher = { id: 'claude', scan: async () => {}, agents: () => list, takeEvents: () => { const f = fresh; fresh = []; return f; } };
  const w = startWatchers({ state, bus, repo, config: {}, watchers: [watcher], autoStart: false });
  await w.tick();
  assert.equal(state.get('w:claude:ext-1'), undefined, 'Aktivität nur kurz nach dem Ende → ausgeblendet');
  assert.equal(events.length, 0, 'keine Ereignisse unter der Tool-Id');
  assert.equal(repo.getSession('ext-1'), undefined, 'keine zweite Session-Zeile');
  // echte spätere CLI-Nutzung
  list = [mk(5000 + 60_000)];
  await w.tick();
  assert.ok(state.get('w:claude:ext-1'));
  // laufende Arena-Session → ausblenden
  repo.createSession({ id: 'arena-2', toolId: 'claude', acpSessionId: 'ext-2', source: 'acp', startedAt: 1 });
  const b = createAgent({ id: 'w:claude:ext-2', kind: 'main', toolId: 'claude', sessionId: 'ext-2', project: 'p', source: 'watch' });
  b.lastActivity = Date.now();
  list = [b];
  await w.tick();
  assert.equal(state.get('w:claude:ext-2'), undefined);
  w.stop();
});

test('Sperrdatei: zweiter Server mit demselben Datenordner wird abgewiesen, tote PID übernommen', async () => {
  const { acquireLock } = await import('../server/config.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-lock-'));
  const a = acquireLock(dir);
  assert.equal(a.ok, true);
  // anderer, lebender Prozess (dieser Test-Prozess unter fremder PID-Annahme): eigene PID gilt nicht als fremd
  const b = acquireLock(dir, process.pid + 1_000_000);
  assert.equal(b.ok, false);
  assert.equal(b.pid, process.pid);
  a.release();
  fs.writeFileSync(path.join(dir, 'server.lock'), '999999999');
  const c = acquireLock(dir);
  assert.equal(c.ok, true);
  c.release();
  assert.equal(fs.existsSync(path.join(dir, 'server.lock')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
