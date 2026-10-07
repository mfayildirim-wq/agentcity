// Einstieg: Szene, UI-Module, Store und WebSocket-Verbindung zusammenstecken
import { World } from './world.js';
import { Demo } from './demo.js';
import { createStore } from './store.js';
import { createConnection } from './ws.js';
import { AgentList } from './ui/list.js';
import { DetailCard } from './ui/detail.js';
import { renderStats } from './ui/stats.js';
import { renderLegend } from './ui/legend.js';
import { toast, showBanner, hideBanner } from './ui/toast.js';
import { ChatBar } from './ui/chat.js';
import { PermissionStack } from './ui/permission.js';
import { NewSessionDialog } from './ui/newsession.js';
import { SettingsPanel } from './ui/settings.js';
import { ShellView, OutputView } from './ui/terminal.js';
import { setTools, agentName, agentColor } from './config.js';
import { MeetingPicker, MeetingBar, meetingTitle } from './ui/meeting.js';
import { Board } from './ui/board.js';
import { Timeline } from './ui/timeline.js';
import { Archive } from './ui/archive.js';

const params = new URLSearchParams(location.search);
const store = createStore();
let demo = null;
let liveState = 'off'; // Zustand der WS-Verbindung, unabhängig vom Demo-Modus
let wasLive = false;

const $ = (id) => document.getElementById(id);
const statsEl = $('stats');
const emptyEl = $('empty');
const liveEl = $('live');

const select = (id) => store.select(id);
const hover = (id) => { for (const [k, av] of world.avatars) av.hovered = k === id; };

// Figuren steuerbarer Sessions lassen sich auf den Besprechungstisch ziehen
const dragInfo = (id) => {
  const a = store.state.agents.get(id);
  if (!a || a.source !== 'acp' || a.kind !== 'main' || !a.controllable || store.state.connection !== 'live') return null;
  return { name: agentName(a), color: agentColor(a) };
};
const world = new World($('stage'), $('labels'), { onSelect: select, onHover: () => {}, dragInfo, onDropMeeting: (id) => dropOnMeeting(id) });
const list = new AgentList($('list'), {
  onSelect: select, onHover: hover,
  onAdopt: (id) => { const a = store.state.agents.get(id); return a && sessionAction('adopt', a); },
});
// Terminals: Nutzer-Shell (Chat-Leiste) und schreibgeschützte Agenten-Ausgabe (Detailkarte)
const shell = new ShellView({
  store, toast,
  request: (type, payload) => conn.request(type, payload),
  send: (type, payload) => conn.send(type, payload),
});
const output = new OutputView({ store });
const detail = new DetailCard($('detail'), {
  onSelect: select,
  getDiffs: (id) => store.state.diffs[id],
  getTerminals: (id) => store.terminalsOf(id),
  onTerminals: (id) => loadTerminals(id),
  output,
  onAction: (kind, a) => sessionAction(kind, a),
});
renderLegend($('legend'));

// Live-Anfragen; im Demo-Modus gibt es keine steuerbaren Agenten
const request = (type, payload, timeoutMs) => conn.request(type, payload, timeoutMs).then((r) => r, (err) => {
  toast(err.message, 'error', 7000);
  throw err;
});
const quiet = (type, payload, timeoutMs) => conn.request(type, payload, timeoutMs);

const chat = new ChatBar($('chat'), {
  store,
  onSend: (agentId, text) => request('session.prompt', { agentId, text }),
  onCancel: (agentId) => request('session.cancel', { agentId }).catch(() => {}),
  onMode: (agentId, modeId) => request('session.setMode', { agentId, modeId }).catch(() => {}),
  onArenaMode: (agentId, arenaMode) => request('session.setArenaMode', { agentId, arenaMode }).catch(() => {}),
  onDeselect: () => select(null),
  shell,
});
const perms = new PermissionStack($('perms'), {
  onAnswer: (permissionId, optionId) => request('permission.answer', { permissionId, optionId }),
  onSelect: select,
});
const newSession = new NewSessionDialog($('newsession'), {
  store,
  request: quiet,
  toast,
  onCreated: (agentId) => select(agentId),
});

const settings = new SettingsPanel($('settings'), { request: quiet, toast });

// ---------------------------------------------------------------- Besprechungen und Aufgaben
const openMeeting = (id) => { store.setMeetingView(id); };
const meetingPicker = new MeetingPicker($('meetpick'), {
  store,
  onOpen: openMeeting,
  async onCreate({ title, participantIds }) {
    const res = await request('meeting.create', { title, participantIds });
    store.applyMeeting(res.meeting);
    openMeeting(res.meeting.id);
  },
});
const meetingBar = new MeetingBar($('meeting'), {
  store,
  onSend: (meetingId, text) => request('meeting.message', { meetingId, text }, 30_000),
  onParticipants: (meetingId, participantIds) => request('meeting.update', { meetingId, participantIds }),
  onCloseMeeting: (meetingId) => request('meeting.update', { meetingId, closed: true }).catch(() => {}),
  onLeave: () => store.setMeetingView(null),
  onCreateTask: async (task) => {
    const res = await request('task.create', task, 30_000);
    store.applyTask(res.task);
    const who = res.task.assigneeId && store.state.agents.get(res.task.assigneeId);
    toast(who ? `Aufgabe an ${agentName(who)} übergeben` : 'Aufgabe angelegt', 'info');
  },
  onSelect: (id) => { store.setMeetingView(null); select(id); },
});
const board = new Board($('board'), {
  store,
  onCreate: (t) => request('task.create', t).then((r) => store.applyTask(r.task)),
  onUpdate: (taskId, patch) => request('task.update', { taskId, ...patch }),
  onAssign: (taskId, agentId) => request('task.assign', { taskId, agentId }, 30_000).then((r) => store.applyTask(r.task)),
  onDelete: (taskId) => request('task.delete', { taskId }).then(() => store.applyTaskRemove(taskId)),
  onSelect: select,
  toast,
});
board.onToggle = (on) => $('btn-board').classList.toggle('on', on);

// ---------------------------------------------------------------- Verlauf: Zeitstrahl (Wiedergabe) und Archiv
// zurück zu Live: Live-Zustand wiederherstellen, gepufferte Nachrichten anwenden, frischen Snapshot holen
function goLive() {
  timeline.cancel(); // laufende Scrub-Schritte dürfen danach nichts mehr anwenden
  if (!store.state.playback) return;
  const lost = store.exitPlayback();
  // Puffer übergelaufen: Chat- und Terminal-Verlauf neu laden
  if (lost) {
    historyLoaded.clear();
    termsLoaded.clear();
    if (store.state.selected) setTimeout(() => loadChatHistory(store.state.selected), 50);
  }
  conn.resync();
}
const timeline = new Timeline($('timeline'), { store, request: quiet, onLive: goLive, toast });
const archive = new Archive($('archive'), {
  request: quiet,
  toast,
  async onResume(sessionId) {
    const res = await request('history.resume', { sessionId }, 90_000);
    goLive();
    select(res.agentId);
    toast('Session fortgesetzt', 'info');
  },
});
archive.onToggle = (on) => {
  $('btn-archive').classList.toggle('on', on);
  if (on && board.isOpen) { board.close(); $('btn-board').classList.remove('on'); }
};
const toggleTimeline = () => {
  if (!liveOnly()) return;
  timeline.toggle();
  if (timeline.isOpen) layoutTimeline();
  $('btn-timeline').classList.toggle('on', timeline.isOpen);
};
const toggleArchive = () => {
  if (!liveOnly()) return;
  archive.toggle();
};
// Zeitstrahl sitzt über der Chat- bzw. Besprechungsleiste: Abstand nach deren Höhe
function layoutTimeline() {
  const bar = ['chat', 'meeting'].map($).find((el) => !el.classList.contains('hidden'));
  const h = bar?.firstElementChild?.offsetHeight ?? 0;
  document.body.style.setProperty('--tl-bottom', `${12 + (h ? h + 8 : 0)}px`);
}
if (typeof ResizeObserver === 'function') {
  const ro = new ResizeObserver(() => { if (timeline.isOpen) layoutTimeline(); });
  ro.observe($('chat'));
  ro.observe($('meeting'));
}

// Figur auf ein Meeting-Pad gezogen: zur geöffneten (bzw. einzigen offenen) Besprechung hinzufügen, sonst neue
async function dropOnMeeting(agentId) {
  const a = store.state.agents.get(agentId);
  if (!a) return;
  const open = store.openMeetings();
  const target = store.state.meetings.get(store.state.meetingView) ?? (open.length === 1 ? open[0] : null);
  try {
    if (target) {
      if (!target.participantIds.includes(agentId)) {
        const res = await request('meeting.update', { meetingId: target.id, participantIds: [...target.participantIds, agentId] });
        store.applyMeeting(res.meeting);
        toast(`${agentName(a)} nimmt an „${meetingTitle(target)}“ teil`, 'info');
      }
      openMeeting(target.id);
    } else {
      const res = await request('meeting.create', { participantIds: [agentId] });
      store.applyMeeting(res.meeting);
      openMeeting(res.meeting.id);
    }
  } catch { /* Hinweis kam als Toast */ }
}

const liveOnly = () => {
  if (demo) { toast('Besprechungen und Aufgaben gibt es nur live', 'warn'); return false; }
  if (liveState !== 'live') { toast('Keine Verbindung zum Server', 'warn'); return false; }
  return true;
};

// Chatverlauf aus der DB nachladen (z. B. nach Neuladen der Seite), einmal je Agent
const historyLoaded = new Set();
function loadChatHistory(id) {
  const a = id && store.state.agents.get(id);
  if (!a || a.source !== 'acp' || a.kind !== 'main' || a.replay || historyLoaded.has(id) || store.state.connection !== 'live') return;
  historyLoaded.add(id);
  quiet('chat.history', { agentId: id, limit: 200 })
    .then((res) => store.applyChatHistory(id, res.messages))
    .catch(() => historyLoaded.delete(id));
}

// Agenten-Terminals (Liste + Puffer) vom Server holen – einmal je Agent und Verbindung
const termsLoaded = new Set();
function loadTerminals(id) {
  const a = id && store.state.agents.get(id);
  if (!a || a.source !== 'acp' || a.replay || termsLoaded.has(id) || store.state.connection !== 'live') return;
  termsLoaded.add(id);
  quiet('pty.list', { agentId: id })
    .then((res) => { store.applyTerminalList(id, res.terminals); output.reload(); })
    .catch(() => termsLoaded.delete(id));
}

// Detailkarte: Session beenden / neu starten / Terminal / übernehmen
async function sessionAction(kind, a) {
  if (kind === 'terminal') { chat.setView('term'); return; }
  try {
    if (kind === 'close') await request('session.close', { agentId: a.id });
    // externe Session übernehmen (session/load); Hinweis-Toast kommt vom Server
    if (kind === 'adopt') {
      const res = await request('session.adopt', { agentId: a.id }, 90_000);
      select(res.agentId);
    }
    if (kind === 'restart' && a.launch) {
      await request('session.close', { agentId: a.id }).catch(() => {});
      const res = await request('session.create', a.launch, 90_000);
      select(res.agentId);
    }
  } catch { /* Hinweis kam bereits als Toast */ }
}

if (params.has('debug')) window.__arena = { world, store };

// ---------------------------------------------------------------- Store → Oberfläche
store.subscribe((s, changes) => {
  // Tool-Farben/-Stile vor dem Abgleich der Figuren setzen
  if (changes.has('tools')) {
    setTools(s.tools);
    if (newSession.isOpen) newSession.drawTools();
    if (settings.isOpen) settings.load(); // Änderung aus einem anderen Fenster
  }
  const agents = store.agentList();
  // Teilnehmer offener Besprechungen bleiben am Tisch
  const meetingMoved = (changes.has('meetings') || changes.has('agents'))
    && world.setMeetingIds(store.openMeetings().flatMap((m) => m.participantIds));
  if (changes.has('agents') || changes.has('tools') || meetingMoved) {
    world.sync(agents);
    renderStats(statsEl, agents);
    emptyEl.classList.toggle('hidden', agents.length > 0);
  }
  if (changes.has('selected')) { world.select(s.selected); loadChatHistory(s.selected); }
  if (changes.has('agents') || changes.has('selected') || changes.has('diffs') || changes.has('tools') || changes.has('terminals')) {
    list.render(agents, s.selected);
    detail.render(agents, s.selected, store.now);
    if (changes.has('selected')) list.scrollTo(s.selected);
  }
  // Wiedergabe: Chat-/Besprechungsleiste und Berechtigungskarten ausgeblendet
  const playback = !!s.playback;
  if (changes.has('playback')) {
    document.body.classList.toggle('playback', playback);
    timeline.onPlayback(s.playback);
  }
  const meetingOn = !!(s.meetingView && s.meetings.has(s.meetingView));
  if (changes.has('meetingView') || changes.has('meetings') || changes.has('playback')) {
    chat.suppressed = meetingOn || playback;
    $('btn-meeting').classList.toggle('on', meetingOn);
  }
  if (changes.has('agents') || changes.has('selected') || changes.has('chats') || changes.has('meetingView') || changes.has('meetings') || changes.has('playback')) chat.render(s.selected, changes);
  if (changes.has('meetings') || changes.has('meetingView') || changes.has('agents') || changes.has('playback')) {
    meetingBar.render(meetingOn && !playback ? s.meetingView : null, changes);
    if (meetingPicker.isOpen && (changes.has('meetings') || changes.has('agents'))) meetingPicker.draw();
  }
  if (changes.has('tasks') || changes.has('agents') || changes.has('selected')) board.render();
  if (changes.has('permissions') || changes.has('agents')) perms.render(s.permissions, s.agents);
  if (timeline.isOpen && (changes.has('selected') || changes.has('meetingView') || changes.has('playback') || changes.has('meetings'))) layoutTimeline();
  if (changes.has('connection')) {
    liveEl.dataset.state = s.connection;
    liveEl.title = { live: 'Live verbunden', demo: 'Demo-Modus', off: 'Keine Verbindung' }[s.connection];
  }
});

// ---------------------------------------------------------------- Verbindung
const conn = createConnection({
  onMessage(msg) {
    if (msg.type === 'toast') { toast(msg.text, msg.level); return; }
    if (msg.type === 'error') { toast(msg.message, 'error'); return; }
    if (demo) return; // im Demo-Modus werden Live-Daten ignoriert; beim Verlassen kommt ein frischer Snapshot
    store.dispatch(msg);
  },
  onStatus(st, info) {
    liveState = st;
    if (st === 'live') {
      hideBanner();
      // nach Wiederverbindung Terminal-Puffer neu holen (Ausgabe während der Trennung)
      if (wasLive) {
        termsLoaded.clear();
        shell.resync();
        if (store.state.selected && detail.tab === 'terms') setTimeout(() => loadTerminals(store.state.selected), 50);
      }
      wasLive = true;
    } else if (wasLive || info?.code === 4401) {
      showBanner(info?.code === 4401 ? 'Zugang abgelehnt – melde neu an …' : 'Verbindung getrennt – verbinde neu …');
    }
    if (!demo) store.setConnection(st);
  },
});
if (window.__arena) window.__arena.conn = conn;

// ---------------------------------------------------------------- Demo-Modus
function setDemo(on) {
  $('btn-demo').classList.toggle('on', on);
  if (on && !demo) {
    timeline.close();
    $('btn-timeline').classList.remove('on');
    archive.close();
    store.clear();
    demo = new Demo(store);
    store.setConnection('demo');
    demo.start();
  } else if (!on && demo) {
    demo.stop();
    demo = null;
    store.clear();
    store.setConnection(liveState);
    conn.resync();
  }
}

$('btn-demo').addEventListener('click', () => setDemo(!demo));
$('btn-empty-demo').addEventListener('click', () => setDemo(true));
const openNew = () => {
  if (demo) setDemo(false);
  if (liveState !== 'live') { toast('Keine Verbindung zum Server', 'warn'); return; }
  newSession.toggle();
};
$('btn-new').addEventListener('click', openNew);
$('btn-empty-new').addEventListener('click', openNew);
$('btn-settings').addEventListener('click', () => {
  if (liveState !== 'live') { toast('Keine Verbindung zum Server', 'warn'); return; }
  if (newSession.isOpen) newSession.close();
  settings.toggle();
});
const toggleMeetingPicker = () => {
  if (!liveOnly()) return;
  if (newSession.isOpen) newSession.close();
  meetingPicker.toggle();
};
const toggleBoard = () => {
  if (!board.isOpen && archive.isOpen) archive.close();
  board.toggle();
  $('btn-board').classList.toggle('on', board.isOpen);
};
$('btn-meeting').addEventListener('click', toggleMeetingPicker);
$('btn-timeline').addEventListener('click', toggleTimeline);
$('btn-archive').addEventListener('click', toggleArchive);
$('btn-board').addEventListener('click', toggleBoard);
// Klick außerhalb schließt die Besprechungsauswahl
document.addEventListener('pointerdown', (e) => {
  if (meetingPicker.isOpen && !e.target.closest('#meetpick, #btn-meeting')) meetingPicker.close();
});
$('btn-legend').addEventListener('click', (e) => {
  const el = $('legend');
  el.classList.toggle('hidden');
  e.currentTarget.classList.toggle('on', !el.classList.contains('hidden'));
});
$('btn-reset').addEventListener('click', () => { select(null); world.resetView(); });
$('btn-labels').addEventListener('click', (e) => {
  const on = !world.labelsVisible;
  world.setLabelsVisible(on);
  e.currentTarget.classList.toggle('on', !on);
});
$('btn-panel').addEventListener('click', (e) => {
  document.body.classList.toggle('panel-off');
  e.currentTarget.classList.toggle('on', document.body.classList.contains('panel-off'));
  updateInset();
});
window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, [contenteditable]')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') {
    // laufenden Scrub (Daten werden noch geladen) ebenfalls verwerfen
    const scrubbing = timeline.isOpen && timeline.busy;
    if (store.state.playback || scrubbing) goLive();
    else if (meetingPicker.isOpen) meetingPicker.close();
    else if (settings.isOpen) settings.close(); else if (newSession.isOpen) newSession.close();
    else if (store.state.meetingView) store.setMeetingView(null);
    else select(null);
  }
  if (e.key === 'b' && !newSession.isOpen && !settings.isOpen) { e.preventDefault(); toggleMeetingPicker(); }
  if (e.key === 't' && !newSession.isOpen && !settings.isOpen) { e.preventDefault(); toggleBoard(); }
  if (e.key === 'r') { select(null); world.resetView(); }
  if (e.key === 'z' && !newSession.isOpen && !settings.isOpen) { e.preventDefault(); toggleTimeline(); }
  if (e.key === 'a' && !newSession.isOpen && !settings.isOpen) { e.preventDefault(); toggleArchive(); }
  // Wiedergabe: Pfeiltasten springen 10 s (mit Umschalt 1 min)
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && timeline.isOpen && store.state.playback) {
    e.preventDefault();
    timeline.step((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 60_000 : 10_000));
  }
  if (e.key === 'n' && !newSession.isOpen && !settings.isOpen && !perms.list.length) { e.preventDefault(); openNew(); }
});

function updateInset() {
  const off = document.body.classList.contains('panel-off') || window.innerWidth <= 760;
  world.setInset(off ? 0 : 272 + 24);
}
window.addEventListener('resize', updateInset);
updateInset();

if (params.has('demo')) setDemo(true);
