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
    skirt: gender === 'f' && chance(id + 'sk', 0.5),
    height: 0.94 + (hash(id + 'ht') % 121) / 1000, // 0,94 … 1,06
    glasses: chance(id + 'gl', 0.28),
    beard: gender === 'm' && chance(id + 'bd', 0.35),
  };
}
