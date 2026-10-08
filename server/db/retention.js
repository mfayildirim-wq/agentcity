// Aufräumregel für die Datenbank: beim Start und danach täglich alte Daten löschen, danach WAL kürzen und
// freie Seiten zurückgeben. Frist (Tage) für Ereignisse und Berechtigungen = days, für Nachrichten,
// Besprechungsbeiträge und Sessions/Agenten ohne Ereignisse = 2 × days.
export const DEFAULT_RETENTION_DAYS = 90;
export const RETENTION_INTERVAL_MS = 24 * 3600_000;
const DAY_MS = 24 * 3600_000;

// Frist aus ARENA_RETENTION_DAYS (positive Zahl), sonst 90
export function retentionDays(env = process.env) {
  const n = Number(env.ARENA_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

// Ein Durchlauf; liefert die Zahl gelöschter Zeilen je Tabelle
export function runRetention(db, { days = DEFAULT_RETENTION_DAYS, now = Date.now() } = {}) {
  const base = now - days * DAY_MS;
  const long = now - 2 * days * DAY_MS;
  const run = (sql, ...args) => Number(db.prepare(sql).run(...args).changes);
  const out = {};
  db.exec('BEGIN');
  try {
    out.events = run('DELETE FROM events WHERE t < ?', base);
    out.permissions = run('DELETE FROM permissions WHERE t < ?', base);
    out.messages = run('DELETE FROM messages WHERE t < ?', long);
    out.meetingMessages = run(`DELETE FROM meeting_messages WHERE meeting_id IN
      (SELECT id FROM meetings WHERE closed_at IS NOT NULL AND closed_at < ?)`, long);
    // beendete Sessions ohne (verbliebene) Ereignisse samt ihrer Agenten; Agenten ohne Ereignisse und ohne Session
    const oldSessions = `SELECT s.id FROM sessions s WHERE s.ended_at IS NOT NULL AND s.ended_at < ?
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id)`;
    out.agents = run(`DELETE FROM agents WHERE session_id IN (${oldSessions})
      OR (started_at < ? AND NOT EXISTS (SELECT 1 FROM events e WHERE e.agent_id = agents.id)
          AND (session_id IS NULL OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = agents.session_id)))`, long, long);
    out.sessions = run(`DELETE FROM sessions WHERE id IN (${oldSessions})`, long);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  // WAL kürzen, freie Seiten zurückgeben (wirkt nur bei auto_vacuum=INCREMENTAL)
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('PRAGMA incremental_vacuum');
  return out;
}

// Sofort ausführen, danach im Intervall; Fehler werden nur protokolliert
export function startRetention(db, { days = DEFAULT_RETENTION_DAYS, intervalMs = RETENTION_INTERVAL_MS, log = console } = {}) {
  const tick = () => {
    try {
      const n = runRetention(db, { days });
      const total = Object.values(n).reduce((a, b) => a + b, 0);
      if (total) log.log?.(`[db] Aufräumen (${days} d): ${Object.entries(n).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')}`);
      return n;
    } catch (err) {
      log.error?.('[db] Aufräumen', err.message);
      return null;
    }
  };
  const first = tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { first, run: tick, stop: () => clearInterval(timer) };
}
