// Paket 1.1: Artefakt-Erkennung (Diff, Text, Terminal, Port-Scan), Dedup/Update, Ausschlüsse, Limit, Persistenz
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db/migrate.js';
import { createRepo } from '../server/db/repo.js';
import { runRetention } from '../server/db/retention.js';
import { createBus, BROADCAST_TYPES } from '../server/core/bus.js';
import { createState } from '../server/core/state.js';
import { createAgent, createEvent, kindOfPath, createArtifact } from '../server/core/model.js';
import { createArtifacts, excludedPath, cleanUrl, artifactId, MAX_PER_SESSION } from '../server/core/artifacts.js';

function setup({ ports = () => [], acp = null, port = 4317 } = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcity-art-')));
  const bus = createBus();
  const state = createState({ bus });
  const repo = createRepo(openDb(':memory:'));
  const agent = createAgent({ id: 'a1', sessionId: 's1', toolId: 'claude', project: 'p', cwd: tmp, status: 'tool' });
  state.upsert(agent);
  const added = [];
  const updated = [];
  bus.on('artifact.add', ({ artifact }) => added.push(artifact));
  bus.on('artifact.update', ({ artifact }) => updated.push(artifact));
  const art = createArtifacts({ bus, state, repo, acp, config: { port }, listListeningPorts: ports, scanMs: 0 });
  const file = (rel, content = 'x') => {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };
  const diff = (p) => bus.emit('event', { event: createEvent('a1', 'diff', { sessionId: 's1', path: p, oldText: '', newText: 'y' }) });
  const turn = (text) => bus.emit('session.turnEnd', { agentId: 'a1', stopReason: 'end_turn', text, meetingId: null });
  const cleanup = () => { art.stop(); fs.rmSync(tmp, { recursive: true, force: true }); };
  return { tmp, bus, state, repo, art, added, updated, file, diff, turn, cleanup };
}

test('Modell: kindOfPath nach Endung, Bus kennt artifact.add/update', () => {
  assert.equal(kindOfPath('/a/b/index.html'), 'html');
  assert.equal(kindOfPath('README.MD'), 'text');
  assert.equal(kindOfPath('x.tsx'), 'text');
  assert.equal(kindOfPath('bild.PNG'), 'image');
  assert.equal(kindOfPath('doc.pdf'), 'pdf');
  assert.equal(kindOfPath('archiv.zip'), 'file');
  assert.equal(kindOfPath('Makefile'), 'file');
  assert.ok(BROADCAST_TYPES.includes('artifact.add') && BROADCAST_TYPES.includes('artifact.update'));
  const a = createArtifact({ sessionId: 's', kind: 'nope', source: 'x' });
  assert.equal(a.kind, 'file');
  assert.equal(a.source, 'text');
  assert.equal(a.seen, false);
});

test('Ausschlüsse und URL-Bereinigung', () => {
  assert.ok(excludedPath('node_modules/x.js'));
  assert.ok(excludedPath('/p/.git/HEAD'));
  assert.ok(excludedPath('dist/app.js'));
  assert.ok(excludedPath('build/out.html'));
  assert.ok(excludedPath('package-lock.json'));
  assert.ok(!excludedPath('src/builder.js'));
  assert.ok(!excludedPath('docs/dist-notes.md'));
  assert.equal(cleanUrl('http://localhost:3000/pfad).'), 'http://localhost:3000/pfad');
  assert.equal(cleanUrl('ftp://x'), null);
});

test('Diff → text-Artefakt mit previewUrl; zweiter Diff gleicher Pfad → update statt add', () => {
  const s = setup();
  try {
    const p = s.file('docs/out.md', '# Hallo');
    s.diff(p);
    assert.equal(s.added.length, 1);
    const a = s.added[0];
    assert.equal(a.kind, 'text');
    assert.equal(a.source, 'diff');
    assert.equal(a.title, 'out.md');
    assert.equal(a.path, p);
    assert.equal(a.previewUrl, '/preview/s1/docs/out.md');
    assert.equal(a.sessionId, 's1');
    assert.equal(a.agentId, 'a1');
    assert.equal(a.size, 7);
    assert.equal(a.id, artifactId('s1', p));
    // gleicher Pfad erneut: update, updatedAt steigt, seen zurückgesetzt
    s.art.markSeen('s1');
    assert.equal(s.art.forSession('s1')[0].seen, true);
    s.diff(p);
    assert.equal(s.added.length, 1);
    assert.equal(s.updated.length, 1);
    assert.equal(s.updated[0].id, a.id);
    assert.ok(s.updated[0].updatedAt >= a.updatedAt);
    assert.equal(s.updated[0].seen, false);
    assert.equal(s.art.forSession('s1').length, 1);
    // Datei-Art ohne Vorschau: kein previewUrl
    const z = s.file('out/archiv.zip');
    s.diff(z);
    assert.equal(s.added[1].kind, 'file');
    assert.equal(s.added[1].previewUrl, null);
    // HTML
    const h = s.file('site/index.html', '<h1>hi</h1>');
    s.diff(h);
    assert.equal(s.added[2].kind, 'html');
    assert.equal(s.added[2].previewUrl, '/preview/s1/site/index.html');
  } finally { s.cleanup(); }
});

test('Text: localhost-URL → web; Backtick-Pfad unter cwd → text; Ausschlüsse; fremde URL nur mit Ergebnis-Wort', () => {
  const s = setup();
  try {
    s.file('docs/out.md', 'a');
    s.file('node_modules/x.js', 'b');
    s.file('docs/notiz.txt', 'c');
    s.turn([
      'Der Server läuft unter http://localhost:3000 – bitte prüfen.',
      'Die Doku liegt in `docs/out.md`, dazu `node_modules/x.js`.',
      'Siehe https://docs.example.com/api für Details.',
      'Nicht vorhanden: `docs/fehlt.md`.',
      'docs/notiz.txt',
    ].join('\n'));
    const kinds = s.added.map((a) => [a.kind, a.title, a.source]);
    assert.deepEqual(kinds, [['web', 'localhost:3000', 'text'], ['text', 'out.md', 'text'], ['text', 'notiz.txt', 'text']]);
    assert.equal(s.added[0].url, 'http://localhost:3000/');
    assert.equal(s.added[0].previewUrl, null);
    // fremde URL mit Ergebnis-Wort in derselben Zeile zählt
    s.turn('Die Seite ist deployed: https://meine-app.vercel.app/ (fertig)');
    assert.equal(s.added.length, 4);
    assert.equal(s.added[3].url, 'https://meine-app.vercel.app/');
    assert.equal(s.added[3].title, 'meine-app.vercel.app');
    // Pfad außerhalb cwd (absolut) wird nicht aufgenommen
    s.turn(`Datei: /etc/hosts`);
    assert.equal(s.added.length, 4);
  } finally { s.cleanup(); }
});

test('URL von Agent City selbst (eigener Port) wird ignoriert; gleiche URL = dasselbe Artefakt', () => {
  const s = setup({ port: 4317 });
  try {
    s.turn('Öffne http://127.0.0.1:4317/?demo und http://localhost:5173/');
    assert.equal(s.added.length, 1);
    assert.equal(s.added[0].url, 'http://localhost:5173/');
    s.turn('Weiterhin erreichbar: http://localhost:5173');
    assert.equal(s.added.length, 1);
    assert.equal(s.updated.length, 1);
  } finally { s.cleanup(); }
});

test('Terminal: localhost-URL aus pty.output (Puffer über Chunk-Grenzen), nur Agenten-Terminals', () => {
  const s = setup();
  try {
    s.bus.emit('event', { event: createEvent('a1', 'terminal', { sessionId: 's1', ptyId: 'p:1', command: 'npm run dev', category: 'terminal' }) });
    s.bus.emit('pty.output', { ptyId: 'p:1', data: '\x1b[32m  ➜  Local:   http://local' });
    assert.equal(s.added.length, 0);
    s.bus.emit('pty.output', { ptyId: 'p:1', data: 'host:5173/\x1b[0m\r\n' });
    assert.equal(s.added.length, 1);
    assert.deepEqual([s.added[0].kind, s.added[0].source, s.added[0].url], ['web', 'terminal', 'http://localhost:5173/']);
    // fremde URL in der Terminalausgabe zählt nicht
    s.bus.emit('pty.output', { ptyId: 'p:1', data: 'deployed https://example.com/\n' });
    assert.equal(s.added.length, 1);
    // unbekanntes Terminal: nichts
    s.bus.emit('pty.output', { ptyId: 'p:unknown', data: 'http://localhost:9999/\n' });
    assert.equal(s.added.length, 1);
  } finally { s.cleanup(); }
});

test('Port-Scan mit gefälschter Funktion → web http://localhost:5173; verschwundener Port → ended', () => {
  let ports = [5173, 4317];
  const acp = { has: (id) => id === 'a1', processGroupPids: (id) => (id === 'a1' ? [111, 222] : []) };
  const calls = [];
  const s = setup({ acp, ports: (pids) => { calls.push(pids); return ports; } });
  try {
    assert.equal(s.art.scanPorts(), 1);
    assert.deepEqual(calls[0], [111, 222]);
    assert.equal(s.added.length, 1);
    assert.deepEqual([s.added[0].kind, s.added[0].source, s.added[0].url, s.added[0].title], ['web', 'port', 'http://localhost:5173/', 'localhost:5173']);
    assert.equal(s.art.scanPorts(), 0); // kein Doppel
    ports = [];
    s.art.scanPorts();
    assert.equal(s.updated.length, 1);
    assert.equal(s.updated[0].ended, true);
    assert.equal(s.updated[0].url, 'http://localhost:5173/');
    // Session, die nicht arbeitet, wird nicht gescannt
    s.state.upsert({ ...s.state.get('a1'), status: 'waiting_user' });
    ports = [8080];
    s.art.scanPorts();
    assert.equal(s.added.length, 1);
  } finally { s.cleanup(); }
});

test('Limit 50 je Session: älteste fallen heraus (auch aus der DB)', () => {
  const s = setup();
  try {
    for (let i = 0; i < MAX_PER_SESSION + 5; i++) s.diff(s.file(`f/${i}.txt`));
    const list = s.art.forSession('s1');
    assert.equal(list.length, MAX_PER_SESSION);
    assert.ok(!list.some((a) => a.title === '0.txt'));
    assert.ok(list.some((a) => a.title === `${MAX_PER_SESSION + 4}.txt`));
    assert.equal(s.repo.artifacts.forSession('s1', 100).length, MAX_PER_SESSION);
  } finally { s.cleanup(); }
});

test('Persistenz: repo.artifacts.forSession/markSeen, Snapshot (10 je laufender Session), Aufräumen nach 180 Tagen', () => {
  const s = setup();
  try {
    for (let i = 0; i < 12; i++) s.diff(s.file(`d/${i}.md`));
    const rows = s.repo.artifacts.forSession('s1', 100);
    assert.equal(rows.length, 12);
    assert.equal(rows[0].title, '11.md'); // neueste zuerst
    assert.equal(rows[0].seen, false);
    assert.equal(rows[0].previewUrl, '/preview/s1/d/11.md');
    assert.equal(s.art.markSeen('s1'), 12);
    assert.ok(s.repo.artifacts.forSession('s1').every((a) => a.seen));
    assert.equal(s.art.snapshot().length, 10);
    assert.equal(s.art.get(rows[0].id).id, rows[0].id);
    // neues Modul auf derselben DB lädt die Artefakte der Session
    const art2 = createArtifacts({ bus: createBus(), state: s.state, repo: s.repo, scanMs: 0 });
    assert.equal(art2.forSession('s1').length, 12);
    art2.stop();
    // Aufräumen: Artefakte beendeter Sessions nach 180 Tagen
    s.repo.createSession({ id: 's1', toolId: 'claude', startedAt: 1 });
    s.repo.endSession('s1', 'done', 2);
    const out = runRetention(s.repo.db, { days: 90, now: 1000 });
    assert.equal(out.artifacts, 0);
    const out2 = runRetention(s.repo.db, { days: 90, now: 181 * 24 * 3600_000 + 10 });
    assert.equal(out2.artifacts, 12);
  } finally { s.cleanup(); }
});
