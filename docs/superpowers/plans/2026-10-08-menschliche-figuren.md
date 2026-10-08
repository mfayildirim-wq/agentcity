# Menschlichere Figuren – Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Figuren sehen wie unterschiedliche Menschen aus – Frauen und Männer, verschiedene Frisuren, Hautfarben, Kleidung, Größe, Brille, Bart – je Agent fest zugeordnet (wiedererkennbar). Die Tool-Farbe bleibt als Akzent (Kopfbedeckung/Raute/Schal/Visier, Abzeichen), damit Claude/Codex/OpenCode/Hermes unterscheidbar bleiben.

**Architecture:** `public/js/person.js` leitet aus der Agent-Id deterministisch eine „Person“ ab (`personOf(a)`), rein und testbar. `avatar.js` baut daraus Körper, Frisur und Extras aus Grundkörpern (keine Modelle, kein Build). Hemdfarbe ist persönlich (gedeckte Palette), Hose persönlich; die Tool-Farbe liegt auf dem Stil-Zubehör (`cap`, `hoodie`, `scarf`, `visor`, `gem`) und bei Subagenten auf dem Abzeichen; zusätzlich ein schmaler Kragenring in Tool-/Typfarbe, damit die Zugehörigkeit auch ohne Zubehör sichtbar ist.

**Tech Stack:** Three.js 0.170 (ESM ohne Build), `node:test`.

**Konventionen:** Deutsch in Kommentaren/Texten; Tests `test/*.test.js`; Commits klein; Design kompakt und dezent (keine grellen Farben).

---

## Dateiübersicht

- Create `public/js/person.js` – `personOf(a)`: Geschlecht, Frisur, Haarfarbe, Haut, Hemd, Hose, Größe, Brille, Bart.
- Modify `public/js/avatar.js` – Körperproportionen je Person, Frisuren, Brille, Bart, Kragenring; Tool-Farbe nur auf Zubehör.
- Modify `public/js/config.js` – `skinTone`/`hairTone` bleiben (werden von `person.js` genutzt); neue Palette `SHIRTS`, `PANTS`.
- Test `test/person.test.js`.

---

### Task 1: `person.js` + Test

**Files:**
- Create: `public/js/person.js`
- Test: `test/person.test.js`

- [ ] **Step 1: Test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { personOf, HAIR_STYLES } from '../public/js/person.js';

test('personOf ist deterministisch und vollständig', () => {
  const p = personOf({ id: 'a:123', kind: 'main' });
  assert.deepEqual(p, personOf({ id: 'a:123', kind: 'main' }));
  assert.ok(['f', 'm'].includes(p.gender));
  assert.ok(HAIR_STYLES.includes(p.hair));
  assert.match(p.hairColor, /^#/); assert.match(p.skin, /^#/); assert.match(p.shirt, /^#/); assert.match(p.pants, /^#/);
  assert.ok(p.height >= 0.94 && p.height <= 1.06);
  assert.equal(typeof p.glasses, 'boolean');
  assert.equal(typeof p.beard, 'boolean');
});

test('Verteilung: beide Geschlechter und mehrere Frisuren über 200 Ids', () => {
  const ps = Array.from({ length: 200 }, (_, i) => personOf({ id: `a:${i}`, kind: 'main' }));
  const f = ps.filter((p) => p.gender === 'f').length;
  assert.ok(f > 60 && f < 140, `Frauen: ${f}`);
  assert.ok(new Set(ps.map((p) => p.hair)).size >= 5);
  assert.ok(ps.every((p) => p.gender === 'm' || !p.beard)); // kein Bart bei Frauen
});
```

- [ ] **Step 2: FAIL** (Modul fehlt).

- [ ] **Step 3: Implementieren**

```js
// Person je Agent: aus der Id deterministisch abgeleitet, damit Figuren wiedererkennbar sind
import { hash, skinTone, hairTone } from './config.js';

export const HAIR_STYLES = ['short', 'buzz', 'long', 'bob', 'bun', 'ponytail', 'curly', 'bald'];
const HAIR_F = ['long', 'bob', 'bun', 'ponytail', 'curly', 'short'];
const HAIR_M = ['short', 'buzz', 'curly', 'bald', 'short', 'bob'];
// gedeckte Kleidungsfarben (kompakt, dezent – keine Signalfarben, die mit Status/Tool kollidieren)
const SHIRTS = ['#c9c3b8', '#8d9bb3', '#a9b8a2', '#d6b89a', '#b89ab0', '#9db3b8', '#d8cfa8', '#9a9fae', '#c4a59b', '#a3b0c6', '#b5a98f', '#8f9d8b'];
const PANTS = ['#3a3f4b', '#4a4640', '#2f3742', '#5a5247', '#3d4a52'];

const pick = (arr, key) => arr[hash(key) % arr.length];
const chance = (key, p) => (hash(key) % 1000) / 1000 < p;

export function personOf(a) {
  const id = a.id;
  const gender = chance(id + 'g', 0.5) ? 'f' : 'm';
  return {
    gender,
    hair: pick(gender === 'f' ? HAIR_F : HAIR_M, id + 'hs'),
    hairColor: hairTone(id),
    skin: skinTone(id),
    shirt: pick(SHIRTS, id + 'sh'),
    pants: pick(PANTS, id + 'pa'),
    height: 0.94 + (hash(id + 'ht') % 121) / 1000, // 0,94 … 1,06
    glasses: chance(id + 'gl', 0.28),
    beard: gender === 'm' && chance(id + 'bd', 0.35),
  };
}
```

- [ ] **Step 4: PASS**, **Step 5: Commit** – `feat(web): Person je Agent`.

### Task 2: Figur aus der Person bauen

**Files:**
- Modify: `public/js/avatar.js:7-30 (GEO), 63-161 (build), 164-214 (buildStyle)`

- [ ] **Step 1: Geometrien ergänzen** in `GEO`:

```js
  hairLong: new THREE.SphereGeometry(0.215, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.5), // Deckhaar (wie hair, etwas größer)
  hairBack: new THREE.CapsuleGeometry(0.17, 0.26, 4, 12),   // langes Haar hinten bis zu den Schultern
  bob: new THREE.SphereGeometry(0.235, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.68), // bis zum Kinn
  bun: new THREE.SphereGeometry(0.085, 12, 10),
  ponytail: new THREE.CapsuleGeometry(0.06, 0.3, 4, 10),
  curl: new THREE.SphereGeometry(0.075, 10, 8),               // Locken: 7 Kugeln auf dem Deckhaar
  beard: new THREE.SphereGeometry(0.19, 20, 10, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.3), // unterer Kopfbereich
  lens: new THREE.TorusGeometry(0.055, 0.008, 6, 20),
  bridge: new THREE.BoxGeometry(0.05, 0.008, 0.008),
  collar: new THREE.TorusGeometry(0.2, 0.025, 8, 28),
  skirt: new THREE.CylinderGeometry(0.2, 0.3, 0.32, 20, 1, true),
```

- [ ] **Step 2: `build(a)` umstellen** –
  - `const p = personOf(a); this.person = p;` (Import `personOf` aus `./person.js`).
  - Materialien: `skin = this.m(p.skin)`, `hair = this.m(p.hairColor)`, `shirtM = this.m(p.shirt)`, `pantsM = this.m(p.pants)`; Subagenten: `shirtM = this.m(agentColor(a))` (Typfarbe bleibt am Hemd, Person sonst gleich).
  - Proportionen: Frauen `torso.scale.set(0.88, 1, 0.74)`, Schultern (`mkArm`-x) `±0.28` statt `±0.31`; Männer `torso.scale.set(1, 1, 0.8)`. Körperhöhe: `body.scale.setScalar(p.height)` (Label- und Ring-Positionen bleiben an `group`).
  - Rock bei Frauen mit Wahrscheinlichkeit aus `hash(id+'sk') % 2` (50 %): `new THREE.Mesh(GEO.skirt, pantsM)` bei `y = 0.62`, `DoubleSide`; Beine dann in Hautfarbe (`legM = skin`).
  - Frisur über `buildHair(p.hair, { head, hair, cap })`:
    ```js
    buildHair(style, { head, hair, cap }) {
      if (style === 'bald') { cap.visible = false; return; }
      if (style === 'buzz') { cap.scale.set(1.0, 0.6, 1.0); return; }
      if (style === 'long') {
        const back = new THREE.Mesh(GEO.hairBack, hair); back.position.set(0, -0.12, -0.12); back.scale.set(1.15, 1, 0.7); head.add(back);
      } else if (style === 'bob') {
        cap.geometry = GEO.bob; cap.position.set(0, 0.0, -0.02);
      } else if (style === 'bun') {
        const b = new THREE.Mesh(GEO.bun, hair); b.position.set(0, 0.12, -0.2); head.add(b);
      } else if (style === 'ponytail') {
        const t = new THREE.Mesh(GEO.ponytail, hair); t.position.set(0, -0.05, -0.24); t.rotation.x = 0.35; head.add(t);
      } else if (style === 'curly') {
        for (let i = 0; i < 7; i++) { const c = new THREE.Mesh(GEO.curl, hair); const ang = (i / 7) * Math.PI * 2; c.position.set(Math.sin(ang) * 0.16, 0.12 + Math.cos(ang * 2) * 0.03, Math.cos(ang) * 0.16 - 0.02); head.add(c); }
      }
    }
    ```
    (`cap` ist die vorhandene Haarkappe `GEO.hair`; `short` bleibt die Kappe.)
  - Brille: zwei `lens`-Tori bei `(±0.07, 0.01, 0.19)`, Material dunkel `#2a2d33`, `bridge` dazwischen.
  - Bart: `beard`-Mesh in Haarfarbe bei `(0, -0.02, 0.01)`, `scale.set(1, 0.9, 1)`.
  - Kragenring: `collar` in Tool-Farbe (Haupt) bzw. Typfarbe (Sub) bei `y = 1.36`, `rotation.x = π/2`, Material leicht emissiv (`emissiveIntensity 0.2`).
  - `buildStyle(...)` unverändert: nutzt weiterhin `agentColor(a)` für Mütze/Kapuze/Schal/Visier/Raute. Bei `hoodie` bleibt die Frisur verdeckt (`cap.visible = false`, zusätzliche Haar-Meshes ebenfalls `visible = false`).
  - Augen bleiben; Mund: kleiner Box-Strich `0.06 × 0.012 × 0.01` in dunklerer Hautfarbe bei `(0, -0.08, 0.19)`.

- [ ] **Step 3: `lookOf(a)`** – unverändert (Person hängt nur an der Id); Subagenten-Look `sub` bleibt.

- [ ] **Step 4: Prüfen** – `?demo`: Figuren unterscheidbar (mind. eine Frau mit langem Haar/Rock, ein Mann mit Bart, eine Brille), Tool-Farbe an Mütze/Raute/Kragen sichtbar; Gehen/Sitzen/Tippen/Hand heben funktionieren weiter (Rock bewegt sich mit `body`); Schatten ok. Screenshot per Headless-Chrome wie im Repo üblich (`--headless=new --use-angle=swiftshader --enable-unsafe-swiftshader --virtual-time-budget=8000 --screenshot=…`).

- [ ] **Step 5: Tests** – `npm test` grün. **Step 6: Commit** – `feat(web): menschlichere Figuren`.

### Task 3: Feinschliff

- [ ] Hemdfarbe darf nicht mit der Tool-Farbe verwechselbar sein: falls `shirt` und `agentColor(a)` nahe beieinander liegen (Farbabstand im RGB-Raum < 0.18), die nächste Palettenfarbe nehmen (in `person.js` mit optionalem Parameter `avoid` lösen und in `avatar.js` `personOf(a, agentColor(a))` aufrufen; Test ergänzen).
- [ ] Demo-Hauptagenten bekommen Namen? Nein – Namen bleiben Titel/Tool (YAGNI).
- [ ] `npm test` grün, Commit `fix(web): Hemdfarbe meidet Tool-Farbe`.
