#!/usr/bin/env node
// Agent Arena v2 – Start: Konfig → DB → Repo → Registry → Zustand/Bus → Recorder → Watcher → HTTP + WS
import { loadConfig } from './config.js';
import { openDb } from './db/migrate.js';
import { createRepo } from './db/repo.js';
import { createRecorder } from './db/recorder.js';
import { createBus } from './core/bus.js';
import { createState } from './core/state.js';
import { startWatchers } from './watchers/index.js';
import { createHttpServer } from './api/http.js';
import { attachWs } from './api/ws.js';
import { createHandlers } from './api/handlers/index.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const repo = createRepo(db);
// Platzhalter bis Paket 3 (Task 3.1): noch keine steuerbaren Tools
const registry = { list: () => [], get: () => null };
const bus = createBus();
const state = createState({ bus });
const recorder = createRecorder({ bus, repo, state });
const watchers = startWatchers({ state, bus, config, autoStart: false });

const server = createHttpServer({ config });
const ws = attachWs({
  server,
  token: config.token,
  ctx: { state, bus, repo, registry, acp: null, pty: null, config },
  handlers: createHandlers(),
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${config.port} ist schon belegt – läuft Agent Arena bereits? Dann einfach http://${config.host}:${config.port} öffnen.`);
    console.error(`  Beenden:  kill $(lsof -ti tcp:${config.port})   ·   Anderer Port:  PORT=4318 npm start\n`);
    process.exit(1);
  }
  throw err;
});

await watchers.tick();
watchers.start();

server.listen(config.port, config.host, () => {
  const n = state.all().length;
  console.log(`\n  Agent Arena läuft auf  http://${config.host}:${server.address().port}`);
  console.log(`  Quelle: ${config.claudeProjectsDir}  ·  ${n} Agent(en) im Zeitfenster von ${config.windowMin} min`);
  console.log(`  Daten:  ${config.dataDir}\n`);
});

// Sauber beenden: Watcher stoppen, Puffer schreiben, Verbindungen und DB schließen
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n  ${signal} – Agent Arena wird beendet …`);
  watchers.stop();
  recorder.stop();
  ws.close();
  server.close();
  try { db.close(); } catch { /* bereits geschlossen */ }
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
