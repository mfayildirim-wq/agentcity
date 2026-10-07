// Kennzahlen in der Kopfleiste
import { svgIcon } from '../config.js';
import { ICON } from './common.js';

export function renderStats(el, agents) {
  const rooms = new Set(agents.map((x) => x.project)).size;
  const mains = agents.filter((x) => x.kind === 'main').length;
  const subs = agents.filter((x) => x.kind === 'sub' && x.status !== 'done').length;
  const busy = agents.filter((x) => x.status === 'tool' || x.status === 'thinking').length;
  el.innerHTML = [
    [ICON.rooms, rooms, 'Projekte'],
    [ICON.agent, mains, 'Sessions'],
    [ICON.sub, subs, 'aktive Subagenten'],
    [ICON.bolt, busy, 'arbeiten gerade'],
  ].map(([ic, n, t]) => `<span class="stat" title="${t}">${svgIcon(ic)}<b>${n}</b></span>`).join('');
}
