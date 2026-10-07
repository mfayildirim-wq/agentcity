// Startet alle Datei-Watcher, gleicht deren Agenten mit dem Zustand ab und
// überspringt Sessions, die bereits von einem ACP-Agenten gesteuert werden.
import fs from 'node:fs';
import { createClaudeWatcher } from './claude.js';
import { createCodexWatcher } from './codex.js';
import { createOpencodeWatcher } from './opencode.js';
import { createHermesWatcher } from './hermes.js';

// Watcher nur für vorhandene Quellen; Claude bleibt immer dabei (Ordner kann später entstehen)
export function createDefaultWatchers(config) {
  const windowMs = (config.windowMin ?? 90) * 60_000;
  const exists = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };
  const list = [createClaudeWatcher({ root: config.claudeProjectsDir, windowMs })];
  if (exists(config.codexSessionsDir)) list.push(createCodexWatcher({ root: config.codexSessionsDir, windowMs }));
  if (exists(config.opencodeDb)) list.push(createOpencodeWatcher({ dbPath: config.opencodeDb, windowMs }));
  if (exists(config.hermesDb)) list.push(createHermesWatcher({ dbPath: config.hermesDb, windowMs }));
  return list;
}

// Übernehmen (session/load) nur für Tools, deren Adapter das zuverlässig kann
const ADOPTABLE = new Set(['claude', 'codex']);
// Sitzungsdatei einer geschlossenen Arena-Session gilt erst als externe Nutzung, wenn danach (> 5 s) noch etwas passiert
export const ARENA_GRACE_MS = 5000;

// repo (optional): Session-Ende vermerken, wenn ein Watcher-Hauptagent verschwindet; wieder offen, wenn er zurückkehrt
export function startWatchers({ state, bus, repo = null, config, watchers = createDefaultWatchers(config), intervalMs = 1500, autoStart = true }) {
  const owned = new Map(watchers.map((w) => [w.id, new Set()])); // watcher-Id → Agent-Ids im Zustand
  let timer = null;
  let running = false;

  // Sessions, die ein ACP-Agent steuert (auch während einer laufenden Übernahme)
  function acpSessionIds() {
    const ids = new Set();
    for (const a of state.all()) {
      if (a.source !== 'acp') continue;
      if (a.sessionId) ids.add(a.sessionId);
      if (a.acpSessionId) ids.add(a.acpSessionId);
    }
    return ids;
  }

  const dbCall = (fn) => { if (!repo) return; try { fn(); } catch (err) { console.error('[watch] DB', err?.message ?? err); } };

  function syncWatcher(w) {
    // erst nach dem (asynchronen) Scan ermitteln – eine Übernahme kann währenddessen abgeschlossen sein
    const acpSessions = acpSessionIds();
    const arenaOwned = new Map(); // sessionId → true, wenn die Datei zu einer (geschlossenen) Arena-Session gehört
    const ownedByArena = (sid, lastActivity) => {
      if (!repo?.arenaSessionFor || !sid) return false;
      if (!arenaOwned.has(sid)) {
        let r = null;
        try { r = repo.arenaSessionFor(sid); } catch { /* DB optional */ }
        // ausblenden, solange keine echte spätere CLI-Nutzung (Aktivität > 5 s nach dem Ende) vorliegt
        arenaOwned.set(sid, !!r && (r.active || r.endedAt == null || !(lastActivity > r.endedAt + ARENA_GRACE_MS)));
      }
      return arenaOwned.get(sid);
    };
    const mainActivity = new Map();
    const all = w.agents();
    for (const a of all) if (a.kind === 'main' && a.sessionId) mainActivity.set(a.sessionId, a.lastActivity ?? 0);
    const skip = (a) => !!a.sessionId && (acpSessions.has(a.sessionId)
      || ownedByArena(a.sessionId, mainActivity.get(a.sessionId) ?? a.lastActivity ?? 0));
    const adoptable = w.adoptable ?? ADOPTABLE.has(w.id);
    const list = all.filter((a) => !skip(a)).map((a) => ({ ...a, adoptable: adoptable && a.kind === 'main' }));
    const ids = new Set(list.map((a) => a.id));
    const mine = owned.get(w.id);
    for (const a of list) {
      if (a.kind === 'main' && a.sessionId && !mine.has(a.id)) dbCall(() => repo.reopenSession?.(a.sessionId));
      state.upsert(a);
    }
    for (const id of mine) {
      if (ids.has(id)) continue;
      const a = state.get(id);
      // verschwunden (nicht von einem ACP-Agenten übernommen) → Session beendet, Ende = letzte Aktivität
      if (a?.kind === 'main' && a.sessionId && !acpSessions.has(a.sessionId) && !arenaOwned.get(a.sessionId)) {
        dbCall(() => repo.endSession?.(a.sessionId, 'ended', a.lastActivity ?? Date.now()));
      }
      state.remove(id);
    }
    owned.set(w.id, ids);
    // neue Ereignisse für Recorder/Browser (DB dedupliziert per Id)
    for (const event of w.takeEvents?.() ?? []) {
      if (event.sessionId && (acpSessions.has(event.sessionId) || arenaOwned.get(event.sessionId))) continue;
      bus?.emit('event', { event });
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      for (const w of watchers) {
        try {
          await w.scan();
          syncWatcher(w);
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

  function stop() {
    clearInterval(timer);
    timer = null;
    for (const w of watchers) try { w.close?.(); } catch { /* bereits zu */ }
  }

  if (autoStart) start();
  return { tick, start, stop, watchers };
}
