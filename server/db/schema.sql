CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT, cwd TEXT UNIQUE, created_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, tool_id TEXT, acp_session_id TEXT, project_id TEXT,
  title TEXT, source TEXT, mode TEXT, started_at INTEGER, ended_at INTEGER, status TEXT);
CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, session_id TEXT, kind TEXT, parent_id TEXT, agent_type TEXT,
  description TEXT, model TEXT, started_at INTEGER, ended_at INTEGER, tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT, t INTEGER, kind TEXT, payload TEXT);
CREATE INDEX IF NOT EXISTS events_session_t ON events(session_id, t);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT, meeting_id TEXT, role TEXT, text TEXT, t INTEGER);
CREATE TABLE IF NOT EXISTS permissions (id TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT, t INTEGER, title TEXT,
  kind TEXT, raw_input TEXT, option_id TEXT, resolved_at INTEGER);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT, description TEXT, status TEXT, assignee_id TEXT,
  meeting_id TEXT, source_message_id TEXT, created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS meetings (id TEXT PRIMARY KEY, title TEXT, participant_ids TEXT, created_at INTEGER, closed_at INTEGER);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS meeting_messages (id TEXT PRIMARY KEY, meeting_id TEXT, role TEXT, agent_id TEXT, text TEXT,
  target_ids TEXT, t INTEGER);
CREATE INDEX IF NOT EXISTS meeting_messages_meeting_t ON meeting_messages(meeting_id, t);
