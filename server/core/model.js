// Einheitliches Agentenmodell – alle Quellen (ACP, Watcher, Demo) erzeugen dieselben Objekte.
import { randomUUID } from 'node:crypto';

export const STATUS = ['idle', 'thinking', 'tool', 'waiting_user', 'waiting_permission', 'error', 'done'];
export const CATEGORIES = ['terminal', 'workbench', 'library', 'portal', 'meeting', 'lounge'];

// ACP ToolKind → Station
export const KIND_TO_CATEGORY = {
  execute: 'terminal', edit: 'workbench', delete: 'workbench', move: 'workbench',
  read: 'library', search: 'library', think: 'meeting', fetch: 'portal', switch_mode: 'lounge', other: 'workbench',
};

export function kindToCategory(kind) {
  return KIND_TO_CATEGORY[kind] ?? 'workbench';
}

// Claude-Code-Werkzeugname → Station (aus v1, für Watcher)
export function toolCategory(name = '') {
  if (name.startsWith('mcp__')) return 'portal';
  switch (name) {
    case 'Bash': case 'BashOutput': case 'KillShell': case 'Monitor': case 'TaskStop':
      return 'terminal';
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
      return 'workbench';
    case 'Read': case 'Grep': case 'Glob': case 'LSP': case 'ToolSearch': case 'Skill':
      return 'library';
    case 'WebSearch': case 'WebFetch': case 'Artifact':
      return 'portal';
    case 'Agent': case 'Task': case 'SendMessage': case 'Workflow': case 'TodoWrite':
    case 'TaskCreate': case 'TaskUpdate': case 'ListAgents':
      return 'meeting';
    case 'AskUserQuestion': case 'ExitPlanMode': case 'EnterPlanMode':
      return 'lounge';
    default:
      return 'workbench';
  }
}

export function createAgent(p) {
  return {
    id: p.id, kind: p.kind ?? 'main', toolId: p.toolId, sessionId: p.sessionId ?? null,
    acpSessionId: p.acpSessionId ?? null, parentId: p.parentId ?? null,
    project: p.project, cwd: p.cwd ?? null, title: p.title ?? null, description: p.description ?? null,
    agentType: p.agentType ?? null, model: p.model ?? null,
    status: p.status ?? 'idle', tool: null, category: null, detail: null,
    lastText: null, lastPrompt: null, startedAt: p.startedAt ?? Date.now(), lastActivity: Date.now(),
    tokens: { input: 0, output: 0, cache: 0 }, toolCount: 0,
    source: p.source ?? 'acp', controllable: p.controllable ?? (p.source !== 'watch'),
    mode: p.mode ?? null, modes: p.modes ?? [], plan: [], error: null, events: [],
  };
}

// kind: 'text' | 'thought' | 'tool' | 'tool_update' | 'prompt' | 'plan' | 'diff' | 'permission' | 'error' | 'status' | 'usage'
export function createEvent(agentId, kind, payload, t = Date.now()) {
  return { id: randomUUID(), agentId, t, kind, ...payload };
}

// ---------------------------------------------------------------- Artefakte (v0.3)
// Dateiendung → Art der Vorschau: html (iframe), text (gerendert), image, pdf; alles andere ist „file“ (nur Hinweis)
export const ARTIFACT_KINDS = ['web', 'html', 'text', 'image', 'pdf', 'file'];
export const ARTIFACT_SOURCES = ['diff', 'text', 'terminal', 'port'];
export const KIND_BY_EXT = {
  '.html': 'html', '.htm': 'html',
  '.md': 'text', '.txt': 'text', '.json': 'text', '.yaml': 'text', '.yml': 'text', '.csv': 'text', '.log': 'text',
  '.js': 'text', '.mjs': 'text', '.cjs': 'text', '.ts': 'text', '.tsx': 'text', '.jsx': 'text', '.py': 'text', '.css': 'text',
  '.sql': 'text', '.sh': 'text', '.go': 'text', '.rs': 'text', '.java': 'text', '.kt': 'text', '.swift': 'text', '.toml': 'text', '.xml': 'text',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.svg': 'image', '.webp': 'image',
  '.pdf': 'pdf',
};
export const extOf = (p) => { const m = /\.[^./\\]+$/.exec(String(p ?? '')); return m ? m[0].toLowerCase() : ''; };
export const kindOfPath = (p) => KIND_BY_EXT[extOf(p)] ?? 'file';

// Artefakt-Objekt (Server und Browser gleich); id wird aus Session + Pfad/URL abgeleitet (siehe artifacts.js)
export function createArtifact(p) {
  const t = p.t ?? Date.now();
  return {
    id: p.id ?? randomUUID(), sessionId: p.sessionId, agentId: p.agentId ?? null, t, updatedAt: p.updatedAt ?? t,
    kind: ARTIFACT_KINDS.includes(p.kind) ? p.kind : 'file', title: p.title ?? null,
    url: p.url ?? null, path: p.path ?? null, previewUrl: p.previewUrl ?? null,
    source: ARTIFACT_SOURCES.includes(p.source) ? p.source : 'text', seen: !!p.seen, ended: !!p.ended,
    ...(p.size != null ? { size: p.size } : {}),
  };
}

export function createPermission(agentId, req) {
  return {
    id: randomUUID(), agentId, t: Date.now(), title: req.toolCall?.title ?? 'Berechtigung',
    toolCallId: req.toolCall?.toolCallId ?? null, kind: req.toolCall?.kind ?? 'other',
    content: req.toolCall?.content ?? [], locations: req.toolCall?.locations ?? [],
    rawInput: req.toolCall?.rawInput ?? null, options: Array.isArray(req.options) ? req.options : [], resolved: null,
  };
}
