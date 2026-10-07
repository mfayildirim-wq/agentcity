import { World } from './world.js';
import { UI } from './ui.js';
import { Demo } from './demo.js';

const params = new URLSearchParams(location.search);
let demo = null;
let live = null;
let lastLive = null;

const world = new World(document.getElementById('stage'), document.getElementById('labels'), {
  onSelect: (key) => select(key),
  onHover: () => {},
});
const ui = new UI({
  onSelect: (key) => select(key),
  onHover: (key) => {
    for (const [k, av] of world.avatars) av.hovered = k === key;
  },
});

window.__arena = { world, ui };

function select(key) {
  world.select(key);
  ui.select(key);
}

function apply(snap) {
  world.sync(snap.agents);
  ui.render(snap);
}

function connect() {
  live = new EventSource('/api/events');
  live.onmessage = (e) => {
    lastLive = JSON.parse(e.data);
    if (!demo) { ui.setConnection('live'); apply(lastLive); }
  };
  live.onerror = () => { if (!demo) ui.setConnection('off'); };
}

function setDemo(on) {
  document.getElementById('btn-demo').classList.toggle('on', on);
  if (on && !demo) {
    select(null);
    demo = new Demo(apply);
    ui.setConnection('demo');
    demo.start();
  } else if (!on && demo) {
    demo.stop();
    demo = null;
    select(null);
    ui.setConnection(live?.readyState === 1 ? 'live' : 'off');
    apply(lastLive || { now: Date.now(), agents: [] });
  }
}

document.getElementById('btn-demo').addEventListener('click', () => setDemo(!demo));
document.getElementById('btn-empty-demo').addEventListener('click', () => setDemo(true));
document.getElementById('btn-reset').addEventListener('click', () => { select(null); world.resetView(); });
document.getElementById('btn-labels').addEventListener('click', (e) => {
  const on = !world.labelsVisible;
  world.setLabelsVisible(on);
  e.currentTarget.classList.toggle('on', !on);
});
document.getElementById('btn-panel').addEventListener('click', (e) => {
  document.body.classList.toggle('panel-off');
  e.currentTarget.classList.toggle('on', document.body.classList.contains('panel-off'));
  updateInset();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') select(null);
  if (e.key === 'r' && !e.metaKey && !e.ctrlKey) { select(null); world.resetView(); }
});

function updateInset() {
  const off = document.body.classList.contains('panel-off') || window.innerWidth <= 760;
  world.setInset(off ? 0 : 272 + 24);
}
window.addEventListener('resize', updateInset);
updateInset();

connect();
if (params.has('demo')) setDemo(true);
