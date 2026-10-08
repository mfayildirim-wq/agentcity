// Person je Agent: aus der Id deterministisch abgeleitet, damit Figuren wiedererkennbar sind.
// Rein und ohne Browser importierbar (nur config.js).
import { hash, skinTone, hairTone } from './config.js';

export const HAIR_STYLES = ['short', 'buzz', 'long', 'bob', 'bun', 'ponytail', 'curly', 'bald'];
const HAIR_F = ['long', 'bob', 'bun', 'ponytail', 'curly', 'short'];
const HAIR_M = ['short', 'buzz', 'curly', 'bald', 'short', 'bob'];
// gedeckte Kleidungsfarben (kompakt, dezent – keine Signalfarben, die mit Status/Tool kollidieren)
export const SHIRTS = ['#c9c3b8', '#8d9bb3', '#a9b8a2', '#d6b89a', '#b89ab0', '#9db3b8', '#d8cfa8', '#9a9fae', '#c4a59b', '#a3b0c6', '#b5a98f', '#8f9d8b'];
export const PANTS = ['#3a3f4b', '#4a4640', '#2f3742', '#5a5247', '#3d4a52'];

const pick = (arr, key) => arr[hash(key) % arr.length];
const chance = (key, p) => (hash(key) % 1000) / 1000 < p;

// Farbabstand im RGB-Raum (Komponenten 0 … 1), nur für #rrggbb
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
export function colorDistance(a, b) {
  const x = rgb(a), y = rgb(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

// Hemd aus der Palette; liegt es zu nah an der zu meidenden Farbe (Tool-Farbe), die nächste Palettenfarbe nehmen
const MIN_DISTANCE = 0.18;
function shirtOf(id, avoid) {
  let i = hash(id + 'sh') % SHIRTS.length;
  if (avoid) for (let n = 0; n < SHIRTS.length && colorDistance(SHIRTS[i], avoid) < MIN_DISTANCE; n++) i = (i + 1) % SHIRTS.length;
  return SHIRTS[i];
}

// avoid: optionale Farbe (#rrggbb), der das Hemd nicht zu ähnlich sein darf
export function personOf(a, avoid = null) {
  const id = a.id;
  const gender = chance(id + 'g', 0.5) ? 'f' : 'm';
  return {
    gender,
    hair: pick(gender === 'f' ? HAIR_F : HAIR_M, id + 'hs'),
    hairColor: hairTone(id),
    skin: skinTone(id),
    shirt: shirtOf(id, avoid),
    pants: pick(PANTS, id + 'pa'),
    skirt: gender === 'f' && chance(id + 'sk', 0.5),
    height: 0.94 + (hash(id + 'ht') % 121) / 1000, // 0,94 … 1,06
    glasses: chance(id + 'gl', 0.28),
    beard: gender === 'm' && chance(id + 'bd', 0.35),
  };
}
