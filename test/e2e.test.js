// Ende-zu-Ende: echter Server (server/index.js) als Kindprozess auf Port 0 mit eigenem Datenordner und Fake-Tools.
// Zyklus: Login-Link → Session → Prompt → Rückfrage → zweite Session → Besprechung → Aufgabe → Schließen →
// Fortsetzen → Shutdown. Danach: keine Restprozesse, alle Sessions beendet, Sperrdatei weg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'test', 'fake-agent.js');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
const childPids = (pid) => {
  try { return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number); } catch { return []; }
};
const get = (port, p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject);
});

test('E2E: Server-Zyklus mit Fake-Tools bis zum Shutdown', { timeout: 60_000 }, async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcity-e2e-')));
  const data = path.join(tmp, 'data');
  const proj = path.join(tmp, 'proj');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(data, 'agents.json'), JSON.stringify([
    { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE], color: '#888888' },
    { id: 'fake2', name: 'Fake Zwei', command: process.execPath, args: [FAKE], color: '#999999' },
  ]));
  const nope = path.join(tmp, 'nope');
  const env = {
    ...process.env, AGENTCITY_DATA_DIR: data, PORT: '0', AGENTCITY_OPEN: '',
    CLAUDE_PROJECTS_DIR: path.join(nope, 'claude'), CODEX_SESSIONS_DIR: path.join(nope, 'codex'),
    OPENCODE_DB: path.join(nope, 'oc.db'), HERMES_DB: path.join(nope, 'h.db'),
  };
  const srv = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => srv.on('exit', (code) => r(code)));
  let ws = null;
  try {
    // Start: Login-Link aus der Ausgabe
    const link = await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]{32})/);
        if (m) { clearInterval(iv); resolve({ port: Number(m[1]), token: m[2] }); }
        else if (Date.now() - t0 > 10_000) { clearInterval(iv); reject(new Error(`kein Start: ${out}`)); }
      }, 50);
    });
    assert.ok(fs.existsSync(path.join(data, 'server.lock')));
    assert.equal(link.token, fs.readFileSync(path.join(data, 'token'), 'utf8').trim());
    assert.equal((await get(link.port, '/')).statusCode, 401);
    const login = await get(link.port, `/?t=${link.token}`);
    assert.equal(login.statusCode, 302);
    const cookie = login.headers['set-cookie'][0].split(';')[0];

    ws = new WebSocket(`ws://127.0.0.1:${link.port}/ws`, { headers: { Origin: `http://127.0.0.1:${link.port}`, Cookie: cookie } });
    const q = [];
    const waiters = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      q.push(m);
      for (const w of [...waiters]) if (w.p(m)) { waiters.splice(waiters.indexOf(w), 1); w.r(m); }
    });
    const next = (p, ms = 10_000) => new Promise((resolve, reject) => {
      const hit = q.find(p);
      if (hit) { resolve(hit); return; }
      const t = setTimeout(() => reject(new Error('Zeitüberschreitung')), ms);
      waiters.push({ p, r: (m) => { clearTimeout(t); resolve(m); } });
    });
    let seq = 0;
    const req = async (type, payload = {}) => {
      const id = `e${++seq}`;
      ws.send(JSON.stringify({ type, id, ...payload }));
      const r = await next((m) => m.id === id);
      if (r.type === 'error') throw new Error(`${type}: ${r.message}`);
      return r;
    };
    const snap = await next((m) => m.type === 'snapshot');
    assert.deepEqual(snap.tools.filter((t) => t.id.startsWith('fake')).map((t) => t.id), ['fake', 'fake2']);

    // Session 1 (Bestätigen): Prompt → Rückfrage → Antwort
    const { agentId: a1 } = await req('session.create', { toolId: 'fake', cwd: proj, title: 'E2E-1' });
    await next((m) => m.type === 'agent.update' && m.agent.id === a1 && m.agent.status === 'waiting_user');
    await req('session.prompt', { agentId: a1, text: 'hi' });
    const pr = await next((m) => m.type === 'permission.request' && m.permission.agentId === a1);
    await req('permission.answer', { permissionId: pr.permission.id, optionId: 'allow' });
    await next((m) => m.type === 'chat.message' && m.agentId === a1 && m.message.text === 'fertig.');
    await next((m) => m.type === 'agent.update' && m.agent.id === a1 && m.agent.status === 'waiting_user' && m.agent.plan?.length === 2);

    // Session 2 (Auto) und Besprechung mit beiden
    const { agentId: a2 } = await req('session.create', { toolId: 'fake2', cwd: proj, title: 'E2E-2', mode: 'auto' });
    await next((m) => m.type === 'agent.update' && m.agent.id === a2 && m.agent.status === 'waiting_user');
    const { meeting } = await req('meeting.create', { title: 'Runde', participantIds: [a1, a2] });
    const sent = await req('meeting.message', { meetingId: meeting.id, text: 'Was ist der Plan?' });
    assert.equal(sent.sent.length, 2);
    const pr2 = await next((m) => m.type === 'permission.request' && m.permission.agentId === a1 && m.permission.id !== pr.permission.id);
    await req('permission.answer', { permissionId: pr2.permission.id, optionId: 'allow' });
    const agentReplies = () => q.filter((m) => m.type === 'meeting.message' && m.meetingId === meeting.id && m.message.role === 'agent');
    for (const t0 = Date.now(); agentReplies().length < 2 && Date.now() - t0 < 10_000;) await new Promise((r) => setTimeout(r, 50));
    assert.equal(agentReplies().length, 2);

    // Aufgabe an Session 2: Status folgt dem Agenten
    const { task } = await req('task.create', { title: 'Tests schreiben', description: 'bitte', assigneeId: a2 });
    await next((m) => m.type === 'task.update' && m.task.id === task.id && m.task.status === 'waiting');

    // Schließen, Archiv, Fortsetzen
    const s1 = q.findLast((m) => m.type === 'agent.update' && m.agent.id === a1).agent.sessionId;
    await req('session.close', { agentId: a1 });
    await req('session.close', { agentId: a2 });
    await next((m) => m.type === 'agent.remove' && m.agentId === a2);
    const hs = await req('history.sessions', { ended: true });
    const row = hs.sessions.find((s) => s.id === s1);
    assert.equal(row.status, 'done');
    assert.equal(row.resumable, true);
    const resumed = await req('history.resume', { sessionId: s1 });
    await next((m) => m.type === 'chat.chunk' && m.agentId === resumed.agentId && m.text === 'alte Antwort');
    // Ereignisse landen gebündelt (alle 500 ms) in der DB
    let kinds = [];
    for (const t0 = Date.now(); !kinds.includes('prompt') && Date.now() - t0 < 5000;) {
      kinds = (await req('history.events', { sessionId: s1, limit: 500 })).events.map((e) => e.kind);
      if (!kinds.includes('prompt')) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(kinds.includes('prompt') && kinds.includes('permission'), kinds.join(','));
    await req('task.update', { taskId: task.id, status: 'done' });

    // Shutdown mit laufender (fortgesetzter) Session
    const kids = childPids(srv.pid);
    assert.ok(kids.length >= 1, 'Agenten-Prozess läuft');
    ws.close();
    srv.kill('SIGTERM');
    assert.equal(await exited, 0);
    for (const t0 = Date.now(); kids.some(alive) && Date.now() - t0 < 5000;) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(kids.filter(alive), [], 'keine Restprozesse');
    assert.equal(fs.existsSync(path.join(data, 'server.lock')), false, 'Sperrdatei weg');
    const db = new DatabaseSync(path.join(data, 'agentcity.db'), { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL').get().n, 0, 'alle Sessions beendet');
      assert.ok(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n >= 3);
    } finally { db.close(); }
  } catch (err) {
    err.message += `\n--- Server-Ausgabe ---\n${out}`;
    throw err;
  } finally {
    ws?.terminate();
    if (srv.exitCode === null) { srv.kill('SIGKILL'); await exited; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
