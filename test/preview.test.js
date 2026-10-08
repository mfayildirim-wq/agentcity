// Paket 1.2: Vorschau-Route (/preview/<sessionId>/<relpfad>) und Artefakt-Handler (list/seen/open), Snapshot
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import WebSocket from 'ws';
import { createHttpServer } from '../server/api/http.js';
import { attachWs, readOnlyAllowed } from '../server/api/ws.js';
import { createHandlers } from '../server/api/handlers/index.js';
import artifactHandlers, { openArtifact } from '../server/api/handlers/artifact.js';
import { createPreviewHandler, PREVIEW_PREFIX, parsePreviewPath, contentTypeOf, MAX_TEXT_BYTES } from '../server/api/preview.js';
import { createBus } from '../server/core/bus.js';
import { createState } from '../server/core/state.js';
import { createAgent, createEvent } from '../server/core/model.js';
import { openDb } from '../server/db/migrate.js';
import { createRepo } from '../server/db/repo.js';
import { createArtifacts } from '../server/core/artifacts.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
const COOKIE = `agentcity_token=${TOKEN}`;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcity-prev-')));
const proj = path.join(tmp, 'proj');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
fs.mkdirSync(outside);
fs.writeFileSync(path.join(proj, 'docs', 'demo.html'), '<!doctype html><h1>Hallo</h1>');
fs.writeFileSync(path.join(proj, 'docs', 'demo.md'), '# Titel\n\nText');
fs.writeFileSync(path.join(proj, 'docs', 'groß.txt'), Buffer.alloc(MAX_TEXT_BYTES + 1, 97));
fs.writeFileSync(path.join(proj, 'archiv.zip'), 'zip');
fs.writeFileSync(path.join(outside, 'geheim.txt'), 'geheim');
fs.symlinkSync(path.join(outside, 'geheim.txt'), path.join(proj, 'link.txt'));

let server; let port; let wsApi; let state; let bus; let repo; let artifacts;

before(async () => {
  bus = createBus();
  state = createState({ bus });
  repo = createRepo(openDb(':memory:'));
  state.upsert(createAgent({ id: 'a1', sessionId: 's1', toolId: 'claude', project: 'proj', cwd: proj, status: 'tool' }));
  // beendete Session nur in der DB (cwd aus der Projekt-Tabelle)
  const pid = repo.upsertProject({ cwd: proj, name: 'proj' });
  repo.createSession({ id: 's-alt', toolId: 'claude', projectId: pid, startedAt: 1 });
  repo.endSession('s-alt', 'done', 2);
  artifacts = createArtifacts({ bus, state, repo, config: { port: 0 }, scanMs: 0 });
  const config = { token: TOKEN, port: 0 };
  server = createHttpServer({ config, routes: { [PREVIEW_PREFIX]: createPreviewHandler({ state, repo }) } });
  wsApi = attachWs({ server, token: TOKEN, ctx: { state, bus, repo, config, artifacts }, handlers: createHandlers(artifactHandlers) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(async () => {
  artifacts.stop();
  wsApi.close();
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const get = (p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
  }).on('error', reject);
});
const auth = (p) => get(p, { Cookie: COOKIE });

function open(origin = true) {
  const headers = { Cookie: COOKIE, ...(origin ? { Origin: `http://127.0.0.1:${port}` } : {}) };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  const q = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    q.push(m);
    for (const w of [...waiters]) if (w.p(m)) { waiters.splice(waiters.indexOf(w), 1); w.r(m); }
  });
  const next = (p, ms = 3000) => new Promise((resolve, reject) => {
    const hit = q.find(p);
    if (hit) { resolve(hit); return; }
    const t = setTimeout(() => reject(new Error('Zeitüberschreitung')), ms);
    waiters.push({ p, r: (m) => { clearTimeout(t); resolve(m); } });
  });
  let seq = 0;
  const req = async (type, payload = {}) => {
    const id = `t${++seq}`;
    ws.send(JSON.stringify({ type, id, ...payload }));
    return next((m) => m.id === id);
  };
  return { ws, next, req, q };
}

test('parsePreviewPath und contentTypeOf', () => {
  assert.deepEqual(parsePreviewPath('/preview/s1/docs/a%20b.md'), { sessionId: 's1', rel: 'docs/a b.md' });
  assert.equal(parsePreviewPath('/preview/s1'), null);
  assert.equal(parsePreviewPath('/preview/s1/'), null);
  assert.equal(parsePreviewPath('/preview/s1/%E0%A4%A'), null);
  assert.equal(contentTypeOf('x.md'), 'text/markdown; charset=utf-8');
  assert.equal(contentTypeOf('x.ts'), 'text/plain; charset=utf-8');
  assert.equal(contentTypeOf('x.png'), 'image/png');
  assert.equal(contentTypeOf('x.bin'), 'application/octet-stream');
});

test('Vorschau: 401 ohne Cookie; HTML mit CSP-Sandbox; Markdown als Text; Cache-Control no-store', async () => {
  assert.equal((await get('/preview/s1/docs/demo.html')).status, 401);
  const html = await auth('/preview/s1/docs/demo.html');
  assert.equal(html.status, 200);
  assert.equal(html.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(html.headers['content-security-policy'], 'sandbox allow-scripts allow-forms');
  assert.equal(html.headers['cache-control'], 'no-store');
  assert.equal(html.headers['x-frame-options'], undefined);
  assert.ok(html.body.includes('<h1>Hallo</h1>'));
  const md = await auth('/preview/s1/docs/demo.md');
  assert.equal(md.status, 200);
  assert.equal(md.headers['content-type'], 'text/markdown; charset=utf-8');
  assert.equal(md.headers['content-security-policy'], undefined);
  assert.equal(md.body, '# Titel\n\nText');
  // beendete Session: cwd aus der DB
  assert.equal((await auth('/preview/s-alt/docs/demo.md')).status, 200);
  assert.equal((await auth('/preview/unbekannt/docs/demo.md')).status, 404);
});

test('Vorschau: 404 außerhalb cwd (..%2f, Symlink), 404 ohne Vorschau-Art, 413 bei großer Datei', async () => {
  assert.equal((await auth('/preview/s1/..%2foutside%2fgeheim.txt')).status, 404);
  assert.equal((await auth('/preview/s1/../outside/geheim.txt')).status, 404);
  assert.equal((await auth('/preview/s1/docs/../../outside/geheim.txt')).status, 404);
  assert.equal((await auth('/preview/s1/link.txt')).status, 404);
  assert.equal((await auth('/preview/s1/archiv.zip')).status, 404);
  assert.equal((await auth('/preview/s1/docs/fehlt.md')).status, 404);
  assert.equal((await auth('/preview/s1/docs')).status, 404);
  assert.equal((await auth('/preview/s1/docs/gro%C3%9F.txt')).status, 413);
});

test('Handler: artifact.list/seen, Snapshot enthält artifacts, Broadcast artifact.add', async () => {
  const c = open();
  try {
    const snap0 = await c.next((m) => m.type === 'snapshot');
    assert.deepEqual(snap0.artifacts, []);
    bus.emit('event', { event: createEvent('a1', 'diff', { sessionId: 's1', path: path.join(proj, 'docs', 'demo.md'), newText: 'x' }) });
    const add = await c.next((m) => m.type === 'artifact.add');
    assert.equal(add.artifact.title, 'demo.md');
    assert.equal(add.artifact.previewUrl, '/preview/s1/docs/demo.md');
    const list = await c.req('artifact.list', { sessionId: 's1' });
    assert.equal(list.artifacts.length, 1);
    assert.equal(list.artifacts[0].seen, false);
    assert.deepEqual(await c.req('artifact.seen', { sessionId: 's1' }).then((r) => r.ok), true);
    assert.equal((await c.req('artifact.list', { sessionId: 's1' })).artifacts[0].seen, true);
    // frischer Snapshot per hello enthält die Artefakte
    c.ws.send(JSON.stringify({ type: 'hello' }));
    const snap = await c.next((m) => m.type === 'snapshot' && m.artifacts?.length);
    assert.equal(snap.artifacts[0].id, add.artifact.id);
    const err = await c.req('artifact.list', {});
    assert.equal(err.type, 'error');
  } finally { c.ws.terminate(); }
});

test('artifact.open: ohne Origin abgelehnt; mit Origin per `open` (gefälscht); nur macOS', async () => {
  assert.equal(readOnlyAllowed('artifact.open'), false);
  assert.equal(readOnlyAllowed('artifact.seen'), false);
  assert.equal(readOnlyAllowed('artifact.list'), true);
  const a = artifacts.forSession('s1')[0];
  const ro = open(false);
  try {
    await ro.next((m) => m.type === 'snapshot');
    const r = await ro.req('artifact.open', { artifactId: a.id });
    assert.equal(r.type, 'error');
    assert.match(r.message, /nur lesend/);
    assert.equal((await ro.req('artifact.list', { sessionId: 's1' })).artifacts.length, 1);
  } finally { ro.ws.terminate(); }
  const calls = [];
  const spawnFn = (cmd, args) => { calls.push([cmd, args]); return { unref() {}, on() {} }; };
  assert.deepEqual(openArtifact({ path: '/p/x.md' }, { platform: 'darwin', spawnFn }).args, ['-R', '/p/x.md']);
  assert.deepEqual(openArtifact({ url: 'http://localhost:3000/' }, { platform: 'darwin', spawnFn }).args, ['http://localhost:3000/']);
  assert.throws(() => openArtifact({ url: 'javascript:alert(1)' }, { platform: 'darwin', spawnFn }), /weder Pfad noch URL/);
  assert.throws(() => openArtifact({ path: '/p' }, { platform: 'linux', spawnFn }), /nur auf macOS/);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([cmd]) => cmd === 'open'));
  // über den Handler mit gefälschtem spawn
  const c = open();
  try {
    await c.next((m) => m.type === 'snapshot');
    const ctx = { ...wsApi, artifacts };
    const r = artifactHandlers['artifact.open']({ artifacts, openOptions: { platform: 'darwin', spawnFn } }, { artifactId: a.id });
    assert.equal(r.ok, true);
    assert.deepEqual(calls[2][1], ['-R', a.path]);
    assert.throws(() => artifactHandlers['artifact.open'](ctx, { artifactId: 'nope' }), /nicht gefunden/);
  } finally { c.ws.terminate(); }
});
