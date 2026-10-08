// Wiedergabe: rekonstruiert aus gespeicherten Ereignissen (history.events) den Zustand der Agenten zu einem
// Zeitpunkt – Status, Station, Werkzeug, letzter Text/Prompt, Plan. Rein funktional (auch im Node-Test nutzbar).

const SUB_LINGER_MS = 3 * 60_000; // beendete Subagenten bleiben kurz sichtbar (wie live)
const WATCH_IDLE_MS = 60_000; // Watcher melden kein Zugende: nach 60 s Ruhe gilt der Agent als wartend
const MAX_EVENTS = 20;

const KIND_TO_CATEGORY = {
  execute: 'terminal', edit: 'workbench', delete: 'workbench', move: 'workbench',
  read: 'library', search: 'library', think: 'meeting', fetch: 'portal', switch_mode: 'lounge', other: 'workbench',
};

const basename = (p) => String(p ?? '').replace(/\/+$/, '').split('/').pop() || null;

// Marker-Art für den Zeitstrahl: prompt | permission | error | tool (oder null = kein Marker)
export function markerKind(e) {
  if (e.kind === 'prompt') return 'prompt';
  if (e.kind === 'permission') return e.optionId || e.auto ? null : 'permission';
  if (e.kind === 'error') return 'error';
  if (e.kind === 'tool' || e.kind === 'terminal') return 'tool';
  return null;
}

// Ist die Session zum Zeitpunkt t sichtbar?
export const sessionAt = (s, t) => (s.startedAt ?? 0) <= t && (s.endedAt == null || s.endedAt >= t);

function blank(base) {
  return {
    status: 'idle', tool: null, category: null, detail: null, lastText: null, lastPrompt: null, plan: [], error: null,
    toolCount: 0, events: [], lastActivity: base.startedAt ?? 0, ...base,
  };
}

// Ereignis auf den Agentenzustand anwenden (wie acp/session.js live)
function step(a, e, open) {
  a.lastActivity = e.t;
  const compact = { id: e.id, t: e.t, kind: e.kind, label: e.label ?? null, tool: e.tool ?? null, category: e.category ?? null, status: e.status ?? null };
  a.events.push(compact);
  if (a.events.length > MAX_EVENTS) a.events.shift();
  switch (e.kind) {
    case 'prompt':
      Object.assign(a, { status: 'thinking', lastPrompt: e.label ?? e.text ?? null, lastText: null, tool: null, category: null, detail: null, error: null });
      open.clear();
      return;
    case 'tool': {
      if (e.toolCallId) open.add(e.toolCallId);
      const category = e.category ?? KIND_TO_CATEGORY[e.toolKind] ?? 'workbench';
      Object.assign(a, { status: 'tool', tool: e.tool ?? 'Werkzeug', category, detail: e.detail ?? e.label ?? null });
      a.toolCount += 1;
      return;
    }
    case 'terminal':
      Object.assign(a, { status: 'tool', category: 'terminal', tool: a.status === 'tool' && a.tool ? a.tool : 'Terminal', detail: e.label ?? e.command ?? null });
      return;
    case 'tool_update':
      if (e.status === 'completed' || e.status === 'failed') {
        open.delete(e.toolCallId);
        if (!open.size && a.status === 'tool') Object.assign(a, { status: 'thinking', tool: null, category: null, detail: null });
      }
      return;
    case 'permission':
      if (!e.optionId && !e.auto) a.status = 'waiting_permission';
      else if (a.status === 'waiting_permission') a.status = open.size ? 'tool' : 'thinking';
      return;
    case 'text':
      a.lastText = e.label ?? e.text ?? a.lastText;
      return;
    case 'status':
      if (e.status) Object.assign(a, { status: e.status, tool: null, category: null, detail: null });
      open.clear();
      return;
    case 'error':
      Object.assign(a, { status: 'error', error: { message: e.message ?? e.label ?? 'Fehler' }, tool: null, category: null, detail: null });
      return;
    case 'plan':
      if (Array.isArray(e.entries)) a.plan = e.entries;
      return;
    default:
  }
}

/**
 * Zustand aller Agenten zum Zeitpunkt t.
 * sessions: Session-Objekte aus history.sessions; data: Map sessionId → { events[] (nach t sortiert), agents[] }
 * Rückgabe: Agenten-Objekte wie im Live-Zustand (replay: true, controllable: false).
 */
export function reconstruct(sessions, data, t) {
  const out = [];
  for (const s of sessions) {
    if (!sessionAt(s, t)) continue;
    const d = data.get(s.id) ?? { events: [], agents: [] };
    const rows = d.agents ?? [];
    const project = s.project || basename(s.cwd) || 'Projekt';
    const mainRow = rows.find((r) => r.kind === 'main');
    const subIds = new Set(rows.filter((r) => r.kind === 'sub').map((r) => r.id));
    // Ersatz ohne Agentenzeile: erstes Ereignis, das keinem Subagenten gehört
    const mainId = mainRow?.id ?? d.events.find((e) => e.agentId && !subIds.has(e.agentId))?.agentId ?? `h:${s.id}`;
    const common = { toolId: s.toolId, sessionId: s.id, acpSessionId: s.acpSessionId ?? null, project, cwd: s.cwd ?? null, house: s.houseId ?? s.id,
      source: s.source ?? 'acp', controllable: false, adoptable: false, replay: true, tokens: { input: 0, output: 0, cache: 0 } };
    const agents = new Map();
    const opens = new Map();
    agents.set(mainId, blank({ ...common, id: mainId, kind: 'main', parentId: null, title: s.title ?? null, model: mainRow?.model ?? null,
      startedAt: s.startedAt, agentName: null }));
    for (const r of rows) {
      if (r.kind !== 'sub' || r.id === mainId) continue;
      agents.set(r.id, blank({ ...common, id: r.id, kind: 'sub', parentId: r.parentId ?? mainId, description: r.description ?? null,
        agentType: r.agentType ?? null, model: r.model ?? null, startedAt: r.startedAt ?? s.startedAt, endedAt: r.endedAt ?? null }));
    }
    for (const e of d.events) {
      if (e.t > t) break;
      let a = agents.get(e.agentId);
      if (!a) a = agents.get(mainId); // unbekannte Agenten-Id (z. B. alte Daten) → Hauptagent
      if (!opens.has(a.id)) opens.set(a.id, new Set());
      step(a, e, opens.get(a.id));
    }
    for (const a of agents.values()) {
      if (a.kind === 'sub') {
        // Subagent erst ab Start, nach dem Ende kurz „fertig“, danach weg
        if ((a.startedAt ?? 0) > t && !a.events.length) continue; // noch nicht gestartet
        if (a.endedAt != null && a.endedAt <= t) {
          if (t - a.endedAt > SUB_LINGER_MS) continue;
          Object.assign(a, { status: 'done', tool: null, category: null, detail: null });
        } else if (t - Math.max(a.lastActivity ?? 0, a.startedAt ?? 0) > SUB_LINGER_MS) {
          continue; // ohne Ende gespeichert (z. B. Watcher): nach längerer Ruhe nicht mehr zeigen
        } else if (a.status === 'idle') a.status = 'thinking';
      } else if (a.source === 'watch' && (a.status === 'thinking' || a.status === 'tool') && t - a.lastActivity > WATCH_IDLE_MS) {
        Object.assign(a, { status: 'waiting_user', tool: null, category: null, detail: null });
      } else if (a.status === 'idle' && a.events.length === 0 && a.source === 'acp') {
        a.status = 'waiting_user';
      }
      delete a.endedAt;
      out.push(a);
    }
  }
  return out;
}

// Bündelt Werkzeug-Marker: je Spalte (Breite `bucketMs`) ein Marker mit Anzahl
export function bundleTools(events, from, bucketMs) {
  const buckets = new Map();
  for (const e of events) {
    if (markerKind(e) !== 'tool' || e.t < from) continue;
    const k = Math.floor((e.t - from) / bucketMs);
    const b = buckets.get(k);
    if (b) { b.count += 1; if (b.labels.length < 4) b.labels.push(e.tool ?? e.label ?? ''); } else buckets.set(k, { t: from + k * bucketMs + bucketMs / 2, count: 1, labels: [e.tool ?? e.label ?? ''] });
  }
  return [...buckets.values()].sort((x, y) => x.t - y.t);
}

// Neue Ereignisse (Server-Reihenfolge) in den Cache einer Session übernehmen: Duplikate per Id verworfen,
// sortiert nach (t, Reihenfolge des Eintreffens). Rückgabe: Anzahl neuer Ereignisse.
export function mergeEvents(c, events) {
  c.ids ??= new Set();
  c.events ??= [];
  c.order ??= 0;
  let n = 0;
  for (const e of events) {
    if (c.ids.has(e.id)) continue;
    c.ids.add(e.id);
    c.events.push({ ...e, _o: c.order++ });
    n += 1;
  }
  if (n) c.events.sort((x, y) => x.t - y.t || x._o - y._o);
  return n;
}

// Scrub-Gate: verwirft Ergebnisse älterer Scrub-Vorgänge und solche nach „Live“ (cancel)
export function createScrubGate() {
  let seq = 0;
  return {
    begin: () => ++seq,
    valid: (token) => token === seq,
    cancel: () => { seq += 1; },
  };
}
