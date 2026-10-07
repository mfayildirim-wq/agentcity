# Agent Arena v2 – Entwurf

Stand: 07.10.2026 · Status: umgesetzt (07.10.2026, v0.2.0)

## Ziel

Aus der reinen Beobachtung (v1) wird eine Arbeitsumgebung: Der Nutzer startet Agenten verschiedener
Tools (Claude Code, Codex, OpenCode, Hermes, Gemini, weitere), spricht mit ihnen, sieht live, woran sie
arbeiten, bestätigt Rückfragen im Browser, hält Besprechungen ab, verteilt Aufgaben und kann alles
später im Verlauf nachsehen. Weitere Tools lassen sich ohne Code hinzufügen.

## Grundentscheidungen

| Frage | Entscheidung | Begründung |
|---|---|---|
| Steuerprotokoll | **Agent Client Protocol (ACP)** über stdio | Alle Zieltools sprechen es (eingebaut oder per Adapter); einheitliche Ereignisse für Chat, Werkzeuge, Pläne, Diffs, Berechtigungen |
| Bedienung | Terminal **und** Chat pro Session | Chat für Komfort und Besprechungen, Terminal (xterm + node-pty) für volle CLI |
| Rückfragen | im Browser bestätigen | Nutzer behält Kontrolle; Figur hebt die Hand, Karte mit Erlauben/Immer/Ablehnen |
| Datenhaltung | SQLite (`node:sqlite`, in Node ≥ 22 eingebaut) | Keine Fremdabhängigkeit, Verlauf und Archiv |
| Transport Browser ↔ Server | WebSocket (Paket `ws`) | Bidirektional: Chat, Bestätigungen, Terminal |
| Externe Sessions | weiter per Dateibeobachtung (wie v1) | Sessions aus dem eigenen Terminal bleiben sichtbar; „Übernehmen“ setzt sie per ACP `session/load` in der Arena fort |
| Erreichbarkeit | nur 127.0.0.1 + Zugangstoken | Keine fremde Webseite darf Agenten fernsteuern |

## Architektur

```
browser (public/)                       server/
┌──────────────────────────┐            ┌─────────────────────────────────────┐
│ world.js  3D-Szene       │  WebSocket │ api/ws.js      Nachrichten-Router    │
│ avatar.js Figuren        │◄──────────►│ acp/client.js  ACP über stdio        │
│ ui/      Liste, Detail,  │            │ acp/session.js Zustandsmaschine      │
│          Chat, Terminal, │            │ agents/registry.js Tool-Liste        │
│          Meeting, Board, │            │ pty/manager.js Terminals            │
│          Timeline        │            │ watchers/*.js  externe Sessions      │
│ store.js  Zustand        │            │ db/            SQLite + Migrationen │
└──────────────────────────┘            │ core/model.js  einheitliches Modell │
                                        └─────────────────────────────────────┘
```

### Einheitliches Agentenmodell (`core/model.js`)

Alle Quellen (ACP, Watcher, Demo) erzeugen dieselben Objekte:

- `Agent { id, kind: main|sub, toolId, sessionId, parentId, projectId, title, model, status, tool, category, detail, startedAt, lastActivity, tokens, source: acp|watch|demo, controllable: bool }`
- `Status: idle | thinking | tool | waiting_user | waiting_permission | error | done`
- `Event { agentId, t, kind: text|tool|prompt|plan|diff|permission|error|status, payload }`
- `Permission { id, agentId, title, options[], raw }`
- `Plan { agentId, entries[{ content, status, priority }] }`
- `Task { id, title, description, status: open|active|waiting|done, assigneeId, meetingId, sourceMessageId }`
- `Meeting { id, title, participantIds[], messages[] }`

### Server-Module

- **agents/registry.js** – liest `config/agents.json` (vorinstalliert) und `~/.agent-arena/agents.json` (Nutzer).
  Eintrag: `{ id, name, command, args[], env, color, avatarStyle, acp: true, resumeArgs? }`.
  Vorinstalliert: Claude Code (`npx @agentclientprotocol/claude-agent-acp`), Codex (`npx @zed-industries/codex-acp`),
  OpenCode (`opencode acp`), Hermes (`hermes acp`), Gemini (`gemini --experimental-acp`).
  „Testen“ startet den Prozess, sendet `initialize`, meldet Erfolg/Fehler.
- **acp/client.js** – startet den Prozess, JSON-RPC über stdio, Methoden `initialize`, `session/new`, `session/load`,
  `session/prompt`, `session/cancel`, beantwortet `session/request_permission`, bedient `fs/*`- und `terminal/*`-Anfragen
  des Agenten (Lesen/Schreiben im Projektordner, Terminalbefehle über pty/manager).
- **acp/session.js** – übersetzt `session/update`-Ereignisse (agent_message_chunk, tool_call, tool_call_update, plan,
  diff, usage) in Modell-Ereignisse, führt den Agentenzustand, erkennt Subagenten (tool_call mit kind `agent`/`task`
  bzw. Claude-Watcher-Daten) und löst Berechtigungsanfragen auf.
- **pty/manager.js** – ein Terminal pro Session (`node-pty`), optional für den Nutzer sichtbar; Größe, Eingabe, Ausgabe über WS.
- **watchers/claude.js** – v1-Logik aus `server.js`, aufgeteilt; liefert Agenten mit `source: watch`.
  `watchers/codex.js`, `watchers/opencode.js`, `watchers/hermes.js` – lesen die jeweiligen Session-Ordner
  (`~/.codex/sessions`, `~/.local/share/opencode`, `~/.hermes/sessions`) für Titel, Status, letzte Aktivität.
- **db/** – `schema.sql`, `migrate.js`, `repo.js`. Tabellen: `projects, sessions, agents, events, messages,
  tool_calls, permissions, tasks, meetings, meeting_messages`. Ereignisse werden gebündelt (alle 500 ms) geschrieben.
- **api/ws.js** – Nachrichten (JSON, `{ type, ...}`):
  Client → Server: `session.create, session.prompt, session.cancel, session.adopt, permission.answer, pty.input,
  pty.resize, task.create|update|assign, meeting.create|message, settings.agents.save|test, history.query`.
  Server → Client: `snapshot, agent.update, event, permission.request, pty.output, task.update, meeting.update,
  error`. Verbindung erfordert das Token (steht in `~/.agent-arena/token`): Browser über das HttpOnly-Cookie
  `arena_token`, das die Startseite setzt (Origin muss Host und Port der Arena entsprechen); andere Clients per erster
  Nachricht `hello { token }`. Sonst Abbruch mit Code 4401.
- **api/http.js** – statische Dateien, `/vendor/*`, `/api/history/*` (Zeitstrahl, Archiv), `/api/health`.

### Browser

- **store.js** – Zustand aus Snapshot + Deltas; alle UI-Teile lesen daraus.
- **world.js / avatar.js** – wie v1 plus: Figur hebt die Hand bei `waiting_permission`, roter Ring bei `error`,
  Tür-Animation beim Start, Drag & Drop einer Figur zum Besprechungstisch, Fokus-Modus pro Raum.
- **ui/chat.js** – Leiste unten: Eingabe (mehrzeilig, ↑-Verlauf, `/`-Befehle an das Tool durchgereicht, Esc = abbrechen),
  gestreamte Antworten, Anhänge als Dateipfade. Bei `@name` in einer Besprechung gezielte Ansprache.
- **ui/terminal.js** – xterm.js im Detailbereich, Umschalter Chat ⇄ Terminal.
- **ui/permission.js** – Karte mit Titel, Werkzeug, Details (Befehl/Datei/Diff), Knöpfe Erlauben / Immer erlauben
  (für dieses Werkzeug in dieser Session) / Ablehnen; Ton + Markierung in der Liste.
- **ui/detail.js** – Reiter: Aktivität (Verlauf), Plan (Haken), Änderungen (Diff-Vorschau), Terminalausgaben, Subagenten.
- **ui/meeting.js** – Gruppen-Chat mit Teilnehmern, „Aufgabe daraus machen“ an jeder Nachricht.
- **ui/board.js** – Spalten Offen / In Arbeit / Wartet auf dich / Erledigt; Zuweisen per Auswahl, Karte ↔ Figur verknüpft.
- **ui/timeline.js** – Zeitstrahl pro Raum, Scrubben zeigt Zustände aus der DB; Archiv beendeter Sessions mit „Fortsetzen“.
- **ui/settings.js** – Agenten-Tools anlegen/bearbeiten/testen, Standard-Modus (Bestätigen/Auto) pro Tool.

## Abläufe

**Neue Session:** „+“ → Tool, Projektordner (Dateiauswahl mit Verlauf), Modus → Server startet ACP-Prozess mit `cwd`,
legt Projekt/Session in DB an, sendet `agent.update` → Raum entsteht, Figur betritt ihn durch die Tür.

**Prompt:** Chat-Eingabe → `session.prompt` → ACP `session/prompt` → Chunks als `event text` → Sprechblase + Chatverlauf.
Werkzeugaufrufe → `event tool` → Figur geht zur Station. Plan → Detailreiter.

**Berechtigung:** ACP `session/request_permission` → DB + `permission.request` → Karte, Hand hoch → Antwort →
ACP-Response; „Immer erlauben“ merkt sich Werkzeug+Session im Server.

**Subagent:** ACP tool_call `kind: agent`/`task` (oder Watcher) → Sub-Agent mit `parentId`, erscheint neben dem
Erzeuger, geht zur Station, verschwindet 3 min nach Ende.

**Besprechung:** Figuren an den Tisch (Drag oder Knopf) → Meeting in DB → Nutzer-Nachricht geht als Prompt an alle
Teilnehmer (oder nur `@name`), mit Kontext „Du bist in einer Besprechung mit …“. Antworten werden im Meeting
gesammelt. „Aufgabe erstellen“ legt Task an; „Zuweisen“ schickt den Task als Prompt an den Agenten und setzt
Status `active`; Agentenstatus `done`/`waiting_user` setzt Task auf `waiting`; Nutzer hakt ab.

**Übernehmen:** externe Claude-/Codex-Session → `session.adopt` → Server startet den ACP-Adapter im Ordner der Session
und lädt sie per `session/load <id>`, Watcher-Agent wird durch steuerbaren ersetzt.

**Fehler:** Prozess-Exit ≠ 0 oder JSON-RPC-Fehler → Status `error`, Karte „Neu starten / Fortsetzen / Schließen“.
Verbindungsabbruch WS → Banner, automatische Wiederverbindung mit Snapshot.

## Nicht in v2

Import echter Meeting-Transkripte, Mehrbenutzer-Zugriff, Fernzugriff über das Netz, Cloud-Synchronisation.

## Tests

- Server: `node --test` für Registry, ACP-Zustandsmaschine (mit aufgezeichneten ACP-Ereignissen), DB-Repo, WS-Router.
- Fake-ACP-Agent (`test/fake-agent.js`) für End-to-End ohne echte Tools: Prompt → Chunks → Permission → Antwort.
- Browser: manuelle Testliste je Paket, Demo-Modus bleibt erhalten.

## Pakete

1. Server-Umbau (Module, WS, Token, SQLite, Watcher aus v1 übernommen, Frontend auf WS umgestellt)
2. ACP-Client + Claude Code: Session starten, Chat, Berechtigungen, Plan/Diff, Fake-Agent-Tests
3. Registry mit Codex/OpenCode/Hermes/Gemini, Einstellungen zum Hinzufügen/Testen, weitere Watcher
4. Terminal (pty + xterm), Übernehmen externer Sessions
5. Besprechung + Aufgaben-Board
6. Verlauf: Zeitstrahl, Archiv, Fortsetzen
