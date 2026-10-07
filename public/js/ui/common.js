// Gemeinsame Icons und Hilfen der UI-Module

export const ICON = {
  rooms: 'M3 9l9-6 9 6v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM9 21V12h6v9',
  agent: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  sub: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M22 11h-6',
  bolt: 'M13 2 3 14h9l-1 8 10-12h-9z',
  close: 'M6 6l12 12M18 6 6 18',
  prompt: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  text: 'M4 6h16M4 12h16M4 18h10',
};

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const DIAMOND = '<svg viewBox="0 0 32 32"><path d="M16 4 28 16 16 28 4 16Z"/></svg>';
