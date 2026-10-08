// Datenbankzugriffe – alle Funktionen arbeiten auf der injizierten Verbindung.
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const json = (v) => (v == null ? null : JSON.stringify(v));
const parse = (s, fallback = null) => { try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; } };

function rowToTask(r) {
  return r && {
    id: r.id, title: r.title, description: r.description, status: r.status, assigneeId: r.assignee_id,
    meetingId: r.meeting_id, sourceMessageId: r.source_message_id, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function createRepo(db) {
  // vorbereitete Statements einmal anlegen und wiederverwenden
  const stmts = new Map();
  const q = (sql) => {
    let st = stmts.get(sql);
    if (!st) { st = db.prepare(sql); stmts.set(sql, st); }
    return st;
  };

  function tx(fn) {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (err) { db.exec('ROLLBACK'); throw err; }
  }

  // ------------------------------------------------------------ Projekte, Sessions, Agenten
  function upsertProject({ cwd, name }) {
    const row = q('SELECT id FROM projects WHERE cwd = ?').get(cwd);
    if (row) {
      if (name) q('UPDATE projects SET name = ? WHERE id = ?').run(name, row.id);
      return row.id;
    }
    const id = randomUUID();
    q('INSERT INTO projects (id, name, cwd, created_at) VALUES (?, ?, ?, ?)').run(id, name ?? path.basename(cwd), cwd, Date.now());
    return id;
  }

  function createSession(s) {
    q(`INSERT INTO sessions (id, tool_id, acp_session_id, project_id, title, source, mode, started_at, status, parent_session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(s.id, s.toolId ?? null, s.acpSessionId ?? null, s.projectId ?? null, s.title ?? null,
        s.source ?? 'acp', s.mode ?? null, s.startedAt ?? Date.now(), s.status ?? 'active', s.parentSessionId ?? null);
    return s.id;
  }

  // Legt eine Session-Zeile an, falls sie fehlt (z. B. für Watcher-Sessions)
  function ensureSession(s) {
    if (q('SELECT 1 FROM sessions WHERE id = ?').get(s.id)) return false;
    createSession(s);
    return true;
  }

  const updateSessionTitle = (id, title) => q('UPDATE sessions SET title = ? WHERE id = ?').run(title, id);
  const setSessionAcpId = (id, acpSessionId) => q('UPDATE sessions SET acp_session_id = ? WHERE id = ?').run(acpSessionId, id);
  const setSessionMode = (id, mode) => q('UPDATE sessions SET mode = ? WHERE id = ?').run(mode, id);

  // zuletzt verwendete Projektordner (für die Ordnerauswahl)
  const recentProjects = (limit = 10) => q(`SELECT p.cwd, p.name, MAX(s.started_at) AS last FROM projects p
      JOIN sessions s ON s.project_id = p.id WHERE p.cwd IS NOT NULL GROUP BY p.id ORDER BY last DESC LIMIT ?`).all(limit)
    .map((r) => ({ cwd: r.cwd, name: r.name, last: r.last }));
  const getSession = (id) => q('SELECT * FROM sessions WHERE id = ?').get(id);

  // Ende nur einmal setzen (ein späteres Schließen überschreibt z. B. den Fehlerstatus nicht)
  function endSession(id, status = 'done', at = Date.now()) {
    return q('UPDATE sessions SET ended_at = ?, status = ? WHERE id = ? AND ended_at IS NULL').run(at, status, id).changes > 0;
  }

  // beendete Session wieder öffnen (Watcher-Session wieder aktiv, Übernahme)
  const reopenSession = (id) => q("UPDATE sessions SET ended_at = NULL, status = 'active' WHERE id = ? AND ended_at IS NOT NULL")
    .run(id).changes > 0;

  // Beim Start: Sessions ohne Ende (Absturz, harter Abbruch) gelten als beendet – Ende = letztes Ereignis
  // keep: Session-Ids, die gerade laufen (z. B. vom Watcher bereits gemeldet) – bleiben offen
  function endDangling(keep = []) {
    const skip = [...new Set(keep.filter(Boolean))];
    return q(`UPDATE sessions SET status = 'ended', ended_at = MAX(started_at,
        COALESCE((SELECT MAX(e.t) FROM events e WHERE e.session_id = sessions.id), started_at))
      WHERE ended_at IS NULL AND id NOT IN (SELECT value FROM json_each(?))`).run(JSON.stringify(skip)).changes;
  }

  // City-Sessions (source acp) mit dieser ACP-/Tool-Session-Id: { active, endedAt } oder null.
  // Der Watcher blendet deren Sitzungsdatei aus (sonst erschiene eine geschlossene City-Session als externe).
  function citySessionFor(acpSessionId) {
    if (!acpSessionId) return null;
    const r = q(`SELECT COUNT(*) AS n, SUM(ended_at IS NULL) AS open, MAX(ended_at) AS ended FROM sessions
      WHERE acp_session_id = ? AND source = 'acp'`).get(acpSessionId);
    if (!r?.n) return null;
    return { active: r.open > 0, endedAt: r.ended ?? null };
  }

  // kleine Schlüssel/Wert-Ablage (Tabelle meta)
  const meta = {
    get: (key) => q('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null,
    set: (key, value) => q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value == null ? null : String(value)),
  };

  function upsertAgent(a) {
    const ended = a.status === 'done' || a.status === 'error' ? a.lastActivity ?? Date.now() : null;
    q(`INSERT INTO agents (id, session_id, kind, parent_id, agent_type, description, model, started_at, ended_at, tokens_in, tokens_out)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, kind = excluded.kind, parent_id = excluded.parent_id,
         agent_type = excluded.agent_type, description = excluded.description, model = excluded.model,
         ended_at = excluded.ended_at, tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out`)
      .run(a.id, a.sessionId ?? null, a.kind ?? 'main', a.parentId ?? null, a.agentType ?? null, a.description ?? null,
        a.model ?? null, a.startedAt ?? Date.now(), ended,
        (a.tokens?.input ?? 0) + (a.tokens?.cache ?? 0), a.tokens?.output ?? 0);
  }

  const getAgent = (id) => q('SELECT * FROM agents WHERE id = ?').get(id);

  // ------------------------------------------------------------ Ereignisse, Nachrichten, Berechtigungen
  function insertEvents(events) {
    if (!events.length) return 0;
    const stmt = q('INSERT OR IGNORE INTO events (id, session_id, agent_id, t, kind, payload) VALUES (?, ?, ?, ?, ?, ?)');
    return tx(() => {
      for (const e of events) {
        const { id, sessionId, agentId, t, kind, ...payload } = e;
        stmt.run(id ?? randomUUID(), sessionId ?? null, agentId ?? null, t ?? Date.now(), kind, JSON.stringify(payload));
      }
      return events.length;
    });
  }

  function insertMessage(m) {
    q('INSERT OR REPLACE INTO messages (id, session_id, agent_id, meeting_id, role, text, t) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(m.id ?? randomUUID(), m.sessionId ?? null, m.agentId ?? null, m.meetingId ?? null, m.role, m.text, m.t ?? Date.now());
  }

  // letzte Nachrichten eines Agenten (älteste zuerst), für den Chatverlauf nach einem Neuladen
  function messagesForAgent(agentId, limit = 100) {
    return q('SELECT * FROM (SELECT * FROM messages WHERE agent_id = ? ORDER BY t DESC LIMIT ?) ORDER BY t').all(agentId, limit)
      .map((m) => ({ id: m.id, role: m.role, text: m.text, t: m.t, ...(m.meeting_id ? { meetingId: m.meeting_id } : {}) }));
  }

  function insertPermission(p, sessionId = null) {
    q(`INSERT OR REPLACE INTO permissions (id, session_id, agent_id, t, title, kind, raw_input) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(p.id, sessionId, p.agentId, p.t ?? Date.now(), p.title, p.kind, json(p.rawInput));
  }

  function resolvePermission(id, optionId) {
    q('UPDATE permissions SET option_id = ?, resolved_at = ? WHERE id = ?').run(optionId, Date.now(), id);
  }

  // ------------------------------------------------------------ Aufgaben
  const tasks = {
    list: () => q('SELECT * FROM tasks ORDER BY created_at').all().map(rowToTask),
    get: (id) => rowToTask(q('SELECT * FROM tasks WHERE id = ?').get(id)),
    create({ title, description = null, status = 'open', assigneeId = null, meetingId = null, sourceMessageId = null }) {
      const id = randomUUID();
      const now = Date.now();
      q(`INSERT INTO tasks (id, title, description, status, assignee_id, meeting_id, source_message_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, title, description, status, assigneeId, meetingId, sourceMessageId, now, now);
      return tasks.get(id);
    },
    update(id, patch) {
      const cur = tasks.get(id);
      if (!cur) return null;
      const n = { ...cur, ...patch };
      q('UPDATE tasks SET title = ?, description = ?, status = ?, assignee_id = ?, updated_at = ? WHERE id = ?')
        .run(n.title, n.description, n.status, n.assigneeId, Date.now(), id);
      return tasks.get(id);
    },
    delete: (id) => q('DELETE FROM tasks WHERE id = ?').run(id).changes > 0,
  };

  // ------------------------------------------------------------ Besprechungen
  // Nachrichten einer Besprechung liegen in meeting_messages (einmal je Beitrag); die an die einzelnen
  // Agenten gesendeten Prompts (mit Präfix) stehen zusätzlich mit meeting_id in messages (Chatverlauf je Agent)
  const rowToMeetingMessage = (m) => ({
    id: m.id, role: m.role, ...(m.agent_id ? { agentId: m.agent_id } : {}), text: m.text, t: m.t,
    ...(m.target_ids ? { targetIds: parse(m.target_ids, []) } : {}),
  });
  // limit 0: nur Metadaten (ohne Nachrichten)
  function rowToMeeting(r, limit = 200) {
    if (!r) return null;
    const m = { id: r.id, title: r.title, participantIds: parse(r.participant_ids, []), createdAt: r.created_at, closedAt: r.closed_at };
    if (!limit) return m;
    m.messages = q('SELECT * FROM (SELECT rowid AS rn, * FROM meeting_messages WHERE meeting_id = ? ORDER BY t DESC, rowid DESC LIMIT ?) ORDER BY t, rn')
      .all(r.id, limit).map(rowToMeetingMessage);
    return m;
  }
  const meetings = {
    // open: nur nicht geschlossene
    list: ({ open = false } = {}) => q(`SELECT * FROM meetings ${open ? 'WHERE closed_at IS NULL' : ''} ORDER BY created_at`).all()
      .map((r) => rowToMeeting(r)),
    get: (id) => rowToMeeting(q('SELECT * FROM meetings WHERE id = ?').get(id)),
    create({ title = null, participantIds = [] }) {
      const id = randomUUID();
      q('INSERT INTO meetings (id, title, participant_ids, created_at) VALUES (?, ?, ?, ?)')
        .run(id, title, JSON.stringify(participantIds), Date.now());
      return meetings.get(id);
    },
    update(id, { title, participantIds, closed } = {}) {
      const cur = q('SELECT * FROM meetings WHERE id = ?').get(id);
      if (!cur) return null;
      q('UPDATE meetings SET title = ?, participant_ids = ?, closed_at = ? WHERE id = ?')
        .run(title === undefined ? cur.title : title, participantIds ? JSON.stringify(participantIds) : cur.participant_ids,
          closed === undefined ? cur.closed_at ?? null : closed ? Date.now() : null, id);
      return rowToMeeting(q('SELECT * FROM meetings WHERE id = ?').get(id), 0);
    },
    addMessage(meetingId, m) {
      q('INSERT OR REPLACE INTO meeting_messages (id, meeting_id, role, agent_id, text, target_ids, t) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(m.id ?? randomUUID(), meetingId, m.role, m.agentId ?? null, m.text, m.targetIds ? JSON.stringify(m.targetIds) : null, m.t ?? Date.now());
    },
  };

  // ------------------------------------------------------------ Artefakte (v0.3)
  const rowToArtifact = (r) => r && {
    id: r.id, sessionId: r.session_id, agentId: r.agent_id, t: r.t, updatedAt: r.updated_at, kind: r.kind, title: r.title,
    url: r.url, path: r.path, previewUrl: r.preview_url, source: r.source, seen: !!r.seen, ended: !!r.ended,
    ...(r.size != null ? { size: r.size } : {}),
  };
  const artifacts = {
    upsert(a) {
      q(`INSERT INTO artifacts (id, session_id, agent_id, t, updated_at, kind, title, url, path, preview_url, source, seen, ended, size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET agent_id = excluded.agent_id, updated_at = excluded.updated_at, kind = excluded.kind,
           title = excluded.title, url = excluded.url, path = excluded.path, preview_url = excluded.preview_url, source = excluded.source,
           seen = excluded.seen, ended = excluded.ended, size = excluded.size`)
        .run(a.id, a.sessionId ?? null, a.agentId ?? null, a.t ?? Date.now(), a.updatedAt ?? a.t ?? Date.now(), a.kind, a.title ?? null,
          a.url ?? null, a.path ?? null, a.previewUrl ?? null, a.source ?? null, a.seen ? 1 : 0, a.ended ? 1 : 0, a.size ?? null);
    },
    get: (id) => rowToArtifact(q('SELECT * FROM artifacts WHERE id = ?').get(id)),
    // neueste zuerst
    forSession: (sessionId, limit = 50) => q('SELECT * FROM artifacts WHERE session_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?')
      .all(sessionId, limit).map(rowToArtifact),
    markSeen: (sessionId) => q('UPDATE artifacts SET seen = 1 WHERE session_id = ? AND seen = 0').run(sessionId).changes,
    delete: (id) => q('DELETE FROM artifacts WHERE id = ?').run(id).changes > 0,
    // Artefakte beendeter Sessions, die älter als `days` Tage sind
    purge: (days, now = Date.now()) => q(`DELETE FROM artifacts WHERE session_id IN
      (SELECT id FROM sessions WHERE ended_at IS NOT NULL AND ended_at < ?)`).run(now - days * 24 * 3600_000).changes,
  };

  // ------------------------------------------------------------ Verlauf
  const rowToSession = (r) => ({
    id: r.id, toolId: r.tool_id, acpSessionId: r.acp_session_id, projectId: r.project_id, project: r.project_name,
    cwd: r.cwd, title: r.title, source: r.source, mode: r.mode, startedAt: r.started_at, endedAt: r.ended_at,
    duration: r.ended_at != null && r.started_at != null ? Math.max(0, r.ended_at - r.started_at) : null,
    status: r.status, eventCount: r.event_count, parentSessionId: r.parent_session_id ?? null, resumedBy: r.resumed_by ?? null,
  });
  // jüngste Kind-Session, die diese fortsetzt; ein gescheiterter Versuch (error ohne Ereignisse) zählt nicht
  const RESUMED_BY = `(SELECT c.id FROM sessions c WHERE c.parent_session_id = s.id
      AND (c.status IS NOT 'error' OR EXISTS (SELECT 1 FROM events ce WHERE ce.session_id = c.id))
      ORDER BY c.started_at DESC LIMIT 1) AS resumed_by`;
  const history = {
    // ended: nur beendete; since: laufende oder nach diesem Zeitpunkt beendete (für den Zeitstrahl)
    sessions(opts = {}, offsetArg) {
      const o = typeof opts === 'number' ? { limit: opts, offset: offsetArg } : opts ?? {};
      const where = [];
      const args = [];
      if (o.ended) where.push('s.ended_at IS NOT NULL');
      if (o.since != null) { where.push('(s.ended_at IS NULL OR s.ended_at >= ?)'); args.push(o.since); }
      const count = o.withCounts === false ? 'NULL' : '(SELECT COUNT(*) FROM events e WHERE e.session_id = s.id)';
      return q(`SELECT s.*, p.name AS project_name, p.cwd AS cwd, ${count} AS event_count, ${RESUMED_BY}
                FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
                ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                ORDER BY s.started_at DESC, s.rowid DESC LIMIT ? OFFSET ?`).all(...args, o.limit ?? 50, o.offset ?? 0)
        .map(rowToSession);
    },
    session: (id) => {
      const r = q(`SELECT s.*, p.name AS project_name, p.cwd AS cwd, 0 AS event_count, ${RESUMED_BY}
                   FROM sessions s LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = ?`).get(id);
      return r ? rowToSession(r) : null;
    },
    // events(sessionId, { from, to, limit, offset }) – alte Signatur (sessionId, from, to, limit) bleibt gültig
    events(sessionId, opts = {}, toArg, limitArg) {
      const o = typeof opts === 'object' && opts !== null ? opts : { from: opts, to: toArg, limit: limitArg };
      return q('SELECT * FROM events WHERE session_id = ? AND t >= ? AND t <= ? ORDER BY t, rowid LIMIT ? OFFSET ?')
        .all(sessionId, o.from ?? 0, o.to ?? Number.MAX_SAFE_INTEGER, o.limit ?? 5000, o.offset ?? 0)
        .map((r) => ({ ...parse(r.payload, {}), id: r.id, sessionId: r.session_id, agentId: r.agent_id, t: r.t, kind: r.kind }));
    },
    // Agenten einer Session (Haupt- und Subagenten) für die Wiedergabe
    agents: (sessionId) => q('SELECT * FROM agents WHERE session_id = ? ORDER BY started_at').all(sessionId)
      .map((r) => ({
        id: r.id, kind: r.kind, parentId: r.parent_id, agentType: r.agent_type, description: r.description, model: r.model,
        startedAt: r.started_at, endedAt: r.ended_at,
      })),
  };

  return {
    db, tx, upsertProject, createSession, ensureSession, updateSessionTitle, setSessionAcpId, setSessionMode, recentProjects,
    getSession, endSession, reopenSession, endDangling, citySessionFor, meta,
    upsertAgent, getAgent, insertEvents, insertMessage, messagesForAgent, insertPermission, resolvePermission, tasks, meetings, history,
    artifacts,
  };
}
