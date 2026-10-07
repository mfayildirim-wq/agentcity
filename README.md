# Agent Arena

3D-Live-Visualisierung deiner Claude-Code-Sessions im Browser. Jede Session ist eine Figur,
jeder Subagent eine eigene Figur, jedes Projekt ein eigener Raum.

## Start

```bash
npm install
npm start          # → http://127.0.0.1:4317 (Node ≥ 22.13)
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

Der Server (`server/index.js`, Node ≥ 22.13, ESM ohne Build-Schritt) liest
`~/.claude/projects/**/*.jsonl` inkrementell mit (`server/watchers/claude.js`), inkl.
`<session>/subagents/agent-*.jsonl` + `.meta.json`, führt den Zustand aller Agenten im Speicher
und schickt Änderungen per WebSocket (`/ws`) an den Browser. Verlauf und Ereignisse landen in
SQLite (`node:sqlite`). Das Frontend (`public/`, Three.js) hält einen Store und baut daraus die Szene.

```
server/
  index.js          Start: Konfig, DB, Watcher, HTTP + WebSocket
  config.js         Pfade, Port, Token
  core/             Modell, Ereignisbus, Zustand
  db/               Schema, Migration, Repo, Recorder
  watchers/         externe Sessions (Claude Code)
  api/              HTTP, WebSocket-Router, Handler
public/js/          main, store, ws, world, avatar, demo, ui/*
test/               node --test
```

## Daten und Sicherheit

- Ablage in `~/.agent-arena/`: `token` (Zugangstoken, Modus 0600), `arena.db` (SQLite)
- Server nur auf 127.0.0.1; fremde Host-/Origin-Header werden abgewiesen
- WebSocket nur mit Token (`hello { token }` oder Cookie `arena_token`, das die Startseite setzt),
  sonst Abbruch mit Code 4401
- Terminals führen echte Shell-Befehle aus (node-pty). Deshalb gilt für `pty.*` dieselbe Absicherung wie für die
  Agentensteuerung: nur über den authentifizierten WebSocket (Token bzw. Cookie), nur von der Arena-Seite selbst
  (Origin = Host und Port der Arena), Server nur auf 127.0.0.1. Nutzer-Shells gibt es nur für steuerbare Sessions,
  im Projektordner des Agenten; Agenten-Terminals (`terminal/*`) laufen nur innerhalb des Projektordners, sind im
  Browser schreibgeschützt und enden mit der Session
- Es werden keine Daten verschickt

## Entwicklung

```bash
npm run dev        # mit Neustart bei Änderungen
npm test           # node --test
```

## Optionen

| Variable              | Standard              | Bedeutung                          |
|-----------------------|-----------------------|------------------------------------|
| `PORT`                | 4317                  | Port                               |
| `WINDOW_MIN`          | 90                    | Sessions der letzten N Minuten     |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects`  | Quelle der Transkripte             |
| `ARENA_DATA_DIR`      | `~/.agent-arena`      | Token und Datenbank                |
| `ARENA_DB`            | `<ARENA_DATA_DIR>/arena.db` | SQLite-Datei                 |
