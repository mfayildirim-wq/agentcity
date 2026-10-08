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
