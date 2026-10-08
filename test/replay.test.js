// Paket 6.2: Wiedergabe – Rekonstruktion des Agentenzustands aus gespeicherten Ereignissen (public/js/replay.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconstruct, markerKind, bundleTools, sessionAt } from '../public/js/replay.js';

const s1 = { id: 's1', toolId: 'claude', project: 'agentcity', cwd: '/x/agentcity', title: 'Eins', source: 'acp', startedAt: 1000, endedAt: 9000 };
const ev = (t, kind, p = {}) => ({ id: `${kind}-${t}`, agentId: 'a:1', t, kind, ...p });
const data = new Map([['s1', {
  agents: [{ id: 'a:1', kind: 'main' }, { id: 'a:sub', kind: 'sub', parentId: 'a:1', description: 'Recherche', startedAt: 2600, endedAt: 2800 }],
  events: [
    ev(1100, 'prompt', { label: 'Sag nur: eins' }),
    ev(1200, 'tool', { tool: 'Bash', category: 'terminal', toolCallId: 't1', label: 'ls' }),
    ev(1300, 'permission', { permissionId: 'p1', title: 'ls' }),
    ev(1400, 'permission', { permissionId: 'p1', optionId: 'allow' }),
    ev(1500, 'tool_update', { toolCallId: 't1', status: 'completed' }),
    ev(1600, 'plan', { entries: [{ content: 'A', status: 'completed' }] }),
    ev(1700, 'text', { label: 'eins' }),
    ev(1800, 'status', { status: 'waiting_user' }),
    { id: 'sub-tool', agentId: 'a:sub', t: 2700, kind: 'tool', tool: 'Read', category: 'library' },
    ev(3000, 'prompt', { label: 'zwei' }),
    ev(3100, 'error', { message: 'kaputt' }),
  ],
}]]);

const at = (t) => reconstruct([s1], data, t);
const main = (t) => at(t).find((a) => a.id === 'a:1');

test('Status je Zeitpunkt: denkt → Werkzeug → Erlaubnis → wartet → Fehler', () => {
  assert.equal(main(1150).status, 'thinking');
  assert.equal(main(1150).lastPrompt, 'Sag nur: eins');
  assert.equal(main(1250).status, 'tool');
  assert.equal(main(1250).category, 'terminal');
  assert.equal(main(1250).tool, 'Bash');
  assert.equal(main(1350).status, 'waiting_permission');
  assert.equal(main(1450).status, 'tool');
  assert.equal(main(1550).status, 'thinking');
  assert.equal(main(1650).plan.length, 1);
  const w = main(1900);
  assert.equal(w.status, 'waiting_user');
  assert.equal(w.lastText, 'eins');
  assert.equal(w.toolCount, 1);
  assert.equal(w.replay, true);
  assert.equal(w.controllable, false);
  assert.equal(w.project, 'agentcity');
  assert.equal(w.title, 'Eins');
  assert.equal(main(3200).status, 'error');
  assert.equal(main(3200).error.message, 'kaputt');
});

test('Session nur zwischen Start und Ende sichtbar; vor dem ersten Ereignis wartet ein ACP-Agent', () => {
  assert.equal(at(500).length, 0);
  assert.equal(at(9500).length, 0);
  assert.equal(main(1050).status, 'waiting_user');
  assert.ok(sessionAt({ startedAt: 1, endedAt: null }, 1e12));
});

test('Subagent erscheint ab Start, danach kurz „fertig“, dann weg', () => {
  assert.equal(at(2500).some((a) => a.id === 'a:sub'), false);
  const sub = at(2750).find((a) => a.id === 'a:sub');
  assert.equal(sub.parentId, 'a:1');
  assert.equal(sub.status, 'tool');
  assert.equal(sub.category, 'library');
  assert.equal(at(2900).find((a) => a.id === 'a:sub').status, 'done');
  assert.equal(at(2800 + 3 * 60_000 + 1).some((a) => a.id === 'a:sub'), false);
});

test('Watcher-Agent: nach 60 s Ruhe wartend; Ereignisse ohne Agentenzeile gehen an den Hauptagenten', () => {
  const s = { id: 'w', toolId: 'claude', project: 'p', source: 'watch', startedAt: 0, endedAt: null };
  const d = new Map([['w', { agents: [], events: [{ id: 'e', agentId: 'w:claude:w', t: 10, kind: 'tool', tool: 'Bash', category: 'terminal' }] }]]);
  const a = reconstruct([s], d, 20)[0];
  assert.equal(a.id, 'w:claude:w');
  assert.equal(a.status, 'tool');
  assert.equal(reconstruct([s], d, 70_000)[0].status, 'waiting_user');
});

test('Marker-Arten und gebündelte Werkzeuge', () => {
  assert.equal(markerKind({ kind: 'prompt' }), 'prompt');
  assert.equal(markerKind({ kind: 'permission' }), 'permission');
  assert.equal(markerKind({ kind: 'permission', optionId: 'allow' }), null);
  assert.equal(markerKind({ kind: 'error' }), 'error');
  assert.equal(markerKind({ kind: 'tool' }), 'tool');
  assert.equal(markerKind({ kind: 'text' }), null);
  const b = bundleTools([{ kind: 'tool', t: 100, tool: 'A' }, { kind: 'tool', t: 150, tool: 'B' }, { kind: 'tool', t: 260, tool: 'C' }, { kind: 'prompt', t: 120 }], 100, 100);
  assert.deepEqual(b.map((x) => x.count), [2, 1]);
  assert.deepEqual(b[0].labels, ['A', 'B']);
});

test('Store: Wiedergabemodus puffert Live-Nachrichten und Snapshot, Rückkehr wendet sie an', async () => {
  const { createStore } = await import('../public/js/store.js');
  const store = createStore();
  store.applySnapshot({ now: Date.now(), agents: [{ id: 'live', kind: 'main', project: 'p', status: 'idle' }] });
  store.select('live');
  assert.equal(store.enterPlayback(), true);
  store.setPlaybackAgents(123, [{ id: 'alt', kind: 'main', project: 'p', status: 'tool', replay: true }]);
  assert.deepEqual([...store.state.agents.keys()], ['alt']);
  assert.equal(store.state.selected, null);
  assert.equal(store.state.playback.t, 123);
  // Live-Updates werden nicht angewendet, sondern gepuffert
  store.dispatch({ type: 'agent.update', agent: { id: 'neu', kind: 'main', project: 'p', status: 'thinking' } });
  store.dispatch({ type: 'chat.chunk', agentId: 'live', messageId: 'm1', role: 'agent', text: 'hallo' });
  store.applySnapshot({ now: Date.now(), agents: [{ id: 'live', kind: 'main', project: 'p', status: 'waiting_user' }, { id: 'neu', kind: 'main', project: 'p', status: 'thinking' }] });
  assert.deepEqual([...store.state.agents.keys()], ['alt']);
  assert.equal(store.bufferedCount(), 3);
  assert.equal(store.exitPlayback(), false);
  assert.equal(store.state.playback, null);
  assert.deepEqual([...store.state.agents.keys()].sort(), ['live', 'neu']);
  assert.equal(store.state.agents.get('live').status, 'waiting_user');
  assert.equal(store.chatOf('live')[0].text, 'hallo');
  assert.equal(store.state.selected, 'live');
});

test('Subagent ohne gespeichertes Ende verschwindet nach längerer Ruhe', () => {
  const s = { id: 'w', toolId: 'claude', project: 'p', source: 'watch', startedAt: 0, endedAt: null };
  const d = new Map([['w', { agents: [{ id: 'm', kind: 'main' }, { id: 'sub', kind: 'sub', parentId: 'm', startedAt: 100 }],
    events: [{ id: 'e', agentId: 'sub', t: 200, kind: 'tool', tool: 'Read', category: 'library' }] }]]);
  assert.ok(reconstruct([s], d, 300).some((a) => a.id === 'sub'));
  assert.equal(reconstruct([s], d, 200 + 3 * 60_000 + 1).some((a) => a.id === 'sub'), false);
});

test('Store: gepufferte agent.remove/permission.resolved, Rückfragen-Zähler, pty sofort', async () => {
  const { createStore } = await import('../public/js/store.js');
  const store = createStore();
  store.applySnapshot({ now: Date.now(), agents: [{ id: 'x', kind: 'main', project: 'p' }, { id: 'y', kind: 'main', project: 'p' }], permissions: [] });
  store.upsertTerminal({ ptyId: 'p1', agentId: 'x', kind: 'agent' });
  store.enterPlayback();
  store.setPlaybackAgents(1, []);
  store.dispatch({ type: 'agent.remove', agentId: 'y' });
  store.dispatch({ type: 'permission.request', permission: { id: 'perm', agentId: 'x', t: 1, options: [] } });
  assert.equal(store.heldPermissions(), 1);
  store.dispatch({ type: 'pty.output', ptyId: 'p1', data: 'abc' });
  assert.equal(store.state.terminals.get('p1').data, 'abc', 'Terminal-Ausgabe nicht gepuffert');
  store.dispatch({ type: 'permission.resolved', permissionId: 'perm' });
  assert.equal(store.heldPermissions(), 0);
  store.exitPlayback();
  assert.deepEqual([...store.state.agents.keys()], ['x']);
  assert.equal(store.state.permissions.size, 0);
});

test('Store: Überlauf verwirft den Puffer, beim Verlassen wird nichts nachgespielt', async () => {
  const { createStore } = await import('../public/js/store.js');
  const store = createStore({ maxBuffer: 3 });
  store.applySnapshot({ now: Date.now(), agents: [{ id: 'x', kind: 'main', project: 'p' }] });
  store.applyChatChunk({ agentId: 'x', messageId: 'm0', role: 'agent', text: 'alt' });
  store.enterPlayback();
  for (let i = 0; i < 5; i++) store.dispatch({ type: 'chat.chunk', agentId: 'x', messageId: `m${i + 1}`, role: 'agent', text: 'neu' });
  assert.equal(store.isOverflowed(), true);
  assert.equal(store.bufferedCount(), 0);
  assert.equal(store.exitPlayback(), true);
  assert.deepEqual(store.state.chats, {}, 'Chat wird neu geladen statt lückenhaft ergänzt');
  assert.ok(store.state.agents.has('x'));
});

test('Live während laufendem Scrub: veraltetes Ergebnis wird verworfen (Gate)', async () => {
  const { createStore } = await import('../public/js/store.js');
  const { createScrubGate } = await import('../public/js/replay.js');
  const store = createStore();
  store.applySnapshot({ now: Date.now(), agents: [{ id: 'live', kind: 'main', project: 'p' }] });
  const gate = createScrubGate();
  let release;
  const loading = new Promise((r) => { release = r; });
  // Scrub beginnt, lädt noch …
  const scrub = (async () => {
    const token = gate.begin();
    await loading;
    if (gate.valid(token)) store.setPlaybackAgents(5, [{ id: 'alt', kind: 'main', project: 'p' }]);
  })();
  store.enterPlayback();
  // … Nutzer drückt Live
  gate.cancel();
  store.exitPlayback();
  release();
  await scrub;
  assert.equal(store.state.playback, null);
  assert.deepEqual([...store.state.agents.keys()], ['live']);
});

test('mergeEvents: Duplikate verworfen, sortiert nach (t, Eintreffen)', async () => {
  const { mergeEvents } = await import('../public/js/replay.js');
  const c = {};
  assert.equal(mergeEvents(c, [{ id: 'a', t: 2 }, { id: 'b', t: 1 }, { id: 'c', t: 2 }]), 3);
  assert.equal(mergeEvents(c, [{ id: 'a', t: 2 }, { id: 'd', t: 2 }]), 1);
  assert.deepEqual(c.events.map((e) => e.id), ['b', 'a', 'c', 'd']);
});
