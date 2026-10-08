#!/usr/bin/env node
// Agent Arena v2 – Start: Konfig → DB → Repo → Registry → Zustand/Bus → Recorder → Watcher → HTTP + WS
import { loadConfig, acquireLock } from './config.js';
import { openDb } from './db/migrate.js';
import { createRepo } from './db/repo.js';
import { createRecorder } from './db/recorder.js';
import { createBus } from './core/bus.js';
import { createState } from './core/state.js';
import { startWatchers } from './watchers/index.js';
import { createHttpServer } from './api/http.js';
import { attachWs } from './api/ws.js';
import { createHandlers } from './api/handlers/index.js';
import sessionHandlers from './api/handlers/session.js';
import permissionHandlers from './api/handlers/permission.js';
import fsHandlers from './api/handlers/fs.js';
import settingsHandlers from './api/handlers/settings.js';
import chatHandlers from './api/handlers/chat.js';
import ptyHandlers from './api/handlers/pty.js';
import meetingHandlers from './api/handlers/meeting.js';
import taskHandlers from './api/handlers/task.js';
import historyHandlers from './api/handlers/history.js';
import { createMeetings } from './core/meetings.js';
import { createTasks } from './core/tasks.js';
import { createPtyManager } from './pty/manager.js';
import { createRegistry } from './agents/registry.js';
import { createSessionManager } from './acp/manager.js';
import { spawn } from 'node:child_process';
import { loginUrl } from './api/http.js';

const config = loadConfig();
// pro Datenordner nur ein Server (sonst schrieben zwei Prozesse in dieselbe DB und beendeten fremde Sessions)
const lock = acquireLock(config.dataDir);
if (!lock.ok) {
  console.error(`\n  Agent Arena läuft bereits mit diesem Datenordner (${config.dataDir}, PID ${lock.pid}).`);
  console.error(`  Anderer Datenordner:  ARENA_DATA_DIR=/pfad npm start\n`);
  process.exit(1);
}
const db = openDb(config.dbPath);
const repo = createRepo(db);
// Tool-Registry: Standardliste + ~/.agent-arena/agents.json
const registry = createRegistry({ dataDir: config.dataDir, arenaDir: config.arenaDir });
const bus = createBus();
const state = createState({ bus });
// Terminals: Nutzer-Shells und Agenten-Terminals (node-pty)
const pty = createPtyManager({ bus });
const acp = createSessionManager({ state, bus, repo, registry, pty });
const recorder = createRecorder({ bus, repo, state });
// Besprechungen und Aufgaben (offene aus der DB laden, im Snapshot enthalten)
const meetings = createMeetings({ state, bus, repo, acp, registry });
const tasks = createTasks({ state, bus, repo, acp });
meetings.load();
tasks.load();
const watchers = startWatchers({ state, bus, repo, config, autoStart: false });

const server = createHttpServer({ config });
const ws = attachWs({
  server,
  token: config.token,
  ctx: { state, bus, repo, registry, acp, pty, config, meetings, tasks },
  handlers: createHandlers(sessionHandlers, permissionHandlers, fsHandlers, settingsHandlers, chatHandlers, ptyHandlers,
    meetingHandlers, taskHandlers, historyHandlers),
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${config.port} ist schon belegt – läuft Agent Arena bereits? Dann den Link aus dessen Terminal öffnen.`);
    console.error(`  Beenden:  kill $(lsof -ti tcp:${config.port})   ·   Anderer Port:  PORT=4318 npm start\n`);
    lock.release();
    process.exit(1);
  }
  throw err;
});

await watchers.tick();
watchers.start();

server.listen(config.port, config.host, () => {
  // erst jetzt (Port gehört uns): nach Absturz offen gebliebene Sessions beenden – außer den vom Watcher gemeldeten
  try { repo.endDangling(state.all().map((a) => a.sessionId)); } catch (err) { console.error('[db] endDangling', err.message); }
  const n = state.all().length;
  const url = loginUrl(config.host, server.address().port, config.token);
  console.log(`\n  Agent Arena läuft – im Browser öffnen:  ${url}`);
  console.log(`  Quelle: ${config.claudeProjectsDir}  ·  ${n} Agent(en) im Zeitfenster von ${config.windowMin} min`);
  console.log(`  Daten:  ${config.dataDir}\n`);
  if (process.env.ARENA_OPEN === '1' && process.platform === 'darwin') {
    try { spawn('open', [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* egal */ }
  }
});

// Sauber beenden: Agenten-Prozesse und Watcher stoppen, Puffer schreiben, Verbindungen und DB schließen
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n  ${signal} – Agent Arena wird beendet …`);
  watchers.stop();
  await Promise.race([acp.stopAll(), new Promise((r) => setTimeout(r, 2500))]);
  await pty.closeAll({ graceMs: 1000 });
  recorder.stop();
  ws.close();
  server.close();
  try { db.close(); } catch { /* bereits geschlossen */ }
  lock.release();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
