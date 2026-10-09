// Kachelmodus: Aufteilung des Bildschirms für n CLI-Fenster (reine Funktion, auch in Tests importierbar).
// 1: ganz · 2: nebeneinander · gerade n: 2 Reihen × n/2 Spalten · ungerade n: eine Kachel belegt zwei Felder –
// bei 3 die ganze obere Reihe, sonst die linke Spalte über beide Reihen. Zelle 0 ist die große Kachel.
export function tileLayout(n) {
  if (n <= 0) return { cols: 1, rows: 1, cells: [] };
  const cell = (col, row, colSpan = 1, rowSpan = 1) => ({ col, row, colSpan, rowSpan });
  if (n === 1) return { cols: 1, rows: 1, cells: [cell(1, 1)] };
  if (n === 2) return { cols: 2, rows: 1, cells: [cell(1, 1), cell(2, 1)] };
  const cols = Math.ceil(n / 2), rows = 2;
  const odd = n % 2 === 1;
  const cells = [];
  if (odd) cells.push(n === 3 ? cell(1, 1, 2, 1) : cell(1, 1, 1, 2));
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      if (odd && (n === 3 ? r === 1 : c === 1)) continue; // von der großen Kachel belegt
      cells.push(cell(c, r));
    }
  }
  return { cols, rows, cells: cells.slice(0, n) };
}
