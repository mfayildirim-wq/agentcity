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
  if (isFile) db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA busy_timeout=2000');
  db.exec(SCHEMA);
  return db;
}
