# Agent City v0.3 – Umsetzungsplan „Ergebnisse, Leinwand, CLI-Stapel“

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ergebnisse der Agenten (Webseiten, HTML, Text, Dateien) automatisch erkennen und als Vorschau im Ergebnis-Frame und auf einer Leinwand im Raum zeigen; Kopf-Text mit Auftrag und Tätigkeit; Klick auf Figur öffnet die CLI; alle CLIs als gestaffelter Kartenstapel.

**Architecture:** Server erkennt Artefakte aus vorhandenen Bus-Ereignissen (`server/core/artifacts.js`), speichert sie in SQLite, liefert Vorschauen über `/preview/<sessionId>/<relpfad>` und meldet sie per WS. Browser: Ergebnis-Frame (`ui/results.js`), Leinwand als `CSS3DObject` (`screen.js`, `CSS3DRenderer` als zweite Ebene), Kartenstapel (`ui/deck.js`) als Container für die bisherige Chat-/Meeting-Leiste.

**Tech Stack:** wie v0.2.0 (Node ≥ 22.13 ESM, `node:sqlite`, `ws`, Three.js inkl. `examples/jsm/renderers/CSS3DRenderer.js`, xterm). Keine neuen Pakete.

**Spezifikation:** `docs/superpowers/specs/2026-10-08-arena-v3-ergebnisse-design.md` – vor jeder Aufgabe lesen. Verbindliches WS-Protokoll v2 in `docs/superpowers/plans/2026-10-07-arena-v2.md`; neue Typen werden dort unter „v0.3-Nachträge“ ergänzt.

**Regeln:** wie v2-Plan (Deutsch in UI/Kommentaren, ESM ohne Build, Tests zuerst mit `npm test`, `node --check`, Design kompakt/dezent, Server nur 127.0.0.1, Login-Link, Commit je Task mit `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`). `?demo` muss nach jeder Aufgabe funktionieren. Fatihs Server läuft evtl. auf 4317 – Browser-Prüfungen auf **4318**.

---

## WS-Protokoll (v0.3-Nachträge, verbindlich)

```
Client → Server
artifact.list   { sessionId, limit? }     → artifact.list.result { artifacts[] }
artifact.open   { artifactId }            → artifact.open.result { ok }     (nur Browser-Origin)
artifact.seen   { sessionId }             → artifact.seen.result { ok }
Server → Client (Broadcast)
artifact.add    { artifact }
artifact.update { artifact }
snapshot.artifacts[]   (letzte 10 je laufender Session)
```

Artefakt-Objekt wie in der Spec (`id, sessionId, agentId, t, updatedAt, kind, title, url?, path?, previewUrl?, source, seen, ended?`).

---

## Paket 1 – Artefakte: Erkennung, DB, Vorschau, Frame

### Task 1.1: Modell, Erkennung, DB
**Files:** Create `server/core/artifacts.js`, `test/artifacts.test.js`; Modify `server/core/model.js` (createArtifact, KIND_BY_EXT), `server/db/schema.sql`, `server/db/migrate.js` (Tabelle + Index, idempotent), `server/db/repo.js` (`artifacts: upsert, forSession(sessionId, limit), markSeen(sessionId), purge(days)`), `server/db/retention.js` (Artefakte beendeter Sessions nach 180 Tagen), `server/core/bus.js` (`artifact.add`, `artifact.update` in BROADCAST_TYPES), `server/index.js` (Modul starten).
- [ ] `createArtifacts({ bus, state, repo, acp, config })` abonniert: `event` mit `kind:'diff'` (→ Datei), `session.turnEnd` (→ URLs/Pfade im Text), `event` mit `kind:'terminal'` + `pty.output` (→ localhost-URLs; Puffer pro PTY, Regex auf Zeilen), Port-Scan alle 5 s für Sessions mit Status `tool|thinking` (Funktion `listListeningPorts(pids)` injizierbar; Standard über `lsof -nP -iTCP -sTCP:LISTEN -a -p <pids>`; PIDs aus `acp.processGroupPids(agentId)` – im Manager ergänzen: Haupt-PID + PTY-PIDs).
- [ ] Dedup-Schlüssel: `sessionId + (path || url)`; Update setzt `updatedAt`, `seen=false`, Bus `artifact.update`; neu → `artifact.add`. Ausschlüsse und Limit 50 laut Spec. `previewUrl` nur für Pfade unter `cwd` (Realpath) und kind ≠ file.
- [ ] Tests: Diff → text-Artefakt mit previewUrl; zweiter Diff gleicher Pfad → update statt add; Text mit `http://localhost:3000` → web; Text mit `` `docs/out.md` `` (existiert in Temp-cwd) → text; `node_modules/x.js` ignoriert; URL ohne Ergebnis-Wort und nicht localhost ignoriert; Port-Scan mit gefälschter Funktion → web `http://localhost:5173`; Limit 50; Persistenz (`repo.artifacts.forSession`).
- [ ] Commit `feat(artifacts): Erkennung und Speicherung`.

### Task 1.2: Vorschau-Route und WS-Handler
**Files:** Create `server/api/preview.js`, `server/api/handlers/artifact.js`, `test/preview.test.js`; Modify `server/api/http.js` (Route `/preview/`), `server/api/handlers/index.js`, `server/api/ws.js` (Snapshot `artifacts`, `artifact.open` in die Origin-Pflichtliste).
- [ ] `/preview/<sessionId>/<relpfad>`: Cookie-Pflicht; `cwd` aus laufender Session oder DB; Realpath unter cwd; Content-Type nach Endung; HTML mit `Content-Security-Policy: sandbox allow-scripts allow-forms`; Text ≤ 2 MB, Bilder ≤ 20 MB, sonst 413; `Cache-Control: no-store`.
- [ ] Handler `artifact.list|open|seen`; `open`: `open -R <path>` bzw. `open <url>` per `spawn` ohne Shell (nur macOS; sonst Fehler „nicht unterstützt“).
- [ ] Tests: 401 ohne Cookie; 404 außerhalb cwd (`..%2f`, Symlink); CSP-Header bei `.html`; 413 bei großer Datei; `artifact.open` ohne Origin abgelehnt; Snapshot enthält `artifacts`.
- [ ] Commit `feat(api): Vorschau-Route und Artefakt-Handler`.

### Task 1.3: Ergebnis-Frame im Browser
**Files:** Create `public/js/ui/results.js`; Modify `public/js/store.js` (`artifacts: Map<sessionId, Artifact[]>`, apply add/update/list, `unseenCount(sessionId)`), `public/js/main.js`, `public/js/ui/chat.js` (Frame rechts an der Chat-Leiste einhängen, Umschalt-Icon „Ergebnisse“ mit Zähler), `public/js/ui/common.js` (kleiner Markdown-Renderer: Überschriften, Listen, Code, Links – nach `esc`), `public/css/panels.css`, `public/js/demo.js` (Beispiel-Artefakte: eine HTML-Seite als Data-URL-iframe, eine Markdown-Karte, eine PDF-Hinweiskarte).
- [ ] Frame laut Spec (Liste, Vorschau je kind, Knöpfe Öffnen/Link kopieren/Neuer Tab/Neu laden, einklappbar, `localStorage`-Zustand, auto-wählt neuestes).
- [ ] iframe-Regeln: Dateien `sandbox="allow-scripts allow-forms"`, externe/localhost `sandbox="allow-scripts allow-forms allow-same-origin"`; `onerror`/Timeout 4 s ohne `load` → Karte „im neuen Tab öffnen“.
- [ ] Browser-Prüfung (Port 4318, Claude-Session im Ordner agentcity): Prompt „Lege `docs/demo.html` mit einer kleinen Seite und `docs/demo.md` mit drei Zeilen an“ → zwei Artefakte erscheinen, HTML als Vorschau, MD gerendert, „Öffnen“ zeigt die Datei im Finder. Danach die Testdateien löschen (Prompt an den Agenten oder manuell) und Session schließen.
- [ ] Commit `feat(web): Ergebnis-Frame`.

---

## Paket 2 – Leinwand im Raum

### Task 2.1: CSS3D-Ebene und Leinwand
**Files:** Create `public/js/screen.js`; Modify `public/js/world.js` (zweiter Renderer `CSS3DRenderer` mit eigenem Container `#screens` zwischen `#stage` und `#labels`, `pointer-events` nur auf Leinwand-Elementen; Render-Aufruf im Loop; Resize), `public/js/room.js` (Monitore der Werkbank entfernen, Leinwand-Platzhalterfläche 4,8 × 2,7 an der Rückwand bei x = 0,6, Mitte y = 1,9; Werkbank bleibt), `public/index.html` (`<div id="screens">`), `public/css/app.css`.
- [ ] `Screen`-Klasse: `CSS3DObject` mit DOM (`.screen`): Inhalt je Artefakt (iframe `pointer-events:none`, Textkarte 40 Zeilen, Bild, Hinweiskarte), Chip „n Ergebnisse“ mit Ungesehen-Punkt, Leerzustand. `setArtifact(a | null)`, `setCount(n, unseen)`. Klick → Callback `onOpen(sessionId)`. Skalierung: DOM 960 × 540 px, `scale 0.005` → 4,8 × 2,7 Einheiten.
- [ ] `World.syncScreens(artifactsBySession, agents, selected)`: je Raum neuestes Artefakt (Raum = Projekt; bei ausgewähltem Agent dessen neuestes); maximal 4 iframes gleichzeitig (nach Kameradistanz), Rest Hinweiskarte; Räume außerhalb des Frustums: Inhalt pausieren (`display:none` des iframes).
- [ ] Wiedergabemodus: `syncScreens` bekommt Artefakte bis `t` (Store liefert `artifactsUntil(t)` aus `artifact.list` + Zeit).
- [ ] Prüfung: `?demo` zeigt in drei Räumen Leinwände (HTML, Markdown, Hinweis); Live mit Session aus Task 1.3; Klick auf Leinwand öffnet Chat + Frame.
- [ ] Commit `feat(web): Leinwand im Raum`.

---

## Paket 3 – Kopf-Text, Klick, CLI-Stapel

### Task 3.1: Kopf-Text und Klick
**Files:** Modify `public/js/avatar.js` (Label: `.tag-task`, `.tag-act`, `.tag-name`; `update(a, task)`), `public/js/world.js` (`sync` bekommt `tasks` für Auftrag-Zeile; Distanzstufen `data-dist="0|1|2"` am Label; Klick vs. Alt-Klick), `public/js/main.js` (Klick → `openDeck(agentId)`; Alt-Klick → select+focus), `public/css/app.css`.
- [ ] Zeile 1 Auftrag: aktive Aufgabe (`tasks` mit `assigneeId`, Status active/waiting, neueste) → Titel; sonst `lastPrompt` 60 Zeichen (Meeting-Präfix abschneiden: alles bis `]` entfernen); Subagent: `description`. Zeile 2 Tätigkeit laut Spec. „Namen aus“ → nur Zeile 2.
- [ ] Prüfung mit `?demo` und live.
- [ ] Commit `feat(web): Kopf-Text und Klick-Verhalten`.

### Task 3.2: CLI-Stapel
**Files:** Create `public/js/ui/deck.js`; Modify `public/js/ui/chat.js` (wird zu einer Karte: `ChatCard` mit `mount(el)`/`unmount()`, Terminal nur bei `front`), `public/js/ui/meeting.js` (`MeetingCard` analog), `public/js/ui/results.js` (hängt am Deck, nicht an der Chat-Leiste), `public/js/main.js`, `public/js/store.js` (`deck: { open, order: sessionIds[], front }`, `unread: Map<agentId, n>`), `public/index.html` (`#deck`), `public/css/panels.css`.
- [ ] Deck laut Spec: MRU-Reihenfolge, Versatz 24 px, scale 0,97/Stufe, max. 8 + Chip „+n“, Klick holt nach vorn (180 ms), `Tab`/`Shift+Tab`, `Esc` schließt, nur vordere Karte mit xterm, Ungelesen-Punkt + Aufleuchten bei `chat.message`/`permission.request` für hintere Karten; Frame rechts an der vorderen Karte.
- [ ] Öffnen: Klick auf Figur, Klick auf Leinwand, Auswahl in der Liste (steuerbare Session), `N` nach dem Anlegen, Besprechung öffnen. Auswahl eines Watcher-Agenten öffnet weiterhin nur die Detailkarte.
- [ ] Zeitstrahl-Abstand (`layoutTimeline`) auf das Deck umstellen.
- [ ] Browser-Prüfung (4318): drei Claude/Codex-Sessions + eine Besprechung → vier Karten gestaffelt, Klick/Tab wechselt, Terminal nur vorne, Antwort in hinterer Karte zeigt Punkt; `?demo` zeigt Stapel nicht (keine steuerbaren Sessions) aber Leinwände/Kopf-Text.
- [ ] Commit `feat(web): CLI-Stapel`.

### Task 3.3: Abschluss
**Files:** Modify `README.md` (Abschnitte Ergebnisse, Leinwand, Stapel, Tastenkürzel Tab/Shift+Tab, Alt-Klick), Spec-Status „umgesetzt“, `package.json` `0.3.0`, v2-Plan „v0.3-Nachträge“ vollständig.
- [ ] `npm test` grün, `?demo` ok, Live-Zyklus aus 1.3 + 3.2 einmal komplett.
- [ ] Commit `chore: v0.3.0`.

---

## Selbstprüfung gegen die Spec

Erkennung (diff/text/terminal/port) → 1.1 · Vorschau-Route + CSP → 1.2 · Frame → 1.3 · Leinwand CSS3D, Chip, 4-iframe-Limit, Wiedergabe → 2.1 · Kopf-Text zwei Zeilen + Distanzstufen → 3.1 · Klick/Alt-Klick → 3.1 · Stapel MRU/Tab/Ungelesen/Frame → 3.2 · Demo-Artefakte → 1.3 · README/Version → 3.3. Bezeichner: `artifactId`, `sessionId`, `previewUrl`, kinds `web|html|text|image|pdf|file`, sources `diff|text|terminal|port`.
