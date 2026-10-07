// Startet alle Datei-Watcher, gleicht deren Agenten mit dem Zustand ab und
// überspringt Sessions, die bereits von einem ACP-Agenten gesteuert werden.
import { createClaudeWatcher } from './claude.js';

export function createDefaultWatchers(config) {
  return [
    createClaudeWatcher({ root: config.claudeProjectsDir, windowMs: (config.windowMin ?? 90) * 60_000 }),
  ];
}

export function startWatchers({ state, config, watchers = createDefaultWatchers(config), intervalMs = 1500, autoStart = true }) {
  const owned = new Map(watchers.map((w) => [w.id, new Set()])); // watcher-Id → Agent-Ids im Zustand
  let timer = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      // Sessions, die ein ACP-Agent übernommen hat, ignorieren
      const acpSessions = new Set(state.all().filter((a) => a.source === 'acp' && a.sessionId).map((a) => a.sessionId));
      for (const w of watchers) {
        try { await w.scan(); } catch (err) { console.error(`[watch:${w.id}]`, err.message); continue; }
        const list = w.agents().filter((a) => !acpSessions.has(a.sessionId));
        const ids = new Set(list.map((a) => a.id));
        for (const a of list) state.upsert(a);
        const mine = owned.get(w.id);
        for (const id of mine) if (!ids.has(id)) state.remove(id);
        owned.set(w.id, ids);
      }
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
  }

  function stop() { clearInterval(timer); timer = null; }

  if (autoStart) start();
  return { tick, start, stop, watchers };
}
