// Schreibt Bus-Ereignisse in die Datenbank: Ereignisse gebündelt, Agenten entprellt.
import path from 'node:path';

export function createRecorder({ bus, repo, state, flushMs = 500, debounceMs = 1000 }) {
  let buffer = [];
  const lastWrite = new Map(); // agentId → Zeitpunkt
  const pending = new Map(); // agentId → Timer
  const latest = new Map(); // agentId → zuletzt gemeldeter Stand (solange ein Timer läuft)

  const sessionOf = (agentId) => state?.get(agentId)?.sessionId ?? null;

  function writeAgent(agent) {
    lastWrite.set(agent.id, Date.now());
    try {
      if (agent.kind === 'main' && agent.sessionId) {
        const projectId = agent.cwd ? repo.upsertProject({ cwd: agent.cwd, name: agent.project ?? path.basename(agent.cwd) }) : null;
        repo.ensureSession({
          id: agent.sessionId, toolId: agent.toolId, acpSessionId: agent.acpSessionId, projectId,
          title: agent.title, source: agent.source, mode: agent.mode, startedAt: agent.startedAt,
        });
      }
      repo.upsertAgent(agent);
    } catch (err) {
      console.error('[recorder] Agent', err.message);
    }
  }

  function onAgentUpdate({ agent }) {
    latest.set(agent.id, agent);
    const since = Date.now() - (lastWrite.get(agent.id) ?? 0);
    if (since >= debounceMs && !pending.has(agent.id)) { latest.delete(agent.id); writeAgent(agent); return; }
    if (pending.has(agent.id)) return; // Timer schreibt den dann aktuellen Stand
    pending.set(agent.id, setTimeout(() => {
      pending.delete(agent.id);
      const cur = latest.get(agent.id) ?? agent;
      latest.delete(agent.id);
      writeAgent(cur);
    }, Math.max(0, debounceMs - since)));
  }

  function onEvent({ event }) {
    buffer.push({ ...event, sessionId: event.sessionId ?? sessionOf(event.agentId) });
  }

  function flush() {
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    try { repo.insertEvents(batch); } catch (err) { console.error('[recorder] Ereignisse', err.message); }
  }

  const onAgentRemove = ({ agentId }) => { if (!pending.has(agentId)) lastWrite.delete(agentId); };
  bus.on('agent.update', onAgentUpdate);
  bus.on('agent.remove', onAgentRemove);
  bus.on('event', onEvent);
  const timer = setInterval(flush, flushMs);
  timer.unref?.();

  function stop() {
    clearInterval(timer);
    // anstehende (entprellte) Agenten noch wegschreiben
    for (const [id, t] of pending) {
      clearTimeout(t);
      const cur = latest.get(id);
      if (cur) writeAgent(cur);
    }
    pending.clear();
    latest.clear();
    bus.off('agent.update', onAgentUpdate);
    bus.off('agent.remove', onAgentRemove);
    bus.off('event', onEvent);
    flush();
  }

  return { flush, stop };
}
