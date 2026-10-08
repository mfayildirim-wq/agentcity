import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  STATUS, CATEGORIES, createAgent, createEvent, createPermission, kindToCategory, toolCategory,
} from '../server/core/model.js';
import { createBus } from '../server/core/bus.js';
import { createState } from '../server/core/state.js';
import { loadToken } from '../server/config.js';

test('createAgent setzt Defaults', () => {
  const a = createAgent({ id: 'a1', toolId: 'claude', project: 'p' });
  assert.equal(a.kind, 'main');
  assert.equal(a.status, 'idle');
  assert.equal(a.source, 'acp');
  assert.equal(a.controllable, true);
  assert.deepEqual(a.tokens, { input: 0, output: 0, cache: 0 });
  assert.deepEqual(a.events, []);
  assert.equal(a.parentId, null);
  const w = createAgent({ id: 'w1', toolId: 'claude', project: 'p', source: 'watch' });
  assert.equal(w.controllable, false);
});

test('Konstanten und Kategorien', () => {
  assert.ok(STATUS.includes('waiting_permission'));
  assert.ok(CATEGORIES.includes('terminal'));
  assert.equal(kindToCategory('execute'), 'terminal');
  assert.equal(kindToCategory('read'), 'library');
  assert.equal(kindToCategory('unbekannt'), 'workbench');
  assert.equal(toolCategory('Bash'), 'terminal');
  assert.equal(toolCategory('mcp__x__y'), 'portal');
  assert.equal(toolCategory('Edit'), 'workbench');
});

test('createEvent und createPermission', () => {
  const e = createEvent('a1', 'tool', { tool: 'Bash' }, 5);
  assert.equal(e.agentId, 'a1');
  assert.equal(e.kind, 'tool');
  assert.equal(e.tool, 'Bash');
  assert.equal(e.t, 5);
  assert.ok(e.id);
  const p = createPermission('a1', { toolCall: { title: 'ls', toolCallId: 't1', kind: 'execute' }, options: [{ optionId: 'x' }] });
  assert.equal(p.title, 'ls');
  assert.equal(p.kind, 'execute');
  assert.equal(p.resolved, null);
  assert.equal(p.options.length, 1);
});

test('state.upsert löst Bus-Ereignis aus, remove ebenfalls', () => {
  const bus = createBus();
  const state = createState({ bus });
  const seen = [];
  bus.on('agent.update', (m) => seen.push(['u', m.agent.id]));
  bus.on('agent.remove', (m) => seen.push(['r', m.agentId]));
  const a = createAgent({ id: 'a1', toolId: 'claude', project: 'p' });
  assert.equal(state.upsert(a), true);
  assert.equal(state.get('a1').id, 'a1');
  // unverändert → kein zweites Ereignis
  assert.equal(state.upsert({ ...a }), false);
  state.upsert({ ...a, status: 'thinking' });
  assert.equal(state.all().length, 1);
  assert.equal(state.snapshot().agents.length, 1);
  state.remove('a1');
  state.remove('a1');
  assert.deepEqual(seen, [['u', 'a1'], ['u', 'a1'], ['r', 'a1']]);
  assert.equal(state.get('a1'), undefined);
});

test('loadToken erzeugt 32 Hex-Zeichen mit Modus 0600 und liest es wieder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcity-tok-'));
  const t1 = loadToken(dir);
  assert.match(t1, /^[0-9a-f]{32}$/);
  assert.equal(fs.statSync(path.join(dir, 'token')).mode & 0o777, 0o600);
  assert.equal(loadToken(dir), t1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('house: Standard ist die Session-Id, explizit überschreibbar', () => {
  const a = createAgent({ id: 'a1', toolId: 'claude', project: 'p', sessionId: 's1' });
  assert.equal(a.house, 's1');
  const b = createAgent({ id: 'a2', toolId: 'claude', project: 'p', sessionId: 's2', house: 'haus-x' });
  assert.equal(b.house, 'haus-x');
  const c = createAgent({ id: 'a3', toolId: 'claude', project: 'p' });
  assert.equal(c.house, null);
});
