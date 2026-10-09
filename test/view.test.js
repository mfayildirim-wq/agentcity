import test from 'node:test';
import assert from 'node:assert/strict';
import { approachDir, roomFocus, isDouble } from '../public/js/view.js';

test('approachDir: Blick von vorn/rechts bleibt, sonst klemmen (nicht hinter einer Wand)', () => {
  const keep = approachDir([0, 0.5, 1]);
  assert.ok(keep[2] >= 0.35 && keep[0] >= -0.3); // eigene Richtung ist erlaubt
  const blocked = approachDir([-0.9, 0.3, -0.4]); // hinter der Wand
  const front = approachDir([0.5, 0.48, 0.72]);
  assert.equal(blocked[0], front[0]); // auf den Front-Default geklemmt
  assert.ok(blocked[0] > 0 && blocked[2] > 0);
  const norm = Math.hypot(blocked[0], blocked[1], blocked[2]);
  assert.ok(Math.abs(norm - 1) < 1e-9);
});

test('roomFocus: Nahsicht näher als Übersicht, Kamera vor der offenen Front', () => {
  const c = [10, 0, 20];
  const ov = roomFocus(c, false);
  const cl = roomFocus(c, true);
  assert.deepEqual(ov.target, [10, 1.1, 20]);
  assert.ok(Math.hypot(cl.pos[0] - c[0], cl.pos[1] - c[1], cl.pos[2] - c[2]) < Math.hypot(ov.pos[0] - c[0], ov.pos[1] - c[1], ov.pos[2] - c[2]));
  assert.ok(cl.pos[2] > c[2] && cl.pos[0] > c[0]); // vor der offenen Seite (+z, +x)
  assert.ok(ov.pos[2] > c[2]);
});

test('isDouble: Fenster und Maximalabstand', () => {
  const last = { t: 100, x: 10, y: 20 };
  assert.ok(isDouble(last, 300, 12, 21));
  assert.ok(!isDouble(last, 500, 12, 21)); // zu spät
  assert.ok(!isDouble(last, 200, 40, 21)); // zu weit
  assert.ok(!isDouble(null, 200, 40, 21)); // kein Vorgänger
});