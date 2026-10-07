import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createPtyManager, ByteRing } from '../server/pty/manager.js';
import { createTerminalHandlers, outputLimit } from '../server/acp/terminal.js';
import { createBus } from '../server/core/bus.js';
import { createState } from '../server/core/state.js';
import { createSessionManager } from '../server/acp/manager.js';
import { createHttpServer } from '../server/api/http.js';
import { attachWs } from '../server/api/ws.js';
import { createHandlers } from '../server/api/handlers/index.js';
import sessionHandlers from '../server/api/handlers/session.js';
import ptyHandlers from '../server/api/handlers/pty.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-agent.js');
const TOOLS = { fake: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE] } };
const registry = { get: (id) => TOOLS[id] ?? null, list: () => Object.values(TOOLS) };
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arena-pty-')));
const TOKEN = '0123456789abcdef0123456789abcdef';

after(() => fs.rmSync(cwd, { recursive: true, force: true }));

const waitFor = async (pred, ms = 4000) => {
  const t0 = Date.now();
  for (;;) {
    const r = pred();
    if (r) return r;
    if (Date.now() - t0 > ms) throw new Error('Zeitüberschreitung');
    await new Promise((res) => setTimeout(res, 10));
  }
};

function busLog() {
  const bus = createBus();
  const seen = [];
  for (const type of ['pty.output', 'pty.exit', 'event', 'chat.message', 'agent.update']) bus.on(type, (p) => seen.push({ type, ...p }));
  return { bus, seen };
}

// ---------------------------------------------------------------- PTY-Manager

test('open echo hallo → data enthält hallo, exit 0, Bus-Ereignisse', async () => {
  const { bus, seen } = busLog();
  const pty = createPtyManager({ bus });
  const data = [];
  let exit = null;
  pty.on('data', (d) => data.push(d.data));
  pty.on('exit', (e) => { exit = e; });
  const { ptyId } = pty.open({ cwd, command: 'echo', args: ['hallo'], kind: 'agent', agentId: 'a1' });
  assert.match(ptyId, /^p:/);
  await waitFor(() => exit);
  assert.equal(exit.exitCode, 0);
  assert.match(data.join(''), /hallo/);
  await waitFor(() => seen.some((m) => m.type === 'pty.exit' && m.ptyId === ptyId));
  assert.match(seen.filter((m) => m.type === 'pty.output').map((m) => m.data).join(''), /hallo/);
  assert.equal(seen.find((m) => m.type === 'pty.exit').code, 0);
  assert.match(pty.buffer(ptyId), /hallo/);
  assert.equal(pty.output(ptyId).output, 'hallo\n', 'ACP-Ausgabe mit \\n statt \\r\\n');
  assert.deepEqual(await pty.waitExit(ptyId), { exitCode: 0, signal: null });
  await pty.closeAll();
});

test('Befehl mit Leerzeichen ohne args läuft über sh -c', async () => {
  const pty = createPtyManager();
  const { ptyId } = pty.open({ cwd, command: 'echo eins && echo zwei', kind: 'agent', agentId: 'a1' });
  const st = await pty.waitExit(ptyId);
  assert.equal(st.exitCode, 0);
  assert.match(pty.buffer(ptyId), /eins\r?\nzwei/);
  assert.equal(pty.get(ptyId).command, 'echo eins && echo zwei');
  await pty.closeAll();
});

test('Nutzer-Shell: Eingabe, Größe, schließen; eine je Agent', async () => {
  const pty = createPtyManager({ shell: '/bin/sh' });
  const { ptyId } = pty.open({ cwd, kind: 'user', agentId: 'a1', cols: 90, rows: 20 });
  assert.equal(pty.userShell('a1'), ptyId);
  pty.write(ptyId, 'echo $((40+2))\n');
  await waitFor(() => /42/.test(pty.buffer(ptyId)));
  pty.write(ptyId, 'pwd\n');
  await waitFor(() => pty.buffer(ptyId).includes(cwd));
  pty.resize(ptyId, 120, 40);
  assert.throws(() => pty.write('p:gibtsnicht', 'x'), /nicht gefunden/);
  pty.close(ptyId);
  assert.equal(pty.userShell('a1'), null);
  assert.equal(pty.get(ptyId), null);
  await pty.closeAll();
});

test('closeAll: SIGHUP, dann SIGKILL an Prozesse, die HUP ignorieren', async () => {
  const pty = createPtyManager();
  const { ptyId } = pty.open({ cwd, command: 'sh', args: ['-c', "trap '' HUP; echo bereit; sleep 30"], kind: 'agent', agentId: 'a1' });
  await waitFor(() => /bereit/.test(pty.buffer(ptyId)));
  let exit = null;
  pty.on('exit', (e) => { exit = e; });
  const t0 = Date.now();
  await pty.closeAll({ graceMs: 300 });
  assert.ok(Date.now() - t0 >= 280, 'wartet die Schonfrist ab');
  assert.equal(pty.size, 0);
  await waitFor(() => exit, 3000);
  assert.ok(exit.signal || exit.exitCode !== 0, 'hart beendet');
});

test('Shell startet nicht → Fehler, kein Eintrag bleibt', () => {
  const pty = createPtyManager({ spawn: () => { throw new Error('posix_spawnp failed.'); } });
  assert.throws(() => pty.open({ cwd, kind: 'user', agentId: 'a1' }), /konnte nicht starten.*posix_spawnp/);
  assert.equal(pty.size, 0);
  assert.equal(pty.userShell('a1'), null);
});

test('Ringpuffer begrenzt und schneidet an Zeichengrenzen', () => {
  const r = new ByteRing(1024);
  for (let i = 0; i < 300; i++) r.push('äöü-');
  const s = r.toString();
  assert.ok(Buffer.byteLength(s) <= 1024);
  assert.equal(r.truncated, true);
  assert.ok(!s.includes('\ufffd'), 'kein halbes Zeichen');
  assert.ok(s.endsWith('äöü-'));
});

test('closeAgent beendet alle Terminals eines Agenten', async () => {
  const pty = createPtyManager({ shell: '/bin/sh' });
  const a = pty.open({ cwd, kind: 'user', agentId: 'a1' }).ptyId;
  const b = pty.open({ cwd, command: 'sleep', args: ['30'], kind: 'agent', agentId: 'sub1', ownerId: 'a1' }).ptyId;
  const c = pty.open({ cwd, command: 'sleep', args: ['30'], kind: 'agent', agentId: 'a2' }).ptyId;
  const exits = [];
  pty.on('exit', (e) => exits.push(e.ptyId));
  pty.closeAgent('a1');
  assert.equal(pty.get(a), null);
  assert.equal(pty.get(b), null);
  assert.ok(pty.get(c));
  await waitFor(() => exits.includes(a) && exits.includes(b));
  await pty.closeAll();
});

// ---------------------------------------------------------------- ACP terminal/*

test('terminal-Handler: Ordner prüfen, Ausgabe begrenzen, release', async () => {
  const pty = createPtyManager();
  const created = [];
  const h = createTerminalHandlers({ pty, cwd, agentId: 'a1', onCreate: (t) => created.push(t) });
  assert.equal(h.supported, true);
  await assert.rejects(() => h.createTerminal({ sessionId: 's', command: 'ls', cwd: os.homedir() }), /außerhalb/);
  await assert.rejects(() => h.createTerminal({ sessionId: 's', command: '' }), /command/);
  const { terminalId } = await h.createTerminal({
    sessionId: 's', command: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(5000) + 'ENDE')"], outputByteLimit: 1024,
  });
  assert.equal(created[0].ptyId, terminalId);
  assert.deepEqual(await h.waitForTerminalExit({ sessionId: 's', terminalId }), { exitCode: 0, signal: null });
  const out = h.terminalOutput({ sessionId: 's', terminalId });
  assert.equal(out.truncated, true);
  assert.ok(Buffer.byteLength(out.output) <= 1024);
  assert.ok(out.output.endsWith('ENDE'));
  assert.equal(out.exitStatus.exitCode, 0);
  h.releaseTerminal({ sessionId: 's', terminalId });
  assert.throws(() => h.terminalOutput({ sessionId: 's', terminalId }), /terminal/);
  assert.ok(pty.get(terminalId), 'bleibt zur Anzeige erhalten');
  assert.equal(outputLimit(undefined), 64 * 1024);
  // höchstens maxLive laufende Terminals
  const h2 = createTerminalHandlers({ pty, cwd, agentId: 'a2', maxLive: 16 });
  for (let i = 0; i < 16; i++) await h2.createTerminal({ sessionId: 's', command: 'sleep', args: ['30'] });
  await assert.rejects(() => h2.createTerminal({ sessionId: 's', command: 'sleep', args: ['30'] }), /Zu viele/);
  h2.dispose();
  assert.equal(outputLimit(10), 1024);
  assert.equal(createTerminalHandlers().supported, false);
  await pty.closeAll();
});

test('ACP mit Fake-Agent: terminal/create, Ereignis terminal, Station, Aufräumen beim Schließen', async () => {
  const { bus, seen } = busLog();
  const state = createState({ bus });
  const pty = createPtyManager({ bus });
  const manager = createSessionManager({ state, bus, repo: null, registry, pty, sessionOptions: { textThrottleMs: 5 } });
  try {
    const id = await manager.createSession({ toolId: 'fake', cwd });
    await manager.prompt(id, 'terminal echo hallo terminal');
    const msg = seen.find((m) => m.type === 'chat.message' && m.message.role === 'agent' && /Ausgabe/.test(m.message.text));
    assert.match(msg.message.text, /Ausgabe: hallo terminal \| Code: 0/);
    const ev = seen.find((m) => m.type === 'event' && m.event.kind === 'terminal').event;
    assert.equal(ev.agentId, id);
    assert.equal(ev.command, 'echo hallo terminal');
    assert.equal(ev.category, 'terminal');
    assert.ok(seen.some((m) => m.type === 'agent.update' && m.agent.id === id && m.agent.category === 'terminal'), 'Figur geht zum Terminal');
    assert.ok(state.get(id).events.some((e) => e.kind === 'terminal' && e.ptyId === ev.ptyId), 'kompaktes Ereignis trägt ptyId');
    const list = pty.listFor(id);
    assert.equal(list.length, 1);
    assert.equal(list[0].released, true);
    assert.match(pty.buffer(ev.ptyId), /hallo terminal/);

    // killTerminal beendet den Befehl
    await manager.prompt(id, 'terminal-kill');
    const killed = seen.filter((m) => m.type === 'chat.message' && /Ausgabe/.test(m.message.text)).pop();
    assert.doesNotMatch(killed.message.text, /Code: 0 \| Signal: -/);

    // Anzeige-Terminal aus _meta.terminal_* (Claude-Adapter)
    await manager.prompt(id, 'anzeige');
    assert.ok(seen.some((m) => m.type === 'chat.message' && m.message.text === 'angezeigt'), 'Client meldet _meta.terminal_output');
    const disp = seen.filter((m) => m.type === 'event' && m.event.kind === 'terminal').pop().event;
    assert.equal(disp.display, true);
    assert.equal(disp.command, 'npm test');
    assert.match(pty.buffer(disp.ptyId), /pass 12\r\n/);
    assert.equal(pty.get(disp.ptyId).exitCode, 0);
    assert.equal(pty.listFor(id).length, 3);

    pty.open({ cwd, kind: 'user', agentId: id });
    await manager.close(id);
    assert.equal(pty.listFor(id).length, 0, 'Schließen räumt alle Terminals auf');
  } finally {
    await manager.stopAll();
    await pty.closeAll();
  }
});

// ---------------------------------------------------------------- WebSocket

let server; let port; let wsApi; let wsManager; let wsPty; let wsState;

before(async () => {
  const bus = createBus();
  wsState = createState({ bus });
  wsPty = createPtyManager({ bus, shell: '/bin/sh' });
  wsManager = createSessionManager({ state: wsState, bus, repo: null, registry, pty: wsPty });
  const config = { token: TOKEN, port: 0 };
  server = createHttpServer({ config });
  wsApi = attachWs({
    server, token: TOKEN,
    ctx: { state: wsState, bus, repo: null, registry, acp: wsManager, pty: wsPty, config },
    handlers: createHandlers(sessionHandlers, ptyHandlers),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(async () => {
  await wsManager.stopAll();
  await wsPty.closeAll();
  wsApi.close();
  await new Promise((r) => server.close(r));
});

function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const queue = [];
  const waiters = [];
  let seq = 0;
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    queue.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  ws.next = (pred, ms = 5000) => new Promise((resolve, reject) => {
    const hit = queue.find(pred);
    if (hit) { resolve(hit); return; }
    const t = setTimeout(() => reject(new Error('Zeitüberschreitung')), ms);
    waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
  ws.request = async (type, payload = {}) => {
    const id = `q${++seq}`;
    ws.send(JSON.stringify({ type, id, ...payload }));
    const res = await ws.next((m) => m.id === id);
    if (res.type === 'error') throw new Error(res.message);
    return res;
  };
  ws.queue = queue;
  ws.ready = new Promise((resolve) => ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', token: TOKEN })); resolve(); }))
    .then(() => ws.next((m) => m.type === 'snapshot'));
  return ws;
}

test('WS: pty.open/input/output, Wiederverwendung mit Puffer, Schreibschutz, pty.list', async () => {
  const ws = connect();
  await ws.ready;
  const { agentId } = await ws.request('session.create', { toolId: 'fake', cwd });
  await assert.rejects(() => ws.request('pty.open', { agentId: 'gibtsnicht' }), /nicht gefunden/);
  // externe (Watcher-)Agenten und Subagenten bekommen keine Shell
  wsState.upsert({ id: 'w:claude:x', kind: 'main', source: 'watch', cwd, project: 'p' });
  wsState.upsert({ id: 'a:sub', kind: 'sub', source: 'acp', parentId: agentId, cwd, project: 'p' });
  await assert.rejects(() => ws.request('pty.open', { agentId: 'w:claude:x' }), /nur für steuerbare/);
  await assert.rejects(() => ws.request('pty.open', { agentId: 'a:sub' }), /nur für steuerbare/);
  wsState.remove('w:claude:x');
  wsState.remove('a:sub');

  const { ptyId, buffer, reused } = await ws.request('pty.open', { agentId, cols: 80, rows: 24 });
  assert.match(ptyId, /^p:/);
  assert.equal(buffer, '');
  assert.equal(reused, false);
  await ws.request('pty.input', { ptyId, data: 'echo ws-$((6*7))\n' });
  await ws.next((m) => m.type === 'pty.output' && m.ptyId === ptyId && /ws-42/.test(m.data));
  await ws.request('pty.resize', { ptyId, cols: 100, rows: 30 });

  // zweiter Aufruf (z. B. nach Neuladen) → dieselbe Shell mit Puffer
  const again = await ws.request('pty.open', { agentId });
  assert.equal(again.ptyId, ptyId);
  assert.equal(again.reused, true);
  assert.match(again.buffer, /ws-42/);

  // Agenten-Terminal: in pty.list, aber schreibgeschützt
  await ws.request('session.prompt', { agentId, text: 'terminal echo vom agenten' });
  const ev = await ws.next((m) => m.type === 'event' && m.event.kind === 'terminal');
  await ws.next((m) => m.type === 'pty.exit' && m.ptyId === ev.event.ptyId);
  await assert.rejects(() => ws.request('pty.input', { ptyId: ev.event.ptyId, data: 'x' }), /schreibgeschützt/);
  const { terminals } = await ws.request('pty.list', { agentId });
  const agentTerm = terminals.find((t) => t.ptyId === ev.event.ptyId);
  assert.equal(agentTerm.kind, 'agent');
  assert.equal(agentTerm.exitCode, 0);
  assert.match(agentTerm.data, /vom agenten/);
  assert.ok(terminals.some((t) => t.ptyId === ptyId && t.kind === 'user'));

  await ws.request('pty.close', { ptyId });
  await ws.next((m) => m.type === 'pty.exit' && m.ptyId === ptyId);
  await ws.request('session.close', { agentId });
  assert.equal(wsPty.listFor(agentId).length, 0);
  ws.close();
});
