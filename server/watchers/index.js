// Startet alle Datei-Watcher, gleicht deren Agenten mit dem Zustand ab und
// überspringt Sessions, die bereits von einem ACP-Agenten gesteuert werden.
import { createClaudeWatcher } from './claude.js';

export function createDefaultWatchers(config) {
  return [
    createClaudeWatcher({ root: config.claudeProjectsDir, windowMs: (config.windowMin ?? 90) * 60_000 }),
  ];
}

export function startWatchers({ state, bus, config, watchers = createDefaultWatchers(config), intervalMs = 1500, autoStart = true }) {
  const owned = new Map(watchers.map((w) => [w.id, new Set()])); // watcher-Id → Agent-Ids im Zustand
  let timer = null;
  let running = false;

  function syncWatcher(w, acpSessions) {
    const skip = (a) => a.sessionId && acpSessions.has(a.sessionId);
    const list = w.agents().filter((a) => !skip(a));
    const ids = new Set(list.map((a) => a.id));
    for (const a of list) state.upsert(a);
    const mine = owned.get(w.id);
    for (const id of mine) if (!ids.has(id)) state.remove(id);
    owned.set(w.id, ids);
    // neue Ereignisse für Recorder/Browser (DB dedupliziert per Id)
    for (const event of w.takeEvents?.() ?? []) {
      if (event.sessionId && acpSessions.has(event.sessionId)) continue;
      bus?.emit('event', { event });
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      // Sessions, die ein ACP-Agent übernommen hat, ignorieren
      const acpSessions = new Set();
      for (const a of state.all()) {
        if (a.source !== 'acp') continue;
        if (a.sessionId) acpSessions.add(a.sessionId);
        if (a.acpSessionId) acpSessions.add(a.acpSessionId);
      }
      for (const w of watchers) {
        try {
          await w.scan();
          syncWatcher(w, acpSessions);
        } catch (err) {
          console.error(`[watch:${w.id}]`, err?.message ?? err);
        }
      }
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch((err) => console.error('[watch]', err?.message ?? err)); }, intervalMs);
    timer.unref?.();
  }

  function stop() { clearInterval(timer); timer = null; }

  if (autoStart) start();
  return { tick, start, stop, watchers };
}
