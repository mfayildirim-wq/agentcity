// Kameranavigation: Blickrichtung auf die offene Hausfront klemmen, Flugziel für einen Raum.
// Reine Funktionen ohne DOM/Three – auch in Tests importierbar.

// Offene Seite: Vorderseite (+z) und rechte Seite (+x); Rückwand (−z) und Linkswand (−x) blockieren den Blick
export const FRONT_DIR = [0.5, 0.48, 0.72];
const MIN_Z = 0.35;
const MIN_X = -0.3;
const norm = (d) => {
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / l, d[1] / l, d[2] / l];
};

// Blickrichtung so klemmen, dass die Kamera nie hinter einer Wand steht
export function approachDir(dir) {
  const d = norm(dir);
  if (d[2] < MIN_Z || d[0] < MIN_X) return norm(FRONT_DIR);
  return d;
}

// Flugziel für einen Raum: Blick von der offenen Front, Nahsicht näher an der Mitte
export function roomFocus(center, close = false) {
  const dir = norm(FRONT_DIR);
  const dist = close ? 13 : 24;
  const target = [center[0], center[1] + 1.1, center[2]];
  const pos = [target[0] + dir[0] * dist, target[1] + dir[1] * dist, target[2] + dir[2] * dist];
  return { target, pos };
}

// Doppelklick: gleicher Ort innerhalb des Fensters
export function isDouble(last, now, dx, dy, windowMs = 350, maxPx = 6) {
  if (!last) return false;
  return now - last.t <= windowMs && Math.hypot(dx - last.x, dy - last.y) <= maxPx;
}
