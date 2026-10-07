// In-Memory-Zustand aller Agenten, offenen Berechtigungen, Aufgaben und Besprechungen.

export function createState({ bus }) {
  const agents = new Map();
  const permissions = new Map();
  const tasks = new Map();
  const meetings = new Map();
  // Fingerabdruck je Agent, damit unveränderte Upserts keine Ereignisse auslösen
  const prints = new Map();

  function upsert(agent) {
    const print = JSON.stringify(agent);
    if (prints.get(agent.id) === print) return false;
    prints.set(agent.id, print);
    agents.set(agent.id, agent);
    bus.emit('agent.update', { agent });
    return true;
  }

  function remove(id) {
    if (!agents.has(id)) return false;
    agents.delete(id);
    prints.delete(id);
    bus.emit('agent.remove', { agentId: id });
    return true;
  }

  const get = (id) => agents.get(id);
  const all = () => [...agents.values()];

  function snapshot(extra = {}) {
    return {
      now: Date.now(),
      agents: all(),
      tasks: [...tasks.values()],
      meetings: [...meetings.values()],
      permissions: [...permissions.values()].filter((p) => !p.resolved),
      tools: [],
      ...extra,
    };
  }

  return { agents, permissions, tasks, meetings, upsert, remove, get, all, snapshot };
}
