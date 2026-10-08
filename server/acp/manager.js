// Session-Manager: startet ACP-Agenten, übernimmt Watcher-Sessions, leitet Prompts,
// Abbrüche, Berechtigungsantworten und Moduswechsel an die passende Session weiter.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAgent } from '../core/model.js';
import { AcpClient, rpcErrorMessage } from './client.js';
import { createAcpSession } from './session.js';
import { createTerminalHandlers } from './terminal.js';
import { withTimeout } from '../core/util.js';

export const MODES = ['confirm', 'auto']; // City-Modus: Rückfragen bestätigen oder automatisch freigeben
export const START_TIMEOUT_MS = 60_000;
// Tools, deren Adapter session/load sicher können (weitere merkt sich Agent City aus initialize)
export const LOAD_CAPABLE = new Set(['claude', 'codex']);

function checkDir(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('Projektordner muss ein absoluter Pfad sein');
  let real;
  try { real = fs.realpathSync(cwd); } catch { throw new Error(`Ordner nicht gefunden: ${cwd}`); }
  if (!fs.statSync(real).isDirectory()) throw new Error(`Kein Ordner: ${cwd}`);
  return real;
}

export function createSessionManager({
  state, bus, repo, registry, pty = null, clientFactory = (opts) => new AcpClient(opts), sessionOptions = {},
  startTimeoutMs = START_TIMEOUT_MS,
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
  // adopted: bestehende DB-Session wird übernommen (gehört Agent City erst nach erfolgreichem Laden);
  // load: open lädt eine Session (Zeitlimit-Text); parentSessionId: Verweis beim Fortsetzen
  async function launch({ tool, cwd, mode, title, sessionId, acpSessionId = null, open, adopted = false, load = adopted, parentSessionId = null }) {
    const id = `a:${randomUUID()}`;
    const project = path.basename(cwd);
    const projectId = repo?.upsertProject?.({ cwd, name: project }) ?? null;
    try {
      repo?.createSession?.({ id: sessionId, toolId: tool.id, acpSessionId, projectId, title, source: 'acp', mode, parentSessionId });
    } catch { /* Session-Zeile existiert schon (Übernahme) */ }
    const agent = createAgent({
      id, toolId: tool.id, sessionId, acpSessionId, project, cwd, title: title || null, source: 'acp', controllable: true,
      status: 'thinking', mode: null,
    });
    agent.cityMode = mode === 'auto' ? 'auto' : 'confirm';
    agent.launch = { toolId: tool.id, cwd, mode, title: title || null };
    agent.detail = 'startet …';
    // ownsSession: DB-Session gehört dieser City-Session (bei Übernahme erst nach erfolgreichem Laden)
    const entryData = { client: null, launch: agent.launch, ownsSession: !adopted };
    // Agenten-Terminals (terminal/*) laufen über den PTY-Manager im Projektordner
    const terminal = createTerminalHandlers({ pty, cwd, agentId: id, onCreate: (t) => entryData.session?.terminalStarted(t) });
    const client = clientFactory({ tool, cwd, terminal });
    entryData.client = client;
    const session = createAcpSession({ agent, client, state, bus, repo, pty, ownsSession: () => entryData.ownsSession, ...sessionOptions });
    entryData.session = session;
    sessions.set(id, entryData);
    const closedDuringStart = () => sessions.get(id) !== entryData;
    state.upsert(agent);

    try {
      client.start();
      const init = await withTimeout(client.initialize(), startTimeoutMs, 'initialize');
      if (closedDuringStart()) throw new Error('beim Start geschlossen');
      rememberLoad(tool.id, !!init.agentCapabilities?.loadSession);
      const res = (await withTimeout(Promise.resolve(open(client, session, init)), startTimeoutMs, load ? 'session/load' : 'session/new')) ?? {};
      if (closedDuringStart()) throw new Error('beim Start geschlossen');
      const modes = res.modes?.availableModes ?? [];
      const patch = {
        acpSessionId: client.sessionId, modes: modes.map((m) => ({ id: m.id, name: m.name })),
        mode: res.modes?.currentModeId ?? null, status: 'waiting_user', detail: null,
        agentName: tool.name ?? init.agentInfo?.title ?? init.agentInfo?.name ?? tool.id,
        loadSession: !!init.agentCapabilities?.loadSession,
      };
      state.upsert({ ...session.get(), ...patch, lastActivity: Date.now() });
      repo?.setSessionAcpId?.(sessionId, client.sessionId);
      entryData.ownsSession = true;
      return id;
    } catch (err) {
      const msg = rpcErrorMessage(err);
      // während des Starts geschlossen: aufräumen, keinen Agenten wieder anlegen
      if (closedDuringStart()) {
        session.close();
        pty?.closeAgent(id);
        throw new Error(`${tool.name ?? tool.id}: Start abgebrochen`);
      }
      const a = session.get();
      if (a && a.status !== 'error') {
        state.upsert({ ...a, status: 'error', detail: null, error: { message: msg, stderrTail: client.stderrTail(30) }, lastActivity: Date.now() });
      }
      session.close();
      pty?.closeAgent(id);
      // eigene Session-Zeile (neue Session, Fortsetzen) als fehlgeschlagen beenden – nicht bei einer Übernahme
      try { if (entryData.ownsSession) repo?.endSession?.(sessionId, 'error'); } catch { /* DB optional */ }
      throw new Error(`${tool.name ?? tool.id} konnte nicht starten: ${msg}`);
    }
  }

  async function createSession({ toolId, cwd, mode = 'confirm', title = null }) {
    const tool = toolOf(toolId);
    if (mode && !MODES.includes(mode)) throw new Error(`Unbekannter City-Modus: ${mode}`);
    const dir = checkDir(cwd);
    return launch({
      tool, cwd: dir, mode, title, sessionId: randomUUID(),
      open: (client) => client.newSession(),
    });
  }

  // Watcher-Agent (externe Session) durch steuerbaren ACP-Agenten ersetzen
  const adopting = new Set(); // Watcher-Agent-Ids, deren Übernahme gerade läuft

  async function adopt(watchAgentId) {
    if (adopting.has(watchAgentId)) throw new Error('Session wird bereits übernommen');
    adopting.add(watchAgentId);
    try { return await adoptNow(watchAgentId); } finally { adopting.delete(watchAgentId); }
  }

  async function adoptNow(watchAgentId) {
    const w = state.get(watchAgentId);
    if (!w) throw new Error('Agent nicht gefunden');
    if (w.source !== 'watch' || w.kind !== 'main') throw new Error('Nur externe Hauptsessions lassen sich übernehmen');
    if (!w.cwd) throw new Error('Projektordner der Session unbekannt');
    const tool = toolOf(w.toolId);
    const dir = checkDir(w.cwd);
    const external = w.acpSessionId ?? w.sessionId;
    // bereits übernommen (z. B. Watcher hat den Agenten kurz vor dem Entfernen erneut gemeldet)
    const taken = state.all().some((a) => a.source === 'acp'
      && [a.sessionId, a.acpSessionId].some((sid) => sid && (sid === w.sessionId || sid === external)));
    if (taken) {
      state.remove(w.id);
      throw new Error('Session wird bereits in Agent City gesteuert');
    }
    const id = await launch({
      tool, cwd: dir, mode: 'confirm', title: w.title, sessionId: w.sessionId, acpSessionId: external, adopted: true,
      open: async (client, session, init) => {
        if (!init.agentCapabilities?.loadSession) throw new Error('Tool kann Sessions nicht laden');
        return session.load(() => client.loadSession(external));
      },
    });
    // Watcher-Agent samt Subagenten entfernen; der Watcher überspringt die Session künftig (acpSessionId)
    for (const a of state.all()) if (a.source === 'watch' && (a.id === w.id || a.parentId === w.id)) state.remove(a.id);
    try { repo?.reopenSession?.(w.sessionId); } catch { /* DB optional */ }
    bus?.emit('toast', {
      level: 'warn',
      text: `${w.title || 'Session'} fortgesetzt – die laufende CLI-Sitzung sollte beendet werden, sonst schreiben zwei Prozesse`,
    });
    return id;
  }

  // ---------------------------------------------------------------- Fortsetzen (Archiv)
  // Kann das Tool Sessions laden? Gemerkt aus initialize (Tabelle meta), Standard für Claude und Codex
  const loadCaps = new Map();
  function rememberLoad(toolId, can) {
    if (loadCaps.get(toolId) === can) return;
    loadCaps.set(toolId, can);
    try { repo?.meta?.set?.(`loadSession:${toolId}`, can ? '1' : '0'); } catch { /* DB optional */ }
  }
  function canLoad(toolId) {
    if (!loadCaps.has(toolId)) {
      let v = null;
      try { v = repo?.meta?.get?.(`loadSession:${toolId}`) ?? null; } catch { /* DB optional */ }
      if (v != null) loadCaps.set(toolId, v === '1');
    }
    return loadCaps.has(toolId) ? loadCaps.get(toolId) : LOAD_CAPABLE.has(toolId);
  }

  const resuming = new Set(); // DB-Session-Ids, deren Fortsetzen gerade läuft

  // Beendete Session aus dem Archiv fortsetzen: neuer ACP-Prozess im gespeicherten Ordner, session/load mit der
  // gespeicherten ACP-Id, neue Session-Zeile mit Verweis auf die alte (parent_session_id)
  async function resume(sessionId) {
    if (resuming.has(sessionId)) throw new Error('Session wird bereits fortgesetzt');
    resuming.add(sessionId);
    try { return await resumeNow(sessionId); } finally { resuming.delete(sessionId); }
  }

  async function resumeNow(sessionId) {
    const s = repo?.history?.session?.(sessionId);
    if (!s) throw new Error('Session nicht gefunden');
    if (s.endedAt == null) throw new Error('Session läuft noch – nur beendete Sessions lassen sich fortsetzen');
    const external = s.acpSessionId ?? (s.source === 'watch' ? s.id : null);
    if (!external) throw new Error('Session hat keine ladbare ACP-Id');
    if (!s.cwd) throw new Error('Projektordner der Session unbekannt');
    const tool = toolOf(s.toolId);
    if (!canLoad(tool.id)) throw new Error(`${tool.name ?? tool.id} kann Sessions nicht laden`);
    // fehlgeschlagene Starts (Status error) blockieren nicht
    const taken = state.all().some((a) => a.source === 'acp' && a.status !== 'error'
      && [a.sessionId, a.acpSessionId].some((sid) => sid && (sid === external || sid === s.id)));
    if (taken) throw new Error('Session wird bereits in Agent City gesteuert');
    // Der Watcher zeigt auch die Sitzungsdatei einer gerade geschlossenen City-Session – deren Agent wird ersetzt.
    // Eine externe Session (source watch), die gerade läuft, wird dagegen übernommen.
    const watched = state.all().filter((a) => a.source === 'watch' && [a.sessionId, a.acpSessionId].includes(external));
    const w = watched.find((a) => a.kind === 'main');
    if (w && s.source === 'watch') return adopt(w.id);
    const dir = checkDir(s.cwd);
    const id = await launch({
      tool, cwd: dir, mode: s.mode === 'auto' ? 'auto' : 'confirm', title: s.title, sessionId: randomUUID(), acpSessionId: external,
      load: true, parentSessionId: s.id,
      open: async (client, session, init) => {
        if (!init.agentCapabilities?.loadSession) throw new Error('Tool kann Sessions nicht laden');
        return session.load(() => client.loadSession(external));
      },
    });
    for (const a of state.all()) if (a.source === 'watch' && (watched.some((x) => x.id === a.id) || (w && a.parentId === w.id))) state.remove(a.id);
    return id;
  }

  // status: 'done' (Nutzer schließt), 'ended' (Server wird beendet)
  async function close(agentId, status = 'done') {
    const e = entry(agentId);
    sessions.delete(agentId);
    const a = e.session.get();
    await e.session.close();
    // alle Terminals der Session (Nutzer-Shell, Agenten- und Anzeige-Terminals) beenden
    try { pty?.closeAgent(agentId); } catch { /* bereits weg */ }
    for (const s of state.all()) if (s.parentId === agentId) state.remove(s.id);
    // Agent-Zeile mit Ende schreiben, bevor er aus dem Zustand verschwindet (der Recorder schreibt Entferntes nicht mehr sicher)
    try { if (a) repo?.upsertAgent?.({ ...(state.get(agentId) ?? a), status: 'done', lastActivity: Date.now() }); } catch { /* DB optional */ }
    state.remove(agentId);
    // fehlgeschlagene Übernahme: die externe (Watcher-)Session bleibt offen
    try { if (a?.sessionId && e.ownsSession) repo?.endSession?.(a.sessionId, status); } catch { /* DB optional */ }
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
    return { ok: true };
  }

  function setCityMode(agentId, cityMode) {
    const e = entry(agentId);
    e.session.setCityMode(cityMode);
    try { repo?.setSessionMode?.(e.session.get().sessionId, cityMode); } catch { /* DB optional */ }
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

  // Server-Ende: laufende Sessions gelten als „ended“ (lassen sich im Archiv fortsetzen)
  async function stopAll() {
    // zuerst in der DB vermerken (das Beenden der Prozesse kann länger dauern als der Server wartet)
    for (const e of sessions.values()) {
      const sid = e.session.get()?.sessionId;
      try { if (sid && e.ownsSession) repo?.endSession?.(sid, 'ended'); } catch { /* DB optional */ }
    }
    await Promise.all([...sessions.keys()].map((id) => close(id, 'ended').catch(() => {})));
  }

  return { createSession, adopt, resume, canLoad, close, prompt, cancel, setMode, setCityMode, answerPermission, get, has, stopAll, sessions };
}
