// Stadt um die Räume: Pflasterstraßen zwischen den Häusern, Grünstreifen mit kleinen Bäumen hinter jedem Haus.
import * as THREE from 'three';
import { ROOM_W, ROOM_D } from './room.js';

const GROUND_Y = -0.46;      // Höhe des großen Untergrunds (world.js)
const MARGIN = 5;            // Straße rund um den Häuserblock
const STONE = 0.46;          // Kantenlänge eines Pflastersteins
const PITCH = 0.52;          // Stein + Fuge
const STRIP = 1.9;           // Tiefe des Grünstreifens hinter dem Haus
const HALF_W = ROOM_W / 2 + 0.25; // Sockel des Raums (room.js: ROOM_W + 0.5)
const HALF_D = ROOM_D / 2 + 0.25;

const STONE_COLORS = ['#4f535a', '#53575e', '#575b61', '#5b5e63', '#55534f'].map((c) => new THREE.Color(c));
const CROWN_COLORS = ['#4f8a57', '#5c9a63', '#467a4d', '#6aa56a'].map((c) => new THREE.Color(c));

// deterministischer Zufall je Position: die Stadt sieht nach jedem Neuaufbau gleich aus
function rand(x, z, k = 0) {
  const s = Math.sin(x * 127.1 + z * 311.7 + k * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

const mat = (extra = {}) => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9, metalness: 0, ...extra });

export class Town {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.geo = {
      stone: new THREE.BoxGeometry(STONE, 0.12, STONE),
      trunk: new THREE.CylinderGeometry(0.07, 0.11, 1, 7),
      crown: new THREE.IcosahedronGeometry(1, 0),
    };
    this.mat = {
      stone: mat({ roughness: 0.95 }),
      grass: mat({ color: '#3d5a3b', roughness: 1 }),
      trunk: mat({ color: '#6b4a32' }),
      crown: mat({ flatShading: true }),
    };
  }

  // centers: Mittelpunkte der Räume (x, z)
  layout(centers) {
    this.clear();
    if (!centers.length) return;
    const xs = centers.map((c) => c.x), zs = centers.map((c) => c.z);
    const x0 = Math.min(...xs) - HALF_W - MARGIN, x1 = Math.max(...xs) + HALF_W + MARGIN;
    const z0 = Math.min(...zs) - HALF_D - STRIP - MARGIN, z1 = Math.max(...zs) + HALF_D + MARGIN;

    // Grundstück je Haus: Sockel + Grünstreifen dahinter (hier liegt kein Pflaster)
    const lots = centers.map((c) => ({ x: c.x, z0: c.z - HALF_D - STRIP, z1: c.z + HALF_D }));
    const blocked = (x, z) => lots.some((l) => Math.abs(x - l.x) < HALF_W + STONE / 2 && z > l.z0 - STONE / 2 && z < l.z1 + STONE / 2);

    // Pflaster im Läuferverband: jede zweite Reihe um einen halben Stein versetzt
    const spots = [];
    for (let z = z0, row = 0; z <= z1; z += PITCH, row++) {
      for (let x = x0 + (row % 2) * PITCH / 2; x <= x1; x += PITCH) {
        if (!blocked(x, z)) spots.push([x, z]);
      }
    }
    const stones = new THREE.InstancedMesh(this.geo.stone, this.mat.stone, spots.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    spots.forEach(([x, z], i) => {
      q.setFromAxisAngle(up, (rand(x, z, 1) - 0.5) * 0.12);
      s.set(0.9 + rand(x, z, 2) * 0.12, 1, 0.9 + rand(x, z, 3) * 0.12);
      p.set(x + (rand(x, z, 4) - 0.5) * 0.03, GROUND_Y + 0.02 + rand(x, z, 5) * 0.02, z + (rand(x, z, 6) - 0.5) * 0.03);
      stones.setMatrixAt(i, m.compose(p, q, s));
      stones.setColorAt(i, STONE_COLORS[Math.floor(rand(x, z, 7) * STONE_COLORS.length)]);
    });
    stones.receiveShadow = true;
    this.group.add(stones);

    // Grünstreifen + kleine Bäume hinter jedem Haus
    const trees = [];
    for (const l of lots) {
      const grass = new THREE.Mesh(new THREE.BoxGeometry(HALF_W * 2, 0.1, STRIP), this.mat.grass);
      grass.position.set(l.x, GROUND_Y + 0.05, l.z0 + STRIP / 2);
      grass.receiveShadow = true;
      this.group.add(grass);
      const n = 8;
      for (let i = 0; i < n; i++) {
        const x = l.x - HALF_W + 1 + (i / (n - 1)) * (HALF_W * 2 - 2) + (rand(l.x, i, 8) - 0.5) * 0.5;
        const z = l.z0 + STRIP / 2 + (rand(l.x, i, 9) - 0.5) * 0.4;
        trees.push({ x, z, k: 0.8 + rand(x, z, 10) * 0.4, c: CROWN_COLORS[Math.floor(rand(x, z, 11) * CROWN_COLORS.length)] });
      }
    }
    const trunks = new THREE.InstancedMesh(this.geo.trunk, this.mat.trunk, trees.length);
    const crowns = new THREE.InstancedMesh(this.geo.crown, this.mat.crown, trees.length * 2);
    trees.forEach((t, i) => {
      const y = GROUND_Y + 0.1;
      q.identity();
      trunks.setMatrixAt(i, m.compose(p.set(t.x, y + 0.7 * t.k, t.z), q, s.set(t.k, 1.4 * t.k, t.k)));
      // zwei Kronen übereinander, leicht gedreht
      q.setFromAxisAngle(up, rand(t.x, t.z, 12) * Math.PI);
      crowns.setMatrixAt(i * 2, m.compose(p.set(t.x, y + 1.95 * t.k, t.z), q, s.set(0.78 * t.k, 0.9 * t.k, 0.78 * t.k)));
      crowns.setMatrixAt(i * 2 + 1, m.compose(p.set(t.x + 0.08, y + 2.65 * t.k, t.z - 0.05), q, s.set(0.5 * t.k, 0.6 * t.k, 0.5 * t.k)));
      crowns.setColorAt(i * 2, t.c);
      crowns.setColorAt(i * 2 + 1, t.c.clone().offsetHSL(0, 0, 0.04));
    });
    for (const im of [trunks, crowns]) { im.castShadow = true; im.receiveShadow = true; this.group.add(im); }
  }

  clear() {
    for (const o of [...this.group.children]) {
      if (o.isInstancedMesh) o.dispose();
      else if (o.geometry && !Object.values(this.geo).includes(o.geometry)) o.geometry.dispose();
      o.removeFromParent();
    }
  }
}
