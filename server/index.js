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
import sessionHandlers from './api/handlers/session.js';
import permissionHandlers from './api/handlers/permission.js';
import fsHandlers from './api/handlers/fs.js';
import { createRegistry } from './agents/registry.js';
import { createSessionManager } from './acp/manager.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const repo = createRepo(db);
// Vorstufe der Registry (Paket 3 ergänzt Nutzer-Tools): Claude Code über den ACP-Adapter
const registry = createRegistry({ arenaDir: config.arenaDir });
const bus = createBus();
const state = createState({ bus });
const acp = createSessionManager({ state, bus, repo, registry });
const recorder = createRecorder({ bus, repo, state });
const watchers = startWatchers({ state, bus, config, autoStart: false });

const server = createHttpServer({ config });
const ws = attachWs({
  server,
  token: config.token,
  ctx: { state, bus, repo, registry, acp, pty: null, config },
  handlers: createHandlers(sessionHandlers, permissionHandlers, fsHandlers),
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

// Sauber beenden: Agenten-Prozesse und Watcher stoppen, Puffer schreiben, Verbindungen und DB schließen
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n  ${signal} – Agent Arena wird beendet …`);
  watchers.stop();
  await Promise.race([acp.stopAll(), new Promise((r) => setTimeout(r, 2500))]);
  recorder.stop();
  ws.close();
  server.close();
  try { db.close(); } catch { /* bereits geschlossen */ }
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
