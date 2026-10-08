# Häuser als Auftrag + Eingang durch die Tür – Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein Haus ist ein Auftrag (Hauptagent + Subagenten), nicht mehr der Projektordner. „Neue Session“ baut ein neues Haus oder fügt einen Agenten mit Kontext zu einem bestehenden Haus hinzu. Neue Figuren kommen von der Straße durch die Tür an der Vorderseite herein und gehen beim Verlassen wieder hinaus.

**Architecture:** Jeder Agent bekommt ein Feld `house` (Id). Standard: `house = sessionId` der Hauptsession; Subagenten erben das Haus des Hauptagenten; ein per `houseId` gestarteter Agent übernimmt Haus und Ordner des Hauses und erhält als ersten Prompt den Kontext des Hauses. Der Browser gruppiert Räume, Liste und Statistik nach `house`; der Hausname kommt aus Titel/erstem Prompt des ältesten Hauptagenten; der Ordnername bleibt als Untertitel. Die Welt setzt neue Hauptfiguren auf die Straße vor dem Haus und führt sie über den Türpunkt hinein.

**Tech Stack:** Node ≥ 22.13 ESM, `node:test`, SQLite (`node:sqlite`), Three.js (ohne Build), kein Framework im Browser.

**Konventionen (wie im Repo):** Kommentare und Texte auf Deutsch; Tests in `test/*.test.js` mit `node:test` + `node:assert/strict`; `npm test` muss grün bleiben; Commits klein und deutsch (`feat:`, `fix:`, `test:`), ohne Attribution-Zeilen des Nutzers zu verändern (siehe bestehende `git log`-Konvention: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` als letzte Zeile).

---

## Dateiübersicht

- Modify `server/core/model.js` – Feld `house` in `createAgent`.
- Modify `server/acp/session.js:154-160` – Subagent erbt `house`.
- Modify `server/acp/manager.js` – `launch({ house })`, `createSession({ houseId })` mit Kontext-Prompt, `resume` behält Haus.
- Modify `server/api/handlers/session.js` – `houseId` durchreichen.
- Modify `server/db/schema.sql`, `server/db/migrate.js`, `server/db/repo.js` – Spalte `house_id` in `sessions`; `createSession`, `listSessions`/Mapping liefern `houseId`.
- Modify `server/watchers/claude.js:384-386`, `server/watchers/opencode.js:186` – Subagenten erben `house` des Hauptagenten (wie `project`).
- Create `public/js/houses.js` – `houseOf(a)`, `houseName(mains)`, `groupByHouse(agents)`, `housesFor(agents)` (für den Dialog).
- Modify `public/js/world.js` – Räume nach Haus; Straße/Tür-Einlauf; Verlassen über die Tür.
- Modify `public/js/room.js` – `Room(id, world)`, `setName(name, project)`, Türrahmen, Konstante `STREET`.
- Modify `public/js/avatar.js:270-274` – `leave(points)` mit Wegpunkten.
- Modify `public/js/ui/list.js` – Gruppen nach Haus mit Ordner als Untertitel.
- Modify `public/js/ui/stats.js` – Hauszahl.
- Modify `public/js/ui/newsession.js` – Abschnitt „Haus“: neues Haus / bestehendes Haus.
- Modify `public/js/replay.js` – `house` aus der Session.
- Modify `public/js/demo.js` – `house` je Agent, zweites Haus im selben Ordner.
- Modify `public/css/app.css`, `public/css/panels.css` – Raumschild mit Untertitel, Hausliste im Dialog.
- Test `test/model.test.js`, `test/acp-session.test.js`, `test/ws-session.test.js`, `test/watcher-claude.test.js`, `test/db.test.js`, `test/replay.test.js`, `test/houses.test.js` (neu, reine Funktionen aus `public/js/houses.js` – sie sind framework-frei importierbar).

---

## Paket 1 – Server: Feld `house`

### Task 1.1: Modell und Subagenten

**Files:**
- Modify: `server/core/model.js:39-51`
- Modify: `server/acp/session.js:154-160`
- Test: `test/model.test.js`

- [x] **Step 1: Test schreiben** – in `test/model.test.js` anhängen:

```js
test('house: Standard ist die Session-Id, explizit überschreibbar', () => {
  const a = createAgent({ id: 'a1', toolId: 'claude', project: 'p', sessionId: 's1' });
  assert.equal(a.house, 's1');
  const b = createAgent({ id: 'a2', toolId: 'claude', project: 'p', sessionId: 's2', house: 'haus-x' });
  assert.equal(b.house, 'haus-x');
  const c = createAgent({ id: 'a3', toolId: 'claude', project: 'p' });
  assert.equal(c.house, null);
});
```

- [x] **Step 2: Test laufen lassen** – `node --test test/model.test.js` → FAIL (`a.house` ist `undefined`).

- [x] **Step 3: Implementieren** – in `createAgent` nach `project:` ergänzen:

```js
    project: p.project, cwd: p.cwd ?? null, title: p.title ?? null, description: p.description ?? null,
    // Haus = Auftrag: Standard ist die Hauptsession; Beitritt zu einem bestehenden Haus setzt die Id explizit
    house: p.house ?? p.sessionId ?? null,
```

In `server/acp/session.js` `createSub` (Zeile ~158): `parentId: id, project: main.project, house: main.house, cwd: main.cwd, …`.

- [x] **Step 4: Tests** – `node --test test/model.test.js` → PASS. `npm test` → grün.

- [x] **Step 5: Commit** – `git commit -am "feat(model): Feld house je Agent"`.

### Task 1.2: Watcher – Subagenten erben das Haus

**Files:**
- Modify: `server/watchers/claude.js:384-386`
- Modify: `server/watchers/opencode.js:186`
- Test: `test/watcher-claude.test.js`

- [x] **Step 1: Test** – in `test/watcher-claude.test.js` im bestehenden Test, der `main.project`/`sub.project === 'demo'` prüft (Zeile ~56), ergänzen:

```js
  assert.equal(main.house, main.sessionId);
  assert.equal(sub.house, main.house);
```

- [x] **Step 2: Laufen lassen** – FAIL, falls `sub.house` abweicht (Sub hat dieselbe sessionId wie main → könnte zufällig PASS sein; dann trotzdem Schritt 3 umsetzen, damit es explizit ist).

- [x] **Step 3: Implementieren** – claude.js:

```js
    const houseOf = new Map(out.filter((a) => a.kind === 'main').map((a) => [a.sessionId, a.house]));
    for (const a of visible) if (a.kind === 'sub') { a.project = projectOf.get(a.sessionId) || a.project; a.house = houseOf.get(a.sessionId) || a.house; }
```

opencode.js Zeile 186: beim Mapping der Subs zusätzlich `house: mains.get(a.parentId).house` (analog zu `project`).

- [x] **Step 4: Tests** – `npm test` → grün. **Step 5: Commit** – `feat(watch): Subagenten erben das Haus`.

### Task 1.3: DB-Spalte `house_id`

**Files:**
- Modify: `server/db/schema.sql:2-3`, `server/db/migrate.js`, `server/db/repo.js:41-56, 214`
- Test: `test/db.test.js`

- [x] **Step 1: Test** – in `test/db.test.js`:

```js
test('Session speichert house_id und liefert houseId', () => {
  const { repo } = fresh();
  repo.createSession({ id: 's9', toolId: 'claude', source: 'acp', houseId: 'haus-1' });
  assert.equal(repo.getSession('s9').houseId, 'haus-1');
  repo.createSession({ id: 's10', toolId: 'claude', source: 'acp' });
  assert.equal(repo.getSession('s10').houseId, 's10'); // Standard: eigenes Haus
});
```

(`fresh()` = Helfer der Datei, der eine frische DB + Repo anlegt – falls er anders heißt, den vorhandenen verwenden.)

- [x] **Step 2: FAIL prüfen.**

- [x] **Step 3: Implementieren** – schema.sql: `house_id TEXT` an `sessions` anhängen. migrate.js: wie die vorhandenen Migrationen eine prüfende `ALTER TABLE sessions ADD COLUMN house_id TEXT` (über `PRAGMA table_info(sessions)` prüfen, ob die Spalte fehlt). repo.js `createSession`: `house_id` einfügen mit `s.houseId ?? s.id`; Mapping der Session-Zeile: `houseId: r.house_id ?? r.id`; `listSessions`/Archiv-Abfragen liefern dadurch `houseId` mit.

- [x] **Step 4: Tests** – `npm test` grün. **Step 5: Commit** – `feat(db): house_id je Session`.

### Task 1.4: Session mit `houseId` starten (Beitritt) + Kontext-Prompt

**Files:**
- Modify: `server/acp/manager.js:46-118, resume`
- Modify: `server/api/handlers/session.js:7-13`
- Test: `test/acp-session.test.js`, `test/ws-session.test.js`

- [x] **Step 1: Test (Manager)** – in `test/acp-session.test.js` nach dem Muster der vorhandenen `createSession`-Tests mit dem Fake-Agenten:

```js
test('Beitritt: neue Session übernimmt Haus und Ordner und bekommt den Kontext als ersten Prompt', async () => {
  const first = await manager.createSession({ toolId: 'fake', cwd, mode: 'confirm', title: 'Webseite bauen' });
  await manager.prompt(first, 'mach eine Webseite');
  await waitFor(() => state.get(first).status === 'waiting_user');
  const second = await manager.createSession({ toolId: 'fake', cwd: '/irgendwo/anders', houseId: state.get(first).house });
  const b = state.get(second);
  assert.equal(b.house, state.get(first).house);
  assert.equal(b.cwd, cwd); // Ordner des Hauses, nicht der übergebene
  await waitFor(() => (b2 = state.get(second)).lastPrompt != null);
  assert.match(state.get(second).lastPrompt, /Webseite bauen|mach eine Webseite/);
});
```

(`waitFor` und `cwd` sind in der Datei vorhanden; `let b2;` davor deklarieren oder die Zeile vereinfachen.)

- [x] **Step 2: FAIL prüfen.**

- [x] **Step 3: Implementieren** – manager.js:

```js
  async function launch({ tool, cwd, mode, title, sessionId, acpSessionId = null, open, adopted = false, load = adopted, parentSessionId = null, house = null }) {
    …
    repo?.createSession?.({ id: sessionId, toolId: tool.id, acpSessionId, projectId, title, source: 'acp', mode, parentSessionId, houseId: house ?? sessionId });
    const agent = createAgent({ …, house: house ?? sessionId, … });
```

```js
  // Kontext eines Hauses für einen beitretenden Agenten (ältester Hauptagent des Hauses)
  function houseContext(houseId) {
    const mains = state.all().filter((a) => a.kind === 'main' && a.house === houseId).sort((x, y) => (x.startedAt || 0) - (y.startedAt || 0));
    const main = mains[0];
    if (!main) throw new Error('Haus nicht gefunden');
    const name = main.title || main.lastPrompt || main.project;
    const lines = [`Du kommst als weiterer Agent in das Haus „${name}“ (Ordner ${main.cwd}).`];
    if (main.lastPrompt) lines.push(`Auftrag des Hauses: „${main.lastPrompt}“`);
    if (main.lastText) lines.push(`Letzter Stand von ${main.agentName ?? main.toolId}: „${main.lastText.slice(0, 600)}“`);
    lines.push('Antworte mit einem Satz, womit du helfen kannst, und warte dann auf Anweisungen.');
    return { cwd: main.cwd, text: lines.join('\n') };
  }

  async function createSession({ toolId, cwd, mode = 'confirm', title = null, houseId = null }) {
    const tool = toolOf(toolId);
    if (mode && !MODES.includes(mode)) throw new Error(`Unbekannter City-Modus: ${mode}`);
    const ctx = houseId ? houseContext(houseId) : null;
    const dir = checkDir(ctx?.cwd ?? cwd);
    const id = await launch({ tool, cwd: dir, mode, title, sessionId: randomUUID(), house: houseId, open: (client) => client.newSession() });
    if (ctx) prompt(id, ctx.text).catch(() => { /* Agent meldet Fehler selbst */ });
    return id;
  }
```

`resume(...)`: `house: <house der ursprünglichen Session aus repo.getSession(parentSessionId)?.houseId ?? parentSessionId>` an `launch` übergeben. `adopt`: `house: w.house`.

handlers/session.js: `houseId: typeof msg.houseId === 'string' && msg.houseId ? msg.houseId : null` an `createSession` geben.

- [x] **Step 4: Test (WS)** – in `test/ws-session.test.js`: `session.create` mit `houseId` einer laufenden Session → Antwort `agentId`, Snapshot/`agent.update` enthält `house` gleich dem der ersten Session.

- [x] **Step 5: Tests** – `npm test` grün. **Step 6: Commit** – `feat(acp): Beitritt zu einem Haus mit Kontext-Prompt`.

---

## Paket 2 – Browser: Häuser

### Task 2.1: `public/js/houses.js` + Tests

**Files:**
- Create: `public/js/houses.js`
- Test: `test/houses.test.js`

- [x] **Step 1: Test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { houseOf, houseName, groupByHouse, housesFor } from '../public/js/houses.js';

const main = (id, extra = {}) => ({ id, kind: 'main', sessionId: id, house: id, project: 'shop', cwd: '/x/shop', startedAt: 1, ...extra });

test('houseOf fällt auf sessionId und Projekt zurück', () => {
  assert.equal(houseOf({ house: 'h1' }), 'h1');
  assert.equal(houseOf({ sessionId: 's1' }), 's1');
  assert.equal(houseOf({ project: 'p' }), 'p');
});

test('houseName: Titel, sonst erster Prompt gekürzt, sonst Ordner', () => {
  assert.equal(houseName([main('a', { title: 'Webseite bauen' })]), 'Webseite bauen');
  assert.equal(houseName([main('a', { lastPrompt: 'mach bitte eine Webseite mit Shop und Warenkorb und allem drum und dran' })]), 'mach bitte eine Webseite mit Shop und Warenkorb und …');
  assert.equal(houseName([main('a')]), 'shop');
  // ältester Hauptagent bestimmt den Namen
  assert.equal(houseName([main('b', { startedAt: 5, title: 'Zweiter' }), main('a', { title: 'Erster' })]), 'Erster');
});

test('groupByHouse gruppiert Haupt- und Subagenten', () => {
  const g = groupByHouse([main('a'), { id: 'a-sub', kind: 'sub', parentId: 'a', house: 'a', project: 'shop' }, main('b')]);
  assert.deepEqual([...g.keys()], ['a', 'b']);
  assert.equal(g.get('a').length, 2);
});

test('housesFor liefert Liste für den Dialog', () => {
  const list = housesFor([main('a', { title: 'Shop' }), main('b', { project: 'blog', cwd: '/x/blog' })]);
  assert.deepEqual(list.map((h) => [h.id, h.name, h.cwd, h.project, h.count]), [['a', 'Shop', '/x/shop', 'shop', 1], ['b', 'blog', '/x/blog', 'blog', 1]]);
});
```

- [x] **Step 2: FAIL** (Modul fehlt).

- [x] **Step 3: Implementieren**

```js
// Häuser: ein Haus ist ein Auftrag (Hauptagent + Subagenten); reine Funktionen, auch in Tests nutzbar
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + ' …' : s);

export const houseOf = (a) => a.house ?? a.sessionId ?? a.project ?? 'ohne';

// Name aus dem ältesten Hauptagenten: Titel, sonst erster Prompt, sonst Ordnername
export function houseName(agents) {
  const mains = agents.filter((a) => a.kind === 'main').sort((x, y) => (x.startedAt || 0) - (y.startedAt || 0));
  const m = mains[0] ?? agents[0];
  if (!m) return 'Haus';
  if (m.title) return m.title;
  if (m.lastPrompt) return trunc(m.lastPrompt.replace(/\s+/g, ' ').trim(), 52);
  return m.project || 'Haus';
}

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
    const main = list.filter((a) => a.kind === 'main').sort((x, y) => (x.startedAt || 0) - (y.startedAt || 0))[0];
    return main ? { id, name: houseName(list), cwd: main.cwd, project: main.project, count: list.length } : null;
  }).filter(Boolean);
}
```

- [x] **Step 4: PASS**, **Step 5: Commit** – `feat(web): Hausfunktionen`.

### Task 2.2: Räume nach Haus, Raumschild mit Untertitel

**Files:**
- Modify: `public/js/room.js:148-157, 303-315`
- Modify: `public/js/world.js:233-242, 307-323`
- Modify: `public/js/ui/list.js:54-82`, `public/js/ui/stats.js:6`, `public/js/replay.js:93`, `public/js/demo.js`
- Modify: `public/css/app.css:210-217`

- [x] **Step 1: room.js** – Konstruktor `constructor(id, world)`; `this.id = id; this.name = id;` Label: `<span class="room-dot"></span><span class="room-name"></span><span class="room-proj"></span><span class="room-count"></span>`; Methode:

```js
  setName(name, project) {
    if (name !== this.name) { this.name = name; this.labelEl.querySelector('.room-name').textContent = name; }
    const p = project && project !== name ? project : '';
    if (p !== this.project) { this.project = p; this.labelEl.querySelector('.room-proj').textContent = p; }
  }
```

- [x] **Step 2: world.js** – `import { houseOf, houseName } from './houses.js';` In `sync`: `byRoom` nach `houseOf(a)`; `this.rooms.get(houseOf(a))`; nach dem Anlegen je Raum `room.setName(houseName(list), list.find((a) => a.kind === 'main')?.project ?? list[0]?.project)`. `layoutRooms` sortiert weiter nach `order`, dann `name`.

- [x] **Step 3: list.js** – Gruppen über `groupByHouse`; Kopf: `<span class="grp-name">${esc(houseName(list))}</span><span class="grp-proj">${esc(project)}</span><span class="grp-n">…`; `data-toggle` = Haus-Id. stats.js: `new Set(agents.map(houseOf)).size`. replay.js: Agenten aus Sessions bekommen `house: s.houseId ?? s.id`. demo.js: `addMain` setzt `house: id`, `spawnSub` setzt `house: parent.house`; vierten Hauptagenten anlegen: `this.addMain('restaurant-app', 'Checkout-Flow prüfen', now - 3 * 60e3)` → zwei Häuser im selben Ordner sichtbar.

- [x] **Step 4: CSS** – `.room-proj, .grp-proj { color: var(--tx-3); font-size: 11px; margin-left: 6px; }`; `.room-name` auf 160 px mit Ellipsis begrenzen (`max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`).

- [x] **Step 5: Prüfen** – `npm test` grün; `?demo`: vier Häuser, zwei mit Untertitel „restaurant-app“; Namen stammen aus den Titeln. **Step 6: Commit** – `feat(web): Räume und Liste nach Haus`.

### Task 2.3: Dialog „Neue Session“: Haus wählen

**Files:**
- Modify: `public/js/ui/newsession.js`
- Modify: `public/css/panels.css` (Abschnitt `.ns-…`)

- [ ] **Step 1: Zustand** – `this.houseId = null` (null = neues Haus). Im `build()` nach dem Tool-Abschnitt:

```html
      <div class="ns-label">Haus</div>
      <div class="ns-houses" role="radiogroup" aria-label="Haus"></div>
```

`drawHouses()`:

```js
  drawHouses() {
    const box = this.el.querySelector('.ns-houses');
    if (!box) return;
    const houses = housesFor(this.store.agentList().filter((a) => a.source !== 'demo'));
    if (this.houseId && !houses.some((h) => h.id === this.houseId)) this.houseId = null;
    const item = (id, name, sub, on) => `<button class="ns-house ${on ? 'on' : ''}" data-house="${esc(id)}" role="radio" aria-checked="${on}" title="${esc(sub)}">${svgIcon(id ? ICON.home : ICON.plus)}<span>${esc(name)}</span><em>${esc(sub)}</em></button>`;
    box.innerHTML = item('', 'Neues Haus', 'eigener Auftrag, Ordner unten wählen', !this.houseId)
      + houses.map((h) => item(h.id, h.name, h.project, h.id === this.houseId)).join('');
    // bei Beitritt ist der Ordner der des Hauses
    const h = houses.find((x) => x.id === this.houseId);
    this.el.querySelector('.ns-pathrow').classList.toggle('hidden', !!h);
    this.el.querySelector('.ns-dirs').classList.toggle('hidden', !!h);
    if (h) this.cwd = h.cwd;
  }
```

Klick-Handler: `const house = e.target.closest('[data-house]'); if (house) { this.houseId = house.dataset.house || null; this.drawHouses(); return; }`. `submit()`: `houseId: this.houseId` mitsenden; bei Beitritt die cwd-Pflichtprüfung überspringen. Nach `onCreated` bleibt `houseId` gespeichert? Nein – beim nächsten `open()` auf `null` zurücksetzen (Standard: neues Haus). `ICON.home` in `ui/common.js` ergänzen, falls nicht vorhanden (Pfad: `M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z`).

- [ ] **Step 2: CSS** – `.ns-houses { display:flex; flex-wrap:wrap; gap:6px; }`, `.ns-house` im Stil von `.ns-tool` (kompakt, `em` klein in `var(--tx-3)`), `.on` hervorgehoben; `.hidden { display:none }` existiert bereits.

- [ ] **Step 3: main.js** – `store.subscribe`: bei `changes.has('agents')` und `newSession.isOpen` → `newSession.drawHouses()`.

- [ ] **Step 4: Prüfen** – Dialog zeigt „Neues Haus“ + laufende Häuser; Beitritt blendet den Ordnerwähler aus. **Step 5: Commit** – `feat(web): Haus im Dialog wählen`.

---

## Paket 3 – Eingang durch die Tür

### Task 3.1: Straße, Türpunkt, Einlauf, Auslauf

**Files:**
- Modify: `public/js/room.js` (Konstante `STREET`, Türrahmen)
- Modify: `public/js/world.js:348-369, 412-437, 509-523`
- Modify: `public/js/avatar.js:270-274`

- [ ] **Step 1: room.js** – `export const STREET = new THREE.Vector3(0, -0.45, ROOM_D / 2 + 3.2);` (lokale Koordinaten, auf Straßenhöhe). Türrahmen vorn am Türpunkt: zwei Pfosten `box(0.12, 2.2, 0.12, M.wallTop, ±0.75, 0, hd + 0.2)` und Sturz `box(1.62, 0.12, 0.12, M.wallTop, 0, 2.2, hd + 0.2)`; eine Stufe `box(1.8, 0.45, 0.6, M.floorEdge, 0, -0.45, hd + 0.55)` (castShadow false).

- [ ] **Step 2: avatar.js** – `leave(points)`: `this.walkTo(Array.isArray(points) ? points : [points]);` Ausblenden erst, wenn der Weg abgelaufen ist (ist schon so: `want = leaving && !path.length ? 0 : 1`).

- [ ] **Step 3: world.js** –
  - Import `STREET` aus `./room.js`.
  - Neue Hauptfigur (ohne Elternteil im Raum): `av.group.position.copy(STREET); av.entering = true;`
  - `place()`: vor `walkTo`: 
    ```js
    const from = av.entering ? DOOR : av.group.position;
    const pts = this.route(room, from, slot.pos);
    av.walkTo(av.entering ? [DOOR.clone(), ...pts] : pts);
    av.entering = false;
    ```
  - Verlassen: `av.leave([DOOR.clone(), STREET.clone()])` (in `sync`, Zeile ~366).
  - `loop()`: nach `av.tick`: Höhe an die Straße anpassen – 
    ```js
    const wantY = av.group.position.z > ROOM_D / 2 + 0.25 ? -0.45 : 0;
    av.group.position.y += (wantY - av.group.position.y) * Math.min(1, dt * 6);
    ```
  - Beim Betreten sofort sichtbar: `av.setOpacity(1); av.opacity = 1;` für Hauptfiguren, die auf der Straße starten (Einblenden bleibt für Subagenten am Tisch).

- [ ] **Step 4: Prüfen** – `?demo`: Nach Neuladen laufen die drei Hauptfiguren von der Straße durch die Türen; endet ein Demo-Subagent, bleibt alles wie bisher. Live: neue Session (`N`) → Figur kommt von vorn herein; Session schließen → Figur geht durch die Tür hinaus und verblasst auf der Straße.

- [ ] **Step 5: Tests** – `npm test` grün. **Step 6: Commit** – `feat(web): Figuren kommen durch die Tür`.

### Task 3.2: Abschluss

- [ ] `npm test` grün; `?demo` wie oben; Live-Zyklus: Haus A starten („mach eine kleine Webseite“), zweiten Agenten mit Beitritt zu Haus A starten → er meldet sich mit einem Satz; Liste zeigt ein Haus mit zwei Hauptagenten; Raumschild zeigt den Auftrag und darunter den Ordner.
- [ ] README: Abschnitt „Häuser“ (3–5 Sätze: Haus = Auftrag, Beitritt, Kontext-Prompt, Tür).
- [ ] Commit `docs: Häuser und Tür`.
