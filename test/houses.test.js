import test from 'node:test';
import assert from 'node:assert/strict';
import { houseOf, houseName, groupByHouse, housesFor } from '../public/js/houses.js';

const main = (id, extra = {}) => ({ id, kind: 'main', sessionId: id, house: id, project: 'shop', cwd: '/x/shop', startedAt: 1, ...extra });

test('houseOf fällt auf sessionId und Projekt zurück', () => {
  assert.equal(houseOf({ house: 'h1' }), 'h1');
  assert.equal(houseOf({ sessionId: 's1' }), 's1');
  assert.equal(houseOf({ project: 'p' }), 'p');
  assert.equal(houseOf({}), 'ohne');
});

test('houseName: Titel, sonst erster Prompt gekürzt, sonst Ordner', () => {
  assert.equal(houseName([main('a', { title: 'Webseite bauen' })]), 'Webseite bauen');
  assert.equal(houseName([main('a', { lastPrompt: 'mach bitte eine Webseite mit Shop und Warenkorb und allem drum und dran' })]), 'mach bitte eine Webseite mit Shop und Warenkorb und …');
  assert.equal(houseName([main('a')]), 'shop');
  assert.equal(houseName([]), 'Haus');
  // ältester Hauptagent bestimmt den Namen
  assert.equal(houseName([main('b', { startedAt: 5, title: 'Zweiter' }), main('a', { title: 'Erster' })]), 'Erster');
  // nur Subagenten (Hauptagent noch nicht gemeldet): erster Eintrag
  assert.equal(houseName([{ id: 's', kind: 'sub', project: 'blog' }]), 'blog');
});

test('groupByHouse gruppiert Haupt- und Subagenten', () => {
  const g = groupByHouse([main('a'), { id: 'a-sub', kind: 'sub', parentId: 'a', house: 'a', project: 'shop' }, main('b')]);
  assert.deepEqual([...g.keys()], ['a', 'b']);
  assert.equal(g.get('a').length, 2);
  assert.equal(g.get('b').length, 1);
});

test('housesFor liefert Liste für den Dialog', () => {
  const list = housesFor([main('a', { title: 'Shop' }), main('b', { project: 'blog', cwd: '/x/blog' })]);
  assert.deepEqual(list.map((h) => [h.id, h.name, h.cwd, h.project, h.count]), [['a', 'Shop', '/x/shop', 'shop', 1], ['b', 'blog', '/x/blog', 'blog', 1]]);
  // Subagenten zählen mit; Häuser ohne Hauptagenten fehlen
  const withSub = housesFor([main('a'), { id: 'a-sub', kind: 'sub', house: 'a', project: 'shop' }, { id: 'x-sub', kind: 'sub', house: 'x', project: 'p' }]);
  assert.deepEqual(withSub.map((h) => [h.id, h.count]), [['a', 2]]);
});
