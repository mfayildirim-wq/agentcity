// Gemeinsame Konstanten für Szene und Oberfläche

export const STATIONS = {
  terminal:  { label: 'Terminal',     color: '#3fb67a', icon: 'M4 17l6-5-6-5M12 19h8' },
  workbench: { label: 'Werkbank',     color: '#4c8df6', icon: 'M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z' },
  library:   { label: 'Bibliothek',   color: '#d9a62e', icon: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5' },
  portal:    { label: 'Web-Portal',   color: '#2bb3c8', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z' },
  meeting:   { label: 'Besprechung',  color: '#d97757', icon: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8' },
  lounge:    { label: 'Lounge',       color: '#8a94a6', icon: 'M20 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v3M2 11a2 2 0 0 1 4 0v3h12v-3a2 2 0 0 1 4 0v6H2zM4 17v2M20 17v2' },
};

export const STATUS = {
  tool:     { label: 'arbeitet',       color: '#4c8df6' },
  thinking: { label: 'denkt nach',     color: '#9b8afb' },
  waiting:  { label: 'wartet auf dich', color: '#f0a33a' },
  idle:     { label: 'pausiert',       color: '#6b7587' },
  done:     { label: 'fertig',         color: '#3fb67a' },
};

export const CLAUDE_ORANGE = '#d97757';

// Farbpalette für Subagenten-Typen (gedeckt, gut unterscheidbar)
const SUB_COLORS = ['#5b8def', '#3fb6a8', '#c76fd8', '#e0a03a', '#6fbf5a', '#e36f8e', '#7f7ee8', '#4fb0d9', '#d2875a', '#9aa83a'];
const SKIN = ['#f2d3bd', '#e8bf9f', '#d6a07c', '#b77b55', '#8d5a3b', '#f5ddc9'];
const HAIR = ['#2b2018', '#4a3122', '#7a4d2c', '#c9a46a', '#1d1d24', '#8a8f99', '#a2482c'];

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function subColor(type) { return SUB_COLORS[hash(type || 'agent') % SUB_COLORS.length]; }
export function skinTone(key) { return SKIN[hash(key + 's') % SKIN.length]; }
export function hairTone(key) { return HAIR[hash(key + 'h') % HAIR.length]; }

export function agentColor(a) { return a.kind === 'main' ? CLAUDE_ORANGE : subColor(a.agentType); }

export function agentName(a) {
  if (a.kind === 'main') return a.title || 'Claude';
  return a.description || a.agentType || 'Subagent';
}

export function shortModel(m) {
  if (!m) return '–';
  const x = m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  return x.split('-').map((p, i) => (i === 0 ? p[0].toUpperCase() + p.slice(1) : p)).join(' ').replace(/ (\d+) (\d+)$/, ' $1.$2');
}

export function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + ' M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.0', '') + ' k';
  return String(n);
}

export function fmtAgo(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function svgIcon(path, cls = '') {
  return `<svg viewBox="0 0 24 24" class="ic ${cls}"><path d="${path}"/></svg>`;
}
