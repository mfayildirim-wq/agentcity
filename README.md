# Agent Arena

3D-Live-Visualisierung deiner Claude-Code-Sessions im Browser. Jede Session ist eine Figur,
jeder Subagent eine eigene Figur, jedes Projekt ein eigener Raum.

## Start

```bash
npm install
npm start          # → http://127.0.0.1:4317
```

Demo ohne laufendes Claude Code: http://127.0.0.1:4317/?demo (oder ▶-Knopf oben rechts).

## Was du siehst

| Station      | Werkzeuge                                         |
|--------------|---------------------------------------------------|
| Terminal     | Bash, Monitor, KillShell                          |
| Werkbank     | Edit, Write, NotebookEdit                         |
| Bibliothek   | Read, Grep, Glob, LSP, Skill                      |
| Web-Portal   | WebSearch, WebFetch, alle MCP-Tools               |
| Besprechung  | Agent/Task (hier entstehen Subagenten), SendMessage |
| Lounge       | wartet auf dich / pausiert                        |

- Orange Figur mit Raute = Hauptagent, kleinere farbige Figuren = Subagenten (Farbe je Agententyp)
- Gestrichelte Bögen verbinden Subagenten mit ihrem Erzeuger
- Ring am Boden = Status (blau/grün/… je Station, lila denkt, orange wartet auf dich)
- Klick auf Figur oder Listeneintrag → Kamera folgt, Detailkarte mit Modell, Tokens, Verlauf
- Tasten: `Esc` Auswahl aufheben, `R` Ansicht zurücksetzen

## Funktionsweise

`server.js` (ohne Abhängigkeiten) liest `~/.claude/projects/**/*.jsonl` inkrementell mit,
inkl. `<session>/subagents/agent-*.jsonl` + `.meta.json`, und streamt den Zustand per
Server-Sent Events. Das Frontend (`public/`, Three.js) baut daraus die Szene.
Nur lokal gebunden (127.0.0.1), es werden keine Daten verschickt.

## Optionen

| Variable              | Standard              | Bedeutung                          |
|-----------------------|-----------------------|------------------------------------|
| `PORT`                | 4317                  | Port                               |
| `WINDOW_MIN`          | 90                    | Sessions der letzten N Minuten     |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects`  | Quelle der Transkripte             |
