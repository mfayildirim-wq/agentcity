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

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-claude-'));
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
  // stabile Ausgabe → zweiter Scan ändert nichts
  await w.scan();
  assert.deepEqual(w.agents(), agents.map((a) => ({ ...a, lastActivity: a.lastActivity })));
  fs.rmSync(root, { recursive: true, force: true });
});

test('startWatchers schreibt in den Zustand und überspringt ACP-Sessions', async () => {
  const { root, sid } = makeFixture();
  const bus = createBus();
  const state = createState({ bus });
  const config = { claudeProjectsDir: root, windowMin: 60 };
  const ws = startWatchers({ state, config, autoStart: false });
  await ws.tick();
  assert.equal(state.all().length, 2);
  // ACP-Agent übernimmt die Session → Watcher-Agenten verschwinden
  state.upsert(createAgent({ id: 'a:1', toolId: 'claude', project: 'demo', sessionId: sid, source: 'acp' }));
  await ws.tick();
  assert.deepEqual(state.all().map((a) => a.id), ['a:1']);
  ws.stop();
  fs.rmSync(root, { recursive: true, force: true });
});
