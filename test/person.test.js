import test from 'node:test';
import assert from 'node:assert/strict';
import { personOf, colorDistance, HAIR_STYLES } from '../public/js/person.js';

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

test('Hemdfarbe meidet die Tool-Farbe (avoid)', () => {
  const a = { id: 'a:77', kind: 'main' };
  const base = personOf(a);
  // ohne avoid unverändert; mit weit entfernter Farbe ebenfalls
  assert.equal(personOf(a, '#000000').shirt, base.shirt);
  // Tool-Farbe gleich der Hemdfarbe: nächste Palettenfarbe, deutlich entfernt, sonst gleiche Person
  const p = personOf(a, base.shirt);
  assert.notEqual(p.shirt, base.shirt);
  assert.ok(colorDistance(p.shirt, base.shirt) >= 0.18);
  assert.deepEqual({ ...p, shirt: base.shirt }, base);
  // deterministisch
  assert.deepEqual(p, personOf(a, base.shirt));
});

test('colorDistance im RGB-Raum (0 … √3)', () => {
  assert.equal(colorDistance('#000000', '#000000'), 0);
  assert.ok(Math.abs(colorDistance('#000000', '#ffffff') - Math.sqrt(3)) < 1e-9);
  assert.ok(colorDistance('#d97757', '#d6b89a') > 0.18);
});
