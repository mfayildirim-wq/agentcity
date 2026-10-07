import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClaudeWatcher, mainId, subId } from '../server/watchers/claude.js';
import { startWatchers } from '../server/watchers/index.js';
import { createBus } from '../server/core/bus.js';
import { createState } from '../server/core/state.js';
import { createAgent } from '../server/core/model.js';

function makeFixture(root = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-claude-'))) {
  const pdir = path.join(root, '-Users-x-myProjects-demo');
  const sid = 'sess-1';
  fs.mkdirSync(path.join(pdir, sid, 'subagents'), { recursive: true });
  const ts = new Date().toISOString();
  const lines = [
    { type: 'user', timestamp: ts, cwd: '/Users/x/myProjects/demo', message: { role: 'user', content: 'Bitte Tests ausführen' } },
    {
      type: 'assistant', timestamp: ts, message: {
        model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5 },
        content: [
          { type: 'tool_use', id: 'tu-agent', name: 'Agent', input: { description: 'Recherche' } },
          { type: 'tool_use', id: 'tu-bash', name: 'Bash', input: { command: 'npm test', description: 'Tests ausführen' } },
        ],
      },
    },
  ];
  fs.writeFileSync(path.join(pdir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const sub = path.join(pdir, sid, 'subagents', 'agent-x.jsonl');
  fs.writeFileSync(sub, JSON.stringify({
    type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id: 'tu-s1', name: 'Read', input: { file_path: '/a/b.js' } }] },
  }) + '\n');
  fs.writeFileSync(path.join(pdir, sid, 'subagents', 'agent-x.meta.json'),
    JSON.stringify({ agentType: 'Explore', description: 'Recherche', toolUseId: 'tu-agent' }));
  return { root, sid };
}

test('Claude-Watcher liefert Haupt- und Subagent im neuen Modell', async () => {
  const { root, sid } = makeFixture();
  const w = createClaudeWatcher({ root, windowMs: 60 * 60_000 });
  await w.scan();
  const agents = w.agents();
  assert.equal(agents.length, 2);
  const main = agents.find((a) => a.kind === 'main');
  const sub = agents.find((a) => a.kind === 'sub');
  assert.equal(main.id, mainId(sid));
  assert.equal(sub.id, subId('x'));
  assert.equal(sub.parentId, main.id);
  assert.equal(main.status, 'tool');
  assert.equal(main.tool, 'Bash');
  assert.equal(main.category, 'terminal');
  assert.equal(main.source, 'watch');
  assert.equal(main.controllable, false);
  assert.equal(main.toolId, 'claude');
  assert.equal(main.project, 'demo');
  assert.equal(sub.project, 'demo');
  assert.equal(sub.category, 'library');
  assert.equal(main.events.length, 3);
  // stabile Ausgabe → zweiter Scan ändert nichts (ohne die zeitabhängigen Felder)
  const stable = (list) => JSON.stringify(list.map(({ lastActivity, startedAt, ...rest }) => rest));
  await w.scan();
  assert.equal(stable(w.agents()), stable(agents));
  assert.deepEqual(w.agents().map((a) => a.id).sort(), agents.map((a) => a.id).sort());
  fs.rmSync(root, { recursive: true, force: true });
});

test('startWatchers schreibt in den Zustand und überspringt ACP-Sessions', async () => {
  const { root, sid } = makeFixture();
  const bus = createBus();
  const state = createState({ bus });
  const config = { claudeProjectsDir: root, windowMin: 60 };
  const ws = startWatchers({ state, bus, config, autoStart: false });
  await ws.tick();
  assert.equal(state.all().length, 2);
  // ACP-Agent übernimmt die Session → Watcher-Agenten verschwinden
  state.upsert(createAgent({ id: 'a:1', toolId: 'claude', project: 'demo', sessionId: sid, source: 'acp' }));
  await ws.tick();
  assert.deepEqual(state.all().map((a) => a.id), ['a:1']);
  ws.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

test('Ereignisse: stabile Ids, neue werden genau einmal gemeldet, eindeutig nach Neuschreiben', async () => {
  // erster Scan (leer) baut nur Zustand auf; danach entstehende Sessions melden ihre Ereignisse
  const root0 = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-claude-'));
  const w = createClaudeWatcher({ root: root0, windowMs: 60 * 60_000 });
  await w.scan();
  const { root, sid } = makeFixture(root0);
  const file = path.join(root, '-Users-x-myProjects-demo', `${sid}.jsonl`);
  await w.scan();
  const first = w.takeEvents();
  assert.equal(first.length, 4); // prompt, 2 tools (Haupt), 1 tool (Sub)
  assert.ok(first.every((e) => e.sessionId === sid && e.id && e.agentId));
  await w.scan();
  assert.equal(w.takeEvents().length, 0);
  // gleicher Inhalt in neuem Watcher (z. B. Server-Neustart) → gleiche Ids
  const w2 = createClaudeWatcher({ root, windowMs: 60 * 60_000 });
  await w2.scan();
  assert.equal(w2.takeEvents().length, 0, 'erster Scan meldet keine historischen Ereignisse');
  assert.deepEqual(w2.agents().flatMap((a) => a.events.map((e) => e.id)).sort(), first.map((e) => e.id).sort());
  // Datei kürzer neu geschrieben → neue Ids, keine Kollision mit den alten
  const ts = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: 'Neu' } }) + '\n');
  await w.scan();
  const after = w.takeEvents();
  assert.equal(after.length, 1);
  assert.ok(!first.some((e) => e.id === after[0].id));
  fs.rmSync(root, { recursive: true, force: true });
});

test('alte Tracker werden entfernt, toolOwner mit', async () => {
  const { root } = makeFixture();
  const w = createClaudeWatcher({ root, windowMs: 60 * 60_000 });
  await w.scan();
  assert.equal(w.trackerCount(), 2);
  assert.ok(w.ownerCount() >= 3);
  // Dateien und Zeitstempel altern lassen
  const old = new Date(Date.now() - 2 * 60 * 60_000);
  for (const f of fs.readdirSync(root, { recursive: true })) {
    const fp = path.join(root, f);
    if (fs.statSync(fp).isFile()) fs.utimesSync(fp, old, old);
  }
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 60 * 60_000;
  try { await w.scan(); } finally { Date.now = realNow; }
  assert.equal(w.trackerCount(), 0);
  assert.equal(w.ownerCount(), 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('startWatchers: Ereignisse auf den Bus, Dedup per acpSessionId, Fehler beenden tick nicht', async () => {
  const { root, sid } = makeFixture();
  const bus = createBus();
  const state = createState({ bus });
  const events = [];
  bus.on('event', ({ event }) => events.push(event));
  const broken = { id: 'kaputt', scan: async () => { throw new Error('kaputt'); }, agents: () => [] };
  const throwsLater = { id: 'kaputt2', scan: async () => {}, agents: () => { throw new Error('auch kaputt'); } };
  const claude = createClaudeWatcher({ root, windowMs: 60 * 60_000 });
  const origError = console.error;
  console.error = () => {};
  try {
    const ws = startWatchers({ state, bus, config: {}, watchers: [broken, throwsLater, claude], autoStart: false });
    await ws.tick();
    assert.equal(state.all().length, 2);
    assert.equal(events.length, 0); // erster Scan: nur Zustand
    fs.appendFileSync(path.join(root, '-Users-x-myProjects-demo', `${sid}.jsonl`),
      JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Weiter' } }) + '\n');
    await ws.tick();
    assert.equal(events.length, 1);
    await ws.tick();
    assert.equal(events.length, 1); // nichts doppelt
    // ACP-Agent mit anderer sessionId, aber acpSessionId = Claude-Session
    state.upsert(createAgent({ id: 'a:2', toolId: 'claude', project: 'demo', sessionId: 'db-1', acpSessionId: sid, source: 'acp' }));
    await ws.tick();
    assert.deepEqual(state.all().map((a) => a.id), ['a:2']);
  } finally {
    console.error = origError;
  }
  fs.rmSync(root, { recursive: true, force: true });
});
