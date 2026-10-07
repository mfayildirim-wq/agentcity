// Session-Manager: startet ACP-Agenten, übernimmt Watcher-Sessions, leitet Prompts,
// Abbrüche, Berechtigungsantworten und Moduswechsel an die passende Session weiter.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAgent } from '../core/model.js';
import { AcpClient } from './client.js';
import { createAcpSession } from './session.js';

export const MODES = ['confirm', 'auto'];

function checkDir(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('Projektordner muss ein absoluter Pfad sein');
  let real;
  try { real = fs.realpathSync(cwd); } catch { throw new Error(`Ordner nicht gefunden: ${cwd}`); }
  if (!fs.statSync(real).isDirectory()) throw new Error(`Kein Ordner: ${cwd}`);
  return real;
}

export function createSessionManager({
  state, bus, repo, registry, clientFactory = (opts) => new AcpClient(opts), sessionOptions = {},
}) {
  const sessions = new Map(); // agentId → { session, client, launch }

  function toolOf(toolId) {
    const tool = registry.get(toolId);
    if (!tool) throw new Error(`Unbekanntes Tool: ${toolId}`);
    return tool;
  }

  function entry(agentId) {
    const e = sessions.get(agentId);
    if (!e) throw new Error('Keine steuerbare Session für diesen Agenten');
    return e;
  }

  // Gemeinsamer Start: Agent anlegen, Prozess starten, initialize; danach new/load durch `open`
  async function launch({ tool, cwd, mode, title, sessionId, acpSessionId = null, open }) {
    const id = `a:${randomUUID()}`;
    const project = path.basename(cwd);
    const projectId = repo?.upsertProject?.({ cwd, name: project }) ?? null;
    try {
      repo?.createSession?.({ id: sessionId, toolId: tool.id, acpSessionId, projectId, title, source: 'acp', mode });
    } catch { /* Session-Zeile existiert schon (Übernahme) */ }
    const agent = createAgent({
      id, toolId: tool.id, sessionId, acpSessionId, project, cwd, title: title || null, source: 'acp', controllable: true,
      status: 'thinking', mode: null,
    });
    agent.launch = { toolId: tool.id, cwd, mode, title: title || null };
    agent.detail = 'startet …';
    const client = clientFactory({ tool, cwd });
    const session = createAcpSession({ agent, client, state, bus, repo, autoApprove: mode === 'auto', ...sessionOptions });
    sessions.set(id, { session, client, launch: agent.launch });
    state.upsert(agent);

    try {
      client.start();
      const init = await client.initialize();
      const res = (await open(client, session, init)) ?? {};
      const modes = res.modes?.availableModes ?? [];
      const patch = {
        acpSessionId: client.sessionId, modes: modes.map((m) => ({ id: m.id, name: m.name })),
        mode: res.modes?.currentModeId ?? null, status: 'waiting_user', detail: null,
        agentName: tool.name ?? init.agentInfo?.title ?? init.agentInfo?.name ?? tool.id,
        loadSession: !!init.agentCapabilities?.loadSession,
      };
      state.upsert({ ...session.get(), ...patch, lastActivity: Date.now() });
      repo?.setSessionAcpId?.(sessionId, client.sessionId);
      // gewünschten Modus setzen, wenn das Tool ihn kennt
      if (mode && modes.some((m) => m.id === mode) && res.modes?.currentModeId !== mode) {
        try { await session.setMode(mode); } catch (err) { bus.emit('toast', { level: 'warn', text: `Modus ${mode} nicht gesetzt: ${err.message}` }); }
      }
      return id;
    } catch (err) {
      const msg = err?.message || String(err);
      const a = session.get();
      if (a && a.status !== 'error') {
        state.upsert({ ...a, status: 'error', detail: null, error: { message: msg, stderrTail: client.stderrTail(30) }, lastActivity: Date.now() });
      }
      session.close();
      throw new Error(`${tool.name ?? tool.id} konnte nicht starten: ${msg}`);
    }
  }

  async function createSession({ toolId, cwd, mode = 'confirm', title = null }) {
    const tool = toolOf(toolId);
    if (mode && !MODES.includes(mode)) throw new Error(`Unbekannter Modus: ${mode}`);
    const dir = checkDir(cwd);
    return launch({
      tool, cwd: dir, mode, title, sessionId: randomUUID(),
      open: (client) => client.newSession(),
    });
  }

  // Watcher-Agent (externe Session) durch steuerbaren ACP-Agenten ersetzen
  async function adopt(watchAgentId) {
    const w = state.get(watchAgentId);
    if (!w) throw new Error('Agent nicht gefunden');
    if (w.source !== 'watch' || w.kind !== 'main') throw new Error('Nur externe Hauptsessions lassen sich übernehmen');
    if (!w.cwd) throw new Error('Projektordner der Session unbekannt');
    const tool = toolOf(w.toolId);
    const dir = checkDir(w.cwd);
    const external = w.acpSessionId ?? w.sessionId;
    const id = await launch({
      tool, cwd: dir, mode: 'confirm', title: w.title, sessionId: w.sessionId, acpSessionId: external,
      open: async (client, session, init) => {
        if (!init.agentCapabilities?.loadSession) throw new Error('Tool kann Sessions nicht laden');
        return session.load(() => client.loadSession(external));
      },
    });
    // Watcher-Agent samt Subagenten entfernen; der Watcher überspringt die Session künftig (acpSessionId)
    for (const a of state.all()) if (a.source === 'watch' && (a.id === w.id || a.parentId === w.id)) state.remove(a.id);
    return id;
  }

  async function close(agentId) {
    const e = entry(agentId);
    sessions.delete(agentId);
    const a = e.session.get();
    await e.session.close();
    for (const s of state.all()) if (s.parentId === agentId) state.remove(s.id);
    state.remove(agentId);
    try { if (a?.sessionId) repo?.endSession?.(a.sessionId, 'done'); } catch { /* DB optional */ }
    return { ok: true };
  }

  function prompt(agentId, text, opts) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Leerer Prompt');
    return entry(agentId).session.prompt(text, opts);
  }

  const cancel = (agentId) => entry(agentId).session.cancel();

  async function setMode(agentId, modeId) {
    const e = entry(agentId);
    await e.session.setMode(modeId);
    try { repo?.setSessionMode?.(e.session.get().sessionId, modeId); } catch { /* DB optional */ }
    return { ok: true };
  }

  function answerPermission(permissionId, optionId) {
    for (const { session } of sessions.values()) {
      if (session.hasPermission(permissionId)) return session.answer(permissionId, optionId);
    }
    throw new Error('Berechtigung nicht (mehr) offen');
  }

  const get = (agentId) => sessions.get(agentId)?.session ?? null;
  const has = (agentId) => sessions.has(agentId);

  async function stopAll() {
    await Promise.all([...sessions.keys()].map((id) => close(id).catch(() => {})));
  }

  return { createSession, adopt, close, prompt, cancel, setMode, answerPermission, get, has, stopAll, sessions };
}
