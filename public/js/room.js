// Raum eines Projekts: Boden, Wände, Möbel, Stationen je Werkzeugart (aus world.js herausgelöst).
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { STATIONS } from './config.js';
import { Screen, SCREEN_W, SCREEN_H, SCREEN_SCALE } from './screen.js';

export const ROOM_W = 16;
export const ROOM_D = 12;
export const ROOM_GAP = 5;
export const DOOR = new THREE.Vector3(0, 0, ROOM_D / 2 - 0.4);
export const WALL_H = 3.4; // hoch genug für die Leinwand (4,8 × 2,7, Mitte y = 1,9)
export const SCREEN_POS = new THREE.Vector3(0.6, 1.9, -ROOM_D / 2 + 0.06); // Leinwand an der Rückwand

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.02, ...extra });
const M = {
  floor: mat('#e7e1d7'),
  floorEdge: mat('#c9c0b2'),
  wall: mat('#d9dee6'),
  wallTop: mat('#f2f4f7'),
  wood: mat('#b88a5e'),
  woodDark: mat('#8a6443'),
  metal: mat('#3a3f4b', { roughness: 0.45, metalness: 0.35 }),
  screen: mat('#11151c', { roughness: 0.3 }),
  fabric: mat('#7d8aa0'),
  fabricDark: mat('#5f6b80'),
  plant: mat('#5c9a63'),
  pot: mat('#e9e4dc'),
  white: mat('#f7f7f5'),
  tile: new THREE.LineBasicMaterial({ color: '#d5cdc0', transparent: true, opacity: 0.55 }),
};

function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}
function cyl(rt, rb, h, material, x = 0, y = 0, z = 0, seg = 24) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), material);
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// ---------------------------------------------------------------- Möbel
function screenMat(color) {
  return new THREE.MeshStandardMaterial({ color: '#0e1218', emissive: color, emissiveIntensity: 0.55, roughness: 0.35 });
}

function monitor(color, x, z, rotY = 0) {
  const g = new THREE.Group();
  g.add(box(0.12, 0.28, 0.12, M.metal, 0, 0, 0));
  const frame = box(1.05, 0.62, 0.06, M.metal, 0, 0.28, 0);
  g.add(frame);
  const s = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.52), screenMat(color));
  s.position.set(0, 0.59, 0.035);
  g.add(s);
  g.position.set(x, 0.78, z);
  g.rotation.y = rotY;
  g.userData.screen = s;
  return g;
}

function desk(w, d, x, z) {
  const g = new THREE.Group();
  g.add(box(w, 0.06, d, M.wood, 0, 0.72, 0));
  for (const sx of [-1, 1]) g.add(box(0.06, 0.72, d - 0.1, M.woodDark, sx * (w / 2 - 0.08), 0, 0));
  g.position.set(x, 0, z);
  return g;
}

function plant(x, z, s = 1) {
  const g = new THREE.Group();
  g.add(cyl(0.22, 0.17, 0.38, M.pot, 0, 0, 0));
  const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 0), M.plant);
  leaves.position.y = 0.78;
  leaves.scale.set(1, 1.25, 1);
  leaves.castShadow = true;
  g.add(leaves);
  g.position.set(x, 0, z);
  g.scale.setScalar(s);
  return g;
}

function bookshelf(x, z, w = 2.2) {
  const g = new THREE.Group();
  g.add(box(w, 2.1, 0.45, M.woodDark, 0, 0, 0));
  const palette = ['#c0603f', '#3f6fb0', '#d9a62e', '#4d8f6b', '#8b5fa8', '#e7e1d7', '#2f3a4d'];
  for (let shelf = 0; shelf < 4; shelf++) {
    const y = 0.12 + shelf * 0.5;
    g.add(box(w - 0.12, 0.04, 0.4, M.wood, 0, y, 0.03));
    let bx = -w / 2 + 0.14;
    let i = shelf * 3;
    while (bx < w / 2 - 0.2) {
      const bw = 0.07 + ((i * 37) % 5) * 0.015;
      const bh = 0.3 + ((i * 53) % 4) * 0.035;
      const b = box(bw, bh, 0.3, mat(palette[i % palette.length]), bx + bw / 2, y + 0.04, 0.06);
      b.rotation.z = (i % 9 === 0) ? 0.18 : 0;
      g.add(b);
      bx += bw + 0.012;
      i++;
    }
  }
  g.position.set(x, 0, z);
  return g;
}

function sofa(x, z, rotY = 0) {
  const g = new THREE.Group();
  g.add(box(2.6, 0.38, 0.95, M.fabric, 0, 0.06, 0));
  g.add(box(2.6, 0.55, 0.25, M.fabric, 0, 0.42, -0.36));
  for (const sx of [-1, 1]) g.add(box(0.22, 0.6, 0.95, M.fabric, sx * 1.3, 0.06, 0));
  for (const sx of [-0.62, 0.62]) g.add(box(1.15, 0.1, 0.7, M.fabricDark, sx, 0.44, 0.08));
  g.position.set(x, 0, z);
  g.rotation.y = rotY;
  return g;
}

function rug(x, z, w, d, color) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat(color, { roughness: 1 }));
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, 0.006, z);
  m.receiveShadow = true;
  return m;
}

function stationPad(x, z, w, d, color) {
  const g = new THREE.Group();
  const shape = new THREE.Shape();
  const r = 0.35, hw = w / 2, hd = d / 2;
  shape.moveTo(-hw + r, -hd);
  shape.lineTo(hw - r, -hd); shape.quadraticCurveTo(hw, -hd, hw, -hd + r);
  shape.lineTo(hw, hd - r); shape.quadraticCurveTo(hw, hd, hw - r, hd);
  shape.lineTo(-hw + r, hd); shape.quadraticCurveTo(-hw, hd, -hw, hd - r);
  shape.lineTo(-hw, -hd + r); shape.quadraticCurveTo(-hw, -hd, -hw + r, -hd);
  const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.1, roughness: 1, depthWrite: false }));
  fill.rotation.x = -Math.PI / 2;
  fill.position.y = 0.004;
  fill.receiveShadow = true;
  const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(shape.getPoints(8).map((p) => new THREE.Vector3(p.x, 0, -p.y))), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.45 }));
  edge.position.y = 0.008;
  g.add(fill, edge);
  g.position.set(x, 0, z);
  g.userData.fill = fill;
  return g;
}

// ---------------------------------------------------------------- Raum
export class Room {
  constructor(name, world) {
    this.name = name;
    this.world = world;
    this.group = new THREE.Group();
    this.animated = [];
    this.stations = {};
    this.build();
    this.buildLabel();
  }

  build() {
    const g = this.group;
    const hw = ROOM_W / 2, hd = ROOM_D / 2;

    // Boden als Sockel mit Kante
    const base = box(ROOM_W + 0.5, 0.45, ROOM_D + 0.5, M.floorEdge, 0, -0.45, 0);
    base.castShadow = false;
    g.add(base);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_D), M.floor);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    g.add(floor);
    const pts = [];
    for (let x = -hw + 1; x < hw; x += 1) pts.push(new THREE.Vector3(x, 0.003, -hd), new THREE.Vector3(x, 0.003, hd));
    for (let z = -hd + 1; z < hd; z += 1) pts.push(new THREE.Vector3(-hw, 0.003, z), new THREE.Vector3(hw, 0.003, z));
    g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), M.tile));

    // Rück- und Seitenwand (Diorama)
    g.add(box(ROOM_W + 0.5, WALL_H, 0.25, M.wall, 0, 0, -hd - 0.125));
    g.add(box(0.25, WALL_H, ROOM_D + 0.25, M.wall, -hw - 0.125, 0, -0.125 + 0.125));
    g.add(box(ROOM_W + 0.5, 0.08, 0.3, M.wallTop, 0, WALL_H, -hd - 0.125));
    g.add(box(0.3, 0.08, ROOM_D + 0.25, M.wallTop, -hw - 0.125, WALL_H, 0));
    // Fensterstreifen an der Rückwand (links und rechts neben der Leinwand)
    for (const wx of [-5.2, 5.4]) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1), new THREE.MeshStandardMaterial({ color: '#cfe3f5', emissive: '#9cc6ea', emissiveIntensity: 0.35, roughness: 0.2 }));
      win.position.set(wx, 1.9, -hd + 0.005);
      g.add(win);
    }

    // Leinwand: Rahmen an der Wand, davor eine Fläche, die nur in den Tiefenpuffer schreibt (Ausschnitt im
    // WebGL-Bild → darunter liegt die CSS3D-Ebene mit dem DOM der Leinwand; Figuren davor verdecken sie korrekt)
    const sw = SCREEN_W * SCREEN_SCALE, sh = SCREEN_H * SCREEN_SCALE;
    const bezel = box(sw + 0.16, sh + 0.16, 0.06, M.metal, SCREEN_POS.x, SCREEN_POS.y - (sh + 0.16) / 2, -hd + 0.0);
    bezel.castShadow = false;
    g.add(bezel);
    const cut = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), new THREE.MeshBasicMaterial({ colorWrite: false }));
    cut.position.copy(SCREEN_POS);
    cut.renderOrder = -1; // vor der Wand zeichnen, damit sie dahinter nicht erscheint
    cut.userData.screenCut = true;
    g.add(cut);
    this.screenCut = cut;
    this.screen = new Screen();
    this.screen.object.position.copy(SCREEN_POS);
    g.add(this.screen.object);

    // Stationen ------------------------------------------------------------
    // Terminal (hinten links)
    const term = new THREE.Group();
    term.add(desk(2.6, 0.9, 0, 0));
    const m1 = monitor(STATIONS.terminal.color, -0.6, -0.15);
    const m2 = monitor(STATIONS.terminal.color, 0.6, -0.15);
    term.add(m1, m2);
    term.position.set(-5, 0, -4.6);
    g.add(term);
    this.addStation('terminal', -5, -4.4, 3.6, 3.0, [[-0.6, 0.75], [0.6, 0.75], [-1.7, 0.95], [1.7, 0.95]], Math.PI, [m1.userData.screen, m2.userData.screen]);

    // Werkbank (hinten Mitte) – ohne Monitore, dahinter hängt die Leinwand
    const wb = new THREE.Group();
    wb.add(desk(3.6, 0.95, 0, 0));
    wb.position.set(0.6, 0, -4.6);
    g.add(wb);
    this.addStation('workbench', 0.6, -4.4, 4.6, 3.0, [[-1.05, 0.75], [0, 0.75], [1.05, 0.75], [-2.2, 0.95], [2.2, 0.95]], Math.PI);

    // Bibliothek (rechts hinten)
    g.add(bookshelf(4.75, -5.55, 1.9));
    g.add(bookshelf(6.75, -5.55, 1.9));
    g.add(rug(5.75, -3.9, 3.4, 2.2, '#e3d2b4'));
    this.addStation('library', 5.75, -3.9, 4.0, 3.0, [[-1.0, -0.6], [1.0, -0.6], [0, -0.6], [-1.1, 0.7], [1.1, 0.7]], null);

    // Web-Portal (rechts vorne)
    const portal = new THREE.Group();
    portal.add(cyl(0.95, 1.05, 0.14, M.metal, 0, 0, 0, 40));
    const ringMat = new THREE.MeshStandardMaterial({ color: STATIONS.portal.color, emissive: STATIONS.portal.color, emissiveIntensity: 0.9, roughness: 0.3 });
    const torus = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.06, 12, 64), ringMat);
    torus.position.y = 1.25;
    torus.castShadow = true;
    const torus2 = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.035, 10, 48), ringMat);
    torus2.position.y = 1.25;
    const globe = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 1), new THREE.MeshStandardMaterial({ color: '#bfeaf2', emissive: STATIONS.portal.color, emissiveIntensity: 0.35, roughness: 0.4, flatShading: true }));
    globe.position.y = 1.25;
    portal.add(torus, torus2, globe);
    portal.position.set(5.4, 0, 2.6);
    g.add(portal);
    this.animated.push((t, act) => {
      const k = 0.4 + act * 1.6;
      torus.rotation.y = t * 0.6 * k; torus.rotation.x = Math.sin(t * 0.4) * 0.3;
      torus2.rotation.x = t * 0.9 * k; globe.rotation.y = -t * 0.5 * k;
      ringMat.emissiveIntensity = 0.5 + act * 0.7 + Math.sin(t * 3) * 0.1;
    });
    this.addStation('portal', 5.4, 2.6, 3.6, 3.4, [[-1.3, 0.4], [0, 1.4], [1.3, 0.4], [-1.0, -1.1], [1.0, -1.1]], 'center');

    // Besprechungstisch (Mitte) – hier entstehen Subagenten
    const meet = new THREE.Group();
    meet.add(cyl(1.15, 1.15, 0.06, M.white, 0, 0.72, 0, 48));
    meet.add(cyl(0.12, 0.3, 0.72, M.metal, 0, 0, 0, 16));
    meet.position.set(-0.6, 0, 1.2);
    g.add(meet);
    this.meetingCenter = new THREE.Vector3(-0.6, 0, 1.2);
    const seats = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      seats.push([Math.sin(a) * 1.7, Math.cos(a) * 1.7]);
    }
    this.addStation('meeting', -0.6, 1.2, 4.4, 4.4, seats, 'center');

    // Lounge (vorne links)
    g.add(rug(-5.2, 3.3, 4, 2.6, '#cdd5e1'));
    g.add(sofa(-5.2, 3.9, 0));
    g.add(box(1.2, 0.36, 0.6, M.wood, -5.2, 0, 5.05));
    g.add(plant(-7.3, 4.9, 1.1));
    g.add(plant(7.3, -5.4 + 9.8, 0.9));
    g.add(plant(-7.3, -5.4, 0.9));
    this.addStation('lounge', -5.2, 3.4, 4.4, 3.0, [[-0.62, 0.45], [0.62, 0.45], [-1.7, -0.6], [1.7, -0.6], [0, -1.6]], 0);
    this.loungeSeats = 2;

    // Spawnpunkt am Eingang
    const mat2 = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.5 });
    const door = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.5), mat2);
    door.rotation.x = -Math.PI / 2;
    door.position.set(0, 0.005, hd - 0.25);
    g.add(door);

    // Hindernisse für einfache Wegplanung (Kreis, lokal)
    this.obstacles = [
      { x: -0.6, z: 1.2, r: 1.45 },
      { x: 5.4, z: 2.6, r: 1.1 },
      { x: -5.2, z: 5.05, r: 0.7 },
      { x: -5.2, z: 3.9, r: 1.0 },
    ];
  }

  addStation(id, x, z, w, d, slots, facing, screens = []) {
    const pad = stationPad(x, z, w, d, STATIONS[id].color);
    this.group.add(pad);
    const c = new THREE.Vector3(x, 0, z);
    this.stations[id] = {
      id,
      center: c,
      pad,
      screens,
      slots: slots.map(([sx, sz]) => {
        const p = new THREE.Vector3(x + sx, 0, z + sz);
        let f = facing;
        if (facing === 'center') f = Math.atan2(c.x - p.x, c.z - p.z);
        else if (facing == null) f = Math.atan2(sx > 0 ? 0.6 : -0.2, sz < 0 ? -1 : 0.4);
        return { pos: p, facing: f };
      }),
      activity: 0,
    };
    // Bibliothek: Blick zum Regal
    if (id === 'library') {
      const s = this.stations[id].slots;
      s[0].facing = Math.PI; s[1].facing = Math.PI; s[2].facing = Math.PI; s[3].facing = 0.4; s[4].facing = -0.4;
    }
  }

  buildLabel() {
    const el = document.createElement('div');
    el.className = 'room-label';
    el.innerHTML = `<span class="room-dot"></span><span class="room-name"></span><span class="room-count"></span>`;
    el.querySelector('.room-name').textContent = this.name;
    this.countEl = el.querySelector('.room-count');
    this.labelEl = el;
    const lbl = new CSS2DObject(el);
    lbl.position.set(-ROOM_W / 2 + 0.2, 0, ROOM_D / 2 + 0.7);
    lbl.center.set(0, 0.5);
    this.group.add(lbl);
    this.label = lbl;
  }

  tick(t, dt) {
    const drag = this.world.dragging;
    for (const st of Object.values(this.stations)) {
      st.activity += ((st.busy ? 1 : 0) - st.activity) * Math.min(1, dt * 3);
      // beim Ziehen einer Figur leuchtet das Meeting-Pad als Ablageziel
      const hint = drag && st.id === 'meeting' ? (drag.room === this ? 0.34 : 0.16 + Math.sin(t * 5) * 0.05) : 0;
      st.pad.userData.fill.material.opacity = 0.08 + st.activity * 0.16 + hint;
      st.screens.forEach((s, i) => {
        s.material.emissiveIntensity = 0.15 + st.activity * (0.65 + Math.sin(t * 6 + i * 1.7) * 0.12);
      });
    }
    for (const fn of this.animated) fn(t, this.stations.portal.activity);
  }

  // Weltposition der Leinwand (für Abstand/Sichtbarkeit)
  screenWorldPosition(target = new THREE.Vector3()) {
    return target.copy(SCREEN_POS).add(this.group.position);
  }

  dispose() {
    this.labelEl.remove();
    this.screen.dispose();
    this.group.removeFromParent();
  }
}
