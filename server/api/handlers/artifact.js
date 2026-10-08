// WS-Handler: Artefakte einer Session auflisten, als gesehen markieren, im Finder bzw. Browser öffnen.
// artifact.open läuft nur aus dem Browser (Origin-Pflicht in ws.js) und nur auf macOS (`open`).
import { spawn } from 'node:child_process';
import { need as needIn, str } from './util.js';

const need = (ctx) => needIn(ctx.artifacts, 'Artefakte nicht verfügbar');

// Öffnen per `open` ohne Shell; injizierbar für Tests
export function openArtifact(a, { platform = process.platform, spawnFn = spawn } = {}) {
  if (platform !== 'darwin') throw new Error('Öffnen wird nur auf macOS unterstützt');
  let args;
  if (a.path) args = ['-R', a.path]; // Datei im Finder zeigen
  else if (a.url && /^https?:\/\//.test(a.url)) args = [a.url];
  else throw new Error('Artefakt hat weder Pfad noch URL');
  const p = spawnFn('open', args, { stdio: 'ignore', detached: true });
  p.on?.('error', () => {});
  p.unref?.();
  return { ok: true, args };
}

export default {
  'artifact.list'(ctx, msg) {
    const art = need(ctx);
    const sessionId = str(msg.sessionId, 'sessionId');
    const limit = Math.min(Math.max(Math.trunc(Number(msg.limit)) || 50, 1), 50);
    return { artifacts: art.forSession(sessionId, limit) };
  },

  'artifact.seen'(ctx, msg) {
    const art = need(ctx);
    art.markSeen(str(msg.sessionId, 'sessionId'));
    return { ok: true };
  },

  'artifact.open'(ctx, msg) {
    const art = need(ctx);
    const a = art.get(str(msg.artifactId, 'artifactId'));
    if (!a) throw new Error('Artefakt nicht gefunden');
    const { ok } = openArtifact(a, ctx.openOptions);
    return { ok };
  },
};
