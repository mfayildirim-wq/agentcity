# Agent Arena

3D-Arbeitsumgebung für KI-Coding-Agenten im Browser. Jede Session ist eine Figur, jeder Subagent eine eigene
Figur, jedes Projekt ein eigener Raum. Agenten verschiedener Tools (Claude Code, Codex, OpenCode, Hermes, Gemini
und eigene) lassen sich starten, im Chat oder Terminal steuern, Rückfragen im Browser bestätigen, in Besprechungen
zusammenbringen, mit Aufgaben versorgen und später im Verlauf nachsehen und fortsetzen. Sessions, die du im eigenen
Terminal startest, erscheinen ebenfalls (Dateibeobachtung) und lassen sich übernehmen.

## Start

```bash
npm install
npm start          # → http://127.0.0.1:4317 (Node ≥ 22.13)
```

Port belegt? `PORT=4318 npm start`. Demo ohne Agenten: http://127.0.0.1:4317/?demo (oder ▶-Knopf oben rechts).

Neue Session: „+“ (oder `N`) → Tool wählen, Projektordner (zuletzt verwendete oben), Modus *Bestätigen* (Rückfragen
im Browser) oder *Auto* (Rückfragen automatisch freigeben), optional Titel. Die Steuerung läuft über das
[Agent Client Protocol](https://agentclientprotocol.com) (ACP) per stdio.

## Was du siehst

| Station      | Werkzeuge                                                |
|--------------|----------------------------------------------------------|
| Terminal     | Shell-Befehle (Bash, exec …)                             |
| Werkbank     | Bearbeiten, Schreiben, Löschen, Verschieben              |
| Bibliothek   | Lesen, Suchen                                            |
| Web-Portal   | WebSearch, WebFetch, MCP-Tools                           |
| Besprechung  | Denken, Subagenten entstehen hier, Besprechungstisch     |
| Lounge       | wartet auf dich / pausiert                               |

- Hauptagenten in der Farbe ihres Tools (Figurenstil je Tool: Raute, Mütze, Kapuze, Schal, Visier), Subagenten
  kleiner in der Farbe ihres Typs, gestrichelte Bögen zum Erzeuger
- Ring am Boden = Status: Stationsfarbe beim Arbeiten, lila denkt, orange wartet auf dich; **Hand hoch** = braucht
  Erlaubnis; **roter Ring, sitzt am Boden** = Fehler
- Sprechblase zeigt den letzten Satz bzw. das aktuelle Werkzeug
- Klick auf Figur oder Listeneintrag → Kamera folgt, Detailkarte mit Reitern Aktivität, Plan, Änderungen (Diffs),
  Terminalausgaben und Subagenten
- Chat-Leiste unten für den ausgewählten steuerbaren Agenten: Enter sendet, Umschalt+Enter Zeilenumbruch, ↑/↓
  Verlauf, `/befehl` geht unverändert an das Tool, Esc bricht eine laufende Antwort ab; Modus des Tools und
  Arena-Modus (Bestätigen/Auto) in der Kopfzeile
- Berechtigungskarten unten rechts: Erlauben / Immer (für dieses Werkzeug in der Session) / Ablehnen, mit Befehl,
  Pfaden und Diff-Vorschau; kurzer Ton bei neuen Rückfragen

## Tools hinzufügen

Zahnrad oben rechts → „Agenten-Tools“: Tabelle aller Tools (installiert ✓/✗, aktiv), Bearbeiten/Neu mit `id`, Name,
Befehl, Argumente, Umgebungsvariablen (`KEY=VAL` je Zeile), Farbe und Figurenstil. „Testen“ startet den Prozess,
sendet `initialize` und zeigt Agent-Info bzw. Fehler. Vorinstalliert sind Claude Code
(`@agentclientprotocol/claude-agent-acp`), Codex (`@zed-industries/codex-acp`), OpenCode (`opencode acp`), Hermes
(`hermes acp`) und Gemini (`gemini --experimental-acp`). Eigene Einträge und Änderungen landen in
`~/.agent-arena/agents.json`, zum Beispiel:

```json
[{ "id": "mein-agent", "name": "Mein Agent", "command": "mein-agent", "args": ["acp"], "env": {},
   "color": "#4c8df6", "avatarStyle": "visor" }]
```

Einträge mit der `id` eines Standard-Tools überschreiben dieses; Löschen eines Standard-Tools deaktiviert es nur.

## Besprechung und Aufgaben

- **Besprechung** (Icon oder `B`): Teilnehmer wählen oder Figuren per Drag & Drop auf das Besprechungspad ziehen.
  Deine Nachricht geht an alle Teilnehmer, `@name` spricht gezielt an (Kurzname, Tool-Name, `@alle`). Die Antworten
  erscheinen im Besprechungsverlauf, Teilnehmer gehen an den Tisch. Jede Nachricht hat „Aufgabe daraus“.
- **Aufgaben-Board** (Icon oder `T`): Spalten Offen / In Arbeit / Wartet auf dich / Erledigt. Zuweisen über die
  Avatar-Auswahl schickt die Aufgabe als Prompt; der Status folgt danach dem Agenten. Karten lassen sich zwischen
  Spalten ziehen, „Erledigt“ setzt du selbst.

## Terminal

In der Chat-Leiste schaltet ein Icon zwischen Chat und Terminal um: eine echte Shell (`$SHELL -l`, node-pty) im
Projektordner der Session, eine je Agent, mit Wiederanzeige nach Neuladen. Befehle, die der Agent selbst ausführt,
erscheinen schreibgeschützt im Reiter „Terminalausgaben“ der Detailkarte.

## Übernehmen und Fortsetzen

- **Übernehmen:** Externe Claude- oder Codex-Sessions (im eigenen Terminal gestartet) zeigen ein
  Übernehmen-Icon. Die Arena startet den ACP-Adapter im Ordner der Session und lädt sie per `session/load`; danach
  steuerst du sie im Browser. Die CLI-Sitzung solltest du beenden, sonst schreiben zwei Prozesse.
- **Fortsetzen:** Beendete Sessions stehen im Archiv. „Fortsetzen“ (nur bei Tools, die Sessions laden können)
  startet einen neuen Prozess im gespeicherten Ordner, lädt den bisherigen Verlauf und legt eine neue Session mit
  Verweis auf die alte an.

## Verlauf

- **Zeitstrahl** (Uhr-Icon oder `Z`): über der Chat-Leiste, eine Spur je Raum, Marker für Prompts (orange),
  Berechtigungen (gelb), Fehler (rot) und Werkzeuge (grau, gebündelt). Zeitraum mit −/+ bzw. Strg/⌘+Rad (15 min bis
  24 h, Standard 90 min). Klicken oder Ziehen auf der Spur startet die **Wiedergabe**: Figuren zeigen den aus der
  Datenbank rekonstruierten Zustand (Status, Station, letzter Text), Chat und Rückfragen sind ausgeblendet,
  Live-Updates werden gepuffert. Banner „Wiedergabe hh:mm:ss“ mit „Live“-Knopf (oder `Esc`, oder ganz nach rechts
  ziehen) führt zurück; ←/→ springen 10 s (mit Umschalt 1 min).
- **Archiv** (Kasten-Icon oder `A`): beendete Sessions mit Projekt, Tool-Farbe, Datum, Dauer und Titel. Klick zeigt
  die Ereignisse, „Fortsetzen“ setzt sie fort (siehe oben).
- Eine Session endet beim Schließen (`done`), wenn der Agent-Prozess abbricht (`error`), wenn eine beobachtete
  externe Session aus dem Zeitfenster fällt (`ended`) und beim Beenden des Servers (`ended`).

## Tastenkürzel

| Taste            | Wirkung                                                                  |
|------------------|--------------------------------------------------------------------------|
| `N`              | Neue Session                                                             |
| `B`              | Besprechung (Auswahl öffnen/schließen)                                   |
| `T`              | Aufgaben-Board                                                           |
| `Z`              | Zeitstrahl                                                               |
| `A`              | Archiv                                                                   |
| `R`              | Ansicht zurücksetzen                                                     |
| `Esc`            | Wiedergabe beenden → Dialog/Besprechung schließen → Auswahl aufheben     |
| `←` / `→`        | in der Wiedergabe 10 s zurück/vor (`Umschalt`: 1 min)                    |
| `Y` / `N`        | erste Berechtigungskarte erlauben / ablehnen (wenn eine offen ist)       |
| Chat: `Enter`    | senden (`Umschalt+Enter` Zeilenumbruch, `↑`/`↓` Verlauf, `Esc` abbrechen)|

## Datenablage

Alles liegt in `~/.agent-arena/` (Ordner Modus 0700):

| Datei         | Inhalt                                                                         |
|---------------|--------------------------------------------------------------------------------|
| `token`       | Zugangstoken (32 Hex-Zeichen, Modus 0600), wird beim ersten Start erzeugt       |
| `agents.json` | eigene bzw. geänderte Agenten-Tools                                            |
| `arena.db`    | SQLite (`node:sqlite`): Projekte, Sessions, Agenten, Ereignisse, Nachrichten, Berechtigungen, Aufgaben, Besprechungen |

Ereignisse werden gebündelt (alle 500 ms) geschrieben; Diff-Texte werden nicht gespeichert (nur Pfad und
Zeilenzahlen). Beiträge von Besprechungen, die seit über 30 Tagen geschlossen sind, werden gelöscht.

## Sicherheit

- Server nur auf 127.0.0.1; fremde Host-/Origin-Header werden abgewiesen
- WebSocket nur mit Token: Browser über das HttpOnly-Cookie `arena_token` (setzt die Startseite, Origin muss Host
  und Port der Arena entsprechen), andere Clients per `hello { token }`; sonst Abbruch mit Code 4401
- Agenten lesen und schreiben Dateien (`fs/*`) nur im Projektordner; im Modus *Bestätigen* braucht jedes
  Werkzeug mit Rückfrage deine Erlaubnis
- Terminals führen echte Shell-Befehle aus (node-pty) und sind deshalb genauso abgesichert wie die
  Agentensteuerung. Nutzer-Shells gibt es nur für steuerbare Sessions, im Projektordner des Agenten;
  Agenten-Terminals sind im Browser schreibgeschützt und enden mit der Session
- Prompts an Teilnehmer einer Besprechung kennzeichnen Beiträge anderer Agenten als nicht vom Nutzer stammend
- Die Arena selbst verschickt keine Daten; was die Agenten-Tools senden, bestimmen diese

## Entwicklung

```bash
npm run dev        # mit Neustart bei Änderungen
npm test           # node --test (inkl. Fake-ACP-Agent test/fake-agent.js)
```

```
server/
  index.js          Start: Konfig, DB, Registry, Watcher, HTTP + WebSocket
  config.js         Pfade, Port, Token
  core/             Modell, Ereignisbus, Zustand, Besprechungen, Aufgaben
  agents/           Tool-Registry (Standard + ~/.agent-arena/agents.json)
  acp/              ACP-Client, Session-Zustandsmaschine, Manager (Start, Übernehmen, Fortsetzen)
  pty/              Terminals (node-pty)
  watchers/         externe Sessions: Claude Code, Codex, OpenCode, Hermes
  db/               Schema, Migration, Repo, Recorder
  api/              HTTP, WebSocket-Router, Handler (session, permission, pty, task, meeting, settings, history, …)
public/js/          main, store, ws, world, avatar, replay, demo, ui/*
test/               node --test
```

## Optionen

| Variable              | Standard                         | Bedeutung                              |
|-----------------------|----------------------------------|----------------------------------------|
| `PORT`                | 4317                             | Port                                   |
| `WINDOW_MIN`          | 90                               | beobachtete Sessions der letzten N min |
| `ARENA_DATA_DIR`      | `~/.agent-arena`                 | Token, Tools, Datenbank                |
| `ARENA_DB`            | `<ARENA_DATA_DIR>/arena.db`      | SQLite-Datei                           |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects`             | Claude-Code-Transkripte                |
| `CODEX_SESSIONS_DIR`  | `~/.codex/sessions`              | Codex-Sessions                         |
| `OPENCODE_DB`         | `~/.local/share/opencode/opencode.db` | OpenCode-Datenbank (nur lesend)   |
| `HERMES_DB`           | `~/.hermes/state.db`             | Hermes-Datenbank (nur lesend)          |

URL-Parameter: `?demo` startet den Demo-Modus, `?debug` legt `window.__arena` (Szene, Store, Verbindung) an.
