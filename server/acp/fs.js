// fs/read_text_file und fs/write_text_file für Agenten – nur innerhalb des Projektordners (cwd).
import fsp from 'node:fs/promises';
import path from 'node:path';
import { RequestError } from '@agentclientprotocol/sdk';

const MAX_READ = 10 * 1024 * 1024;
const deny = (msg) => RequestError.invalidParams(undefined, msg);
const inside = (root, p) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

// Realpath des nächsten existierenden Vorfahren + fehlender Rest (für neue Dateien)
async function realpathLoose(p) {
  const rest = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(await fsp.realpath(cur), ...rest.reverse());
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const parent = path.dirname(cur);
      if (parent === cur) throw err;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

// Liefert den echten Pfad, wenn er (nach Auflösen aller Symlinks) unter root liegt – sonst Fehler.
export async function resolveInside(root, p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw deny('Pfad muss absolut sein');
  const rootReal = await fsp.realpath(root);
  const real = await realpathLoose(path.resolve(p));
  if (!inside(rootReal, real)) throw deny(`Zugriff außerhalb des Projektordners verweigert: ${p}`);
  return real;
}

export async function readTextFile(root, { path: p, line, limit }) {
  const real = await resolveInside(root, p);
  let st;
  try { st = await fsp.stat(real); } catch { throw RequestError.resourceNotFound(p); }
  if (!st.isFile()) throw deny(`Keine Datei: ${p}`);
  if (st.size > MAX_READ) throw deny(`Datei zu groß (${st.size} Bytes): ${p}`);
  let content = await fsp.readFile(real, 'utf8');
  if (line != null || limit != null) {
    const lines = content.split('\n');
    const start = Math.max(0, (line ?? 1) - 1);
    content = lines.slice(start, limit != null ? start + limit : undefined).join('\n');
  }
  return { content };
}

export async function writeTextFile(root, { path: p, content }) {
  const real = await resolveInside(root, p);
  await fsp.mkdir(path.dirname(real), { recursive: true });
  // nach dem Anlegen der Ordner erneut prüfen (Wettlauf mit Symlinks)
  await resolveInside(root, real);
  await fsp.writeFile(real, String(content ?? ''), 'utf8');
  return {};
}
