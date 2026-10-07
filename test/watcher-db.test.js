import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createOpencodeWatcher } from '../server/watchers/opencode.js';
import { createHermesWatcher } from '../server/watchers/hermes.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arena-wdb-'));

function opencodeDb() {
  const file = path.join(tmp(), 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT,
      version TEXT, agent TEXT, model TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
      tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`);
  const now = Date.now();
  const ses = db.prepare('INSERT INTO session (id, parent_id, directory, title, agent, model, time_created, time_updated, tokens_input, tokens_output) VALUES (?,?,?,?,?,?,?,?,?,?)');
  ses.run('ses_1', null, '/Users/x/myProjects/demo', 'Tests reparieren', 'build', '{"id":"deepseek","providerID":"x"}', now - 60_000, now - 2000, 100, 20);
  ses.run('ses_2', 'ses_1', '/Users/x/myProjects/demo', 'Recherche (@general subagent)', 'general', null, now - 30_000, now - 3000, 0, 0);
  ses.run('ses_old', null, '/Users/x/alt', 'Alt', 'build', null, now - 9e6, now - 9e6, 0, 0);
  const msg = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)');
  const part = db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)');
  msg.run('msg_1', 'ses_1', now - 50_000, now - 50_000, JSON.stringify({ role: 'user' }));
  part.run('prt_1', 'msg_1', 'ses_1', now - 50_000, now - 50_000, JSON.stringify({ type: 'text', text: 'Bitte npm test laufen lassen' }));
  msg.run('msg_2', 'ses_1', now - 40_000, now - 2000, JSON.stringify({ role: 'assistant', modelID: 'deepseek-v4', time: { created: now - 40_000 } }));
  part.run('prt_2', 'msg_2', 'ses_1', now - 39_000, now - 39_000, JSON.stringify({ type: 'text', text: 'Ich führe die Tests aus.' }));
  part.run('prt_3', 'msg_2', 'ses_1', now - 30_000, now - 2000, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'npm test', description: 'Tests ausführen' } } }));
  msg.run('msg_3', 'ses_2', now - 20_000, now - 3000, JSON.stringify({ role: 'assistant', finish: 'stop', time: { created: now - 20_000, completed: now - 3000 } }));
  db.close();
  return file;
}

test('OpenCode-Watcher: Session, laufendes Werkzeug, Subagent', async () => {
  const w = createOpencodeWatcher({ dbPath: opencodeDb(), windowMs: 60 * 60_000 });
  await w.scan();
  const agents = w.agents();
  assert.deepEqual(agents.map((a) => a.id).sort(), ['w:opencode:ses_1', 'w:opencode:sub:ses_2']);
  const main = agents.find((a) => a.kind === 'main');
  assert.equal(main.toolId, 'opencode');
  assert.equal(main.source, 'watch');
  assert.equal(main.project, 'demo');
  assert.equal(main.title, 'Tests reparieren');
  assert.equal(main.model, 'deepseek-v4');
  assert.equal(main.status, 'tool');
  assert.equal(main.tool, 'bash');
  assert.equal(main.category, 'terminal');
  assert.equal(main.detail, 'Tests ausführen');
  assert.equal(main.lastPrompt, 'Bitte npm test laufen lassen');
  assert.equal(main.lastText, 'Ich führe die Tests aus.');
  assert.equal(main.toolCount, 1);
  assert.deepEqual(main.events.map((e) => e.kind), ['prompt', 'text', 'tool']);
  const sub = agents.find((a) => a.kind === 'sub');
  assert.equal(sub.parentId, main.id);
  assert.equal(sub.status, 'done');
  assert.equal(sub.agentType, 'general');
  assert.equal(w.takeEvents().length, 3);
  await w.scan(); // unverändert → kein Neulesen, keine doppelten Ereignisse
  assert.equal(w.takeEvents().length, 0);
  w.close();
});

test('OpenCode-Watcher: fehlende/kaputte Datenbank wird still übersprungen', async () => {
  const bad = path.join(tmp(), 'kaputt.db');
  fs.writeFileSync(bad, 'keine sqlite-datei');
  const w = createOpencodeWatcher({ dbPath: bad, windowMs: 60_000 });
  const orig = console.error;
  let logged = 0;
  console.error = () => { logged++; };
  try {
    await w.scan();
    fs.appendFileSync(bad, 'x'); // geändert → erneuter Versuch, aber nur einmal geloggt
    await w.scan();
  } finally { console.error = orig; }
  assert.deepEqual(w.agents(), []);
  assert.equal(logged, 1);
});

function hermesDb() {
  const file = path.join(tmp(), 'state.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, system_prompt TEXT, parent_session_id TEXT,
      started_at REAL NOT NULL, ended_at REAL, title TEXT, tool_call_count INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
      tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, finish_reason TEXT);`);
  const s = Date.now() / 1000;
  db.prepare('INSERT INTO sessions (id, source, model, system_prompt, started_at, ended_at, title, tool_call_count) VALUES (?,?,?,?,?,?,?,?)')
    .run('20261007_1', 'cli', 'gpt-5.4', 'Du bist Hermes.\nCurrent working directory: /Users/x/myProjects/demo\n\nYou are a CLI AI Agent.', s - 60, null, null, 1);
  db.prepare('INSERT INTO sessions (id, source, model, started_at, ended_at) VALUES (?,?,?,?,?)').run('20260101_alt', 'cli', 'x', s - 9e5, s - 9e5);
  const m = db.prepare('INSERT INTO messages (session_id, role, content, tool_calls, timestamp, finish_reason) VALUES (?,?,?,?,?,?)');
  m.run('20261007_1', 'user', '[Note: model was switched.]\n\nListe die Dateien', null, s - 50, null);
  m.run('20261007_1', 'assistant', '', JSON.stringify([{ type: 'function', function: { name: 'terminal', arguments: JSON.stringify({ command: 'ls -la' }) } }]), s - 40, 'tool_calls');
  m.run('20261007_1', 'tool', '{"output":"…"}', null, s - 30, null);
  m.run('20261007_1', 'assistant', 'Hier sind die Dateien.', null, s - 5, 'stop');
  db.close();
  return file;
}

test('Hermes-Watcher: Session mit cwd aus dem System-Prompt, wartet nach Antwort', async () => {
  const w = createHermesWatcher({ dbPath: hermesDb(), windowMs: 60 * 60_000 });
  await w.scan();
  const [a, ...rest] = w.agents();
  assert.equal(rest.length, 0);
  assert.equal(a.id, 'w:hermes:20261007_1');
  assert.equal(a.toolId, 'hermes');
  assert.equal(a.cwd, '/Users/x/myProjects/demo');
  assert.equal(a.project, 'demo');
  assert.equal(a.status, 'waiting_user');
  assert.equal(a.lastPrompt, 'Liste die Dateien');
  assert.equal(a.title, 'Liste die Dateien');
  assert.equal(a.lastText, 'Hier sind die Dateien.');
  assert.deepEqual(a.events.map((e) => e.kind), ['prompt', 'tool', 'text']);
  assert.equal(a.events[1].category, 'terminal');
  assert.equal(a.events[1].label, 'ls -la');
  assert.equal(w.takeEvents().length, 3);
  w.close();
});
