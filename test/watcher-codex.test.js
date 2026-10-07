import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCodexWatcher } from '../server/watchers/codex.js';
import { startWatchers } from '../server/watchers/index.js';
import { createBus } from '../server/core/bus.js';
import { createState } from '../server/core/state.js';
import { createAgent } from '../server/core/model.js';

const pad = (n) => String(n).padStart(2, '0');
const ID = '01a1174f-3d85-7762-bf33-e203e6f895fe';

function fixture(lines, id = ID, root = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-codex-'))) {
  const d = new Date();
  const dir = path.join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-07T19-00-31-${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { root, file };
}

const ts = (off = 0) => new Date(Date.now() - 5000 + off).toISOString();
const meta = { timestamp: ts(), type: 'session_meta', payload: { id: ID, timestamp: ts(), cwd: '/Users/x/myProjects/demo', originator: 'codex_cli_rs', cli_version: '0.154.0' } };
const lines = [
  meta,
  { timestamp: ts(1), type: 'turn_context', payload: { cwd: '/Users/x/myProjects/demo', model: 'gpt-5.5' } },
  { timestamp: ts(2), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
  { timestamp: ts(3), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…</environment_context>' }] } },
  { timestamp: ts(4), type: 'event_msg', payload: { type: 'user_message', message: 'Bitte die Tests ausführen' } },
  { timestamp: ts(5), type: 'response_item', payload: { type: 'reasoning', summary: [] } },
  { timestamp: ts(6), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Ich starte die Tests.' }] } },
  { timestamp: ts(7), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c0', input: '*** Begin Patch\n*** Update File: /Users/x/myProjects/demo/src/app.js\n@@\n-a\n+b\n*** End Patch' } },
  { timestamp: ts(8), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c0', output: 'ok' } },
  { timestamp: ts(9), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 } } } },
  { timestamp: ts(10), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: JSON.stringify({ cmd: 'npm test' }) } },
];

test('Codex-Watcher: session_meta, Werkzeug, Text, Tokens', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-codex-'));
  const w = createCodexWatcher({ root, windowMs: 60 * 60_000 });
  assert.equal(w.adoptable, true);
  await w.scan(); // erster Scan (leer): baut nur Zustand auf
  fixture(lines, ID, root);
  await w.scan();
  const [a] = w.agents();
  assert.equal(a.id, `w:codex:${ID}`);
  assert.equal(a.sessionId, ID);
  assert.equal(a.acpSessionId, ID);
  assert.equal(a.toolId, 'codex');
  assert.equal(a.source, 'watch');
  assert.equal(a.controllable, false);
  assert.equal(a.cwd, '/Users/x/myProjects/demo');
  assert.equal(a.project, 'demo');
  assert.equal(a.model, 'gpt-5.5');
  assert.equal(a.status, 'tool');
  assert.equal(a.tool, 'exec_command');
  assert.equal(a.category, 'terminal');
  assert.equal(a.detail, 'npm test');
  assert.equal(a.lastText, 'Ich starte die Tests.');
  assert.equal(a.lastPrompt, 'Bitte die Tests ausführen');
  assert.equal(a.title, 'Bitte die Tests ausführen');
  assert.equal(a.toolCount, 2);
  assert.deepEqual(a.tokens, { input: 600, output: 50, cache: 400 });
  const kinds = a.events.map((e) => e.kind);
  assert.deepEqual(kinds, ['prompt', 'text', 'tool', 'tool']);
  assert.equal(a.events[2].category, 'workbench');
  assert.equal(a.events[2].label, 'app.js');
  const evs = w.takeEvents();
  assert.equal(evs.length, 4);
  assert.ok(evs.every((e) => e.sessionId === ID && e.agentId === a.id));
  assert.equal(w.takeEvents().length, 0);
});

test('Codex-Watcher liest angehängte Zeilen inkrementell; task_complete → waiting_user', async () => {
  const { root, file } = fixture(lines);
  const w = createCodexWatcher({ root, windowMs: 60 * 60_000 });
  await w.scan();
  w.takeEvents();
  fs.appendFileSync(file, [
    { timestamp: ts(11), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' } },
    { timestamp: ts(12), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Alle Tests grün.' }] } },
    { timestamp: ts(13), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  await w.scan();
  const [a] = w.agents();
  assert.equal(a.status, 'waiting_user');
  assert.equal(a.tool, null);
  assert.equal(a.lastText, 'Alle Tests grün.');
  assert.equal(w.takeEvents().length, 1);
});

test('Codex-Watcher: alte Dateien und fehlender Ordner werden übersprungen', async () => {
  const { root, file } = fixture(lines);
  const old = (Date.now() - 3 * 3600_000) / 1000;
  fs.utimesSync(file, old, old);
  const w = createCodexWatcher({ root, windowMs: 60 * 60_000 });
  await w.scan();
  assert.equal(w.agents().length, 0);
  const none = createCodexWatcher({ root: path.join(root, 'gibtsnicht'), windowMs: 60_000 });
  await none.scan();
  assert.deepEqual(none.agents(), []);
});

test('startWatchers setzt adoptable je Watcher und überspringt ACP-gesteuerte Codex-Sessions', async () => {
  const { root } = fixture(lines);
  const bus = createBus();
  const state = createState({ bus });
  const codex = createCodexWatcher({ root, windowMs: 60 * 60_000 });
  const fake = { id: 'fake', adoptable: false, scan: async () => {}, agents: () => [createAgent({ id: 'w:fake:1', toolId: 'fake', sessionId: 'f1', project: 'p', source: 'watch' })] };
  const ws = startWatchers({ state, bus, config: {}, watchers: [codex, fake], autoStart: false });
  await ws.tick();
  assert.equal(state.get(`w:codex:${ID}`).adoptable, true);
  assert.equal(state.get('w:fake:1').adoptable, false);
  state.upsert(createAgent({ id: 'a:1', toolId: 'codex', sessionId: 'x', acpSessionId: ID, project: 'demo', source: 'acp' }));
  await ws.tick();
  assert.equal(state.get(`w:codex:${ID}`), undefined);
});

test('Codex-Watcher: erster Scan meldet keine historischen Ereignisse; halbe/kaputte Zeilen; Aufräumen', async () => {
  const { root, file } = fixture(lines);
  const w = createCodexWatcher({ root, windowMs: 60 * 60_000 });
  await w.scan();
  assert.equal(w.takeEvents().length, 0);
  assert.equal(w.agents()[0].events.length, 4);
  // kaputte Zeile wird übersprungen, halbe Zeile erst nach Vervollständigung gelesen
  const msg = JSON.stringify({ timestamp: ts(20), type: 'event_msg', payload: { type: 'user_message', message: 'Weiter bitte' } });
  fs.appendFileSync(file, '{kaputt\n' + msg.slice(0, 30));
  await w.scan();
  assert.equal(w.takeEvents().length, 0);
  fs.appendFileSync(file, msg.slice(30) + '\n');
  await w.scan();
  const evs = w.takeEvents();
  assert.equal(evs.length, 1);
  assert.equal(evs[0].label, 'Weiter bitte');
  assert.equal(w.trackerCount(), 1);
  // aus dem Zeitfenster gefallen → Tracker weg
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 3600_000;
  try { await w.scan(); } finally { Date.now = realNow; }
  assert.equal(w.trackerCount(), 0);
  assert.deepEqual(w.agents(), []);
});
