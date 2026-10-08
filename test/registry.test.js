import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistry, loadDefaults, validateAgent, isInstalled } from '../server/agents/registry.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-agent.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentcity-reg-'));

test('Standardliste: fünf Tools, <agentcity> wird ersetzt', () => {
  const defs = loadDefaults('/x/agentcity');
  assert.deepEqual(defs.map((d) => d.id), ['claude', 'codex', 'opencode', 'hermes', 'gemini']);
  assert.equal(defs[0].args[0], '/x/agentcity/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js');
  assert.equal(defs[1].avatarStyle, 'cap');
});

test('Nutzer-Einträge überschreiben Standard, neue kommen dazu, disabled blendet aus', () => {
  const dataDir = tmp();
  fs.writeFileSync(path.join(dataDir, 'agents.json'), JSON.stringify([
    { id: 'claude', name: 'Claude (eigen)', color: '#112233' },
    { id: 'gemini', disabled: true },
    { id: 'mein-tool', name: 'Mein Tool', command: 'node', args: [FAKE], color: '#abcdef' },
  ]));
  const reg = createRegistry({ dataDir, appDir: '/x/agentcity' });
  const ids = reg.list().map((t) => t.id);
  assert.deepEqual(ids, ['claude', 'codex', 'opencode', 'hermes', 'mein-tool']);
  const claude = reg.list().find((t) => t.id === 'claude');
  assert.equal(claude.name, 'Claude (eigen)');
  assert.equal(claude.color, '#112233');
  assert.equal(claude.command, 'node', 'list() zeigt den Befehl wie konfiguriert');
  assert.equal(claude.builtin, true);
  assert.equal(claude.modified, true);
  assert.equal(reg.get('claude').command, process.execPath, 'get() löst node zum laufenden Node auf');
  assert.equal(reg.get('gemini'), null);
  assert.ok(reg.list({ all: true }).find((t) => t.id === 'gemini').disabled);
  assert.equal(reg.get('mein-tool').args[0], FAKE);
  assert.equal(reg.list().find((t) => t.id === 'mein-tool').installed, true);
  // öffentlich: ohne Befehl, Argumente, Umgebung
  const pub = reg.publicList();
  assert.ok(pub.every((t) => t.command === undefined && t.args === undefined && t.env === undefined));
  assert.equal(pub.find((t) => t.id === 'mein-tool').installed, true);
});

test('save/delete schreiben die Nutzer-Datei; Standard wird beim Löschen deaktiviert', () => {
  const dataDir = tmp();
  const reg = createRegistry({ dataDir, appDir: '/x/agentcity' });
  reg.save({ id: 'neu', name: 'Neu', command: 'node', args: [FAKE], env: { FOO: 'bar' }, color: '#123456', avatarStyle: 'visor' });
  const file = path.join(dataDir, 'agents.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].id, 'neu');
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  assert.deepEqual(reg.get('neu').env, { FOO: 'bar' });

  reg.save({ ...reg.list().find((t) => t.id === 'codex'), name: 'Codex 2' });
  assert.equal(reg.get('codex').name, 'Codex 2');

  reg.delete('neu');
  assert.equal(reg.get('neu'), null);
  reg.delete('codex');
  assert.equal(reg.get('codex'), null);
  const codex = reg.list({ all: true }).find((t) => t.id === 'codex');
  assert.equal(codex.disabled, true);
  assert.equal(codex.name, 'Codex', 'Löschen setzt Änderungen am Standard zurück');
  assert.throws(() => reg.delete('gibtsnicht'), /Unbekanntes Tool/);

  // wieder aktivieren
  reg.save({ ...codex, disabled: false });
  assert.ok(reg.get('codex'));
  // neue Registry liest die Datei
  const again = createRegistry({ dataDir, appDir: '/x/agentcity' });
  assert.ok(again.get('codex'));
  assert.equal(again.get('neu'), null);
});

test('Validierung', () => {
  const ok = { id: 'x-1', name: 'X', command: 'node', args: [], color: '#aabbcc' };
  assert.doesNotThrow(() => validateAgent(ok));
  assert.throws(() => validateAgent({ ...ok, id: 'X Y' }), /id/);
  assert.throws(() => validateAgent({ ...ok, name: ' ' }), /Name/);
  assert.throws(() => validateAgent({ ...ok, command: '' }), /Befehl/);
  assert.throws(() => validateAgent({ ...ok, args: 'a b' }), /Argumente/);
  assert.throws(() => validateAgent({ ...ok, args: [1] }), /Argumente/);
  assert.throws(() => validateAgent({ ...ok, color: 'rot' }), /Farbe/);
  assert.throws(() => validateAgent({ ...ok, env: { 'A B': '1' } }), /Umgebung/);
  assert.throws(() => validateAgent({ ...ok, env: { A: 'x\ny' } }), /Zeilenumbruch/);
  assert.throws(() => validateAgent({ ...ok, avatarStyle: 'hut' }), /Figurenstil/);
  const reg = createRegistry({ dataDir: tmp(), appDir: '/x/agentcity' });
  assert.throws(() => reg.save({ ...ok, color: '#zzz' }), /Farbe/);
});

test('isInstalled: PATH-Suche, node mit Skriptpfad', () => {
  assert.equal(isInstalled({ command: 'node', args: [FAKE] }), true);
  assert.equal(isInstalled({ command: 'node', args: ['/gibt/es/nicht.js'] }), false);
  assert.equal(isInstalled({ command: 'sh', args: [] }), true);
  assert.equal(isInstalled({ command: 'nicht-da-xyz', args: [] }), false);
  assert.equal(isInstalled({ command: '/bin/sh', args: [] }), true);
});

test('test() mit Fake-Agent ok, mit fehlendem Befehl Fehler, mit hängendem Agent Zeitlimit', async () => {
  const reg = createRegistry({ dataDir: tmp(), appDir: '/x/agentcity', testTimeoutMs: 1500 });
  const ok = await reg.test({ id: 'fake', name: 'Fake', command: 'node', args: [FAKE], color: '#888888' });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.info.agentInfo.name, 'fake-agent');
  assert.equal(ok.info.agentCapabilities.loadSession, true);

  const bad = await reg.test({ id: 'nd', name: 'ND', command: 'nicht-da', args: [], color: '#888888' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /nicht gefunden/);

  const hang = await reg.test({ id: 'hang', name: 'H', command: 'node', args: [FAKE], env: { FAKE_HANG_INIT: '1' }, color: '#888888' });
  assert.equal(hang.ok, false);
  assert.match(hang.error, /keine Antwort/);
});

test('test(): hängender Prozess wird nach dem Zeitlimit beendet', async () => {
  let client;
  const { AcpClient } = await import('../server/acp/client.js');
  const reg = createRegistry({
    dataDir: tmp(), appDir: '/x/agentcity', testTimeoutMs: 800,
    clientFactory: (opts) => (client = new AcpClient(opts)),
  });
  const res = await reg.test({ id: 'hang', name: 'H', command: 'node', args: [FAKE], env: { FAKE_HANG_INIT: '1' }, color: '#888888' });
  assert.equal(res.ok, false);
  assert.ok(client.exited, 'Prozess ist beendet');
  assert.throws(() => process.kill(client.proc.pid, 0), /ESRCH/);
});

test('Standard-Tool umschalten speichert nur Abweichungen, ohne absolute Programmpfade', () => {
  const dataDir = tmp();
  const appDir = '/x/agentcity';
  const file = path.join(dataDir, 'agents.json');
  const reg = createRegistry({ dataDir, appDir });
  const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);
  reg.save({ id: 'claude', disabled: true });
  assert.deepEqual(read(), [{ id: 'claude', disabled: true }]);
  assert.equal(reg.get('claude'), null);
  reg.save({ id: 'claude', disabled: false });
  assert.deepEqual(read(), [], 'ohne Abweichung kein Eintrag');
  assert.equal(reg.list().find((t) => t.id === 'claude').modified, false);
  // vollständiger Eintrag aus dem Formular (aufgelöste Pfade) → nur echte Abweichung, Pfade als <agentcity>
  const codex = reg.list().find((t) => t.id === 'codex');
  reg.save({ ...codex, args: [...codex.args, '-c', 'model="gpt-5.5"'] });
  assert.deepEqual(read(), [{ id: 'codex', args: ['<agentcity>/node_modules/@zed-industries/codex-acp/bin/codex-acp.js', '-c', 'model="gpt-5.5"'] }]);
  const again = reg.list().find((t) => t.id === 'codex');
  assert.equal(again.modified, true);
  assert.equal(again.args[0], '/x/agentcity/node_modules/@zed-industries/codex-acp/bin/codex-acp.js');
  // Umschalten behält die Abweichung
  reg.save({ id: 'codex', disabled: true });
  assert.deepEqual(read()[0].disabled, true);
  assert.equal(read()[0].args.length, 3);
  // eigenes Tool mit Programmpfad
  reg.save({ id: 'eigen', name: 'Eigen', command: 'node', args: ['/x/agentcity/tool.js'], color: '#123456' }, { isNew: true });
  assert.equal(read().find((x) => x.id === 'eigen').args[0], '<agentcity>/tool.js');
  assert.throws(() => reg.save({ id: 'eigen', name: 'E', command: 'node', args: [], color: '#123456' }, { isNew: true }), /bereits vergeben/);
  assert.throws(() => reg.save({ id: 'codex', name: 'C', command: 'node', args: [], color: '#123456' }, { isNew: true }), /bereits vergeben/);
  assert.ok(!fs.readdirSync(dataDir).some((f) => f.endsWith('.tmp')), 'keine tmp-Datei übrig');
});

test('findCommand löst relative Pfade auf', async () => {
  const { findCommand } = await import('../server/agents/registry.js');
  const rel = path.relative(process.cwd(), '/bin/sh');
  assert.equal(findCommand(rel), '/bin/sh');
  assert.equal(findCommand('./gibt-es-nicht'), null);
});

test('Feste Liste (tools) ohne Nutzer-Datei bleibt möglich', () => {
  const reg = createRegistry({ tools: [{ id: 'fake', name: 'Fake', command: 'node', args: [FAKE], color: '#888888' }] });
  assert.deepEqual(reg.list().map((t) => t.id), ['fake']);
  assert.equal(reg.get('fake').command, process.execPath);
});
