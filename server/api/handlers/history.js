// WS-Handler: Verlauf – Sessions (Archiv/Zeitstrahl), Ereignisse einer Session, beendete Session fortsetzen.
// Große Ergebnisse werden paginiert: limit (Standard 50, max. 500) und offset.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const page = (msg) => ({
  limit: Math.min(Math.max(Math.trunc(Number(msg.limit)) || DEFAULT_LIMIT, 1), MAX_LIMIT),
  offset: Math.max(Math.trunc(Number(msg.offset)) || 0, 0),
});
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function needRepo(ctx) {
  if (!ctx.repo?.history) throw new Error('Verlauf nicht verfügbar');
  return ctx.repo;
}

// Externe Id zum Laden: ACP-Session-Id, bei Watcher-Sessions die Session-Id des Tools selbst
export const loadIdOf = (s) => s.acpSessionId ?? (s.source === 'watch' ? s.id : null);

// Fortsetzbar: beendet, noch nicht fortgesetzt (keine Kind-Session), ladbare Id vorhanden, Tool bekannt und kann session/load
export function isResumable(s, { registry, acp }) {
  if (s.endedAt == null || s.resumedBy || !loadIdOf(s) || !s.toolId) return false;
  if (registry?.get && !registry.get(s.toolId)) return false;
  return !!acp?.canLoad?.(s.toolId);
}

export default {
  async 'history.sessions'(ctx, msg) {
    const repo = needRepo(ctx);
    const { limit, offset } = page(msg);
    // eine Zeile mehr holen, um hasMore zu bestimmen
    // counts: false spart die Zählung der Ereignisse (Zeitstrahl)
    const rows = repo.history.sessions({ limit: limit + 1, offset, ended: !!msg.ended, since: num(msg.since), withCounts: msg.counts !== false });
    const hasMore = rows.length > limit;
    const sessions = rows.slice(0, limit).map((s) => ({ ...s, resumable: isResumable(s, ctx) }));
    return { sessions, hasMore };
  },

  async 'history.events'(ctx, msg) {
    const repo = needRepo(ctx);
    if (typeof msg.sessionId !== 'string' || !msg.sessionId) throw new Error('sessionId fehlt');
    const { limit, offset } = page(msg);
    const rows = repo.history.events(msg.sessionId, { from: num(msg.from) ?? 0, to: num(msg.to) ?? Number.MAX_SAFE_INTEGER, limit: limit + 1, offset });
    const hasMore = rows.length > limit;
    // Agenten der Session nur mit der ersten Seite
    return { events: rows.slice(0, limit), ...(offset === 0 ? { agents: repo.history.agents?.(msg.sessionId) ?? [] } : {}), hasMore };
  },

  async 'history.resume'(ctx, msg) {
    if (!ctx.acp?.resume) throw new Error('Steuerung nicht verfügbar');
    if (typeof msg.sessionId !== 'string' || !msg.sessionId) throw new Error('sessionId fehlt');
    return { agentId: await ctx.acp.resume(msg.sessionId) };
  },
};
