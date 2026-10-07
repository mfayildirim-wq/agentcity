// WS-Handler: Ordnerauswahl für neue Sessions (nur Verzeichnisse, keine versteckten)
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_ENTRIES = 500;

export default {
  async 'fs.pickDir'(ctx, msg) {
    const start = typeof msg.start === 'string' && msg.start.trim() ? msg.start.trim().replace(/^~(?=$|\/)/, os.homedir()) : os.homedir();
    if (!path.isAbsolute(start)) throw new Error('Pfad muss absolut sein');
    let dir;
    try { dir = await fsp.realpath(start); } catch { throw new Error(`Ordner nicht gefunden: ${start}`); }
    if (!(await fsp.stat(dir)).isDirectory()) throw new Error(`Kein Ordner: ${start}`);
    let dirents = [];
    try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch (err) { throw new Error(`Ordner nicht lesbar: ${err.code ?? err.message}`); }
    const entries = [];
    for (const d of dirents) {
      if (d.name.startsWith('.')) continue;
      let isDir = d.isDirectory();
      if (!isDir && d.isSymbolicLink()) {
        try { isDir = (await fsp.stat(path.join(dir, d.name))).isDirectory(); } catch { isDir = false; }
      }
      if (isDir) entries.push({ name: d.name, path: path.join(dir, d.name) });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
    const parent = path.dirname(dir);
    let recent = [];
    try { recent = ctx.repo?.recentProjects?.(10) ?? []; } catch { /* DB optional */ }
    return { path: dir, parent: parent !== dir ? parent : null, entries: entries.slice(0, MAX_ENTRIES), recent };
  },
};
