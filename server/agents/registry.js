// Tool-Registry (Vorstufe für Paket 3): feste Liste steuerbarer Agenten-Tools.
// Paket 3 ergänzt Nutzer-Einträge (~/.agent-arena/agents.json), Validierung und „Testen“.
import path from 'node:path';
import { ARENA_DIR } from '../config.js';

export function defaultTools(arenaDir = ARENA_DIR) {
  return [
    {
      id: 'claude', name: 'Claude Code', command: 'node',
      args: [path.join(arenaDir, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js')],
      color: '#d97757', avatarStyle: 'gem',
    },
  ];
}

// `node` als Befehl → derselbe Node-Prozess wie die Arena (unabhängig von PATH)
const resolveCommand = (t) => ({ ...t, command: t.command === 'node' ? process.execPath : t.command, args: t.args ?? [], env: t.env ?? {} });

export function createRegistry({ arenaDir = ARENA_DIR, tools = defaultTools(arenaDir) } = {}) {
  const map = new Map(tools.map((t) => [t.id, resolveCommand(t)]));
  return {
    list: () => [...map.values()],
    get: (id) => map.get(id) ?? null,
    // für den Browser: ohne Befehlszeile und Umgebung
    publicList: () => [...map.values()].map(({ id, name, color, avatarStyle }) => ({ id, name, color, avatarStyle: avatarStyle ?? null, installed: true })),
  };
}
