import test from 'node:test';
import assert from 'node:assert/strict';
import { tileLayout } from '../public/js/tiles.js';

const area = (c) => c.colSpan * c.rowSpan;

test('tileLayout: 1 ganz, 2 nebeneinander, 4 und 6 als Raster', () => {
  assert.deepEqual(tileLayout(1), { cols: 1, rows: 1, cells: [{ col: 1, row: 1, colSpan: 1, rowSpan: 1 }] });
  const two = tileLayout(2);
  assert.equal(two.cols, 2); assert.equal(two.rows, 1);
  const four = tileLayout(4);
  assert.equal(four.cols, 2); assert.equal(four.rows, 2); assert.equal(four.cells.length, 4);
  const six = tileLayout(6);
  assert.equal(six.cols, 3); assert.equal(six.rows, 2); assert.equal(six.cells.length, 6);
  assert.ok(six.cells.every((c) => area(c) === 1));
});

test('tileLayout: 3 → eine Kachel über die ganze obere Reihe, zwei darunter', () => {
  const { cols, rows, cells } = tileLayout(3);
  assert.equal(cols, 2); assert.equal(rows, 2);
  assert.deepEqual(cells[0], { col: 1, row: 1, colSpan: 2, rowSpan: 1 });
  assert.deepEqual(cells.slice(1), [{ col: 1, row: 2, colSpan: 1, rowSpan: 1 }, { col: 2, row: 2, colSpan: 1, rowSpan: 1 }]);
});

test('tileLayout: 5 → links eine Kachel über beide Reihen, rechts vier', () => {
  const { cols, rows, cells } = tileLayout(5);
  assert.equal(cols, 3); assert.equal(rows, 2);
  assert.deepEqual(cells[0], { col: 1, row: 1, colSpan: 1, rowSpan: 2 });
  assert.equal(cells.length, 5);
  assert.ok(cells.slice(1).every((c) => c.col > 1 && area(c) === 1));
});

test('tileLayout: ungerade n belegt immer alle Felder lückenlos', () => {
  for (let n = 1; n <= 11; n++) {
    const { cols, rows, cells } = tileLayout(n);
    assert.equal(cells.length, n, `n=${n}`);
    assert.equal(cells.reduce((s, c) => s + area(c), 0), cols * rows, `n=${n} füllt das Raster`);
    const used = new Set();
    for (const c of cells) for (let x = 0; x < c.colSpan; x++) for (let y = 0; y < c.rowSpan; y++) {
      const k = `${c.col + x},${c.row + y}`;
      assert.ok(!used.has(k), `n=${n}: Feld ${k} doppelt`);
      used.add(k);
    }
  }
  assert.deepEqual(tileLayout(0).cells, []);
});
