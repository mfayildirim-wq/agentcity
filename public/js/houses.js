// Häuser: ein Haus ist ein Auftrag (Hauptagent + Subagenten), nicht der Projektordner.
// Reine Funktionen ohne DOM/Three – auch in Tests importierbar.

// an einer Wortgrenze kürzen, mit „…“ als Hinweis
function trunc(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  // mitten im Wort abgeschnitten → bis zum letzten Leerzeichen zurück
  const head = /\s/.test(s[n]) ? cut : cut.replace(/\s*\S*$/, '');
  return `${head.trimEnd()} …`;
}

const byStart = (x, y) => (x.startedAt || 0) - (y.startedAt || 0);
const oldestMain = (agents) => agents.filter((a) => a.kind === 'main').sort(byStart)[0];

// Haus eines Agenten; ältere Quellen ohne Feld fallen auf die Session, dann den Ordner zurück
export const houseOf = (a) => a.house ?? a.sessionId ?? a.project ?? 'ohne';

// Name aus dem ältesten Hauptagenten: Titel, sonst erster Prompt (gekürzt), sonst Ordnername
export function houseName(agents) {
  const m = oldestMain(agents) ?? agents[0];
  if (!m) return 'Haus';
  if (m.title) return m.title;
  if (m.lastPrompt) return trunc(m.lastPrompt.replace(/\s+/g, ' ').trim(), 52);
  return m.project || 'Haus';
}

// Map Haus-Id → Agenten (Reihenfolge des ersten Auftretens)
export function groupByHouse(agents) {
  const g = new Map();
  for (const a of agents) {
    const k = houseOf(a);
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(a);
  }
  return g;
}

// Liste für den Dialog „Neue Session“: nur Häuser mit laufendem Hauptagenten
export function housesFor(agents) {
  return [...groupByHouse(agents)].map(([id, list]) => {
    const main = oldestMain(list);
    return main ? { id, name: houseName(list), cwd: main.cwd, project: main.project, count: list.length } : null;
  }).filter(Boolean);
}
