# Agent City v0.3 – Ergebnisse, Leinwand, CLI-Stapel

Stand: 08.10.2026 · Status: vom Nutzer freigegeben · Basis: v0.2.0 (`master` f58bc70)

## Ziel

Was Agenten erzeugen, wird sichtbar: Webseiten und HTML als Live-Vorschau, Textdateien gerendert, alles andere
als Hinweis mit Link. Die Ergebnisse erscheinen im Raum auf einer Leinwand und neben dem Chat in einem Ergebnis-Frame.
Über jeder Figur steht dauerhaft, woran sie arbeitet. Ein Klick auf die Figur öffnet ihre CLI. Alle CLIs liegen als
gestaffelter Kartenstapel übereinander, die aktive vorne.

## Entscheidungen

| Frage | Entscheidung |
|---|---|
| Ergebnis-Erkennung | Heuristik aus vorhandenen ACP-Daten (Diffs, URLs, Pfade, lauschende Ports); keine Mitarbeit des Agenten nötig |
| Vorschau in 3D | Echte HTML-Elemente in der Szene (Three.js `CSS3DRenderer`), keine Screenshots |
| Vorschau-Inhalte | Web/HTML: iframe · Text/Markdown/Code: gerendert · Bilder: direkt · PDF: iframe · sonst: Hinweiskarte + „Öffnen“ |
| CLI-Ansicht | Gestaffelte Karten (Stapel), aktive vorne; nur die vordere rendert ein Terminal |
| Kopf-Text | Zwei Zeilen dauerhaft (Auftrag, Tätigkeit) plus Sprechblase für Antworttexte |
| Klick auf Figur | öffnet den Stapel mit dieser Session vorne; Alt-Klick = nur auswählen/fokussieren |

## Modell

```js
Artifact {
  id, sessionId, agentId, t, updatedAt,
  kind: 'web' | 'html' | 'text' | 'image' | 'pdf' | 'file',
  title,            // Dateiname oder Seitentitel/Host
  url?,             // web: externe oder localhost-URL
  path?,            // Datei absolut (unter cwd der Session)
  previewUrl?,      // html/text/image/pdf: /preview/<sessionId>/<relpfad>
  source: 'diff' | 'text' | 'terminal' | 'port',
  seen: bool,
}
```

Tabelle `artifacts (id TEXT PRIMARY KEY, session_id, agent_id, t, updated_at, kind, title, url, path, source, seen INTEGER)`,
Index `artifacts_session (session_id, updated_at)`.

Dateiendung → kind: `.html/.htm` html · `.md .txt .json .yaml .yml .csv .log` und Code-Endungen (`.js .ts .tsx .jsx .py .css .sql .sh .go .rs .java .kt .swift .toml .xml`) text · `.png .jpg .jpeg .gif .svg .webp` image · `.pdf` pdf · sonst file.

## Erkennung (Server, `server/core/artifacts.js`)

Quellen, alle aus bereits vorhandenen Bus-Ereignissen:
- `event diff { path }` → Datei-Artefakt (kind nach Endung). Gleicher Pfad in derselben Session = dasselbe Artefakt, `updatedAt` steigt.
- `session.turnEnd { text }` → URLs (`https?://…`) und absolute bzw. relative Pfade, die unter `cwd` existieren. Relative Pfade nur, wenn sie in Backticks oder am Zeilenanfang stehen (keine Wortfragmente).
- `event terminal`/`pty.output` → URLs `http://localhost:<port>` bzw. `127.0.0.1:<port>`; gleiche URL = dasselbe Artefakt.
- `port`: Kindprozesse der Session (Prozessgruppe der ACP-Session und ihrer Terminals) lauschen auf einem TCP-Port → `web` mit `http://localhost:<port>`. Prüfung alle 5 s nur für Sessions mit Status `tool`/`thinking`, über `lsof -nP -iTCP -sTCP:LISTEN -a -p <pids>`; verschwindet der Port, bleibt das Artefakt (als „beendet“ markiert, `url` bleibt).

Ausschlüsse: Pfade unter `node_modules`, `.git`, `dist/`, `build/` und Lock-Dateien; URLs der Arena selbst (eigener Port) und bekannte API-Hosts (docs.*, api.* nur wenn sie in einer Antwort als Quelle genannt werden, nicht als Ergebnis – Heuristik: URL gilt als Ergebnis, wenn localhost, oder wenn der Text sie mit „erstellt/deployed/erreichbar/läuft“ in derselben Zeile nennt). Maximal 50 Artefakte pro Session, älteste fallen heraus.

WS: `artifact.add { artifact }`, `artifact.update { artifact }` (Broadcast), `artifact.list { sessionId }` → `{ artifacts[] }`,
`artifact.open { id }` (nur Browser-Origin; `open -R <path>` bei Dateien, `open <url>` bei web), `artifact.seen { sessionId }`.
Snapshot enthält `artifacts` der laufenden Sessions (letzte 10 je Session).

## Vorschau-Auslieferung (`server/api/preview.js`)

`GET /preview/<sessionId>/<relpfad>`: nur mit gültigem Cookie; Pfad per Realpath unter `cwd` der Session (laufend oder aus DB);
Content-Type nach Endung; `Content-Security-Policy: sandbox allow-scripts allow-forms` für HTML (kein `allow-same-origin`,
damit die Seite weder Cookie noch WS der Arena erreicht); `X-Frame-Options` nicht setzen (soll eingebettet werden);
Textdateien bis 2 MB, Bilder bis 20 MB, sonst 413. Markdown wird clientseitig gerendert (kleiner Renderer in `common.js`,
escaped vorher). Externe/localhost-URLs werden direkt im iframe mit `sandbox="allow-scripts allow-forms allow-same-origin"`
geladen (fremder Origin, kann die Arena ohnehin nicht erreichen); schlägt das Einbetten fehl (X-Frame-Options der Zielseite),
zeigt der Frame eine Karte mit Link „im neuen Tab öffnen“.

## Ergebnis-Frame (`public/js/ui/results.js`)

- Rechts neben der vorderen Karte des Stapels, gleiche Höhe, 360 px breit, einklappbar (Chevron), Zustand in `localStorage`.
- Liste: neueste oben, Icon je kind, Titel, Alter, Quelle als Tooltip; ungesehene mit Punkt. Klick wählt; das neueste wird
  automatisch gewählt, wenn der Nutzer nichts gewählt hat.
- Vorschau: web/html/pdf → iframe; text → gerenderter Text (Markdown) bzw. Code mit Zeilenumbruch; image → `<img>`;
  file → Hinweiskarte (Name, Größe, Pfad). Kopf: Titel, Knöpfe „Öffnen“ (`artifact.open`), „Link kopieren“, „Neuer Tab“, „Neu laden“.
- Öffnen des Frames markiert die Artefakte der Session als gesehen.

## Leinwand (`public/js/screen.js`, Änderungen in `room.js`)

- Die drei Werkbank-Monitore entfallen; stattdessen eine Leinwand (4,8 × 2,7 Einheiten) an der Rückwand jedes Raums,
  Werkbank-Station bleibt davor. Die Leinwand ist ein `CSS3DObject` (zweiter Renderer `CSS3DRenderer`, Ebene zwischen WebGL
  und Labels; WebGL-Platzhalterfläche dahinter für Schatten/Occlusion-Optik).
- Inhalt: neuestes Artefakt des Raums (über alle Sessions des Projekts); ist ein Agent des Raums ausgewählt, dessen neuestes.
  web/html → iframe (gleiche Regeln wie der Frame, aber ohne Interaktion: `pointer-events: none`, Klick auf die Leinwand öffnet
  den Stapel + Frame); text → Textkarte (erste ~40 Zeilen); image → Bild; file/pdf → Hinweiskarte mit Icon, Name, Art, „Öffnen“.
- Chip unten rechts auf der Leinwand: „n Ergebnisse“, Punkt bei ungesehenen. Leer: dezentes Logo, „Noch keine Ergebnisse“.
- Leistung: nur Leinwände im Kamerabereich und maximal 4 iframes gleichzeitig (weiter entfernte zeigen die Hinweiskarte).
- Wiedergabemodus: Leinwand zeigt den Stand zum Zeitpunkt (Artefakte bis `t`).

## Kopf-Text (`public/js/avatar.js`, Label)

- Zeile 1 **Auftrag**: Titel der zugewiesenen aktiven Aufgabe; sonst Kurzfassung des letzten Prompts (60 Zeichen); Subagenten:
  ihre `description`. Zeile 2 **Tätigkeit**: `Edit app.css`, `Bash npm test`, `WebSearch …`, oder Status („denkt nach“,
  „wartet auf dich“, „braucht Erlaubnis“, „fertig“). Darunter wie bisher der Name mit Statuspunkt.
- Sprechblase bleibt für Antworttexte (letzter Satz, 7 s). Bei „Namen aus“ (`btn-labels`) bleibt nur Zeile 2 sichtbar.
- Labels, die sich überlappen, werden nicht ausgewichen; dafür reduziert sich die Schriftgröße mit der Kameradistanz (3 Stufen).

## Klick auf die Figur (`world.js`, `main.js`)

- Linksklick: Session auswählen **und** Stapel öffnen mit dieser Karte vorne (bei Watcher-Agenten: Detailkarte wie bisher).
- Alt-Klick: nur auswählen und Kamera fokussieren (bisheriges Verhalten).
- Klick auf die Leinwand: Stapel + Frame öffnen mit der Session des gezeigten Artefakts.

## CLI-Stapel (`public/js/ui/deck.js`, ersetzt `chat.js`-Positionierung)

- Karten = alle steuerbaren Hauptsessions (`source acp`), dazu jede offene Besprechung. Jede Karte: Kopf (Avatar-Farbe,
  Name, Tätigkeit, Ungelesen-Punkt, Schließen), Inhalt = bisherige Chat-Leiste (Chat ⇄ Terminal, Modus-Umschalter, Eingabe).
- Anordnung unten mittig; Karten um 24 px nach oben/rechts versetzt, hintere leicht verkleinert (scale 0,97 je Stufe) und
  abgedunkelt; maximal 8 sichtbar, Rest als Chip „+n“ (Klick öffnet Liste). Reihenfolge = zuletzt aktiv vorne (MRU).
- Klick auf eine hintere Karte holt sie nach vorn (Animation 180 ms); `Tab`/`Shift+Tab` blättert, wenn kein Eingabefeld außerhalb
  des Stapels fokussiert ist; `Esc` schließt den Stapel. Nur die vordere Karte hält ein xterm; hintere zeigen nur den Kopf.
- Ungelesen: neue Agentenantwort oder Rückfrage in einer hinteren Karte → Punkt + kurzes Aufleuchten des Kopfes.
- Der Ergebnis-Frame hängt rechts an der vorderen Karte und wechselt mit ihr.
- Besprechungskarte: Inhalt = bisherige Meeting-Leiste.

## Nicht in v0.3

Editieren von Ergebnissen, Versionen von Dateien, automatische Screenshots, Vorschau außerhalb des Projektordners.

## Tests

- Server: Erkennung (Diff → Datei, Text mit URL/Pfad, Terminal mit localhost, Port-Scan mit gefälschter `lsof`-Funktion),
  Dedup/Update, Ausschlüsse, Limit 50; Preview-Route (Cookie, Realpath, CSP-Header, Größenlimit, 404 außerhalb); `artifact.open`
  nur mit Origin; DB-Persistenz und Snapshot.
- Browser (manuell + `node --check`): Frame, Leinwand mit iframe/Text/Hinweis, Kopf-Text, Klick, Stapel mit 3 Sessions,
  Wiedergabemodus, `?demo` (Demo liefert Beispiel-Artefakte).

## Pakete

1. Artefakt-Erkennung, DB, Preview-Route, WS, Ergebnis-Frame (am bisherigen Chat)
2. Leinwand mit CSS3DRenderer, Raumumbau, Chip, Wiedergabe
3. Kopf-Text, Klick-Verhalten, CLI-Stapel (Chat/Meeting-Leiste in Karten überführen), Demo-Artefakte, README
