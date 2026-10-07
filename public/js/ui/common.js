// Gemeinsame Icons und Hilfen der UI-Module

export const ICON = {
  rooms: 'M3 9l9-6 9 6v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM9 21V12h6v9',
  agent: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  sub: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M22 11h-6',
  bolt: 'M13 2 3 14h9l-1 8 10-12h-9z',
  close: 'M6 6l12 12M18 6 6 18',
  prompt: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  text: 'M4 6h16M4 12h16M4 18h10',
  plus: 'M12 5v14M5 12h14',
  send: 'M5 12h14M13 6l6 6-6 6',
  stop: 'M7 7h10v10H7z',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  plan: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9',
  diff: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M12 10v6M9 18h6',
  power: 'M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0',
  restart: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  up: 'M12 19V5M6 11l6-6 6 6',
  hand: 'M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V5.5a1.5 1.5 0 0 1 3 0V13M17 9.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-2a6 6 0 0 1-5-2.7L4.3 14a1.5 1.5 0 0 1 2.5-1.7L8 14',
  thought: 'M12 3a7 7 0 0 0-4 12.7V18h8v-2.3A7 7 0 0 0 12 3zM9 21h6',
  legend: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8h.01M11 12h1v5h1',
  chevDown: 'M6 9l6 6 6-6',
  chevUp: 'M18 15l-6-6-6 6',
  check: 'M5 12l5 5 9-10',
  circle: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z',
  half: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 4v16',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z',
  test: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3M7.5 14h9',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  x: 'M6 6l12 12M18 6 6 18',
  terminal: 'M4 17l6-5-6-5M12 19h8',
  adopt: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3',
};

// Kurze Zeitangabe hh:mm
export const fmtTime = (t) => new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

// Minimal-Markdown für Agententext: Codeblöcke, Inline-Code, fett – alles andere bleibt Text
export function renderText(s) {
  const parts = String(s ?? '').split(/```/);
  return parts.map((p, i) => {
    if (i % 2) return `<pre>${esc(p.replace(/^[\w-]*\n/, ''))}</pre>`;
    return esc(p).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  }).join('');
}

// Zeilen-Diff (LCS) für kurze Vorschauen: [{ t: ' '|'+'|'-', s }]
export function lineDiff(oldText, newText, maxLines = 400) {
  const a = String(oldText ?? '').split('\n').slice(0, maxLines);
  const b = String(newText ?? '').split('\n').slice(0, maxLines);
  if (oldText == null) return b.map((s) => ({ t: '+', s }));
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: ' ', s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: '-', s: a[i++] });
    else out.push({ t: '+', s: b[j++] });
  }
  while (i < n) out.push({ t: '-', s: a[i++] });
  while (j < m) out.push({ t: '+', s: b[j++] });
  return out;
}

// Diff-Vorschau als HTML: nur geänderte Zeilen mit je einer Kontextzeile, max. `limit` Zeilen
export function diffHtml(oldText, newText, limit = 12) {
  const d = lineDiff(oldText, newText);
  const changed = (x) => x && x.t !== ' ';
  const keep = d.map((x, k) => changed(x) || changed(d[k - 1]) || changed(d[k + 1]));
  const rows = d.filter((_, k) => keep[k]);
  const shown = rows.slice(0, limit).map((x) => `<div class="dl ${x.t === '+' ? 'add' : x.t === '-' ? 'del' : ''}"><i>${x.t}</i>${esc(x.s)}</div>`).join('');
  const more = rows.length > limit ? `<div class="dl more">… ${rows.length - limit} weitere Zeilen</div>` : '';
  return `<div class="diff">${shown || '<div class="dl more">keine Änderung</div>'}${more}</div>`;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const DIAMOND = '<svg viewBox="0 0 32 32"><path d="M16 4 28 16 16 28 4 16Z"/></svg>';
