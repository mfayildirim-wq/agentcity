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
    q(`INSERT INTO sessions (id, tool_id, acp_session_id, project_id, title, source, mode, started_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(s.id, s.toolId ?? null, s.acpSessionId ?? null, s.projectId ?? null, s.title ?? null,
        s.source ?? 'acp', s.mode ?? null, s.startedAt ?? Date.now(), s.status ?? 'active');
    return s.id;
  }

  // Legt eine Session-Zeile an, falls sie fehlt (z. B. für Watcher-Sessions)
  function ensureSession(s) {
    if (q('SELECT 1 FROM sessions WHERE id = ?').get(s.id)) return false;
    createSession(s);
    return true;
  }

  const updateSessionTitle = (id, title) => q('UPDATE sessions SET title = ? WHERE id = ?').run(title, id);
  const getSession = (id) => q('SELECT * FROM sessions WHERE id = ?').get(id);

  function endSession(id, status = 'done') {
    q('UPDATE sessions SET ended_at = ?, status = ? WHERE id = ?').run(Date.now(), status, id);
  }

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
  };

  // ------------------------------------------------------------ Besprechungen
  function rowToMeeting(r) {
    if (!r) return null;
    const messages = q('SELECT * FROM messages WHERE meeting_id = ? ORDER BY t').all(r.id)
      .map((m) => ({ id: m.id, agentId: m.agent_id, role: m.role, text: m.text, t: m.t, meetingId: m.meeting_id }));
    return {
      id: r.id, title: r.title, participantIds: parse(r.participant_ids, []), createdAt: r.created_at,
      closedAt: r.closed_at, messages,
    };
  }
  const meetings = {
    list: () => q('SELECT * FROM meetings ORDER BY created_at').all().map(rowToMeeting),
    get: (id) => rowToMeeting(q('SELECT * FROM meetings WHERE id = ?').get(id)),
    create({ title = null, participantIds = [] }) {
      const id = randomUUID();
      q('INSERT INTO meetings (id, title, participant_ids, created_at) VALUES (?, ?, ?, ?)')
        .run(id, title, JSON.stringify(participantIds), Date.now());
      return meetings.get(id);
    },
    update(id, { title, participantIds, closed } = {}) {
      const cur = meetings.get(id);
      if (!cur) return null;
      q('UPDATE meetings SET title = ?, participant_ids = ?, closed_at = ? WHERE id = ?')
        .run(title ?? cur.title, JSON.stringify(participantIds ?? cur.participantIds),
          closed === undefined ? cur.closedAt ?? null : closed ? Date.now() : null, id);
      return meetings.get(id);
    },
  };

  // ------------------------------------------------------------ Verlauf
  const history = {
    sessions(limit = 50, offset = 0) {
      return q(`SELECT s.*, p.name AS project_name, p.cwd AS cwd,
                  (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id) AS event_count
                FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
                ORDER BY s.started_at DESC LIMIT ? OFFSET ?`).all(limit, offset)
        .map((r) => ({
          id: r.id, toolId: r.tool_id, acpSessionId: r.acp_session_id, projectId: r.project_id, project: r.project_name,
          cwd: r.cwd, title: r.title, source: r.source, mode: r.mode, startedAt: r.started_at, endedAt: r.ended_at,
          status: r.status, eventCount: r.event_count,
        }));
    },
    events(sessionId, from = 0, to = Number.MAX_SAFE_INTEGER, limit = 5000) {
      return q('SELECT * FROM events WHERE session_id = ? AND t >= ? AND t <= ? ORDER BY t LIMIT ?')
        .all(sessionId, from ?? 0, to ?? Number.MAX_SAFE_INTEGER, limit ?? 5000)
        .map((r) => ({ ...parse(r.payload, {}), id: r.id, sessionId: r.session_id, agentId: r.agent_id, t: r.t, kind: r.kind }));
    },
  };

  return {
    db, tx, upsertProject, createSession, ensureSession, updateSessionTitle, getSession, endSession,
    upsertAgent, getAgent, insertEvents, insertMessage, insertPermission, resolvePermission, tasks, meetings, history,
  };
}
