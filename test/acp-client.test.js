import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpClient } from '../server/acp/client.js';
import { resolveInside } from '../server/acp/fs.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-agent.js');
const tool = { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE] };
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arena-acp-')));
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arena-out-')));
fs.writeFileSync(path.join(tmp, 'a.txt'), 'eins\nzwei\ndrei\n');
fs.writeFileSync(path.join(outside, 'geheim.txt'), 'geheim');
fs.symlinkSync(path.join(outside, 'geheim.txt'), path.join(tmp, 'link.txt'));

const clients = [];
function startClient() {
  const c = new AcpClient({ tool, cwd: tmp });
  clients.push(c);
  c.start();
  return c;
}
after(() => {
  for (const c of clients) c.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const collect = (c) => {
  const updates = [];
  c.on('update', (u) => updates.push(u));
  return updates;
};
const textOf = (updates) => updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => u.content.text).join('');

test('initialize, newSession, prompt mit Berechtigung', async () => {
  const c = startClient();
  const init = await c.initialize();
  assert.equal(init.protocolVersion, 1);
  assert.equal(init.agentCapabilities.loadSession, true);
  const s = await c.newSession();
  assert.equal(s.sessionId, 'fake-1');
  assert.equal(c.sessionId, 'fake-1');
  assert.equal(s.modes.currentModeId, 'confirm');

  const updates = collect(c);
  let perm = null;
  c.on('permission', (req, resolve) => {
    perm = req;
    assert.equal(updates.some((u) => u.sessionUpdate === 'plan'), false);
    resolve({ outcome: 'selected', optionId: 'allow' });
  });
  const res = await c.prompt('hi');
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(perm.toolCall.toolCallId, 't1');
  assert.deepEqual(perm.options.map((o) => o.kind), ['allow_once', 'allow_always', 'reject_once']);
  const done = updates.find((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'completed');
  assert.ok(done);
  assert.equal(updates.find((u) => u.sessionUpdate === 'plan').entries.length, 2);
  assert.equal(textOf(updates), 'Hallo fertig.');

  await c.setMode('auto');
  assert.ok(updates.some((u) => u.sessionUpdate === 'current_mode_update' && u.currentModeId === 'auto'));
});

test('cancel beendet einen laufenden Prompt mit cancelled', async () => {
  const c = startClient();
  await c.initialize();
  await c.newSession();
  const p = c.prompt('langsam');
  await new Promise((r) => setTimeout(r, 50));
  await c.cancel();
  assert.equal((await p).stopReason, 'cancelled');
});

test('Berechtigung ohne Zuhörer wird abgebrochen', async () => {
  const c = startClient();
  await c.initialize();
  await c.newSession();
  assert.equal((await c.prompt('hi')).stopReason, 'cancelled');
});

test('loadSession setzt sessionId', async () => {
  const c = startClient();
  await c.initialize();
  const updates = collect(c);
  await c.loadSession('alt-42');
  assert.equal(c.sessionId, 'alt-42');
  assert.equal(textOf(updates), 'alte Antwort');
});

test('fs: lesen nur unter cwd, Symlink nach außen verboten', async () => {
  const c = startClient();
  await c.initialize();
  await c.newSession();
  const ask = async (text) => {
    const updates = collect(c);
    await c.prompt(text);
    c.removeAllListeners('update');
    return textOf(updates);
  };
  assert.equal(await ask(`lies ${path.join(tmp, 'a.txt')}`), 'Hallo Inhalt: eins\nzwei\ndrei\n');
  assert.match(await ask(`lies ${path.join(outside, 'geheim.txt')}`), /Fehler/);
  assert.match(await ask(`lies ${path.join(tmp, 'link.txt')}`), /Fehler/);
  assert.match(await ask(`lies ${tmp}/../${path.basename(outside)}/geheim.txt`), /Fehler/);
  assert.equal(await ask(`schreib ${path.join(tmp, 'neu', 'b.txt')}`), 'Hallo geschrieben');
  assert.equal(fs.readFileSync(path.join(tmp, 'neu', 'b.txt'), 'utf8'), 'von fake');
  assert.match(await ask(`schreib ${path.join(outside, 'x.txt')}`), /Fehler/);
  assert.match(await ask(`schreib ${path.join(tmp, 'link.txt')}`), /Fehler/);
  assert.equal(fs.existsSync(path.join(outside, 'x.txt')), false);
  assert.equal(fs.readFileSync(path.join(outside, 'geheim.txt'), 'utf8'), 'geheim');
});

test('resolveInside: Zeilen-Grenzen und relative Pfade', async () => {
  await assert.rejects(() => resolveInside(tmp, 'a.txt'), /absolut/);
  assert.equal(await resolveInside(tmp, path.join(tmp, 'a.txt')), path.join(tmp, 'a.txt'));
  await assert.rejects(() => resolveInside(tmp, tmp + '-x/a.txt'), /außerhalb/);
});

test('Prozess-Ende → exit mit stderrTail, offener Prompt scheitert', async () => {
  const c = startClient();
  await c.initialize();
  await c.newSession();
  const exited = new Promise((r) => c.once('exit', r));
  await assert.rejects(() => c.prompt('absturz'));
  const ex = await exited;
  assert.equal(ex.code, 3);
  assert.match(ex.stderrTail, /Absturz wie bestellt/);
});

test('Unbekannter Befehl → exit mit Fehler', async () => {
  const c = new AcpClient({ tool: { id: 'x', command: 'gibt-es-nicht-arena', args: [] }, cwd: tmp });
  clients.push(c);
  const exited = new Promise((r) => c.once('exit', r));
  c.start();
  await assert.rejects(() => c.initialize());
  const ex = await exited;
  assert.match(ex.error ?? '', /ENOENT|nicht gefunden/);
});

test('rpcErrorMessage holt die Ursache aus data.message', async () => {
  const { rpcErrorMessage } = await import('../server/acp/client.js');
  assert.equal(rpcErrorMessage({ message: 'Internal error', data: { message: '{"type":"error","error":{"message":"Modell nicht unterstützt"}}' } }),
    'Internal error: Modell nicht unterstützt');
  assert.equal(rpcErrorMessage({ message: 'Internal error', data: { details: 'kaputt' } }), 'Internal error: kaputt');
  assert.equal(rpcErrorMessage(new Error('einfach')), 'einfach');
});
