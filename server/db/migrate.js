// Öffnet die SQLite-Datenbank und führt das (idempotente) Schema aus.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const SCHEMA = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8');

// Akzeptiert einen Pfad (oder ':memory:') bzw. eine bereits geöffnete Verbindung
export function openDb(target) {
  const isFile = typeof target === 'string' && target !== ':memory:';
  if (isFile) fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = target instanceof DatabaseSync ? target : new DatabaseSync(target);
  // neue Datenbank (noch ohne Tabellen): freie Seiten per incremental_vacuum zurückgeben (siehe retention.js)
  if (!db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get()) db.exec('PRAGMA auto_vacuum=INCREMENTAL');
  if (isFile) db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA busy_timeout=2000');
  db.exec(SCHEMA);
  // Paket 6: Verweis auf die fortgesetzte Session (ältere Datenbanken ohne Spalte nachrüsten)
  const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  if (!cols.includes('parent_session_id')) db.exec('ALTER TABLE sessions ADD COLUMN parent_session_id TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS sessions_started ON sessions(started_at)');
  db.exec('CREATE INDEX IF NOT EXISTS sessions_acp ON sessions(acp_session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS messages_agent_t ON messages(agent_id, t)');
  return db;
}
