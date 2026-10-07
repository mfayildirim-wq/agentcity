// Legende der Stationen
import { STATIONS, svgIcon } from '../config.js';

export function renderLegend(el) {
  el.innerHTML = Object.values(STATIONS)
    .map((s) => `<span style="--c:${s.color}" title="${s.label}">${svgIcon(s.icon)}<em>${s.label}</em></span>`)
    .join('');
}
