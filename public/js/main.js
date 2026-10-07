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

const world = new World($('stage'), $('labels'), { onSelect: select, onHover: () => {} });
const list = new AgentList($('list'), { onSelect: select, onHover: hover });
const detail = new DetailCard($('detail'), { onSelect: select });
renderLegend($('legend'));

window.__arena = { world, store };

// ---------------------------------------------------------------- Store → Oberfläche
store.subscribe((s, changes) => {
  const agents = store.agentList();
  if (changes.has('agents')) {
    world.sync(agents);
    renderStats(statsEl, agents);
    emptyEl.classList.toggle('hidden', agents.length > 0);
  }
  if (changes.has('selected')) world.select(s.selected);
  if (changes.has('agents') || changes.has('selected')) {
    list.render(agents, s.selected);
    detail.render(agents, s.selected, store.now);
    if (changes.has('selected')) list.scrollTo(s.selected);
  }
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
      wasLive = true;
    } else if (wasLive || info?.code === 4401) {
      showBanner(info?.code === 4401 ? 'Zugang abgelehnt – Seite neu laden' : 'Verbindung getrennt – verbinde neu …');
    }
    if (!demo) store.setConnection(st);
  },
});
window.__arena.conn = conn;

// ---------------------------------------------------------------- Demo-Modus
function setDemo(on) {
  $('btn-demo').classList.toggle('on', on);
  if (on && !demo) {
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
  if (e.key === 'Escape') select(null);
  if (e.key === 'r' && !e.metaKey && !e.ctrlKey) { select(null); world.resetView(); }
});

function updateInset() {
  const off = document.body.classList.contains('panel-off') || window.innerWidth <= 760;
  world.setInset(off ? 0 : 272 + 24);
}
window.addEventListener('resize', updateInset);
updateInset();

if (params.has('demo')) setDemo(true);
